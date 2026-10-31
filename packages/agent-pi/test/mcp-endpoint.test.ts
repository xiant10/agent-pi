import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import { McpClient, type ProgressNotification, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { afterEach, describe, expect, it } from "vitest";
import { type AppConfig, loadConfig } from "../src/config.ts";
import { definePlugin } from "../src/index.ts";
import { Services } from "../src/plugins/services.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall, rpc, startTestAgent, type TestAgent, testConfig, TOKENS, waitFor } from "../src/testing.ts";

const TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

const agents: TestAgent[] = [];
const clients: McpClient[] = [];

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
	await Promise.all(agents.splice(0).map((agent) => agent.close()));
});

const ENDPOINT: NonNullable<AppConfig["mcpEndpoint"]> = {
	path: "/mcp",
	tools: [{ name: "ask_billing", description: "Ask the billing agent." }],
};

async function start(config: Partial<AppConfig> = {}, options: Parameters<typeof startTestAgent>[0] = {}): Promise<TestAgent> {
	const agent = await startTestAgent({ ...options, config: { mcpEndpoint: ENDPOINT, ...config } });
	agents.push(agent);
	return agent;
}

const mcpUrl = (agent: TestAgent) => agent.url.replace(/\/agent$/, "/mcp");

async function connect(agent: TestAgent, token: string = TOKENS.alice): Promise<McpClient> {
	const client = new McpClient({ name: "test", version: "1" });
	clients.push(client);
	await client.connect(new StreamableHttpTransport({ url: mcpUrl(agent), headers: { authorization: `Bearer ${token}` } }));
	return client;
}

const text = (result: { content?: unknown }) => JSON.stringify(result.content);

describe("MCP endpoint", () => {
	it("is off unless configured", async () => {
		const agent = await startTestAgent();
		agents.push(agent);
		const response = await fetch(mcpUrl(agent), { method: "POST", headers: { authorization: `Bearer ${TOKENS.alice}` } });
		expect(response.status).toBe(404);
	});

	it("needs a token before anything else", async () => {
		const agent = await start();
		const response = await fetch(mcpUrl(agent), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(response.status).toBe(401);
	});

	it("serves a real client: lists the declared tools and answers a call", async () => {
		const agent = await start();
		agent.faux.setResponses([fauxAssistantMessage([fauxText("You owe nothing.")])]);
		const client = await connect(agent);
		expect(client.serverInfo?.name).toBe("test");
		const tools = await client.listTools();
		expect(tools.map((tool) => tool.name)).toEqual(["ask_billing"]);
		expect(tools[0]!.inputSchema).toMatchObject({ required: ["task"] });
		await client.ping();
		const result = await client.callTool("ask_billing", { task: "What do I owe?" });
		expect(result.isError).toBeFalsy();
		expect(text(result)).toContain("You owe nothing.");
	});

	it("never offers the agent's inner tools", async () => {
		const agent = await start({ subagents: { research: { description: "Research.", model: "main", thinkingLevel: "off", tools: [] } } });
		const client = await connect(agent);
		expect((await client.listTools()).map((tool) => tool.name)).toEqual(["ask_billing"]);
	});

	it("leaves nothing in the owner's session list, and does not count toward it", async () => {
		const agent = await start({ limits: { ...testConfig().limits, maxSessionsPerUser: 1 } });
		await rpc(agent.url, TOKENS.alice, "session.create");
		agent.faux.setResponses([fauxAssistantMessage([fauxText("one")])]);
		const client = await connect(agent);
		expect((await client.callTool("ask_billing", { task: "go" })).isError).toBeFalsy();
		const { sessions } = (await rpc(agent.url, TOKENS.alice, "session.list")).body.result as { sessions: unknown[] };
		expect(sessions).toHaveLength(1);
	});

	it("runs a tool under its profile", async () => {
		const chat = testConfig().profiles.chat!;
		const agent = await start({
			profiles: { chat, careful: { ...chat, thinkingLevel: "high" } },
			mcpEndpoint: { path: "/mcp", tools: [{ name: "ask", description: "Ask.", profile: "careful" }] },
		});
		let reasoning: unknown;
		agent.faux.setResponses([
			(_context, options) => {
				reasoning = options?.reasoning;
				return fauxAssistantMessage([fauxText("ok")]);
			},
		]);
		await (await connect(agent)).callTool("ask", { task: "go" });
		expect(reasoning).toBe("high");
	});

	it("applies plugins, and returns a refusal for the calling model to read", async () => {
		const guard = definePlugin({ name: "guard", beforePrompt: (turn) => (turn.text.includes("forbidden") ? { reject: "not allowed here" } : undefined) });
		const agent = await start({}, { plugins: [guard] });
		const client = await connect(agent);
		const result = await client.callTool("ask_billing", { task: "something forbidden" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("not allowed here");
	});

	it("answers from a plugin without the model", async () => {
		const shortcut = definePlugin({ name: "shortcut", beforePrompt: () => ({ reply: "from the plugin" }) });
		const agent = await start({}, { plugins: [shortcut] });
		expect(text(await (await connect(agent)).callTool("ask_billing", { task: "hi" }))).toContain("from the plugin");
	});

	it("reports a concurrency limit as a tool error", async () => {
		const agent = await start({ limits: { ...testConfig().limits, maxConcurrentRunsPerUser: 1 } }, { tokensPerSecond: 20 });
		agent.faux.setResponses([fauxAssistantMessage([fauxText("long ".repeat(20))]), fauxAssistantMessage([fauxText("second")])]);
		const client = await connect(agent);
		const first = client.callTool("ask_billing", { task: "one" });
		await new Promise((resolve) => setTimeout(resolve, 100));
		const second = await client.callTool("ask_billing", { task: "two" });
		expect(second.isError).toBe(true);
		expect(text(second)).toContain("at most 1");
		expect((await first).isError).toBeFalsy();
	});

	it("refuses a bad task and an unknown tool differently", async () => {
		const agent = await start();
		const client = await connect(agent);
		expect((await client.callTool("ask_billing", {})).isError).toBe(true);
		await expect(client.callTool("nope", { task: "go" })).rejects.toThrow("unknown tool");
	});

	it("reports progress on tool starts and renews the caller's timeout", async () => {
		const agent = await start({ http: { ...testConfig().http, keepAliveMs: 40 } }, { tokensPerSecond: 40 });
		agent.faux.setResponses([fauxAssistantMessage([fauxText("slow ".repeat(30))])]);
		const client = await connect(agent);
		const seen: ProgressNotification[] = [];
		// Longer than the timeout in all, shorter between progress notifications.
		const result = await client.callTool("ask_billing", { task: "go" }, { timeoutMs: 300, onProgress: (progress) => seen.push(progress) });
		expect(result.isError).toBeFalsy();
		expect(seen.length).toBeGreaterThan(1);
		expect(seen.map((progress) => progress.progress)).toEqual(seen.map((_, index) => index + 1));
	});

	it("cancels the run when the client cancels, and only that client's call", async () => {
		const agent = await start({}, { tokensPerSecond: 10 });
		let started = 0;
		const slow = () => {
			started++;
			return fauxAssistantMessage([fauxText("long ".repeat(200))]);
		};
		agent.faux.setResponses([slow, slow]);
		const one = await connect(agent);
		const two = await connect(agent);
		const controller = new AbortController();
		// Both clients number this request the same.
		const cancelled = one.callTool("ask_billing", { task: "go" }, { signal: controller.signal }).catch((error: unknown) => error);
		const other = two.callTool("ask_billing", { task: "go" }, { timeoutMs: 20_000 }).then(() => "finished", () => "failed");
		await waitFor(() => started === 2);
		controller.abort();
		expect(String(await cancelled)).toMatch(/abort/i);
		const runs = () => agent.agent.harness.inspect(BACKGROUND).then(({ tasks }) => tasks.length);
		await waitFor(async () => (await runs()) <= 1);
		expect(await Promise.race([other, new Promise((resolve) => setTimeout(() => resolve("still running"), 100))])).toBe("still running");
	}, 10_000);

	it("stops the run when the client disconnects", async () => {
		const agent = await start({}, { tokensPerSecond: 10 });
		let started = false;
		agent.faux.setResponses([
			() => {
				started = true;
				return fauxAssistantMessage([fauxText("long ".repeat(200))]);
			},
		]);
		const controller = new AbortController();
		const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKENS.alice}` };
		const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_billing", arguments: { task: "go" } } });
		void fetch(mcpUrl(agent), { method: "POST", headers, body, signal: controller.signal }).catch(() => undefined);
		await waitFor(() => started);
		controller.abort();
		await waitFor(async () => (await agent.agent.harness.inspect(BACKGROUND)).tasks.length === 0);
	});

	it("answers a client that only accepts JSON", async () => {
		const agent = await start();
		agent.faux.setResponses([fauxAssistantMessage([fauxText("plain")])]);
		const response = await fetch(mcpUrl(agent), {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${TOKENS.alice}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_billing", arguments: { task: "go" } } }),
		});
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(JSON.stringify(await response.json())).toContain("plain");
	});

	it("does not hold up a shutdown for a call in progress", async () => {
		const agent = await startTestAgent({ config: { mcpEndpoint: ENDPOINT }, tokensPerSecond: 10 });
		let started = false;
		agent.faux.setResponses([
			() => {
				started = true;
				return fauxAssistantMessage([fauxText("long ".repeat(200))]);
			},
		]);
		const client = await connect(agent);
		const call = client.callTool("ask_billing", { task: "go" }, { timeoutMs: 20_000 }).then(() => "answered", () => "failed");
		await waitFor(() => started);
		const began = Date.now();
		await agent.close();
		expect(Date.now() - began).toBeLessThan(6_000);
		await client.close();
		expect(await call).toBe("failed");
	}, 10_000);

	it("refuses a chain past the hop limit", async () => {
		const agent = await start();
		const client = await connect(agent);
		const result = await client.request<{ isError?: boolean; content: unknown }>("tools/call", {
			name: "ask_billing",
			arguments: { task: "go" },
			_meta: { "agent-pi/hops": 3 },
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("more than 2 agents");
	});
});

describe("one agent calling another", () => {
	const callee = async () => {
		const agent = await start();
		const caller = await startTestAgent({
			config: {
				mcpServers: [{ name: "billing", transport: "http", url: mcpUrl(agent), headers: { authorization: `Bearer ${TOKENS.alice}` }, agentContext: true }],
				profiles: { chat: { ...testConfig().profiles.chat!, alwaysOnTools: ["billing:*"] } },
			},
		});
		agents.push(caller);
		return { agent, caller };
	};

	it("calls it as an ordinary MCP tool, in the caller's turn and trace, one hop on", async () => {
		const { agent, caller } = await callee();
		caller.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("billing_ask_billing", { task: "What do I owe?" })], { stopReason: "toolUse" }),
			(context) => {
				expect(JSON.stringify(context.messages.at(-1))).toContain("Nothing.");
				return fauxAssistantMessage([fauxText("You owe nothing.")]);
			},
		]);
		let provider: string | undefined;
		let asked = "";
		agent.faux.setResponses([
			(context, options) => {
				provider = options?.sessionId;
				asked = JSON.stringify(context.messages);
				return fauxAssistantMessage([fauxText("Nothing.")]);
			},
		]);
		const sessionId = (await rpc(caller.url, TOKENS.alice, "session.create")).body.result!.sessionId as string;
		const response = await fetch(caller.url, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${TOKENS.alice}`, traceparent: TRACEPARENT, "x-turn-id": "turn-9" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.prompt", params: { sessionId, input: "balance?" } }),
		});
		expect(((await response.json()) as { result: unknown }).result).toMatchObject({ status: "done", text: "You owe nothing." });
		expect(asked).toContain("What do I owe?");
		const identity = await agent.agent.container.get(Services.identity);
		expect(identity.get(provider)).toMatchObject({
			turnId: "turn-9",
			traceparent: TRACEPARENT,
			userId: "alice",
			metadata: { via: "mcp", tool: "ask_billing", "agent-pi/hops": 1 },
		});
	});

	it("sends third-party servers no context", async () => {
		const bodies: Record<string, unknown>[] = [];
		const agent = await start();
		const original = globalThis.fetch;
		const spy: typeof fetch = async (input, init) => {
			if (typeof init?.body === "string") bodies.push(JSON.parse(init.body) as Record<string, unknown>);
			return original(input, init);
		};
		globalThis.fetch = spy;
		try {
			const caller = await startTestAgent({
				config: {
					mcpServers: [{ name: "billing", transport: "http", url: mcpUrl(agent), headers: { authorization: `Bearer ${TOKENS.alice}` } }],
					profiles: { chat: { ...testConfig().profiles.chat!, alwaysOnTools: ["billing:*"] } },
				},
			});
			agents.push(caller);
			caller.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("billing_ask_billing", { task: "go" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("done")]),
			]);
			agent.faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
			const sessionId = (await original(caller.url, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${TOKENS.alice}` },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.create" }),
			}).then((response) => response.json()) as { result: { sessionId: string } }).result.sessionId;
			await original(caller.url, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${TOKENS.alice}` },
				body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session.prompt", params: { sessionId, input: "go" } }),
			});
		} finally {
			globalThis.fetch = original;
		}
		const call = bodies.find((body) => body.method === "tools/call");
		expect(call).toBeDefined();
		expect(Object.keys((call!.params as { _meta: object })._meta)).toEqual(["progressToken"]);
	});
});

describe("MCP endpoint config", () => {
	const write = (mcpEndpoint: unknown) => {
		const path = join(mkdtempSync(join(tmpdir(), "agent-mcp-")), "agent.json");
		writeFileSync(
			path,
			JSON.stringify({
				agent: "test",
				auth: { kind: "static", tokens: "a=b" },
				models: { smart: { provider: "anthropic", modelId: "m" } },
				profiles: { chat: { model: "smart" } },
				mcpEndpoint,
			}),
		);
		return path;
	};

	it("reads an endpoint, defaulting its path", () => {
		expect(loadConfig(write({ tools: [{ name: "ask", description: "Ask." }] })).mcpEndpoint).toEqual({ path: "/mcp", tools: [{ name: "ask", description: "Ask." }] });
	});

	it("names the field at fault", () => {
		expect(() => loadConfig(write({ tools: [] }))).toThrow("mcpEndpoint.tools");
		expect(() => loadConfig(write({ tools: [{ name: "bad name", description: "x" }] }))).toThrow("mcpEndpoint.tools[0].name");
	});

	it("will not start with a clashing path, an unknown profile, or a repeated tool", async () => {
		const tool = { name: "ask", description: "Ask." };
		await expect(startTestAgent({ config: { mcpEndpoint: { path: "/agent", tools: [tool] } } })).rejects.toThrow("http.path");
		await expect(startTestAgent({ config: { mcpEndpoint: { path: "/mcp", tools: [{ ...tool, profile: "nope" }] } } })).rejects.toThrow("unknown profile");
		await expect(startTestAgent({ config: { mcpEndpoint: { path: "/mcp", tools: [tool, tool] } } })).rejects.toThrow("two tools");
	});
});
