import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type Authenticator, AuthError, type Principal } from "../auth/authenticator.ts";
import type { RuntimeManifest } from "../runtime.ts";
import type { AgentService } from "../service.ts";
import type { Logger } from "../util/log.ts";
import { traceIdOf } from "../util/tracing.ts";
import type { McpEndpoint } from "./mcp.ts";
import { AGENT_HEADER, handleStreamable, METHOD_HEADER, SESSION_HEADER, SUBMISSION_HEADER, toAppError, TRACE_HEADER, TURN_HEADER, writeJson } from "./streamable-http.ts";

export type HttpOptions = {
	readonly authenticator: Authenticator;
	readonly service: AgentService;
	readonly log: Logger;
	/** Endpoint path of the Streamable HTTP transport. */
	readonly path: string;
	/** Browser origins allowed to call; requests carrying any other `Origin` are refused. `*` allows all. */
	readonly allowedOrigins: readonly string[];
	readonly keepAliveMs: number;
	readonly maxBodyBytes: number;
	/** The MCP endpoint, when this agent offers one. */
	readonly mcp?: { readonly path: string; readonly endpoint: McpEndpoint };
	/** For `/readyz`. */
	readonly readiness: () => { readonly ready: boolean; readonly detail: unknown };
	/** For `/v1/runtime`. */
	readonly runtime: RuntimeManifest;
};

/**
 * Routes: `/healthz`, `/readyz` and `/v1/runtime` without auth, the agent endpoint behind the authenticator, 404
 * otherwise. Authentication runs before any body is read or any session is touched.
 */
export function createHttpServer(options: HttpOptions): Server {
	const server = createServer((req, res) => {
		const started = Date.now();
		const requestId = typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"] : randomUUID();
		res.setHeader("x-request-id", requestId);
		const traceId = typeof req.headers[TRACE_HEADER] === "string" ? traceIdOf(req.headers[TRACE_HEADER]) : undefined;
		let principal: Principal | undefined;
		res.on("finish", () => {
			options.log.info("http.request", {
				requestId,
				method: req.method,
				path: req.url?.split("?")[0],
				status: res.statusCode,
				ms: Date.now() - started,
				...(traceId === undefined ? {} : { traceId }),
				...(principal === undefined ? {} : { userId: principal.userId, tenantId: principal.tenantId }),
			});
		});
		void route(req, res, options, (resolved) => {
			principal = resolved;
		}).catch((error: unknown) => {
			const appError = toAppError(error, options.log);
			if (!res.headersSent) writeJson(res, appError.status, { error: appError.code, message: appError.message }, appError.headers);
			else res.destroy();
		});
	});
	// SSE streams stay open for minutes; only idle keep-alive sockets should time out.
	server.requestTimeout = 0;
	server.headersTimeout = 30_000;
	server.keepAliveTimeout = 65_000;
	return server;
}

async function route(
	req: IncomingMessage,
	res: ServerResponse,
	options: HttpOptions,
	onPrincipal: (principal: Principal) => void,
): Promise<void> {
	const path = new URL(req.url ?? "/", "http://localhost").pathname;
	if ((req.method === "GET" || req.method === "HEAD") && path === "/healthz") {
		if (req.method === "HEAD") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end();
			return;
		}
		return writeJson(res, 200, { ok: true });
	}
	if ((req.method === "GET" || req.method === "HEAD") && path === "/readyz") {
		const { ready, detail } = options.readiness();
		const status = ready ? 200 : 503;
		if (req.method === "HEAD") {
			res.writeHead(status, { "content-type": "application/json" });
			res.end();
			return;
		}
		return writeJson(res, status, { ready, detail });
	}
	if (req.method === "GET" && path === "/v1/runtime") return writeJson(res, 200, options.runtime);
	if (path !== options.path && path !== options.mcp?.path) return writeJson(res, 404, { error: "not_found" });

	if (!applyCors(req, res, options.allowedOrigins)) return writeJson(res, 403, { error: "origin_not_allowed" });
	if (req.method === "OPTIONS") {
		res.writeHead(204, {
			"access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
			"access-control-allow-headers": `authorization, content-type, accept, last-event-id, mcp-session-id, mcp-protocol-version, ${SESSION_HEADER}, ${AGENT_HEADER}, ${METHOD_HEADER}, ${TURN_HEADER}, ${TRACE_HEADER}`,
			"access-control-max-age": "600",
		});
		res.end();
		return;
	}

	let principal: Principal;
	try {
		principal = await options.authenticator.authenticate({ headers: req.headers, method: req.method ?? "", path });
	} catch (error) {
		if (!(error instanceof AuthError)) throw error;
		const headers: Record<string, string> =
			error.status === 401 ? { "www-authenticate": `Bearer error="${error.code === "missing_token" ? "invalid_request" : error.code}"` } : {};
		return writeJson(res, error.status, { error: error.code, message: error.message }, headers);
	}
	onPrincipal(principal);
	if (path === options.mcp?.path) return options.mcp.endpoint.handle(req, res, principal);
	const named = req.headers[AGENT_HEADER];
	if (typeof named === "string" && named !== "" && named !== options.runtime.agent) {
		return writeJson(res, 400, { error: "unknown_agent", message: `this harness serves ${options.runtime.agent}, not ${named}` });
	}
	await handleStreamable(req, res, principal, {
		agent: options.runtime.agent,
		service: options.service,
		log: options.log,
		keepAliveMs: options.keepAliveMs,
		maxBodyBytes: options.maxBodyBytes,
	});
}

/** Non-browser clients send no `Origin`. A browser origin must be allowed explicitly (DNS rebinding protection). */
function applyCors(req: IncomingMessage, res: ServerResponse, allowed: readonly string[]): boolean {
	const origin = req.headers.origin;
	if (origin === undefined) return true;
	if (!allowed.includes("*") && !allowed.includes(origin)) return false;
	res.setHeader("access-control-allow-origin", origin);
	res.setHeader("vary", "origin");
	res.setHeader("access-control-expose-headers", `${SESSION_HEADER}, ${SUBMISSION_HEADER}, mcp-session-id, x-request-id, agent-instance, retry-after`);
	return true;
}
