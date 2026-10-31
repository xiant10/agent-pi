import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { InstanceDoc } from "../src/agent/docs.ts";
import { type AppConfig, loadConfig } from "../src/config.ts";
import { builtinPlugins } from "../src/plugins/library/index.ts";
import { definePlugin, type PluginCatalog } from "../src/plugins/types.ts";
import { rpc, startTestAgent, type TestAgent, testConfig, TOKENS } from "../src/testing.ts";

const running: TestAgent[] = [];
afterEach(async () => {
	await Promise.all(running.splice(0).map((agent) => agent.close()));
});

async function start(options: Parameters<typeof startTestAgent>[0]): Promise<TestAgent> {
	const agent = await startTestAgent(options);
	running.push(agent);
	return agent;
}

async function stop(agent: TestAgent): Promise<void> {
	running.splice(running.indexOf(agent), 1);
	await agent.close();
}

async function createSession(agent: TestAgent): Promise<string> {
	return (await rpc(agent.url, TOKENS.alice, "session.create")).body.result!.sessionId as string;
}

function sqlite(): Pick<AppConfig, "storage"> {
	return { storage: { kind: "sqlite", path: join(mkdtempSync(join(tmpdir(), "agent-multi-")), "agent.sqlite") } };
}

describe("agent identity", () => {
	it("keeps agents with one replica id apart: 421, never the other agent's conversation", async () => {
		const support = await start({ config: { agent: "support", instanceId: "agent-1" } });
		const sales = await start({ config: { agent: "sales", instanceId: "agent-1" } });
		const id = await createSession(support);
		expect(id).toMatch(/^support\.agent-1\.\d+$/);
		expect(await createSession(sales)).toMatch(/^sales\.agent-1\.\d+$/);

		const misrouted = await rpc(sales.url, TOKENS.alice, "session.prompt", { sessionId: id, input: "hello" });
		expect(misrouted.status).toBe(421);
		expect(misrouted.headers.get("agent-instance")).toBe("support.agent-1");
		expect(sales.faux.state.callCount).toBe(0);
	});

	it("refuses to open another agent's storage", async () => {
		const config = sqlite();
		await stop(await start({ configStorage: true, config: { ...config, agent: "support" } }));
		await expect(start({ configStorage: true, config: { ...config, agent: "sales" } })).rejects.toThrow(
			/storage belongs to agent support, not sales/,
		);
		// The refusal let go of the storage: its owner can still open it.
		await start({ configStorage: true, config: { ...config, agent: "support" } });
	});

	it("keeps serving session ids from before agents had names, on that storage only", async () => {
		const config = { ...sqlite(), instanceId: "agent-1" };
		const before = await start({ configStorage: true, config });
		const conversation = (await createSession(before)).split(".").at(-1)!;
		await before.agent.harness.commit(async (tx) => {
			const instance = await tx.doc(InstanceDoc);
			delete instance.agent;
			delete instance.legacyId;
		}, BACKGROUND_CONTEXT);
		await stop(before);

		const upgraded = await start({ configStorage: true, config });
		expect((await rpc(upgraded.url, TOKENS.alice, "session.get", { sessionId: `agent-1.${conversation}` })).status).toBe(200);
		expect((await rpc(upgraded.url, TOKENS.alice, "session.get", { sessionId: `other.${conversation}` })).status).toBe(421);

		const fresh = await start({ config: { instanceId: "agent-1" } });
		const legacy = `agent-1.${(await createSession(fresh)).split(".").at(-1)}`;
		expect((await rpc(fresh.url, TOKENS.alice, "session.get", { sessionId: legacy })).status).toBe(421);
	});
});

describe("storage ownership", () => {
	it("refuses a second process on one file, and frees it on close", async () => {
		const config = sqlite();
		const owner = await start({ configStorage: true, config });
		await expect(start({ configStorage: true, config })).rejects.toThrow(/is in use by another process/);
		await stop(owner);
		await start({ configStorage: true, config });
	});
});

describe("plugins chosen by config", () => {
	const named = (name: string) => () => definePlugin({ name, beforePrompt: () => ({ reply: `from ${name}` }) });
	const catalog: PluginCatalog = { one: named("one"), two: named("two") };

	it("runs what each agent's config selects, from one catalog, before plugins in code", async () => {
		const first = await start({ pluginCatalog: catalog, config: { plugins: [{ use: "one", options: {} }] } });
		const second = await start({
			pluginCatalog: catalog,
			config: { plugins: [{ use: "two", options: {} }] },
			plugins: [named("three")()],
		});
		const answer = async (agent: TestAgent) =>
			(await rpc(agent.url, TOKENS.alice, "session.prompt", { sessionId: await createSession(agent), input: "hello" })).body.result;
		expect(await answer(first)).toMatchObject({ answeredBy: "one" });
		expect(await answer(second)).toMatchObject({ answeredBy: "two" });
	});

	it("fails at startup on an unknown plugin or bad options, naming the entry", async () => {
		await expect(start({ pluginCatalog: catalog, config: { plugins: [{ use: "nope", options: {} }] } })).rejects.toThrow(
			/plugins\[0\]: unknown plugin "nope"; this runtime offers: one, two/,
		);
		await expect(start({ config: { plugins: [{ use: "toString", options: {} }] } })).rejects.toThrow(/unknown plugin "toString"/);
		await expect(start({ pluginCatalog: builtinPlugins, config: { plugins: [{ use: "clock", options: {} }] } })).rejects.toThrow(
			/plugins\[0\] \(clock\): option timeZone must be a non-empty string/,
		);
	});

	it("resolves plugin paths against the config file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-catalog-"));
		writeFileSync(join(dir, "faq.json"), JSON.stringify([{ patterns: ["hours"], answer: "Nine to five." }]));
		const options = { faqFile: "faq.json", assistantName: "Max" };
		const agent = await start({ pluginCatalog: builtinPlugins, config: { baseDir: dir, plugins: [{ use: "shortcuts", options }] } });
		const result = await rpc(agent.url, TOKENS.alice, "session.prompt", { sessionId: await createSession(agent), input: "your hours?" });
		expect(result.body.result).toMatchObject({ text: "Nine to five." });
	});
});

describe("loadConfig for several agents", () => {
	const base = { auth: { kind: "static", tokens: "{}" }, models: { main: { provider: "openai", modelId: "m" } }, profiles: { chat: { model: "main" } } };
	const load = (config: unknown) => {
		const path = join(mkdtempSync(join(tmpdir(), "agent-config-")), "agent.json");
		writeFileSync(path, JSON.stringify(config));
		return loadConfig(path);
	};

	it("requires a valid agent name", () => {
		expect(() => load(base)).toThrow(/agent must be a non-empty string/);
		expect(() => load({ ...base, agent: "Sales.EU" })).toThrow(/agent must match/);
	});

	it("gives each agent its own default storage file and reads plugin options", () => {
		const config = load({ ...base, agent: "sales", plugins: [{ use: "clock", options: { timeZone: "UTC" } }, { use: "audit" }] });
		expect(config.storage).toMatchObject({ kind: "sqlite", path: expect.stringMatching(/sales\.sqlite$/) });
		expect(config.plugins).toEqual([{ use: "clock", options: { timeZone: "UTC" } }, { use: "audit", options: {} }]);
		expect(testConfig().plugins).toEqual([]);
	});
});
