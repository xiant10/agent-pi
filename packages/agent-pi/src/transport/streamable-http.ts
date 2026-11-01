import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { JsonObject, SubmissionRecord } from "@earendil-works/pi-durable";
import type { Principal } from "../auth/authenticator.ts";
import { AppError, invalidParams, RPC } from "../errors.ts";
import type { ClientEvent } from "../events/hub.ts";
import { validTurnId } from "../identity.ts";
import type { Admitted, AgentService, PromptOptions } from "../service.ts";
import type { SessionChanges } from "../sessions.ts";
import type { Logger } from "../util/log.ts";
import { validTraceparent } from "../util/tracing.ts";
import { SseStream } from "./sse.ts";

export const SESSION_HEADER = "agent-session-id";
/** Names the turn a prompt starts; the `turnId` param wins. */
export const TURN_HEADER = "x-turn-id";
/** The W3C trace context of the client's turn. */
export const TRACE_HEADER = "traceparent";
/** Names the submission a streamed run answers, before its first event; absent when a plugin answered. */
export const SUBMISSION_HEADER = "agent-submission-id";

/** Methods the transport defines; plugins add others. */
export const CORE_METHODS = [
	"session.create",
	"session.list",
	"session.get",
	"session.messages",
	"session.update",
	"session.prompt",
	"session.steer",
	"session.interrupt",
	"session.cancel",
	"session.retry",
	"session.close",
	"skills.list",
] as const;

export type RpcId = string | number | null;
export type RpcRequest = { readonly id?: RpcId; readonly method: string; readonly params: Record<string, unknown> };

export type StreamableOptions = {
	readonly service: AgentService;
	readonly log: Logger;
	readonly keepAliveMs: number;
	readonly maxBodyBytes: number;
};

/** The largest delay `setTimeout` honours; a longer one would fire at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** A stream opened on a token inside the verifier's leeway still lasts this long, so a reconnect can't spin. */
const MIN_STREAM_MS = 1000;

/** After `wait()` settles, how long to let the event stream deliver the final events before answering anyway. */
const DRAIN_MS = 1000;

/**
 * The agent over Streamable HTTP (the MCP 2025-06-18 transport, with agent methods):
 *
 * - `POST`: one JSON-RPC request. `session.prompt` and `session.interrupt` answer with an SSE stream of `session/event`
 *   notifications ending in the JSON-RPC response when the client accepts `text/event-stream`; everything else answers
 *   with JSON. A notification (no `id`) is accepted with 202.
 * - `GET`: the session's event stream, resumable with `Last-Event-ID`.
 * - `DELETE`: close the session.
 *
 * The session is named by the `Agent-Session-Id` header or `params.sessionId`.
 */
export async function handleStreamable(
	req: IncomingMessage,
	res: ServerResponse,
	principal: Principal,
	options: StreamableOptions,
): Promise<void> {
	if (req.method === "GET") return openEventStream(req, res, principal, options);
	if (req.method === "DELETE") {
		const sessionId = headerSession(req);
		if (sessionId === undefined) throw invalidParams(`missing ${SESSION_HEADER} header`);
		await options.service.close(principal, sessionId, BACKGROUND_CONTEXT);
		res.writeHead(204).end();
		return;
	}
	if (req.method !== "POST") {
		res.writeHead(405, { allow: "GET, POST, DELETE" }).end();
		return;
	}
	if (!(req.headers["content-type"] ?? "").includes("application/json")) {
		res.writeHead(415, { "content-type": "application/json" }).end(JSON.stringify({ error: "expected application/json" }));
		return;
	}

	let request: RpcRequest;
	try {
		request = parseRequest(await readBody(req, options.maxBodyBytes));
	} catch (error) {
		const rpc = error instanceof AppError ? error : new AppError("parse_error", 400, RPC.parseError, "invalid JSON");
		writeJson(res, rpc.status, rpcError(null, rpc));
		return;
	}
	const isNotification = request.id === undefined;
	const id = request.id ?? null;
	try {
		const streamed = wantsStream(req, request);
		if (streamed && !isNotification) {
			await streamRun(req, res, principal, request, id, options);
			return;
		}
		const { result, headers } = await dispatch(principal, req, request, options, requestContext(res));
		if (isNotification) res.writeHead(202).end();
		else writeJson(res, 200, { jsonrpc: "2.0", id, result }, headers);
	} catch (error) {
		// The client left while waiting for a run; the run goes on, and there is nobody to answer.
		if (res.destroyed) return;
		const rpc = toAppError(error, options.log);
		if (res.headersSent) return;
		if (isNotification) res.writeHead(rpc.status, rpc.headers).end();
		else writeJson(res, rpc.status, rpcError(id, rpc), rpc.headers);
	}
}

async function dispatch(
	principal: Principal,
	req: IncomingMessage,
	request: RpcRequest,
	options: StreamableOptions,
	waitContext: Context,
): Promise<{ readonly result: unknown; readonly headers?: Record<string, string> }> {
	const { service } = options;
	const params = request.params;
	const context = BACKGROUND_CONTEXT;
	const session = () => sessionOf(req, params);
	switch (request.method) {
		case "session.create": {
			const metadata = params.metadata === undefined ? undefined : objectParam(params.metadata, "metadata");
			const info = await service.createSession(
				principal,
				{
					...(params.profile === undefined ? {} : { profile: stringParam(params.profile, "profile") }),
					...(metadata === undefined ? {} : { metadata }),
				},
				context,
			);
			return { result: info, headers: { [SESSION_HEADER]: info.sessionId } };
		}
		case "session.list":
			return {
				result: await service.listSessions(
					principal,
					{
						...(params.archived === undefined ? {} : { archived: params.archived === true }),
						...(params.limit === undefined ? {} : { limit: pageSize(params.limit) }),
						...(params.cursor === undefined ? {} : { cursor: cursorParam(params.cursor) }),
					},
					context,
				),
			};
		case "session.get":
			return { result: await service.getSession(principal, session(), context) };
		case "session.messages":
			return {
				result: await service.messages(
					principal,
					session(),
					{ limit: params.limit === undefined ? 50 : pageSize(params.limit), ...(params.cursor === undefined ? {} : { before: cursorParam(params.cursor) }) },
					context,
				),
			};
		case "session.update":
			return { result: await service.updateSession(principal, session(), sessionChanges(params), context) };
		case "session.prompt": {
			const admitted = await service.prompt(principal, session(), params.input, promptOptions(params, req), context);
			return { result: await settle(admitted, params.wait !== false, service, waitContext) };
		}
		case "session.steer": {
			const admitted = await service.steer(principal, session(), params.input, promptOptions(params, req), context);
			if (admitted.kind === "reply") {
				return { result: { turnId: admitted.turnId, placement: "answered", answeredBy: admitted.plugin, text: admitted.text } };
			}
			return { result: { turnId: admitted.turnId, submissionId: admitted.submission.id, placement: admitted.placement } };
		}
		case "session.interrupt": {
			const admitted = await service.interrupt(principal, session(), params.input, promptOptions(params, req), context);
			if (admitted === undefined) return { result: { aborted: true } };
			return { result: await settle(admitted, params.wait !== false, service, waitContext) };
		}
		case "session.cancel":
			await service.cancel(principal, session(), context, { tasks: params.tasks === true });
			return { result: { aborted: true } };
		case "session.retry":
			return { result: { retried: await service.retry(principal, session(), context) } };
		case "session.close":
			await service.close(principal, session(), context);
			return { result: { closed: true } };
		case "skills.list":
			return { result: { skills: service.skills.map((skill) => ({ name: skill.name, description: skill.description })) } };
		default: {
			const method = service.pluginMethod(request.method);
			if (method === undefined) throw new AppError("method_not_found", 404, RPC.methodNotFound, `unknown method ${request.method}`);
			const result = await method.handler(params, {
				principal,
				session: () => service.pluginSession(method.plugin, principal, session(), context),
				log: options.log,
			});
			return { result: result ?? null };
		}
	}
}

/**
 * Cancelled when the client goes away before its response is written. Only waits use it: admission runs to the end
 * either way, so an input is never half admitted, and an admitted run goes on.
 */
function requestContext(res: ServerResponse): Context {
	const controller = new AbortController();
	res.once("close", () => {
		if (!res.writableFinished) controller.abort();
	});
	return withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
}

/** The JSON result of an admitted input: at once, or after it settles (until the client leaves). */
async function settle(admitted: Admitted, wait: boolean, service: AgentService, waitContext: Context): Promise<Record<string, unknown>> {
	if (admitted.kind === "reply") return replyResult(admitted);
	if (!wait) return { turnId: admitted.turnId, submissionId: admitted.submission.id, placement: admitted.placement };
	const settled = await admitted.submission.wait(waitContext);
	const text = await service.answerText(admitted.conversationId, settled);
	return { turnId: admitted.turnId, submissionId: settled.id, ...outcomeOf(settled), ...(text === undefined ? {} : { text }) };
}

function replyResult(admitted: Extract<Admitted, { kind: "reply" }>): Record<string, unknown> {
	return { turnId: admitted.turnId, status: "done", answeredBy: admitted.plugin, text: admitted.text, placement: admitted.placement };
}

/** Status, reason, and a string `detail` (such as a provider error message) of a submission. */
function outcomeOf(record: SubmissionRecord): { status: string; reason?: string; detail?: string } {
	return {
		status: record.status,
		...(record.reason === undefined ? {} : { reason: record.reason }),
		...(typeof record.detail === "string" ? { detail: record.detail } : {}),
	};
}

/**
 * A run as SSE. Subscribe to the session first, so no event is missed, and buffer events until the input is admitted:
 * a refusal (busy, limits, bad input) still answers with its HTTP status instead of an error inside a 200 stream.
 * Then forward every event and end with the JSON-RPC response once this submission settles.
 */
async function streamRun(
	req: IncomingMessage,
	res: ServerResponse,
	principal: Principal,
	request: RpcRequest,
	id: RpcId,
	options: StreamableOptions,
): Promise<void> {
	const { service } = options;
	const params = request.params;
	const sessionId = sessionOf(req, params);
	const hub = await service.hub(principal, sessionId, BACKGROUND_CONTEXT);

	let sse: SseStream | undefined;
	const pending: ClientEvent[] = [];
	let lastEventId: string | undefined;
	let ours: number | undefined;
	let replyEnded: (() => void) | undefined;
	const settledIds = new Map<number, ReturnType<typeof outcomeOf>>();
	let ended = false;
	let resolveSettled!: () => void;
	const settledSignal = new Promise<void>((resolve) => {
		resolveSettled = resolve;
	});
	const subscription = hub.subscribe(
		{
			event: (event) => {
				lastEventId = event.id;
				if (sse === undefined) pending.push(event);
				else sse.send(notification(sessionId, event), event.id);
				const body = event.body;
				if (body.type === "message.end" && body.source !== undefined) replyEnded?.();
				if (body.type === "submission" && (body.status === "done" || body.status === "unanswered")) {
					settledIds.set(body.submissionId, {
						status: body.status,
						...(body.reason === undefined ? {} : { reason: body.reason }),
						...(body.detail === undefined ? {} : { detail: body.detail }),
					});
					if (body.submissionId === ours) resolveSettled();
				}
			},
			end: () => {
				ended = true;
				resolveSettled();
			},
		},
		undefined,
	);

	try {
		const context = BACKGROUND_CONTEXT;
		const prompt = promptOptions(params, req);
		const admitted =
			request.method === "session.interrupt"
				? await service.interrupt(principal, sessionId, params.input, prompt, context)
				: await service.prompt(principal, sessionId, params.input, prompt, context);
		if (admitted === undefined) {
			writeJson(res, 200, { jsonrpc: "2.0", id, result: { aborted: true } });
			return;
		}
		if (admitted.kind === "reply") {
			const arrived = pending.some((event) => event.body.type === "message.end" && event.body.source !== undefined);
			const stream = new SseStream(res, options.keepAliveMs, { [SESSION_HEADER]: sessionId });
			sse = stream;
			for (const event of pending.splice(0)) stream.send(notification(sessionId, event), event.id);
			// A placed reply's events come from the commit that wrote it; give them a moment to arrive before answering.
			// A queued one is placed after the current run, so its events arrive on the session's GET stream instead.
			if (admitted.placement === "placed" && !arrived) {
				const ended = new Promise<void>((resolve) => {
					replyEnded = resolve;
				});
				await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, DRAIN_MS).unref())]);
			}
			stream.send({ jsonrpc: "2.0", id, result: replyResult(admitted) }, lastEventId);
			stream.end();
			return;
		}
		ours = admitted.submission.id;
		const stream = new SseStream(res, options.keepAliveMs, { [SESSION_HEADER]: sessionId, [SUBMISSION_HEADER]: String(ours) });
		sse = stream;
		for (const event of pending.splice(0)) stream.send(notification(sessionId, event), event.id);
		stream.onClose(() => {
			subscription.unsubscribe();
			if (params.abortOnDisconnect === true && !settledIds.has(ours!)) {
				void service.cancel(principal, sessionId, BACKGROUND_CONTEXT).catch(() => undefined);
			}
		});
		if (settledIds.has(ours)) resolveSettled();

		// Normally the stream reports settlement first; `wait()` covers a stream that resynced past it.
		const waited = admitted.submission
			.wait(BACKGROUND_CONTEXT)
			.then((record) => new Promise<typeof record>((resolve) => setTimeout(() => resolve(record), DRAIN_MS).unref()));
		// A client that left stops this wait; the run goes on unless it asked for `abortOnDisconnect`.
		const closed = new Promise<void>((resolve) => stream.onClose(resolve));
		await Promise.race([settledSignal, waited, closed]);
		if (stream.closed) return;
		if (ended && !settledIds.has(ours)) {
			stream.send(rpcError(id, new AppError("session_ended", 410, RPC.notFound, "session stream ended")), lastEventId);
			stream.end();
			return;
		}
		const record = await admitted.submission.status(BACKGROUND_CONTEXT);
		const text = await service.answerText(admitted.conversationId, record);
		const outcome = settledIds.get(ours) ?? outcomeOf(record);
		stream.send({ jsonrpc: "2.0", id, result: { turnId: admitted.turnId, submissionId: ours, ...outcome, ...(text === undefined ? {} : { text }) } }, lastEventId);
		stream.end();
	} catch (error) {
		const appError = toAppError(error, options.log);
		if (sse === undefined) writeJson(res, appError.status, rpcError(id, appError), appError.headers);
		else {
			sse.send(rpcError(id, appError), lastEventId);
			sse.end();
		}
	} finally {
		subscription.unsubscribe();
	}
}

async function openEventStream(
	req: IncomingMessage,
	res: ServerResponse,
	principal: Principal,
	options: StreamableOptions,
): Promise<void> {
	if (!(req.headers.accept ?? "").includes("text/event-stream")) {
		res.writeHead(406, { "content-type": "application/json" }).end(JSON.stringify({ error: "accept text/event-stream" }));
		return;
	}
	const url = new URL(req.url ?? "/", "http://localhost");
	const sessionId = headerSession(req) ?? url.searchParams.get("sessionId") ?? undefined;
	if (sessionId === undefined) throw invalidParams(`missing ${SESSION_HEADER} header`);
	const hub = await options.service.hub(principal, sessionId, BACKGROUND_CONTEXT);
	const lastEventId = typeof req.headers["last-event-id"] === "string" ? req.headers["last-event-id"] : undefined;
	const sse = new SseStream(res, options.keepAliveMs, { [SESSION_HEADER]: sessionId });
	const subscription = hub.subscribe(
		{ event: (event) => sse.send(notification(sessionId, event), event.id), end: () => sse.end() },
		lastEventId,
	);
	for (const event of subscription.initial) sse.send(notification(sessionId, event), event.id);
	sse.onClose(() => subscription.unsubscribe());
	endAtExpiry(sse, principal);
}

/**
 * A token is checked only when a stream opens, so a stream ends with its token: the client reconnects at once with a
 * fresh token and `Last-Event-ID`, and a removed user gets no fresh token. An end sooner than expiry is harmless.
 */
function endAtExpiry(sse: SseStream, principal: Principal): void {
	if (principal.expiresAt === undefined) return;
	const delay = Math.min(Math.max(principal.expiresAt - Date.now(), MIN_STREAM_MS), MAX_TIMER_MS);
	const timer = setTimeout(() => sse.end(), delay);
	timer.unref();
	sse.onClose(() => clearTimeout(timer));
}

function notification(sessionId: string, event: ClientEvent): unknown {
	return { jsonrpc: "2.0", method: "session/event", params: { sessionId, eventId: event.id, ...event.body } };
}

function wantsStream(req: IncomingMessage, request: RpcRequest): boolean {
	if (request.method !== "session.prompt" && request.method !== "session.interrupt") return false;
	if (request.params.stream === false) return false;
	return (req.headers.accept ?? "").includes("text/event-stream");
}

/**
 * The turn id is the `turnId` param, else the `X-Turn-ID` header; absent, the service generates one. A malformed
 * `traceparent` is ignored rather than refused: tracing never fails a request.
 */
function promptOptions(params: Record<string, unknown>, req: IncomingMessage): PromptOptions {
	const requestId = optionalString(params.requestId, "requestId");
	const header = req.headers[TURN_HEADER];
	const turnId = optionalString(params.turnId, "turnId") ?? (typeof header === "string" && header.length > 0 ? header : undefined);
	if (turnId !== undefined && !validTurnId(turnId)) throw invalidParams("turnId must be 1-128 characters of A-Z a-z 0-9 . _ : -");
	const traceparent = req.headers[TRACE_HEADER];
	const whenBusy = params.whenBusy;
	if (whenBusy !== undefined && whenBusy !== "followUp" && whenBusy !== "steer" && whenBusy !== "reject") {
		throw invalidParams('whenBusy must be "followUp", "steer", or "reject"');
	}
	const duringTools = params.duringTools;
	if (duringTools !== undefined && duringTools !== "abort" && duringTools !== "steer") {
		throw invalidParams('duringTools must be "abort" or "steer"');
	}
	const note = optionalString(params.note, "note");
	return {
		...(note === undefined ? {} : { note }),
		...(requestId === undefined ? {} : { requestId }),
		...(turnId === undefined ? {} : { turnId }),
		...(typeof traceparent === "string" && validTraceparent(traceparent) ? { traceparent } : {}),
		...(whenBusy === undefined ? {} : { whenBusy }),
		...(duringTools === undefined ? {} : { duringTools }),
	};
}

function headerSession(req: IncomingMessage): string | undefined {
	const value = req.headers[SESSION_HEADER];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sessionOf(req: IncomingMessage, params: Record<string, unknown>): string {
	const sessionId = params.sessionId === undefined ? headerSession(req) : stringParam(params.sessionId, "sessionId");
	if (sessionId === undefined) throw invalidParams(`missing sessionId (param or ${SESSION_HEADER} header)`);
	return sessionId;
}

function stringParam(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) throw invalidParams(`${name} must be a non-empty string`);
	return value;
}

function optionalString(value: unknown, name: string): string | undefined {
	return value === undefined ? undefined : stringParam(value, name);
}

const MAX_PAGE = 200;
const MAX_TITLE_CHARS = 200;

function pageSize(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_PAGE) throw invalidParams(`limit must be 1 to ${MAX_PAGE}`);
	return value;
}

function cursorParam(value: unknown): number {
	const cursor = Number(value);
	if (typeof value !== "string" || !Number.isInteger(cursor) || cursor < 0) throw invalidParams("invalid cursor");
	return cursor;
}

function sessionChanges(params: Record<string, unknown>): SessionChanges {
	const { title, pinned, archived } = params;
	if (title !== undefined && (typeof title !== "string" || title.length > MAX_TITLE_CHARS)) throw invalidParams(`title must be at most ${MAX_TITLE_CHARS} characters`);
	if (pinned !== undefined && typeof pinned !== "boolean") throw invalidParams("pinned must be a boolean");
	if (archived !== undefined && typeof archived !== "boolean") throw invalidParams("archived must be a boolean");
	return { ...(title === undefined ? {} : { title }), ...(pinned === undefined ? {} : { pinned }), ...(archived === undefined ? {} : { archived }) };
}

function objectParam(value: unknown, name: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidParams(`${name} must be an object`);
	return value as JsonObject;
}

export function parseRequest(body: string): RpcRequest {
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		throw new AppError("parse_error", 400, RPC.parseError, "invalid JSON");
	}
	if (Array.isArray(value)) throw new AppError("invalid_request", 400, RPC.invalidRequest, "batch requests are not supported");
	const message = value as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
	if (typeof value !== "object" || value === null || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
		throw new AppError("invalid_request", 400, RPC.invalidRequest, "expected a JSON-RPC 2.0 request");
	}
	const id = message.id;
	if (id !== undefined && id !== null && typeof id !== "string" && typeof id !== "number") {
		throw new AppError("invalid_request", 400, RPC.invalidRequest, "id must be a string or number");
	}
	const params = message.params ?? {};
	if (typeof params !== "object" || params === null || Array.isArray(params)) {
		throw new AppError("invalid_request", 400, RPC.invalidRequest, "params must be an object");
	}
	return { ...(id === undefined ? {} : { id }), method: message.method, params: params as Record<string, unknown> };
}

export function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let rejected = false;
		req.on("data", (chunk: Buffer) => {
			if (rejected) return;
			size += chunk.length;
			if (size > maxBytes) {
				rejected = true;
				reject(new AppError("too_large", 413, RPC.invalidRequest, `body larger than ${maxBytes} bytes`));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (!rejected) resolve(Buffer.concat(chunks).toString("utf8"));
		});
		req.on("error", (err) => {
			if (!rejected) {
				rejected = true;
				reject(err);
			}
		});
	});
}

export function rpcError(id: RpcId, error: AppError): unknown {
	return { jsonrpc: "2.0", id, error: { code: error.rpcCode, message: error.message, data: { code: error.code } } };
}

export function toAppError(error: unknown, log: Logger): AppError {
	if (error instanceof AppError) return error;
	log.error("request.failed", { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
	return new AppError("internal", 500, RPC.internal, "internal error");
}

export function writeJson(
	res: ServerResponse,
	status: number,
	body: unknown,
	headers: Readonly<Record<string, string>> = {},
): void {
	res.writeHead(status, { ...headers, "content-type": "application/json" });
	res.end(JSON.stringify(body));
}
