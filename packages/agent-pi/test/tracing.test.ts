import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, type ReadableSpan, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningAgent, startAgent } from "../src/app.ts";
import { StaticTokenAuthenticator } from "../src/auth/static-token.ts";
import type { ClientEventBody } from "../src/events/mapper.ts";
import { toolSpans } from "../src/events/tool-spans.ts";
import { GATEWAY_IDENTITY_HEADERS } from "../src/identity.ts";
import { type AgentPlugin, definePlugin } from "../src/plugins/types.ts";
import { rpc, TOKENS, testConfig, waitFor } from "../src/testing.ts";
import { SILENT_LOGGER } from "../src/util/log.ts";
import { startSpan, traceIdOf, validTraceparent } from "../src/util/tracing.ts";

const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;

let gateway: Server | undefined;
let agent: RunningAgent | undefined;
beforeEach(() => exporter.reset());
afterEach(async () => {
	await agent?.close();
	await new Promise((resolve) => (gateway === undefined ? resolve(undefined) : gateway.close(resolve)));
	agent = undefined;
	gateway = undefined;
});

type Step = { readonly text?: string; readonly tool?: { readonly name: string; readonly args: object }; readonly status?: number };

/** A chat-completions endpoint that plays `script`, then answers "ok", recording the headers of each request. */
async function startGateway(script: readonly Step[] = []) {
	const seen: IncomingHttpHeaders[] = [];
	const steps = [...script];
	gateway = createServer((req, res) => {
		seen.push(req.headers);
		req.resume();
		req.on("end", () => {
			const step = steps.shift() ?? { text: "ok" };
			if (step.status !== undefined) {
				res.writeHead(step.status, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "gateway says no" } }));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta: object, finish: string | null, usage?: object) =>
				`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage === undefined ? {} : { usage }) })}\n\n`;
			if (step.tool !== undefined) {
				const call = { index: 0, id: "call-1", type: "function", function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } };
				res.write(chunk({ role: "assistant", tool_calls: [call] }, null));
				res.write(chunk({}, "tool_calls"));
			} else {
				res.write(chunk({ role: "assistant", content: step.text }, null));
				res.write(chunk({}, "stop", { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 }));
			}
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => gateway!.listen(0, "127.0.0.1", resolve));
	return { url: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`, seen };
}

async function start(url: string, expert = false, plugins: readonly AgentPlugin[] = []) {
	process.env.OPENAI_API_KEY ??= "test-key";
	const model = { provider: "openai-compatible", modelId: "m", baseUrl: url, identityHeaders: GATEWAY_IDENTITY_HEADERS } as const;
	const base = testConfig({ models: { main: model } });
	const chat = base.profiles.chat!;
	agent = await startAgent(
		expert ? { ...base, profiles: { chat: { ...chat, expert: { model: "main", thinkingLevel: "high" } } } } : base,
		{
			log: SILENT_LOGGER,
			storage: new MemoryStorage(),
			authenticator: new StaticTokenAuthenticator(new Map([[TOKENS.alice, "alice"]])),
			plugins,
		},
	);
	return `http://127.0.0.1:${agent.port}/agent`;
}

async function session(agentUrl: string): Promise<string> {
	return (await rpc(agentUrl, TOKENS.alice, "session.create", {})).body.result!.sessionId as string;
}

/** A streaming prompt, as the voice client sends one, returning once the stream ends. */
async function prompt(agentUrl: string, sessionId: string, input: string, headers: Record<string, string> = { traceparent: TRACEPARENT }, extra: object = {}) {
	const response = await fetch(agentUrl, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${TOKENS.alice}`, ...headers },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.prompt", params: { sessionId, input, ...extra } }),
	});
	return response.text();
}

const spans = (name: string): ReadableSpan[] => exporter.getFinishedSpans().filter((span) => span.name === name);
const parentId = (span: ReadableSpan) => span.parentSpanContext?.spanId;

describe("traceparent", () => {
	it("validates", () => {
		expect(validTraceparent(TRACEPARENT)).toBe(true);
		expect(validTraceparent("nope")).toBe(false);
		expect(validTraceparent(`00-${"0".repeat(32)}-00f067aa0ba902b7-01`)).toBe(false);
		expect(validTraceparent(`00-${TRACE_ID}-${"0".repeat(16)}-01`)).toBe(false);
		expect(traceIdOf(TRACEPARENT)).toBe(TRACE_ID);
	});

	it("gives a child span's traceparent in the same trace", () => {
		const span = startSpan("x", { traceparent: TRACEPARENT });
		expect(span.traceparent).toMatch(new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-01$`));
		expect(span.traceparent).not.toBe(TRACEPARENT);
		span.end();
		span.end("ignored");
		expect(spans("x")).toHaveLength(1);
		expect(spans("x")[0]!.status.code).toBe(0);
	});
});

describe("a traced turn", () => {
	it("adds a submission and its model calls to the client's trace, and passes it to the gateway", async () => {
		const { url, seen } = await startGateway();
		const agentUrl = await start(url);
		const sessionId = await session(agentUrl);
		await prompt(agentUrl, sessionId, "hi", { traceparent: TRACEPARENT }, { turnId: TRACE_ID });

		await waitFor(() => spans("agent.submission").length === 1 && spans("agent.model").length === 1);
		const [submission] = spans("agent.submission");
		const [model] = spans("agent.model");
		expect(submission!.spanContext().traceId).toBe(TRACE_ID);
		expect(parentId(submission!)).toBe("00f067aa0ba902b7");
		expect(submission!.attributes).toMatchObject({ "agentpi.session_id": sessionId, "turn.id": TRACE_ID, "agent.status": "done" });
		expect(model!.spanContext().traceId).toBe(TRACE_ID);
		expect(parentId(model!)).toBe(submission!.spanContext().spanId);
		expect(model!.attributes).toMatchObject({ "gen_ai.request.model": "m", "gen_ai.usage.input_tokens": 11, "gen_ai.usage.output_tokens": 3 });
		expect(seen[0]!.traceparent).toBe(`00-${TRACE_ID}-${model!.spanContext().spanId}-01`);
		expect(seen[0]!["x-turn-id"]).toBe(TRACE_ID);
	});

	it("marks a failed model call", async () => {
		const { url } = await startGateway([{ status: 400 }]);
		const agentUrl = await start(url);
		await prompt(agentUrl, await session(agentUrl), "hi");
		await waitFor(() => spans("agent.model").length >= 1);
		expect(spans("agent.model")[0]!.status.code).toBe(2);
	});

	it("starts a trace of its own for a client that sends none, or a malformed one", async () => {
		const { url, seen } = await startGateway();
		const agentUrl = await start(url);
		const sessionId = await session(agentUrl);
		await prompt(agentUrl, sessionId, "one", {});
		await prompt(agentUrl, sessionId, "two", { traceparent: "garbage" });
		await waitFor(() => spans("agent.model").length === 2);
		expect(seen).toHaveLength(2);
		const traces = spans("agent.submission").map((span) => span.spanContext().traceId);
		expect(new Set(traces).size).toBe(2);
		expect(traces).not.toContain(TRACE_ID);
		expect(traces.map((id) => seen.some((headers) => headers.traceparent?.includes(id)))).toEqual([true, true]);
		for (const span of spans("agent.submission")) expect(span.parentSpanContext).toBeUndefined();
	});

	it("does not trace a retried input twice", async () => {
		const { url, seen } = await startGateway();
		const agentUrl = await start(url);
		const sessionId = await session(agentUrl);
		await prompt(agentUrl, sessionId, "hi", { traceparent: TRACEPARENT }, { requestId: "r1" });
		await prompt(agentUrl, sessionId, "hi", { traceparent: TRACEPARENT }, { requestId: "r1" });
		await waitFor(() => spans("agent.submission").length === 1);
		expect(seen).toHaveLength(1);
		expect(spans("agent.submission")).toHaveLength(1);
	});

	it("records a plugin's reply", async () => {
		const { url, seen } = await startGateway();
		const answering = definePlugin({ name: "answering", beforePrompt: () => ({ reply: "from a plugin" }) });
		const agentUrl = await start(url, false, [answering]);
		await prompt(agentUrl, await session(agentUrl), "hi");
		await waitFor(() => spans("agent.reply").length === 1);
		expect(seen).toHaveLength(0);
		expect(spans("agent.reply")[0]!.spanContext().traceId).toBe(TRACE_ID);
		expect(spans("agent.reply")[0]!.attributes["agent.answered_by"]).toBe("answering");
	});

	it("keeps a consulted expert's model calls in the turn, with the parent's identity", async () => {
		const { url, seen } = await startGateway([
			{ tool: { name: "consult_expert", args: { question: "which?" } } },
			{ text: "the first" },
			{ text: "the first one" },
		]);
		const agentUrl = await start(url, true);
		const sessionId = await session(agentUrl);
		await prompt(agentUrl, sessionId, "hard question", { traceparent: TRACEPARENT }, { turnId: TRACE_ID });

		await waitFor(() => spans("agent.model").length === 3 && spans("agent.tool").length === 1);
		expect(seen).toHaveLength(3);
		for (const headers of seen) {
			expect(headers["x-session-id"]).toBe(sessionId);
			expect(headers["x-turn-id"]).toBe(TRACE_ID);
			expect(headers.traceparent).toContain(TRACE_ID);
		}
		const [submission] = spans("agent.submission");
		for (const span of [...spans("agent.model"), ...spans("agent.tool")]) {
			expect(span.spanContext().traceId).toBe(TRACE_ID);
			expect(parentId(span)).toBe(submission!.spanContext().spanId);
		}
		expect(spans("agent.tool")[0]!.attributes["tool.name"]).toBe("consult_expert");
	});
});

describe("toolSpans", () => {
	const observe = () => toolSpans(async () => TRACEPARENT);
	const started: ClientEventBody = { type: "tool.started", callId: "1", name: "lookup" };

	it("spans a call from start to finish", async () => {
		const see = observe();
		see(started);
		see({ type: "tool.finished", callId: "1", name: "lookup", isError: false });
		await waitFor(() => spans("agent.tool").length === 1);
		expect(spans("agent.tool")[0]!.status.code).toBe(0);
	});

	it("marks a failed call", async () => {
		const see = observe();
		see(started);
		see({ type: "tool.finished", callId: "1", name: "lookup", isError: true });
		await waitFor(() => spans("agent.tool").length === 1);
		expect(spans("agent.tool")[0]!.status.code).toBe(2);
	});

	it("closes a call the run abandoned", async () => {
		const see = observe();
		see(started);
		see({ type: "run.finished", submissionIds: [1] });
		await waitFor(() => spans("agent.tool").length === 1);
	});
});
