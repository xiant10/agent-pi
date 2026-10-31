/** Test helpers for agent-pi apps: the real harness and transport with a scripted model and in-memory MCP servers. */
import { createModels } from "@earendil-works/pi-ai/models";
import { type FauxProviderHandle, type FauxResponseStep, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { type JsonRpcMessage, type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { type RunningAgent, type StartOptions, startAgent } from "./app.ts";
import { StaticTokenAuthenticator } from "./auth/static-token.ts";
import type { AppConfig, ProfileConfig } from "./config.ts";
import type { AgentPlugin, PluginCatalog } from "./plugins/types.ts";
import type { Skill } from "./skills/skills.ts";
import { SILENT_LOGGER } from "./util/log.ts";

export { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

export type FakeTool = {
	readonly name: string;
	readonly description: string;
	readonly inputSchema?: Record<string, unknown>;
	readonly call?: (args: Record<string, unknown>) => unknown | Promise<unknown>;
};

/** An MCP server over the in-memory transport; `calls` records every tools/call. */
export function fakeMcpServer(tools: readonly FakeTool[]) {
	const calls: { name: string; args: Record<string, unknown> }[] = [];
	const transport = () => {
		const pair = createInMemoryTransportPair();
		pair.server.onMessage((message: JsonRpcMessage) => {
			if (!("id" in message) || !("method" in message)) return;
			const request = message as JsonRpcRequest;
			queueMicrotask(async () => {
				const reply = (result: unknown) => pair.server.send({ jsonrpc: "2.0", id: request.id, result } as JsonRpcMessage);
				if (request.method === "initialize") {
					await reply({
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { tools: { listChanged: true } },
						serverInfo: { name: "fake", version: "1.0.0" },
					});
				} else if (request.method === "tools/list") {
					await reply({
						tools: tools.map((tool) => ({
							name: tool.name,
							description: tool.description,
							inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
						})),
					});
				} else if (request.method === "tools/call") {
					const params = request.params as { name: string; arguments?: Record<string, unknown> };
					calls.push({ name: params.name, args: params.arguments ?? {} });
					const tool = tools.find((candidate) => candidate.name === params.name);
					const value = tool?.call === undefined ? `ok ${params.name}` : await tool.call(params.arguments ?? {});
					await reply({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
				} else {
					await pair.server.send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "not found" } } as JsonRpcMessage);
				}
			});
		});
		void pair.server.start();
		return pair.client;
	};
	return { transport, calls };
}

export const TOKENS = { alice: "alice-token", bob: "bob-token" } as const;

const PROFILE: ProfileConfig = {
	model: "main",
	thinkingLevel: "off",
	alwaysOnTools: [],
	maxActiveTools: 12,
	preload: { maxTools: 0, minScore: 4 },
	speech: false,
	thinkingEvents: false,
};

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
	return {
		agent: "test",
		baseDir: process.cwd(),
		port: 0,
		host: "127.0.0.1",
		instanceId: "test",
		storage: { kind: "memory" },
		auth: { kind: "static", tokens: "{}" },
		models: { main: { provider: "openai", modelId: "unused" } },
		profiles: {
			chat: PROFILE,
			voice: { ...PROFILE, speech: true, preload: { maxTools: 3, minScore: 1 }, instructions: "Speak briefly." },
		},
		defaultProfile: "chat",
		instructions: [{ name: "base", content: "You are a helpful assistant.", tag: false }],
		plugins: [],
		mcpServers: [],
		limits: { maxSessionsPerUser: 5, maxConcurrentRunsPerUser: 3, maxConcurrentRuns: 50, maxInputChars: 10_000, maxBodyBytes: 1_000_000 },
		http: { path: "/agent", allowedOrigins: [], keepAliveMs: 15_000 },
		durable: { stream: {}, compaction: { enabled: false }, retry: { maxRetries: 0 } },
		logLevel: "error",
		...overrides,
	};
}

export type TestAgent = {
	readonly agent: RunningAgent;
	readonly faux: FauxProviderHandle;
	readonly url: string;
	/** Tool names offered in each model request, in order. */
	readonly offered: string[][];
	close(): Promise<void>;
};

/** Wrap scripted responses so each request also records the tools it offered. */
export function recording(offered: string[][], steps: readonly FauxResponseStep[]): FauxResponseStep[] {
	return steps.map((step) => (context, options, state, model) => {
		offered.push(getCurrentTools(context.messages).map((tool) => tool.name));
		return typeof step === "function" ? step(context, options, state, model) : step;
	});
}

export async function startTestAgent(options: {
	readonly config?: Partial<AppConfig>;
	readonly mcp?: ReturnType<typeof fakeMcpServer>;
	readonly skills?: readonly Skill[];
	readonly tokensPerSecond?: number;
	/** Use the config's storage instead of a fresh MemoryStorage, to test restarts. */
	readonly configStorage?: boolean;
	/** Use this storage instead of a fresh MemoryStorage. */
	readonly storage?: Storage;
	readonly mcpTransport?: StartOptions["mcpTransport"];
	readonly grantOptions?: StartOptions["grantOptions"];
	/** Use this instead of the fixed tokens in `TOKENS`. */
	readonly authenticator?: StartOptions["authenticator"];
	readonly plugins?: readonly AgentPlugin[];
	readonly pluginCatalog?: PluginCatalog;
} = {}): Promise<TestAgent> {
	const faux = fauxProvider(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond });
	const models = createModels();
	models.setProvider(faux.provider);
	const config = testConfig({
		...(options.mcp === undefined ? {} : { mcpServers: [{ name: "crm", transport: "stdio", command: "unused" }] }),
		...options.config,
	});
	// Every configured model is the faux one, so an app can test with its real `config/agent.json`.
	const modelNames = new Set(["main", "expert", ...Object.keys(config.models)]);
	const agent = await startAgent(config, {
		log: SILENT_LOGGER,
		...(options.configStorage === true ? {} : { storage: options.storage ?? new MemoryStorage() }),
		models: {
			models,
			refs: new Map([...modelNames].map((name) => [name, { provider: faux.provider.id, modelId: "faux-1" }])),
		},
		authenticator: options.authenticator ?? new StaticTokenAuthenticator(new Map([[TOKENS.alice, "alice"], [TOKENS.bob, "bob"]])),
		...(options.mcp === undefined ? {} : { mcpTransport: options.mcp.transport }),
		...(options.mcpTransport === undefined ? {} : { mcpTransport: options.mcpTransport }),
		plugins: [...(options.skills === undefined ? [] : [{ name: "test-skills", skills: options.skills }]), ...(options.plugins ?? [])],
		...(options.pluginCatalog === undefined ? {} : { pluginCatalog: options.pluginCatalog }),
		...(options.grantOptions === undefined ? {} : { grantOptions: options.grantOptions }),
	});
	return { agent, faux, url: `http://127.0.0.1:${agent.port}/agent`, offered: [], close: () => agent.close() };
}

export type RpcResponse = { status: number; headers: Headers; body: { result?: Record<string, unknown>; error?: { code: number; message: string } } };

let nextId = 1;

export async function rpc(
	url: string,
	token: string | undefined,
	method: string,
	params: Record<string, unknown> = {},
): Promise<RpcResponse> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json",
			...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
	});
	return { status: response.status, headers: response.headers, body: (await response.json()) as RpcResponse["body"] };
}

export type SseMessage = { id?: string; data: { method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: unknown } };

export function parseSse(text: string): SseMessage[] {
	const messages: SseMessage[] = [];
	for (const block of text.split("\n\n")) {
		let id: string | undefined;
		const data: string[] = [];
		for (const line of block.split("\n")) {
			if (line.startsWith("id: ")) id = line.slice(4);
			else if (line.startsWith("data: ")) data.push(line.slice(6));
		}
		if (data.length > 0) messages.push({ ...(id === undefined ? {} : { id }), data: JSON.parse(data.join("\n")) });
	}
	return messages;
}

/** POST a streamed request and collect every SSE message until the server ends the stream. */
export async function rpcStream(
	url: string,
	token: string,
	method: string,
	params: Record<string, unknown>,
): Promise<{ status: number; headers: Headers; messages: SseMessage[] }> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
		body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
	});
	return { status: response.status, headers: response.headers, messages: parseSse(await response.text()) };
}

/** Event bodies of the `session/event` notifications among `messages`. */
export function events(messages: readonly SseMessage[]): Record<string, unknown>[] {
	return messages.filter((message) => message.data.method === "session/event").map((message) => message.data.params!);
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
