import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@earendil-works/pi-mcp";
import { ownerKey, type Principal } from "../auth/authenticator.ts";
import type { ExposedToolConfig } from "../config.ts";
import { AppError, RPC } from "../errors.ts";
import { HOPS_META, TURN_META, validTurnId } from "../identity.ts";
import type { AgentService, TaskOutcome } from "../service.ts";
import type { Logger } from "../util/log.ts";
import { validTraceparent } from "../util/tracing.ts";
import { SseStream } from "./sse.ts";
import { parseRequest, readBody, rpcError, type RpcId, type RpcRequest, toAppError, TRACE_HEADER, writeJson } from "./streamable-http.ts";

const MCP_SESSION_HEADER = "mcp-session-id";

/** Agents along a chain of calls, the first call being 1. It stops accidental cycles; a client sets its own count. */
const MAX_HOPS = 2;

const TASK_SCHEMA = {
	type: "object",
	properties: {
		task: { type: "string", description: "The whole task, with every fact needed to do it. The agent cannot see your conversation." },
	},
	required: ["task"],
};

export type McpEndpointOptions = {
	readonly agent: string;
	readonly tools: readonly ExposedToolConfig[];
	readonly service: AgentService;
	readonly log: Logger;
	readonly keepAliveMs: number;
	readonly maxBodyBytes: number;
};

/**
 * This agent as an MCP server over Streamable HTTP: the tools the config declares, each a one-shot task. Stateless, so
 * any replica can serve a call. The `Mcp-Session-Id` it hands out stores nothing: cancels arrive on their own POST and
 * name a request id, and every client numbers its requests from 1, so the id tells whose call a cancel means.
 */
export class McpEndpoint {
	readonly #options: McpEndpointOptions;
	readonly #calls = new Map<string, AbortController>();

	constructor(options: McpEndpointOptions) {
		this.#options = options;
	}

	async handle(req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<void> {
		if (req.method !== "POST") {
			res.writeHead(405, { allow: "POST" }).end();
			return;
		}
		if (!(req.headers["content-type"] ?? "").includes("application/json")) {
			writeJson(res, 415, { error: "expected application/json" });
			return;
		}
		let request: RpcRequest;
		try {
			request = parseRequest(await readBody(req, this.#options.maxBodyBytes));
		} catch (error) {
			const rpc = error instanceof AppError ? error : new AppError("parse_error", 400, RPC.parseError, "invalid JSON");
			writeJson(res, rpc.status, rpcError(null, rpc));
			return;
		}
		if (request.id === undefined) {
			if (request.method === "notifications/cancelled") this.#calls.get(callKey(req, principal, request.params.requestId))?.abort();
			res.writeHead(202).end();
			return;
		}
		const { id } = request;
		const reply = (result: unknown, headers?: Record<string, string>) => writeJson(res, 200, { jsonrpc: "2.0", id, result }, headers);
		switch (request.method) {
			case "initialize":
				return reply(
					{
						protocolVersion: negotiated(request.params.protocolVersion),
						capabilities: { tools: {} },
						serverInfo: { name: this.#options.agent, version: "0.1.0" },
					},
					{ [MCP_SESSION_HEADER]: randomUUID() },
				);
			case "ping":
				return reply({});
			case "tools/list":
				return reply({
					tools: this.#options.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: TASK_SCHEMA })),
				});
			case "tools/call":
				return this.#call(req, res, principal, request, id);
			default:
				writeJson(res, 200, rpcError(id, new AppError("method_not_found", 404, RPC.methodNotFound, `unknown method ${request.method}`)));
		}
	}

	async #call(req: IncomingMessage, res: ServerResponse, principal: Principal, request: RpcRequest, id: RpcId): Promise<void> {
		const { service, tools, keepAliveMs, log } = this.#options;
		const params = request.params as { name?: unknown; arguments?: { task?: unknown }; _meta?: Record<string, unknown> };
		const tool = tools.find((candidate) => candidate.name === params.name);
		if (tool === undefined) {
			writeJson(res, 200, rpcError(id, new AppError("invalid_params", 400, RPC.invalidParams, `unknown tool ${String(params.name)}`)));
			return;
		}
		const meta = params._meta ?? {};
		const declaredHops = meta[HOPS_META];
		const hops = typeof declaredHops === "number" ? declaredHops : 0;
		const declaredTurn = meta[TURN_META];
		const turnId = typeof declaredTurn === "string" && validTurnId(declaredTurn) ? declaredTurn : undefined;
		const header = req.headers[TRACE_HEADER];
		const traceparent = [meta.traceparent, header].find((value): value is string => typeof value === "string" && validTraceparent(value));
		const token = meta.progressToken;

		const streaming = (req.headers.accept ?? "").includes("text/event-stream");
		const stream = streaming ? new SseStream(res, keepAliveMs) : undefined;
		let progress = 0;
		const report = (message: string) => {
			if (stream === undefined || (typeof token !== "string" && typeof token !== "number")) return;
			stream.send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: ++progress, message } });
		};
		const heartbeat = setInterval(() => report("working"), keepAliveMs);
		heartbeat.unref();

		const controller = new AbortController();
		const key = callKey(req, principal, id);
		this.#calls.set(key, controller);
		res.once("close", () => {
			if (!res.writableFinished) controller.abort();
		});
		let result: unknown;
		try {
			if (hops > MAX_HOPS) throw new AppError("too_many_hops", 422, RPC.rejected, `this call passed through more than ${MAX_HOPS} agents`);
			log.info("mcp.call", { tool: tool.name, owner: ownerKey(principal), hops, ...(principal.agent === undefined ? {} : { runtime: principal.agent.runtime }) });
			const outcome = await service.runTask(
				principal,
				params.arguments?.task,
				{
					...(tool.profile === undefined ? {} : { profile: tool.profile }),
					metadata: { via: "mcp", tool: tool.name, [HOPS_META]: hops },
					...(turnId === undefined ? {} : { turnId }),
					...(traceparent === undefined ? {} : { traceparent }),
					onEvent: (event) => {
						if (event.type === "tool.started") report(`running ${event.name}`);
					},
					signal: controller.signal,
				},
				BACKGROUND_CONTEXT,
			);
			result = taskResult(outcome);
		} catch (error) {
			// A refusal is something the calling model can read and act on.
			result = toolError(toAppError(error, log).message);
		} finally {
			clearInterval(heartbeat);
			this.#calls.delete(key);
		}
		if (stream === undefined) {
			if (!res.destroyed) writeJson(res, 200, { jsonrpc: "2.0", id, result });
			return;
		}
		stream.send({ jsonrpc: "2.0", id, result });
		stream.end();
	}
}

function taskResult(outcome: TaskOutcome): unknown {
	if (outcome.status !== "done") return toolError(`The agent could not finish (${outcome.reason ?? outcome.status}).`);
	return { content: [{ type: "text", text: outcome.text || "(no answer)" }] };
}

function toolError(text: string): unknown {
	return { content: [{ type: "text", text }], isError: true };
}

function negotiated(requested: unknown): string {
	return (SUPPORTED_PROTOCOL_VERSIONS as readonly unknown[]).includes(requested) ? (requested as string) : LATEST_PROTOCOL_VERSION;
}

function callKey(req: IncomingMessage, principal: Principal, id: unknown): string {
	const session = req.headers[MCP_SESSION_HEADER];
	return `${ownerKey(principal)}\0${typeof session === "string" ? session : ""}\0${String(id)}`;
}
