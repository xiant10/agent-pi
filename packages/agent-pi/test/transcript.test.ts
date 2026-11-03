import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { guardrails } from "../src/plugins/library/guardrails.ts";
import { fakeMcpServer, rpc, startTestAgent, type TestAgent, testConfig, TOKENS, waitFor } from "../src/testing.ts";

let running: TestAgent | undefined;
afterEach(async () => {
	await running?.close();
	running = undefined;
});

type Line = { id: number; role: string; text?: string; turnId?: string; requestId?: string; name?: string; isError?: boolean; images?: number };
type Info = { sessionId: string; busy: boolean; lastActiveAt: number; archived?: boolean; metadata?: Record<string, unknown> };

const limits = (maxSessionsPerUser: number) => ({ ...testConfig().limits, maxSessionsPerUser });

async function create(agent: TestAgent): Promise<string> {
	return (await rpc(agent.url, TOKENS.alice, "session.create", {})).body.result!.sessionId as string;
}

async function list(agent: TestAgent, params: Record<string, unknown> = {}): Promise<{ sessions: Info[]; nextCursor?: string }> {
	return (await rpc(agent.url, TOKENS.alice, "session.list", params)).body.result as never;
}

describe("session.messages", () => {
	it("filters a turn's note as it does the input, so guardrails cover what reaches the model", async () => {
		running = await startTestAgent({ plugins: [guardrails] });
		const seen: string[] = [];
		running.faux.setResponses([
			(context) => {
				seen.push(JSON.stringify(context.messages.at(-1)?.content));
				return fauxAssistantMessage([fauxText("ok")]);
			},
		]);
		const sessionId = await create(running);
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "hi there", note: "the card is 4111 1111 1111 1111" });
		expect(seen[0]).toContain("[card number removed]");
		expect(seen[0]).not.toContain("4111");
	});

	it("gives a turn's note to the model and keeps it out of the transcript", async () => {
		running = await startTestAgent();
		const seen: unknown[] = [];
		running.faux.setResponses([
			(context) => {
				seen.push(context.messages.at(-1)?.content);
				return fauxAssistantMessage([fauxText("Short answer.")]);
			},
			(context) => {
				seen.push(context.messages.at(-1)?.content);
				return fauxAssistantMessage([fauxText("Shorter.")]);
			},
		]);
		const sessionId = await create(running);
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "How was the quarter?", note: "This reply is spoken." });
		await rpc(running.url, TOKENS.alice, "session.interrupt", { sessionId, input: "And the one before?", note: "They heard the first word." });

		expect(JSON.stringify(seen[0])).toContain("This reply is spoken.");
		expect(JSON.stringify(seen[0])).toContain("How was the quarter?");
		expect(JSON.stringify(seen[1])).toContain("They heard the first word.");
		const { messages } = (await rpc(running.url, TOKENS.alice, "session.messages", { sessionId })).body.result as { messages: Line[] };
		expect(messages.filter((line) => line.role === "user").map((line) => line.text)).toEqual(["How was the quarter?", "And the one before?"]);
	});

	it("shows a message that only looks like a note", async () => {
		running = await startTestAgent();
		running.faux.setResponses([fauxAssistantMessage([fauxText("Ok.")])]);
		const sessionId = await create(running);
		const typed = "<turn-note>nothing to hide</turn-note>\n\n";
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: typed });
		const { messages } = (await rpc(running.url, TOKENS.alice, "session.messages", { sessionId })).body.result as { messages: Line[] };
		expect(messages.find((line) => line.role === "user")?.text).toBe(typed);
	});

	it("reads a finished conversation back, with turns and requests", async () => {
		const mcp = fakeMcpServer([{ name: "lookup", description: "Look something up" }]);
		running = await startTestAgent({ mcp, config: { profiles: { chat: { ...testConfig().profiles.chat!, alwaysOnTools: ["crm:*"] } } } });
		running.faux.setResponses([
			fauxAssistantMessage([fauxText("Checking."), fauxToolCall("crm_lookup", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Found it.")]),
		]);
		const sessionId = await create(running);
		await waitFor(async () => {
			const { body } = await rpc(running!.url, TOKENS.alice, "session.get", { sessionId });
			return (body.result!.activeTools as string[]).includes("crm_lookup");
		}).catch(() => undefined);
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "Find it", requestId: "r1", turnId: "t1" });

		const { messages, nextCursor } = (await rpc(running.url, TOKENS.alice, "session.messages", { sessionId })).body.result as { messages: Line[]; nextCursor?: string };
		expect(nextCursor).toBeUndefined();
		expect(messages[0]).toMatchObject({ role: "user", text: "Find it", turnId: "t1", requestId: "r1" });
		expect(messages.at(-1)).toMatchObject({ role: "assistant", text: "Found it." });
		const tool = messages.find((line) => line.role === "tool") as Line & { callId: string };
		expect(tool).toBeDefined();
		expect(tool).not.toHaveProperty("response");
		const payload = await rpc(running.url, TOKENS.alice, "session.tool", { sessionId, callId: tool.callId });
		expect(payload.body.result).toMatchObject({
			request: { type: "toolCall", id: tool.callId, name: "crm_lookup", arguments: {} },
			response: { role: "toolResult", toolCallId: tool.callId, content: [{ type: "text", text: "ok lookup" }] },
		});
		expect((await rpc(running.url, TOKENS.bob, "session.tool", { sessionId, callId: tool.callId })).status).toBe(404);
		expect((await rpc(running.url, TOKENS.alice, "session.tool", { sessionId, callId: "missing" })).status).toBe(404);
		expect((await rpc(running.url, TOKENS.alice, "session.tool", { sessionId, callId: "" })).status).toBe(400);
		await rpc(running.url, TOKENS.alice, "session.update", { sessionId, archived: true });
		expect((await rpc(running.url, TOKENS.alice, "session.tool", { sessionId, callId: tool.callId })).body.result).toEqual(payload.body.result);

	});

	it("pages from the newest, and each page runs oldest first", async () => {
		running = await startTestAgent();
		running.faux.setResponses(["one", "two", "three"].map((text) => fauxAssistantMessage([fauxText(text)])));
		const sessionId = await create(running);
		for (const input of ["a", "b", "c"]) await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input });

		const first = (await rpc(running.url, TOKENS.alice, "session.messages", { sessionId, limit: 2 })).body.result as { messages: Line[]; nextCursor: string };
		expect(first.messages.map((line) => line.text)).toEqual(["c", "three"]);
		const second = (await rpc(running.url, TOKENS.alice, "session.messages", { sessionId, limit: 200, cursor: first.nextCursor })).body.result as { messages: Line[]; nextCursor?: string };
		expect(second.messages.map((line) => line.text)).toEqual(["a", "one", "b", "two"]);
		expect(second.nextCursor).toBeUndefined();
	});

	it("counts images and leaves their data out", async () => {
		running = await startTestAgent();
		running.faux.setResponses([fauxAssistantMessage([fauxText("A cat.")])]);
		const sessionId = await create(running);
		const input = [{ type: "text", text: "What is this?" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }];
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input });
		const { messages } = (await rpc(running.url, TOKENS.alice, "session.messages", { sessionId })).body.result as { messages: Line[] };
		expect(messages[0]).toMatchObject({ role: "user", text: "What is this?", images: 1 });
		expect(JSON.stringify(messages)).not.toContain("aGVsbG8=");
	});

	it("hides another user's transcript", async () => {
		running = await startTestAgent();
		const sessionId = await create(running);
		expect((await rpc(running.url, TOKENS.bob, "session.messages", { sessionId })).status).toBe(404);
	});
});

describe("session.list", () => {
	it("sorts by activity, reports busy and pages", async () => {
		running = await startTestAgent({ tokensPerSecond: 5 });
		const [older, newer] = [await create(running), await create(running)];
		expect((await list(running)).sessions.map((s) => s.sessionId)).toEqual([newer, older]);

		running.faux.setResponses([fauxAssistantMessage([fauxText("a slow answer that takes a while to finish")])]);
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId: older, input: "hi", wait: false });
		const page = await list(running, { limit: 1 });
		expect(page.sessions.map((s) => s.sessionId)).toEqual([older]);
		expect(page.sessions[0]!.busy).toBe(true);
		expect(page.sessions[0]!.lastActiveAt).toBeGreaterThan(0);
		expect((await list(running, { limit: 1, cursor: page.nextCursor })).sessions.map((s) => s.sessionId)).toEqual([newer]);
		await rpc(running.url, TOKENS.alice, "session.cancel", { sessionId: older });
	});
});

describe("session.update", () => {
	it("sets a title and pin in metadata, keeping what was there", async () => {
		running = await startTestAgent();
		const created = await rpc(running.url, TOKENS.alice, "session.create", { metadata: { workItemId: "wi_1" } });
		const sessionId = created.body.result!.sessionId as string;
		const updated = await rpc(running.url, TOKENS.alice, "session.update", { sessionId, title: "Brief", pinned: true });
		expect(updated.body.result!.metadata).toEqual({ workItemId: "wi_1", title: "Brief", pinned: true });
		expect((await list(running)).sessions[0]!.metadata).toEqual({ workItemId: "wi_1", title: "Brief", pinned: true });
	});

	it("archiving frees the limit, keeps the transcript and refuses input until restored", async () => {
		running = await startTestAgent({ config: { limits: limits(1) } });
		running.faux.setResponses([fauxAssistantMessage([fauxText("Kept.")])]);
		const first = await create(running);
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId: first, input: "keep this" });
		expect((await rpc(running.url, TOKENS.alice, "session.create", {})).status).toBe(429);

		await rpc(running.url, TOKENS.alice, "session.update", { sessionId: first, archived: true });
		const second = await create(running);
		expect((await list(running)).sessions.map((s) => s.sessionId)).toEqual([second]);
		const archived = await list(running, { archived: true });
		expect(archived.sessions.map((s) => [s.sessionId, s.archived])).toEqual([[first, true]]);

		const lines = (await rpc(running.url, TOKENS.alice, "session.messages", { sessionId: first })).body.result!.messages as Line[];
		expect(lines.map((line) => line.text)).toEqual(["keep this", "Kept."]);
		expect((await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId: first, input: "more" })).status).toBe(409);

		expect((await rpc(running.url, TOKENS.alice, "session.update", { sessionId: first, archived: false })).status).toBe(429);
		await rpc(running.url, TOKENS.alice, "session.close", { sessionId: second });
		expect((await rpc(running.url, TOKENS.alice, "session.update", { sessionId: first, archived: false })).status).toBe(200);
		expect((await list(running)).sessions.map((s) => s.sessionId)).toEqual([first]);
	});

	it("closes an archived session", async () => {
		running = await startTestAgent();
		const sessionId = await create(running);
		await rpc(running.url, TOKENS.alice, "session.update", { sessionId, archived: true });
		await rpc(running.url, TOKENS.alice, "session.close", { sessionId });
		expect((await list(running, { archived: true })).sessions).toEqual([]);
	});
});

