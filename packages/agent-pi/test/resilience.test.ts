import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { defineTool, definePlugin } from "../src/index.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall, rpc, startTestAgent, type TestAgent, testConfig, TOKENS, waitFor } from "../src/testing.ts";

let running: TestAgent | undefined;
const stopped: TestAgent[] = [];

afterEach(async () => {
	await running?.close();
	running = undefined;
	await Promise.all(stopped.splice(0).map((agent) => agent.close()));
});

async function createSession(agent: TestAgent): Promise<string> {
	return (await rpc(agent.url, TOKENS.alice, "session.create")).body.result!.sessionId as string;
}

/** What a process killed right now leaves on disk: the live database copied mid-run, with its running tasks. */
function crashImage(path: string): string {
	const image = join(mkdtempSync(join(tmpdir(), "agent-crash-")), "agent.sqlite");
	const database = new DatabaseSync(path);
	database.exec(`VACUUM INTO '${image}'`);
	database.close();
	return image;
}

const sessionField = async (agent: TestAgent, sessionId: string, field: string) =>
	(await rpc(agent.url, TOKENS.alice, "session.get", { sessionId })).body.result![field];

describe("crash-loop guard", () => {
	it("shows a parked task and runs it again on session.retry", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		let started = 0;
		const slow = defineTool({
			name: "slow",
			description: "Slow.",
			parameters: Type.Object({}),
			replay: "safe",
			execute: async () => {
				started++;
				if (started === 1) await gate;
				return { output: [{ type: "text", text: "done" }] };
			},
		});
		const plugin = definePlugin({
			name: "slow",
			tools: [slow],
			beforePrompt: () => ({ activateTools: ["slow:slow"] }),
		});
		const path = join(mkdtempSync(join(tmpdir(), "agent-parked-")), "agent.sqlite");
		const config = { storage: { kind: "sqlite" as const, path }, instanceId: "crash", durable: { ...testConfig().durable, restartLimit: 1 } };

		const first = await startTestAgent({ config, configStorage: true, plugins: [plugin] });
		stopped.push(first);
		first.faux.setResponses([fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("unused")])]);
		const sessionId = await createSession(first);
		const inFlight = rpc(first.url, TOKENS.alice, "session.prompt", { sessionId, input: "go" }).catch(() => undefined);
		await waitFor(() => started === 1);
		const image = crashImage(path);
		release();
		await inFlight;

		running = await startTestAgent({ config: { ...config, storage: { kind: "sqlite", path: image } }, configStorage: true, plugins: [plugin] });
		expect(await sessionField(running, sessionId, "parked")).toBe(1);
		expect(await sessionField(running, sessionId, "busy")).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(started).toBe(1);

		const asBob = await rpc(running.url, TOKENS.bob, "session.retry", { sessionId });
		expect(asBob.status).toBe(404);
		expect(started).toBe(1);

		running.faux.setResponses([fauxAssistantMessage([fauxText("recovered")])]);
		const retried = await rpc(running.url, TOKENS.alice, "session.retry", { sessionId });
		expect(retried.body.result).toEqual({ retried: 1 });
		await waitFor(async () => (await sessionField(running!, sessionId, "busy")) === false);
		expect(started).toBe(2);
		expect(await sessionField(running, sessionId, "parked")).toBe(0);
		expect((await rpc(running.url, TOKENS.alice, "session.retry", { sessionId })).body.result).toEqual({ retried: 0 });
	});

	it.each(["session.cancel", "session.interrupt"])("%s gives up on a parked task", async (method) => {
		const never = new Promise<void>(() => {});
		const stuck = defineTool({ name: "stuck", description: "Stuck.", parameters: Type.Object({}), replay: "safe", execute: async () => (await never, {}) });
		const plugin = definePlugin({ name: "stuck", tools: [stuck], beforePrompt: () => ({ activateTools: ["stuck:stuck"] }) });
		const path = join(mkdtempSync(join(tmpdir(), "agent-parked-")), "agent.sqlite");
		const config = { storage: { kind: "sqlite" as const, path }, instanceId: "crash", durable: { ...testConfig().durable, restartLimit: 1 } };
		const first = await startTestAgent({ config, configStorage: true, plugins: [plugin] });
		first.faux.setResponses([fauxAssistantMessage([fauxToolCall("stuck", {})], { stopReason: "toolUse" })]);
		const sessionId = await createSession(first);
		void rpc(first.url, TOKENS.alice, "session.prompt", { sessionId, input: "go" }).catch(() => undefined);
		await waitFor(async () => (await rpc(first.url, TOKENS.alice, "session.get", { sessionId })).body.result!.busy === true);
		await new Promise((resolve) => setTimeout(resolve, 200));
		const image = crashImage(path);
		void first.close().catch(() => undefined);

		running = await startTestAgent({ config: { ...config, storage: { kind: "sqlite", path: image } }, configStorage: true, plugins: [plugin] });
		expect(await sessionField(running, sessionId, "parked")).toBe(1);
		running.faux.setResponses([fauxAssistantMessage([fauxText("moved on")])]);
		const answer = await rpc(running.url, TOKENS.alice, method, { sessionId, input: "next" });
		expect(answer.status).toBe(200);
		await waitFor(async () => (await sessionField(running!, sessionId, "busy")) === false);
		expect(await sessionField(running, sessionId, "parked")).toBe(0);
		if (method === "session.interrupt") expect(answer.body.result).toMatchObject({ status: "done", text: "moved on" });
	});

	it("counts a task parked in the child conversation of a consulted expert", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "agent-parked-")), "agent.sqlite");
		const base = testConfig();
		const config = {
			storage: { kind: "sqlite" as const, path },
			instanceId: "crash",
			durable: { ...base.durable, restartLimit: 1 },
			profiles: { ...base.profiles, chat: { ...base.profiles.chat!, expert: { model: "expert", thinkingLevel: "high" as const } } },
		};
		const first = await startTestAgent({ config, configStorage: true, tokensPerSecond: 10 });
		stopped.push(first);
		let childStarted = false;
		first.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("consult_expert", { question: "why?" })], { stopReason: "toolUse" }),
			() => {
				childStarted = true;
				return fauxAssistantMessage([fauxText("a long expert answer ".repeat(50))]);
			},
		]);
		const sessionId = await createSession(first);
		void rpc(first.url, TOKENS.alice, "session.prompt", { sessionId, input: "go" }).catch(() => undefined);
		await waitFor(() => childStarted);
		await new Promise((resolve) => setTimeout(resolve, 200));
		const image = crashImage(path);

		running = await startTestAgent({ config: { ...config, storage: { kind: "sqlite", path: image } }, configStorage: true });
		const { tasks } = await running.agent.harness.inspect(BACKGROUND_CONTEXT);
		const parked = tasks.filter((task) => task.state.kind === "blocked");
		const conversations = new Set(parked.map((task) => task.record.conversationId));
		expect(conversations.size).toBeGreaterThan(1);
		expect(await sessionField(running, sessionId, "parked")).toBe(parked.length);
	});
});

describe("storage failure", () => {
	it("reports the failure and turns unready", async () => {
		const storage = new MemoryStorage();
		const commit = storage.commit.bind(storage);
		let broken = false;
		storage.commit = (...args: Parameters<typeof commit>) => (broken ? Promise.reject(new Error("disk full")) : commit(...args));
		running = await startTestAgent({ storage });
		const ready = () => fetch(new URL("/readyz", running!.url));
		expect((await ready()).status).toBe(200);
		const sessionId = await createSession(running);

		broken = true;
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "hi" });
		await expect(running.agent.failed).resolves.toMatchObject({ message: "disk full" });
		expect((await ready()).status).toBe(503);
	});
});
