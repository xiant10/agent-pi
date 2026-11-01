import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import type { Authenticator } from "../src/auth/authenticator.ts";
import { EventMapper } from "../src/events/mapper.ts";
import { events, fakeMcpServer, parseSse, rpc, rpcStream, startTestAgent, type TestAgent, TOKENS, waitFor } from "../src/testing.ts";

let running: TestAgent | undefined;
afterEach(async () => {
	await running?.close();
	running = undefined;
});

const start = { type: "message_start", message: { role: "assistant", content: [] } } as never;
const delta = (text: string) => ({ type: "message_update", changes: [{ type: "text_delta", contentIndex: 0, delta: text }] }) as never;
const end = (text: string) => ({ type: "message_end", entry: { model: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }] } }) as never;

describe("EventMapper update frames", () => {
	it("gives each delta its turn, message and offset", () => {
		const mapper = new EventMapper({ speech: false, thinking: false });
		mapper.setTurn("t1");
		const [first] = [mapper.map(start), mapper.map(delta("Hel"))][1]!;
		const [second] = mapper.map(delta("lo"));
		expect(first).toMatchObject({ type: "text.delta", turnId: "t1", offset: 0, text: "Hel" });
		expect(second).toMatchObject({ type: "text.delta", turnId: "t1", offset: 3, text: "lo" });
		expect((first as { messageId: string }).messageId).toBe((second as { messageId: string }).messageId);
	});

	it("reports the reply in progress until it ends", () => {
		const mapper = new EventMapper({ speech: false, thinking: false });
		expect(mapper.partial).toBeUndefined();
		mapper.setTurn("t1");
		mapper.map(start);
		mapper.map(delta("Hello"));
		expect(mapper.partial).toMatchObject({ turnId: "t1", text: "Hello" });
		mapper.map(end("Hello"));
		expect(mapper.partial).toBeUndefined();
	});

	it("keeps one id for a message with no start, and no turn from the one before", () => {
		const mapper = new EventMapper({ speech: false, thinking: false });
		mapper.setTurn("t1");
		mapper.map(start);
		mapper.map(end("first"));
		const [text, ended] = mapper.map(end("from a plugin"));
		expect((text as { messageId: string }).messageId).toBe((ended as { messageId: string }).messageId);
		expect(text).not.toHaveProperty("turnId");
	});

	it("carries a resynced partial on the snapshot under the same id", () => {
		const mapper = new EventMapper({ speech: false, thinking: false });
		mapper.map(start);
		mapper.map(delta("Hi"));
		const { messageId } = mapper.partial!;
		const snapshot = mapper.seed({ inbox: [], agent: {}, run: { inputs: [] }, generation: { attempt: 1, message: { content: [{ type: "text", text: "Hi there" }] } } } as never);
		expect(snapshot).toMatchObject({ type: "snapshot", partial: { messageId, text: "Hi there" } });
	});
});

describe("conversation stream", () => {
	it("marks a run's text with the prompt's turn", async () => {
		running = await startTestAgent({ responses: [() => fauxAssistantMessage([fauxText("hello")])] });
		const created = await rpc(running.url, TOKENS.alice, "session.create");
		const sessionId = created.body.result!.sessionId as string;
		const stream = await rpcStream(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "hi", turnId: "turn-1" });
		const all = events(stream.messages);
		const text = all.filter((event) => event.type === "text.delta");
		expect(text.length).toBeGreaterThan(0);
		expect(text[0]).toMatchObject({ turnId: "turn-1", offset: 0 });
		expect(all.find((event) => event.type === "message.end")).toMatchObject({ turnId: "turn-1", messageId: text[0]!.messageId });
	});

	it("moves a run's text to a steering message's turn", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const mcp = fakeMcpServer([{ name: "slow_lookup", description: "Slow lookup.", call: async () => (await gate, "looked up") }]);
		running = await startTestAgent({ mcp, config: { profiles: { chat: { model: "main", thinkingLevel: "off", alwaysOnTools: ["crm:slow_lookup"], maxActiveTools: 12, preload: { maxTools: 0, minScore: 4 }, speech: false, thinkingEvents: false, taskReports: "wake" } } } });
		running.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("crm_slow_lookup", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("after the steer")]),
		]);
		const sessionId = (await rpc(running.url, TOKENS.alice, "session.create")).body.result!.sessionId as string;
		const stream = rpcStream(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "hi", turnId: "first" });
		await waitFor(() => mcp.calls.length === 1);
		await rpc(running.url, TOKENS.alice, "session.steer", { sessionId, input: "also this", turnId: "second" });
		release();
		const ended = events((await stream).messages).filter((event) => event.type === "message.end");
		expect(ended.map((event) => event.turnId)).toEqual(["first", "second"]);
	});

	it("ends a GET stream when its token expires", async () => {
		const authenticator: Authenticator = {
			authenticate: async () => ({ userId: "alice", scopes: [], claims: {}, token: "t", expiresAt: Date.now() + 200 }),
		};
		running = await startTestAgent({ authenticator });
		const created = await rpc(running.url, "t", "session.create");
		const sessionId = created.body.result!.sessionId as string;
		const started = Date.now();
		const response = await fetch(running.url, { headers: { accept: "text/event-stream", authorization: "Bearer t", "agent-session-id": sessionId } });
		const body = await response.text();
		expect(parseSse(body).length).toBeGreaterThan(0);
		// Inside the verifier's leeway the stream still lasts a moment, so a reconnect can't spin.
		expect(Date.now() - started).toBeGreaterThanOrEqual(900);
	});
});
