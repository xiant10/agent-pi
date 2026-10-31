import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { afterEach, describe, expect, it } from "vitest";
import { Services } from "../src/plugins/services.ts";
import { loadConfig } from "../src/config.ts";
import type { AppConfig } from "../src/config.ts";
import { fakeMcpServer, fauxAssistantMessage, fauxText, fauxToolCall, rpc, startTestAgent, type TestAgent, testConfig, TOKENS } from "../src/testing.ts";

let running: TestAgent | undefined;

afterEach(async () => {
	await running?.close();
	running = undefined;
});

const RESEARCH: AppConfig["subagents"] = {
	research: { description: "Research a question.", model: "expert", thinkingLevel: "high", instructions: "You research.", tools: ["crm:*"] },
};

const chat = (overrides: object = {}) => ({ ...testConfig().profiles.chat!, alwaysOnTools: ["agent_research"], ...overrides });

async function createSession(agent: TestAgent, params: Record<string, unknown> = {}): Promise<string> {
	return (await rpc(agent.url, TOKENS.alice, "session.create", params)).body.result!.sessionId as string;
}

const getCurrentContext = (context: { readonly messages: Parameters<typeof getCurrentTools>[0] }) => context;

const toolResult = (context: { messages: readonly unknown[] }) => JSON.stringify(context.messages.at(-1));

describe("sub-agents", () => {
	it("runs a declared agent as a catalog tool, with its own model, instructions, and tools", async () => {
		const mcp = fakeMcpServer([{ name: "lookup", description: "Look up a record." }, { name: "update", description: "Change a record." }]);
		running = await startTestAgent({
			mcp,
			config: {
				subagents: { research: { ...RESEARCH.research!, tools: ["crm:lookup"] } },
				profiles: { chat: chat() },
			},
		});
		const reasoning: unknown[] = [];
		let childTools: string[] = [];
		let childPrompt: string | undefined;
		running.faux.setResponses([
			(_context, options) => {
				reasoning.push(options?.reasoning);
				return fauxAssistantMessage([fauxToolCall("agent_research", { task: "Find the account." })], { stopReason: "toolUse" });
			},
			(context, options) => {
				reasoning.push(options?.reasoning);
				childTools = getCurrentTools(context.messages).map((tool) => tool.name);
				childPrompt = getCurrentSystemPrompt(context.messages);
				return fauxAssistantMessage([fauxText("Acme, 40 seats.")]);
			},
			(_context, options) => {
				reasoning.push(options?.reasoning);
				return fauxAssistantMessage([fauxText("It is Acme.")]);
			},
		]);
		const sessionId = await createSession(running);
		const answer = await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "Which account?" });
		expect(answer.body.result).toMatchObject({ status: "done", text: "It is Acme." });
		expect(reasoning).toEqual([undefined, "high", undefined]);
		expect(childTools).toEqual(["crm_lookup"]);
		expect(childPrompt).toContain("You research.");
	});

	it("gives a child no tools unless it declares some", async () => {
		running = await startTestAgent({ config: { subagents: { research: { ...RESEARCH.research!, tools: [] } }, profiles: { chat: chat() } } });
		let childTools: string[] | undefined;
		running.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("agent_research", { task: "go" })], { stopReason: "toolUse" }),
			(context) => {
				childTools = getCurrentTools(context.messages).map((tool) => tool.name);
				return fauxAssistantMessage([fauxText("done")]);
			},
			fauxAssistantMessage([fauxText("ok")]),
		]);
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId: await createSession(running), input: "go" });
		expect(childTools).toEqual([]);
	});

	it("lets the owner read a child, but nobody drive it", async () => {
		running = await startTestAgent({ config: { subagents: RESEARCH, profiles: { chat: chat() } } });
		running.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("agent_research", { task: "go" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("found")]),
			fauxAssistantMessage([fauxText("ok")]),
		]);
		const sessionId = await createSession(running);
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "go" });

		const parent = (await rpc(running.url, TOKENS.alice, "session.get", { sessionId })).body.result!;
		const [child] = parent.subagents as string[];
		expect(child).toBeDefined();
		expect((await rpc(running.url, TOKENS.alice, "session.get", { sessionId: child })).body.result).toMatchObject({ parent: sessionId, busy: false });
		for (const method of ["session.prompt", "session.steer", "session.cancel", "session.close"]) {
			expect((await rpc(running.url, TOKENS.alice, method, { sessionId: child, input: "x" })).status).toBe(404);
		}
		expect((await rpc(running.url, TOKENS.bob, "session.get", { sessionId: child })).status).toBe(404);
		const open = (token: string) =>
			fetch(running!.url, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream", "agent-session-id": child! } });
		const stream = await open(TOKENS.alice);
		expect(stream.status).toBe(200);
		const first = new TextDecoder().decode((await stream.body!.getReader().read()).value);
		expect(first).toContain('"type":"snapshot"');
		await stream.body?.cancel().catch(() => undefined);
		expect((await open(TOKENS.bob)).status).toBe(404);
		const listed = (await rpc(running.url, TOKENS.alice, "session.list")).body.result!.sessions as { sessionId: string }[];
		expect(listed.map((session) => session.sessionId)).toEqual([sessionId]);

		await rpc(running.url, TOKENS.alice, "session.close", { sessionId });
		expect((await rpc(running.url, TOKENS.alice, "session.get", { sessionId: child })).status).toBe(404);
	});

	it("reports a child's spend in the parent's usage, under the tool", async () => {
		running = await startTestAgent({ config: { subagents: RESEARCH, profiles: { chat: chat() } } });
		running.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("agent_research", { task: "go" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("found it after a long look")]),
			fauxAssistantMessage([fauxText("ok")]),
		]);
		const sessionId = await createSession(running);
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "go" });
		const parent = (await rpc(running.url, TOKENS.alice, "session.get", { sessionId })).body.result!;
		const usage = parent.usage as { tools: Record<string, { output: number }> };
		const child = (await rpc(running.url, TOKENS.alice, "session.get", { sessionId: (parent.subagents as string[])[0] })).body.result!;
		const spent = Object.values((child.usage as { models: Record<string, { output: number }> }).models)[0]!;
		expect(spent.output).toBeGreaterThan(0);
		expect(usage.tools.agent_research!.output).toBe(spent.output);
	});

	it("refuses to delegate from a child, even when search activates the tool there", async () => {
		running = await startTestAgent({
			config: { subagents: { research: { ...RESEARCH.research!, tools: ["search_tools"] } }, profiles: { chat: chat() } },
		});
		let refusal = "";
		running.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("agent_research", { task: "go" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("search_tools", { query: "research a question" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("agent_research", { task: "deeper" })], { stopReason: "toolUse" }),
			(context) => {
				refusal = toolResult(context);
				return fauxAssistantMessage([fauxText("could not go deeper")]);
			},
			fauxAssistantMessage([fauxText("ok")]),
		]);
		const sessionId = await createSession(running);
		const answer = await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "go" });
		expect(answer.body.result).toMatchObject({ status: "done", text: "ok" });
		expect(refusal).toContain("cannot delegate");
	});

	it("caps the children running at once, and frees the slot afterwards", async () => {
		running = await startTestAgent({
			config: {
				subagents: RESEARCH,
				profiles: { chat: chat() },
				limits: { ...testConfig().limits, maxSubagentsPerSession: 1 },
			},
		});
		let results = "";
		running.faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("agent_research", { task: "one" }), fauxToolCall("agent_research", { task: "two" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("found")]),
			(context) => {
				results = JSON.stringify(context.messages.slice(-2));
				return fauxAssistantMessage([fauxToolCall("agent_research", { task: "three" })], { stopReason: "toolUse" });
			},
			fauxAssistantMessage([fauxText("found again")]),
			fauxAssistantMessage([fauxText("ok")]),
		]);
		const sessionId = await createSession(running);
		const answer = await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "go" });
		expect(answer.body.result).toMatchObject({ status: "done", text: "ok" });
		expect(results).toContain("Too many research agents");
		expect(results).toContain("found");
		expect((await rpc(running.url, TOKENS.alice, "session.get", { sessionId })).body.result!.subagents).toHaveLength(2);
	});

	it("aborts a child that runs out of time and tells the caller", async () => {
		running = await startTestAgent({
			tokensPerSecond: 10,
			config: { subagents: { research: { ...RESEARCH.research!, timeoutMs: 100 } }, profiles: { chat: chat() } },
		});
		let result = "";
		running.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("agent_research", { task: "go" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("a very long answer ".repeat(100))]),
			(context) => {
				result = toolResult(context);
				return fauxAssistantMessage([fauxText("it took too long")]);
			},
		]);
		const answer = await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId: await createSession(running), input: "go" });
		expect(answer.body.result).toMatchObject({ status: "done", text: "it took too long" });
		expect(result).toContain("ran out of time");
	});

	it("keeps a voice profile's instructions out of a consulted expert", async () => {
		running = await startTestAgent({
			config: {
				defaultProfile: "chat",
				profiles: {
					chat: testConfig().profiles.chat!,
					voice: { ...testConfig().profiles.chat!, instructions: "Speak in short sentences.", speech: true, expert: { model: "expert", thinkingLevel: "high" } },
				},
			},
		});
		const prompts: (string | undefined)[] = [];
		const record = (text: Parameters<typeof fauxAssistantMessage>[0], stopReason?: "toolUse") => (context: Parameters<typeof getCurrentContext>[0]) => {
			prompts.push(getCurrentSystemPrompt(context.messages));
			return fauxAssistantMessage(text, stopReason === undefined ? {} : { stopReason });
		};
		running.faux.setResponses([
			record([fauxToolCall("consult_expert", { question: "why?" })], "toolUse"),
			record([fauxText("because")]),
			record([fauxText("That's why.")]),
		]);
		const sessionId = await createSession(running, { profile: "voice" });
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "why?" });
		expect(prompts[0]).toContain("Speak in short sentences.");
		expect(prompts[1]).not.toContain("Speak in short sentences.");
		expect(prompts[2]).toContain("Speak in short sentences.");
		const parent = (await rpc(running.url, TOKENS.alice, "session.get", { sessionId })).body.result!;
		expect((parent.subagents as string[])).toHaveLength(1);
	});

	it("uses the parent's profile for a child's tool policy", async () => {
		const mcp = fakeMcpServer([{ name: "one", description: "First record tool." }, { name: "two", description: "Second record tool." }]);
		running = await startTestAgent({
			mcp,
			config: {
				subagents: { research: { ...RESEARCH.research!, tools: ["search_tools"] } },
				defaultProfile: "chat",
				profiles: {
					chat: testConfig().profiles.chat!,
					small: chat({ maxActiveTools: 3 }),
				},
			},
		});
		let offered: string[] = [];
		running.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("agent_research", { task: "go" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("search_tools", { query: "first record", limit: 1 })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("search_tools", { query: "second record", limit: 1 })], { stopReason: "toolUse" }),
			(context) => {
				offered = getCurrentTools(context.messages).map((tool) => tool.name);
				return fauxAssistantMessage([fauxText("done")]);
			},
			fauxAssistantMessage([fauxText("ok")]),
		]);
		const sessionId = await createSession(running, { profile: "small" });
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "go" });
		// `small` pins three tools, so the second search evicts the first's. The default profile would keep both.
		expect(offered).toEqual(["search_tools", "crm_two"]);
	});

	it("makes a child's model calls for its parent's session and turn", async () => {
		running = await startTestAgent({ config: { subagents: RESEARCH, profiles: { chat: chat() } } });
		let provider: string | undefined;
		running.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("agent_research", { task: "go" })], { stopReason: "toolUse" }),
			(_context, options) => {
				provider = options?.sessionId;
				return fauxAssistantMessage([fauxText("found")]);
			},
			fauxAssistantMessage([fauxText("ok")]),
		]);
		const sessionId = await createSession(running);
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "go", turnId: "turn-7" });
		const identity = await running.agent.container.get(Services.identity);
		expect(identity.get(provider)).toMatchObject({ sessionId, turnId: "turn-7", userId: "alice" });
	});

	it("will not start with a server of the reserved name, or an unknown model", async () => {
		await expect(startTestAgent({ config: { mcpServers: [{ name: "agents", transport: "stdio", command: "unused" }] } })).rejects.toThrow("reserved");
		await expect(startTestAgent({ config: { subagents: { research: { ...RESEARCH.research!, model: "nope" } } } })).rejects.toThrow("nope");
	});
});

describe("sub-agent config", () => {
	const write = (subagents: unknown) => {
		const dir = mkdtempSync(join(tmpdir(), "agent-subagents-"));
		writeFileSync(join(dir, "research.md"), "You research.");
		const path = join(dir, "agent.json");
		writeFileSync(
			path,
			JSON.stringify({
				agent: "test",
				auth: { kind: "static", tokens: "a=b" },
				models: { smart: { provider: "anthropic", modelId: "m" } },
				profiles: { chat: { model: "smart" } },
				subagents,
			}),
		);
		return path;
	};

	it("reads a sub-agent and its defaults", () => {
		const config = loadConfig(write({ research: { description: "Research.", model: "smart", instructionsFile: "research.md", tools: ["crm:*"] } }));
		expect(config.subagents.research).toEqual({ description: "Research.", model: "smart", thinkingLevel: "off", instructions: "You research.", tools: ["crm:*"] });
		expect(config.limits.maxSubagentsPerSession).toBe(3);
	});

	it("names the field at fault", () => {
		expect(() => loadConfig(write({ research: { description: "Research.", model: "other" } }))).toThrow("subagents.research.model");
		expect(() => loadConfig(write({ research: { model: "smart" } }))).toThrow("subagents.research.description");
		expect(() => loadConfig(write({ "Bad Name": { description: "x", model: "smart" } }))).toThrow("name must match");
	});
});
