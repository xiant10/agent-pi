import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type FauxResponseFactory, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import type { Skill } from "../src/skills/skills.ts";
import { events, fakeMcpServer, recording, rpc, rpcStream, startTestAgent, type TestAgent, TOKENS, waitFor } from "../src/testing.ts";

let running: TestAgent | undefined;
afterEach(async () => {
	await running?.close();
	running = undefined;
});

async function createSession(agent: TestAgent, profile?: string, token: string = TOKENS.alice): Promise<string> {
	const created = await rpc(agent.url, token, "session.create", profile === undefined ? {} : { profile });
	expect(created.status).toBe(200);
	return created.body.result!.sessionId as string;
}

describe("auth and ownership", () => {
	it("rejects requests without a valid token before touching sessions", async () => {
		running = await startTestAgent();
		const missing = await fetch(running.url, { method: "POST", body: "{}" });
		expect(missing.status).toBe(401);
		expect(missing.headers.get("www-authenticate")).toContain("Bearer");
		expect((await rpc(running.url, "wrong", "session.list")).status).toBe(401);
	});

	it("hides other users' sessions and lists only the caller's", async () => {
		running = await startTestAgent();
		const sessionId = await createSession(running);
		const asBob = await rpc(running.url, TOKENS.bob, "session.get", { sessionId });
		expect(asBob.status).toBe(404);
		const aliceList = await rpc(running.url, TOKENS.alice, "session.list");
		expect((aliceList.body.result!.sessions as { sessionId: string }[]).map((s) => s.sessionId)).toEqual([sessionId]);
		expect((await rpc(running.url, TOKENS.bob, "session.list")).body.result!.sessions).toEqual([]);
	});

	it("answers 421 with the owning instance for another replica's session id", async () => {
		running = await startTestAgent();
		const response = await rpc(running.url, TOKENS.alice, "session.get", { sessionId: "other.7" });
		expect(response.status).toBe(421);
		expect(response.headers.get("agent-instance")).toBe("other");
	});

	it("enforces the per-user session limit", async () => {
		running = await startTestAgent({ config: { limits: { maxSessionsPerUser: 1, maxConcurrentRunsPerUser: 3, maxConcurrentRuns: 50, maxInputChars: 100, maxBodyBytes: 100_000 } } });
		await createSession(running);
		const second = await rpc(running.url, TOKENS.alice, "session.create");
		expect(second.status).toBe(429);
		expect(second.headers.get("retry-after")).toBe("1");
	});

	it("answers GET and HEAD for healthz and readyz probes", async () => {
		running = await startTestAgent();
		const healthGet = await fetch(new URL("/healthz", running.url));
		expect(healthGet.status).toBe(200);
		expect(await healthGet.json()).toEqual({ ok: true });

		const healthHead = await fetch(new URL("/healthz", running.url), { method: "HEAD" });
		expect(healthHead.status).toBe(200);

		const readyGet = await fetch(new URL("/readyz", running.url));
		expect(readyGet.status).toBe(200);

		const readyHead = await fetch(new URL("/readyz", running.url), { method: "HEAD" });
		expect(readyHead.status).toBe(200);
	});

	it("applies CORS and exposes required response headers", async () => {
		running = await startTestAgent({ config: { http: { path: "/agent", allowedOrigins: ["http://client.local"], keepAliveMs: 15_000 } } });
		const preflight = await fetch(running.url, {
			method: "OPTIONS",
			headers: { Origin: "http://client.local", "Access-Control-Request-Method": "POST" },
		});
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-origin")).toBe("http://client.local");

		const res = await fetch(running.url, {
			method: "POST",
			headers: { Origin: "http://client.local", Authorization: `Bearer ${TOKENS.alice}`, "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "session.list", params: {} }),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("access-control-allow-origin")).toBe("http://client.local");
		expect(res.headers.get("access-control-expose-headers")).toContain("agent-instance");
		expect(res.headers.get("access-control-expose-headers")).toContain("retry-after");
	});
});

describe("prompting", () => {
	it("answers a JSON prompt with the final text", async () => {
		running = await startTestAgent();
		running.faux.setResponses([fauxAssistantMessage([fauxText("Paris.")])]);
		const sessionId = await createSession(running);
		const answer = await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "Capital of France?" });
		expect(answer.body.result).toMatchObject({ status: "done", text: "Paris." });
	});

	it("streams a voice run as SSE: deltas, speech segments, then the JSON-RPC response", async () => {
		running = await startTestAgent();
		running.faux.setResponses([
			fauxAssistantMessage([fauxText("Your next meeting is at three. It is with **Acme**, about the renewal.")]),
		]);
		const sessionId = await createSession(running, "voice");
		const { status, messages } = await rpcStream(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "What is next?" });
		expect(status).toBe(200);
		const bodies = events(messages);
		const types = bodies.map((body) => body.type);
		expect(types).toContain("run.started");
		expect(types).toContain("text.delta");
		expect(bodies.filter((body) => body.type === "speech").map((body) => body.text)).toEqual([
			"Your next meeting is at three.",
			"It is with Acme, about the renewal.",
		]);
		const last = messages.at(-1)!.data;
		expect(last.result).toMatchObject({ status: "done", text: expect.stringContaining("Acme") });
		expect(messages.every((message, index) => index === messages.length - 1 || message.id !== undefined)).toBe(true);
	});
	it("keeps the HTTP status of a refused streamed prompt", async () => {
		running = await startTestAgent();
		const sessionId = await createSession(running);
		const refused = await rpcStream(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "   " });
		expect(refused.status).toBe(400);
	});
});

describe("dynamic tools", () => {
	const crmTools = Array.from({ length: 120 }, (_, index) => ({
		name: `tool_${index}`,
		description: `Unrelated operation number ${index}.`,
	}));
	crmTools.push(
		{ name: "list_accounts", description: "List customer accounts owned by the user." },
		{ name: "get_invoice", description: "Fetch one invoice by number, with amounts and due date." },
	);
	const skill: Skill = {
		name: "accounts",
		description: "Use for questions about customer accounts.",
		tools: ["crm:list_accounts"],
		keywords: ["account"],
		body: "Call crm_list_accounts, then summarize.",
	};

	it("starts with only meta-tools and offers a skill's tools after load_skill", async () => {
		const mcp = fakeMcpServer(crmTools);
		running = await startTestAgent({ mcp, skills: [skill] });
		expect(running.agent.catalog.size).toBe(122);
		running.faux.setResponses(
			recording(running.offered, [
				fauxAssistantMessage([fauxToolCall("load_skill", { name: "accounts" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("crm_list_accounts", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("You have two accounts.")]),
			]),
		);
		const sessionId = await createSession(running);
		const answer = await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "Show my accounts" });
		expect(answer.body.result).toMatchObject({ status: "done", text: "You have two accounts." });
		expect(running.offered[0]).toEqual(["load_skill", "search_tools"]);
		expect(running.offered[1]).toEqual(["load_skill", "search_tools", "crm_list_accounts"]);
		expect(mcp.calls).toEqual([{ name: "list_accounts", args: {} }]);
	});

	it("enables a loaded skill's tools once their server lists them", async () => {
		running = await startTestAgent({ skills: [skill] });
		running.faux.setResponses(
			recording(running.offered, [
				fauxAssistantMessage([fauxToolCall("load_skill", { name: "accounts" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("The account tools are down.")]),
				fauxAssistantMessage([fauxText("Now they work.")]),
			]),
		);
		const sessionId = await createSession(running);
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "Show my accounts" });
		expect(running.offered[1]).toEqual(["load_skill", "search_tools"]);

		running.agent.catalog.setServer("crm", [
			{ name: "crm_list_accounts", server: "crm", mcpName: "list_accounts", description: "List accounts.", inputSchema: { type: "object" } },
		]);
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "Try again" });
		expect(running.offered[2]).toEqual(["load_skill", "search_tools", "crm_list_accounts"]);
	});

	it("search_tools activates the best matches", async () => {
		const mcp = fakeMcpServer(crmTools);
		running = await startTestAgent({ mcp });
		running.faux.setResponses(
			recording(running.offered, [
				fauxAssistantMessage([fauxToolCall("search_tools", { query: "invoice due date", limit: 1 })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("Found it.")]),
			]),
		);
		const sessionId = await createSession(running);
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "When is invoice 42 due?" });
		expect(running.offered[1]).toEqual(["load_skill", "search_tools", "crm_get_invoice"]);
	});

	it("preloads matching tools before the first request for a voice session", async () => {
		const mcp = fakeMcpServer(crmTools);
		running = await startTestAgent({ mcp, skills: [skill] });
		running.faux.setResponses(recording(running.offered, [fauxAssistantMessage([fauxText("Sure.")])]));
		const sessionId = await createSession(running, "voice");
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "Which account renews next?" });
		expect(running.offered[0]).toContain("crm_list_accounts");
	});
});

describe("steering and interrupts", () => {
	it("places a steer after the current tool round", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const mcp = fakeMcpServer([{ name: "slow_lookup", description: "Slow lookup.", call: async () => (await gate, "looked up") }]);
		running = await startTestAgent({ mcp, config: { profiles: { chat: { model: "main", thinkingLevel: "off", alwaysOnTools: ["crm:slow_lookup"], maxActiveTools: 12, preload: { maxTools: 0, minScore: 4 }, speech: false, thinkingEvents: false } } } });
		const seen: string[][] = [];
		running.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("crm_slow_lookup", {})], { stopReason: "toolUse" }),
			(context) => {
				seen.push(context.messages.filter((message) => message.role === "user").map((message) => String(message.content)));
				return fauxAssistantMessage([fauxText("Using the EU account.")]);
			},
		]);
		const sessionId = await createSession(running);
		const prompt = rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "Look up my account" });
		await waitFor(() => mcp.calls.length === 1);
		const steer = await rpc(running.url, TOKENS.alice, "session.steer", { sessionId, input: "Use the EU account" });
		expect(steer.body.result).toMatchObject({ placement: "queued" });
		release();
		expect((await prompt).body.result).toMatchObject({ status: "done", text: "Using the EU account." });
		expect(seen[0]).toEqual(["Look up my account", "Use the EU account"]);
	});

	it("interrupt aborts the speaking run and answers the new input", async () => {
		running = await startTestAgent({ tokensPerSecond: 20 });
		running.faux.setResponses([
			fauxAssistantMessage([fauxText("This is a very long answer that keeps going and going for quite a while longer.")]),
			fauxAssistantMessage([fauxText("Top three only.")]),
		]);
		const sessionId = await createSession(running, "voice");
		const first = rpcStream(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "Summarize everything" });
		await waitFor(async () => (await rpc(running!.url, TOKENS.alice, "session.get", { sessionId })).body.result!.busy === true);
		const interrupted = await rpc(running.url, TOKENS.alice, "session.interrupt", { sessionId, input: "No, top three only" });
		expect(interrupted.body.result).toMatchObject({ status: "done", text: "Top three only." });
		const firstResult = (await first).messages.at(-1)!.data.result;
		expect(firstResult).toMatchObject({ status: "unanswered", reason: "aborted" });
	});

	it("a retried interrupt does not abort the run its first attempt started", async () => {
		running = await startTestAgent({ tokensPerSecond: 20 });
		running.faux.setResponses([
			fauxAssistantMessage([fauxText("This is a very long answer that keeps going and going for quite a while longer.")]),
			fauxAssistantMessage([fauxText("Top three only, and this answer takes a moment to speak.")]),
		]);
		const sessionId = await createSession(running, "voice");
		void rpcStream(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "Summarize everything" });
		await waitFor(async () => (await rpc(running!.url, TOKENS.alice, "session.get", { sessionId })).body.result!.busy === true);
		const params = { sessionId, input: "No, top three only", requestId: "barge-1" };
		const first = await rpc(running.url, TOKENS.alice, "session.interrupt", { ...params, wait: false });
		expect(first.status).toBe(200);
		// The client lost the first response and retries while the interrupt's answer is still streaming.
		const retried = await rpc(running.url, TOKENS.alice, "session.interrupt", params);
		expect(retried.body.result).toMatchObject({
			submissionId: first.body.result!.submissionId,
			status: "done",
			text: "Top three only, and this answer takes a moment to speak.",
		});
		expect(running.faux.state.callCount).toBe(2);
	});
});

describe("event stream", () => {
	it("resumes with Last-Event-ID from the buffer", async () => {
		running = await startTestAgent();
		running.faux.setResponses([fauxAssistantMessage([fauxText("one")]), fauxAssistantMessage([fauxText("two")])]);
		const sessionId = await createSession(running);
		const first = await rpcStream(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "1" });
		const lastId = first.messages.filter((message) => message.id !== undefined).at(-1)!.id!;
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "2" });

		const controller = new AbortController();
		const response = await fetch(running.url, {
			headers: { accept: "text/event-stream", authorization: `Bearer ${TOKENS.alice}`, "agent-session-id": sessionId, "last-event-id": lastId },
			signal: controller.signal,
		});
		expect(response.status).toBe(200);
		const reader = response.body!.getReader();
		let text = "";
		while (!text.includes('"run.finished"')) text += new TextDecoder().decode((await reader.read()).value);
		controller.abort();
		expect(text).not.toContain('"snapshot"');
		expect(text).toContain('"text":"two"');
		expect(text).not.toContain('"text":"one"');
	});
});

describe("expert, credentials, restart", () => {
	it("consult_expert answers through a child conversation on the expert model", async () => {
		running = await startTestAgent({
			config: {
				profiles: {
					voice: {
						model: "main",
						thinkingLevel: "off",
						alwaysOnTools: [],
						maxActiveTools: 12,
						preload: { maxTools: 0, minScore: 4 },
						speech: true,
						thinkingEvents: false,
						expert: { model: "expert", thinkingLevel: "high" },
					},
				},
				defaultProfile: "voice",
			},
		});
		const reasoning: unknown[] = [];
		const step =
			(message: AssistantMessage): FauxResponseFactory =>
			(_context, options) => {
				reasoning.push(options?.reasoning);
				return message;
			};
		running.faux.setResponses([
			step(fauxAssistantMessage([fauxText("Let me think. "), fauxToolCall("consult_expert", { question: "Which plan is cheaper over 3 years?" })], { stopReason: "toolUse" })),
			step(fauxAssistantMessage([fauxText("Plan B, by 12 percent.")])),
			step(fauxAssistantMessage([fauxText("Plan B is cheaper.")])),
		]);
		const sessionId = await createSession(running);
		const { messages } = await rpcStream(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "Which plan?" });
		expect(messages.at(-1)!.data.result).toMatchObject({ status: "done", text: "Plan B is cheaper." });
		// The child ran on the expert's thinking level; the parent did not.
		expect(reasoning).toEqual([undefined, "high", undefined]);
		const bodies = events(messages);
		expect(bodies.find((body) => body.type === "speech")?.text).toBe("Let me think.");
		expect(bodies.some((body) => body.type === "tool.started" && body.name === "consult_expert")).toBe(true);
	});

	it("forwards the caller's bearer token to MCP servers with auth: forward", async () => {
		const mcp = fakeMcpServer([{ name: "whoami", description: "Who is calling." }]);
		const seen: Record<string, string>[] = [];
		running = await startTestAgent({
			config: {
				mcpServers: [{ name: "crm", transport: "http", url: "http://unused", headers: { "x-service": "agent" }, auth: "forward" }],
				profiles: { chat: { model: "main", thinkingLevel: "off", alwaysOnTools: ["crm:whoami"], maxActiveTools: 12, preload: { maxTools: 0, minScore: 4 }, speech: false, thinkingEvents: false } },
			},
			mcpTransport: (_config, headers) => {
				seen.push({ ...headers });
				return mcp.transport();
			},
		});
		running.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("crm_whoami", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const sessionId = await createSession(running);
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "who am I" });
		expect(mcp.calls).toEqual([{ name: "whoami", args: {} }]);
		// Listing used the service headers; the call used a connection carrying alice's token.
		expect(seen[0]).toEqual({ "x-service": "agent" });
		expect(seen[1]).toEqual({ "x-service": "agent", Authorization: `Bearer ${TOKENS.alice}` });
	});

	it("keeps sessions and the instance id across a restart on SQLite", async () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-restart-"));
		const config = { storage: { kind: "sqlite" as const, path: join(dir, "agent.sqlite") }, instanceId: undefined };
		running = await startTestAgent({ config, configStorage: true });
		running.faux.setResponses([fauxAssistantMessage([fauxText("first")])]);
		const sessionId = await createSession(running);
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "1" });
		await running.close();

		running = await startTestAgent({ config, configStorage: true });
		expect(sessionId.startsWith(`${running.agent.instanceId}.`)).toBe(true);
		running.faux.setResponses([fauxAssistantMessage([fauxText("second")])]);
		const answer = await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "2" });
		expect(answer.body.result).toMatchObject({ status: "done", text: "second" });
	});
});
