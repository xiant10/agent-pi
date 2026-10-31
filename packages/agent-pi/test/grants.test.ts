import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { McpClient } from "@earendil-works/pi-mcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../src/auth/authenticator.ts";
import { GrantBroker, GrantError, type GrantsConfig } from "../src/auth/grants.ts";
import { loadConfig } from "../src/config.ts";
import { McpManager } from "../src/mcp/manager.ts";
import { fakeMcpServer, rpc, startTestAgent, type TestAgent, testConfig, TOKENS, waitFor } from "../src/testing.ts";
import { ToolCatalog } from "../src/tools/catalog.ts";
import { SILENT_LOGGER } from "../src/util/log.ts";

const CONFIG: GrantsConfig = {
	url: "http://auth.test/",
	clientId: "agent-pi",
	clientSecret: "secret",
	actions: ["agent:use", "crm:read"],
	audiences: ["agent-pi", "crm-mcp"],
};

const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

/** The auth service's grant routes, in memory. */
class FakeAuth {
	readonly created: Record<string, unknown>[] = [];
	readonly extended: string[] = [];
	readonly revoked: string[] = [];
	readonly stopped = new Set<string>();
	readonly expired = new Set<string>();
	mints = 0;
	down = 0;
	expiresIn = 300;
	#next = 1;

	readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const body = (init?.body === undefined ? {} : JSON.parse(String(init.body))) as Record<string, unknown>;
		if (this.down > 0) {
			this.down--;
			return Response.json({ error: "server_error" }, { status: 500 });
		}
		const refuse = (code: string) => Response.json({ error: code }, { status: 400 });
		if (url.pathname === "/v1/token" && body.grant_type === "client_credentials") {
			return Response.json({ access_token: "service-token", expires_in: 300 });
		}
		if (url.pathname === "/v1/token") {
			const id = String(body.grant_id);
			if (this.stopped.has(id)) return refuse("invalid_grant");
			if (this.expired.has(id)) return refuse("grant_expired");
			this.mints++;
			const created = this.created.find((grant) => grant.id === id);
			return Response.json({
				access_token: jwt({ grant: id, n: this.mints, scope: (created?.actions as string[] | undefined)?.join(" "), aud: created?.audiences }),
				expires_in: this.expiresIn,
			});
		}
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer service-token");
		const path = /^\/v1\/grants\/([^/]+)\/(extend|revoke)$/.exec(url.pathname);
		if (path?.[2] === "extend") {
			if (this.stopped.has(path[1]!)) return refuse("invalid_grant");
			this.extended.push(path[1]!);
			return Response.json({ id: path[1] });
		}
		if (path?.[2] === "revoke") {
			this.revoked.push(path[1]!);
			return new Response(null, { status: 204 });
		}
		const grant = { ...body, id: `grt_${this.#next++}` };
		this.created.push(grant);
		return Response.json(grant, { status: 201 });
	}) as typeof fetch;
}

const user = (token = "user-token"): Principal => ({ userId: "ada", tenantId: "ten_acme", scopes: ["agent:use"], claims: {}, token });

const delegated = (grant: string, scopes = ["agent:use"], aud: string[] = ["agent-pi"]): Principal => ({
	...user(`delegated-${grant}`),
	scopes,
	claims: { grant, aud, act: { sub: "svc_t10-livekit-agent" } },
	agent: { runtime: "svc_t10-livekit-agent", grantId: grant },
});

const CONVERSATION = 1 as ConversationId;

function broker(auth: FakeAuth, now = Date.now) {
	return new GrantBroker(CONFIG, { fetch: auth.fetch, now, retryDelayMs: 1 });
}

describe("GrantBroker", () => {
	it("opens a root from a user token, then extends it", async () => {
		const auth = new FakeAuth();
		const grants = broker(auth);
		const first = await grants.attach(CONVERSATION, undefined, user());
		expect(auth.created).toEqual([
			expect.objectContaining({ subject_token: "user-token", actions: CONFIG.actions, audiences: CONFIG.audiences }),
		]);
		expect(await grants.attach(CONVERSATION, first, user())).toEqual(first);
		expect(auth.created).toHaveLength(1);
		expect(auth.extended).toEqual([first.grantId]);
	});

	it("reuses a spawned agent's stored grant instead of opening another", async () => {
		const auth = new FakeAuth();
		const grants = broker(auth);
		const parent = await grants.attach(CONVERSATION, undefined, user());
		const child = 2 as ConversationId;
		grants.attachStore(async (id) => (id === child ? { grantId: "grt_stored" } : parent));
		expect(await grants.spawn(child, CONVERSATION)).toEqual({ grantId: "grt_stored" });
		expect(auth.created).toHaveLength(1);
	});

	it("opens a child of a delegated caller, asking only for what it holds", async () => {
		const auth = new FakeAuth();
		const grants = broker(auth);
		const grant = await grants.attach(CONVERSATION, undefined, delegated("grt_call"));
		expect(grant.parent).toBe("grt_call");
		expect(auth.created[0]).toMatchObject({ subject_token: "delegated-grt_call", actions: ["agent:use"], audiences: ["agent-pi"] });
		// The same call reuses it, with nothing to extend: the voice grant is the limit.
		expect(await grants.attach(CONVERSATION, grant, delegated("grt_call"))).toEqual(grant);
		expect(auth.created).toHaveLength(1);
		expect(auth.extended).toEqual([]);
		// Rejoining gives the caller a new grant, so the old child must not be kept.
		const next = await grants.attach(CONVERSATION, grant, delegated("grt_next"));
		expect(next).toMatchObject({ parent: "grt_next" });
		expect(next.grantId).not.toBe(grant.grantId);
	});

	it("never mistakes a user for the delegated session before them", async () => {
		const auth = new FakeAuth();
		const grants = broker(auth);
		const child = await grants.attach(CONVERSATION, undefined, delegated("grt_call"));
		const root = await grants.attach(CONVERSATION, child, user());
		expect(root.grantId).not.toBe(child.grantId);
		expect(root.parent).toBeUndefined();
	});

	it("opens a new root when the old grant was stopped", async () => {
		const auth = new FakeAuth();
		const grants = broker(auth);
		const first = await grants.attach(CONVERSATION, undefined, user());
		auth.stopped.add(first.grantId);
		const second = await grants.attach(CONVERSATION, first, user());
		expect(second.grantId).not.toBe(first.grantId);
	});

	it("keeps a grant it already has through an outage, and fails with none", async () => {
		const auth = new FakeAuth();
		const grants = broker(auth);
		const first = await grants.attach(CONVERSATION, undefined, user());
		auth.down = 99;
		expect(await grants.attach(CONVERSATION, first, user())).toEqual(first);
		await expect(grants.attach(2 as ConversationId, undefined, user())).rejects.toMatchObject({ reason: "unavailable" });
	});

	it("retries an outage and resumes", async () => {
		const auth = new FakeAuth();
		const grants = broker(auth);
		await grants.attach(CONVERSATION, undefined, user());
		auth.down = 2;
		await expect(grants.token(CONVERSATION)).resolves.toContain(".");
		expect(auth.down).toBe(0);
	});

	it("caches a token and replaces it a minute before expiry", async () => {
		const auth = new FakeAuth();
		let now = 1_000_000;
		const grants = broker(auth, () => now);
		await grants.attach(CONVERSATION, undefined, user());
		const first = await grants.token(CONVERSATION);
		now += 230_000;
		expect(await grants.token(CONVERSATION)).toBe(first);
		now += 20_000;
		expect(await grants.token(CONVERSATION)).not.toBe(first);
		expect(auth.mints).toBe(2);
	});

	it("mints once for a burst", async () => {
		const auth = new FakeAuth();
		const grants = broker(auth);
		await grants.attach(CONVERSATION, undefined, user());
		const tokens = await Promise.all(Array.from({ length: 10 }, () => grants.token(CONVERSATION)));
		expect(new Set(tokens).size).toBe(1);
		expect(auth.mints).toBe(1);
	});

	it("reports a stopped and an expired grant apart, and drops the cached token", async () => {
		const auth = new FakeAuth();
		auth.expiresIn = 30;
		const grants = broker(auth);
		const { grantId } = await grants.attach(CONVERSATION, undefined, user());
		await grants.token(CONVERSATION);
		auth.stopped.add(grantId);
		await expect(grants.token(CONVERSATION)).rejects.toMatchObject({ reason: "stopped" });
		auth.stopped.clear();
		auth.expired.add(grantId);
		await expect(grants.token(CONVERSATION)).rejects.toMatchObject({ reason: "expired", message: expect.stringContaining("renew") });
	});

	it("resumes after a restart from the stored id, with no user present", async () => {
		const auth = new FakeAuth();
		const { grantId } = await broker(auth).attach(CONVERSATION, undefined, user());
		const restarted = broker(auth);
		restarted.attachStore(async () => ({ grantId }));
		await expect(restarted.token(CONVERSATION)).resolves.toContain(".");
		const unknown = broker(auth);
		unknown.attachStore(async () => undefined);
		await expect(unknown.token(CONVERSATION)).rejects.toBeInstanceOf(GrantError);
	});

	it("gives a spawned agent its own grant, and ends it", async () => {
		const auth = new FakeAuth();
		const grants = broker(auth);
		const parent = await grants.attach(CONVERSATION, undefined, user());
		const child = 2 as ConversationId;
		await grants.spawn(child, CONVERSATION);
		expect(auth.created).toHaveLength(2);
		expect(auth.created[1]).toMatchObject({ actions: CONFIG.actions, audiences: CONFIG.audiences });
		const subject = String(auth.created[1]!.subject_token);
		expect(subject).not.toBe("user-token");
		const own = await grants.grantOf(child);
		expect(own?.grantId).not.toBe(parent.grantId);
		await grants.release(child);
		expect(auth.revoked).toEqual([own?.grantId]);
		await expect(grants.token(child)).rejects.toBeInstanceOf(GrantError);
	});
});

describe("MCP servers with auth: grant", () => {
	it("refuses a call with no grant", async () => {
		const catalog = new ToolCatalog();
		const manager = new McpManager([{ name: "crm", transport: "http", url: "http://unused", auth: "grant" }], {
			catalog,
			log: SILENT_LOGGER,
			createTransport: fakeMcpServer([{ name: "t", description: "t" }]).transport,
		});
		await manager.start();
		const entry = catalog.entries("crm")[0]!;
		await expect(manager.callTool(entry, {}, undefined, undefined)).rejects.toThrow("agent grant");
		await expect(
			manager.callTool(entry, {}, { key: async () => undefined, token: async () => "x" }, undefined),
		).rejects.toThrow("agent grant");
		await manager.close();
	});

	it("keeps a running call alive through token rotation, then closes the old connection", async () => {
		const closes = vi.spyOn(McpClient.prototype, "close");
		let finish!: (value: string) => void;
		const slow = new Promise<string>((resolve) => {
			finish = resolve;
		});
		const catalog = new ToolCatalog();
		const headers: Readonly<Record<string, string>>[] = [];
		const mcp = fakeMcpServer([
			{ name: "slow", description: "slow", call: () => slow },
			{ name: "fast", description: "fast" },
		]);
		const manager = new McpManager([{ name: "crm", transport: "http", url: "http://unused", auth: "grant" }], {
			catalog,
			log: SILENT_LOGGER,
			createTransport: (_config, sent) => {
				headers.push(sent);
				return mcp.transport();
			},
		});
		await manager.start();
		const [slowEntry, fastEntry] = [catalog.entries("crm").find((e) => e.mcpName === "slow")!, catalog.entries("crm").find((e) => e.mcpName === "fast")!];
		const caller = (token: string) => ({ key: async () => "grt_1", token: async () => token });

		const running = manager.callTool(slowEntry, {}, caller("first"), undefined);
		await vi.waitFor(() => expect(mcp.calls).toHaveLength(1));
		closes.mockClear();
		await manager.callTool(fastEntry, {}, caller("second"), undefined);
		expect(headers.map((sent) => sent.Authorization)).toEqual([undefined, "Bearer first", "Bearer second"]);
		expect(closes).not.toHaveBeenCalled();

		finish("done");
		await expect(running).resolves.toMatchObject({ content: [{ text: "done" }] });
		await vi.waitFor(() => expect(closes).toHaveBeenCalledTimes(1));
		await manager.close();
		closes.mockRestore();
	});

	it("keeps two grants of one user on separate connections", async () => {
		const catalog = new ToolCatalog();
		const headers: Readonly<Record<string, string>>[] = [];
		const mcp = fakeMcpServer([{ name: "t", description: "t" }]);
		const manager = new McpManager([{ name: "crm", transport: "http", url: "http://unused", auth: "grant" }], {
			catalog,
			log: SILENT_LOGGER,
			createTransport: (_config, sent) => {
				headers.push(sent);
				return mcp.transport();
			},
		});
		await manager.start();
		const entry = catalog.entries("crm")[0]!;
		await manager.callTool(entry, {}, { key: async () => "a", token: async () => "ta" }, undefined);
		await manager.callTool(entry, {}, { key: async () => "b", token: async () => "tb" }, undefined);
		await manager.callTool(entry, {}, { key: async () => "a", token: async () => "ta" }, undefined);
		expect(headers.slice(1).map((sent) => sent.Authorization)).toEqual(["Bearer ta", "Bearer tb"]);
		await manager.close();
	});
});

describe("a run under a grant", () => {
	let running: TestAgent | undefined;
	afterEach(async () => {
		await running?.close();
		running = undefined;
	});

	const JWT_AUTH = { kind: "jwt", algorithms: ["HS256"], hmacSecret: "unused" } as const;

	async function start(auth: FakeAuth) {
		const mcp = fakeMcpServer([{ name: "whoami", description: "Who is calling." }]);
		const seen: Record<string, string>[] = [];
		running = await startTestAgent({
			config: {
				auth: JWT_AUTH,
				grants: CONFIG,
				mcpServers: [{ name: "crm", transport: "http", url: "http://unused", headers: { "x-service": "agent" }, auth: "grant" }],
				profiles: {
					chat: {
						model: "main",
						thinkingLevel: "off",
						alwaysOnTools: ["crm:whoami"],
						maxActiveTools: 12,
						preload: { maxTools: 0, minScore: 4 },
						speech: false,
						thinkingEvents: false,
						expert: { model: "main", thinkingLevel: "off" },
					},
				},
			},
			grantOptions: { fetch: auth.fetch, retryDelayMs: 1 },
			mcpTransport: (_config, headers) => {
				seen.push({ ...headers });
				return mcp.transport();
			},
		});
		const created = await rpc(running.url, TOKENS.alice, "session.create", { profile: "chat" });
		return { mcp, seen, sessionId: created.body.result!.sessionId as string };
	}

	it("sends the MCP server a token from the grant, never the user's", async () => {
		const auth = new FakeAuth();
		const { mcp, seen, sessionId } = await start(auth);
		running!.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("crm_whoami", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await rpc(running!.url, TOKENS.alice, "session.prompt", { sessionId, input: "who am I" });
		expect(mcp.calls).toEqual([{ name: "whoami", args: {} }]);
		expect(auth.created[0]).toMatchObject({ subject_token: TOKENS.alice });
		// Listing used the service headers; the call used the grant's connection.
		expect(seen[0]).toEqual({ "x-service": "agent" });
		expect(seen[1]!.Authorization).toMatch(/^Bearer x\./);
		expect(JSON.stringify(seen)).not.toContain(TOKENS.alice);
	});

	it("finds the session's grant again after a restart", async () => {
		const auth = new FakeAuth();
		const dir = mkdtempSync(join(tmpdir(), "agent-grants-"));
		const config = { auth: JWT_AUTH, grants: CONFIG, storage: { kind: "sqlite" as const, path: join(dir, "agent.sqlite") }, instanceId: undefined };
		const options = { config, configStorage: true, grantOptions: { fetch: auth.fetch, retryDelayMs: 1 } };
		running = await startTestAgent(options);
		const created = await rpc(running.url, TOKENS.alice, "session.create", { profile: "chat" });
		const sessionId = created.body.result!.sessionId as string;
		running.faux.setResponses([fauxAssistantMessage([fauxText("first")])]);
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "1" });
		await running.close();

		running = await startTestAgent(options);
		running.faux.setResponses([fauxAssistantMessage([fauxText("second")])]);
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "2" });
		expect(auth.created).toHaveLength(1);
		expect(auth.extended).toEqual(["grt_1"]);
	});

	it("tells the model when the grant was stopped", async () => {
		const auth = new FakeAuth();
		const { mcp, sessionId } = await start(auth);
		running!.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("crm_whoami", {})], { stopReason: "toolUse" }),
			(context) => {
				const text = JSON.stringify(context.messages.at(-1));
				expect(text).toContain("access was stopped");
				return fauxAssistantMessage([fauxText("stopped")]);
			},
		]);
		auth.stopped.add("grt_1");
		const answer = await rpc(running!.url, TOKENS.alice, "session.prompt", { sessionId, input: "go" });
		expect(answer.body.result).toMatchObject({ status: "done", text: "stopped" });
		expect(mcp.calls).toEqual([]);
	});

	it("gives consult_expert its own grant, and ends it afterwards", async () => {
		const auth = new FakeAuth();
		const { sessionId } = await start(auth);
		running!.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("consult_expert", { question: "why" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("because")]),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await rpc(running!.url, TOKENS.alice, "session.prompt", { sessionId, input: "ask" });
		expect(auth.created).toHaveLength(2);
		expect(auth.revoked).toEqual(["grt_2"]);
	});

	it("resumes a child under the same grant after a crash", async () => {
		const auth = new FakeAuth();
		const mcp = fakeMcpServer([{ name: "whoami", description: "Who is calling." }]);
		const path = join(mkdtempSync(join(tmpdir(), "agent-grants-")), "agent.sqlite");
		const config = {
			auth: JWT_AUTH,
			grants: CONFIG,
			instanceId: "crash",
			mcpServers: [{ name: "crm", transport: "http" as const, url: "http://unused", auth: "grant" as const }],
			subagents: { research: { description: "Research.", model: "main", thinkingLevel: "off" as const, tools: ["crm:whoami"] } },
			profiles: { chat: { ...testConfig().profiles.chat!, alwaysOnTools: ["agent_research"] } },
		};
		const options = { configStorage: true, grantOptions: { fetch: auth.fetch, retryDelayMs: 1 }, mcpTransport: () => mcp.transport() };
		const first = await startTestAgent({ ...options, config: { ...config, storage: { kind: "sqlite", path } }, tokensPerSecond: 10 });
		let childStarted = false;
		first.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("agent_research", { task: "who" })], { stopReason: "toolUse" }),
			() => {
				childStarted = true;
				return fauxAssistantMessage([fauxText("a long answer ".repeat(50))]);
			},
		]);
		const sessionId = (await rpc(first.url, TOKENS.alice, "session.create", { profile: "chat" })).body.result!.sessionId as string;
		void rpc(first.url, TOKENS.alice, "session.prompt", { sessionId, input: "go" }).catch(() => undefined);
		await waitFor(() => childStarted);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(auth.created).toHaveLength(2);

		const image = join(mkdtempSync(join(tmpdir(), "agent-crash-")), "agent.sqlite");
		const database = new DatabaseSync(path);
		database.exec(`VACUUM INTO '${image}'`);
		database.close();

		running = await startTestAgent({
			...options,
			config: { ...config, storage: { kind: "sqlite", path: image } },
			responses: [
				fauxAssistantMessage([fauxToolCall("crm_whoami", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("it is alice")]),
				fauxAssistantMessage([fauxText("done")]),
			],
		});
		await waitFor(async () => (await rpc(running!.url, TOKENS.alice, "session.get", { sessionId })).body.result!.busy === false);
		// The child's tool found its grant in storage, and the rerun neither opened another nor lost track of this one.
		expect(mcp.calls).toEqual([{ name: "whoami", args: {} }]);
		expect(auth.created).toHaveLength(2);
		expect(auth.revoked).toContain("grt_2");
		await first.close();
	}, 15_000);

	it("keeps a running child's grant across a graceful restart", async () => {
		const auth = new FakeAuth();
		const mcp = fakeMcpServer([{ name: "whoami", description: "Who is calling." }]);
		const path = join(mkdtempSync(join(tmpdir(), "agent-grants-")), "agent.sqlite");
		const config = {
			auth: JWT_AUTH,
			grants: CONFIG,
			instanceId: "restart",
			storage: { kind: "sqlite" as const, path },
			mcpServers: [{ name: "crm", transport: "http" as const, url: "http://unused", auth: "grant" as const }],
			subagents: { research: { description: "Research.", model: "main", thinkingLevel: "off" as const, tools: ["crm:whoami"] } },
			profiles: { chat: { ...testConfig().profiles.chat!, alwaysOnTools: ["agent_research"] } },
		};
		const options = { config, configStorage: true, grantOptions: { fetch: auth.fetch, retryDelayMs: 1 }, mcpTransport: () => mcp.transport() };
		const first = await startTestAgent({ ...options, tokensPerSecond: 10 });
		let childStarted = false;
		first.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("agent_research", { task: "who" })], { stopReason: "toolUse" }),
			() => {
				childStarted = true;
				return fauxAssistantMessage([fauxText("a long answer ".repeat(50))]);
			},
		]);
		const sessionId = (await rpc(first.url, TOKENS.alice, "session.create", { profile: "chat" })).body.result!.sessionId as string;
		void rpc(first.url, TOKENS.alice, "session.prompt", { sessionId, input: "go" }).catch(() => undefined);
		await waitFor(() => childStarted);
		await new Promise((resolve) => setTimeout(resolve, 200));
		await first.close();
		expect(auth.revoked).toEqual([]);

		running = await startTestAgent({
			...options,
			responses: [
				fauxAssistantMessage([fauxToolCall("crm_whoami", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("it is alice")]),
				fauxAssistantMessage([fauxText("done")]),
			],
		});
		await waitFor(async () => (await rpc(running!.url, TOKENS.alice, "session.get", { sessionId })).body.result!.busy === false);
		expect(mcp.calls).toEqual([{ name: "whoami", args: {} }]);
		expect(auth.created).toHaveLength(2);
		expect(auth.revoked).toEqual(["grt_2"]);
	}, 15_000);

	it("ends a child's grant when its parent is cancelled", async () => {
		const auth = new FakeAuth();
		const config = {
			auth: JWT_AUTH,
			grants: CONFIG,
			subagents: { research: { description: "Research.", model: "main", thinkingLevel: "off" as const, tools: [] } },
			profiles: { chat: { ...testConfig().profiles.chat!, alwaysOnTools: ["agent_research"] } },
		};
		running = await startTestAgent({ config, tokensPerSecond: 10, grantOptions: { fetch: auth.fetch, retryDelayMs: 1 } });
		let childStarted = false;
		running.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("agent_research", { task: "who" })], { stopReason: "toolUse" }),
			() => {
				childStarted = true;
				return fauxAssistantMessage([fauxText("a long answer ".repeat(50))]);
			},
		]);
		const sessionId = (await rpc(running.url, TOKENS.alice, "session.create", { profile: "chat" })).body.result!.sessionId as string;
		void rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "go" }).catch(() => undefined);
		await waitFor(() => childStarted);
		await rpc(running.url, TOKENS.alice, "session.cancel", { sessionId });
		await waitFor(() => auth.revoked.includes("grt_2"));
	});

	it("opens a child grant for a delegated MCP call, and ends it with the call", async () => {
		const auth = new FakeAuth();
		running = await startTestAgent({
			config: { auth: JWT_AUTH, grants: CONFIG, mcpEndpoint: { path: "/mcp", tools: [{ name: "ask", description: "Ask." }] } },
			authenticator: { authenticate: async () => delegated("grt_call") },
			grantOptions: { fetch: auth.fetch, retryDelayMs: 1 },
		});
		running.faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
		const response = await fetch(running.url.replace(/\/agent$/, "/mcp"), {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json", authorization: "Bearer any" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask", arguments: { task: "go" } } }),
		});
		expect(JSON.stringify(await response.json())).toContain("done");
		expect(auth.created).toEqual([expect.objectContaining({ subject_token: "delegated-grt_call", actions: ["agent:use"], audiences: ["agent-pi"] })]);
		expect(auth.revoked).toEqual(["grt_1"]);
	});

	it("revokes the grant when the session closes", async () => {
		const auth = new FakeAuth();
		const { sessionId } = await start(auth);
		running!.faux.setResponses([fauxAssistantMessage([fauxText("hi")])]);
		await rpc(running!.url, TOKENS.alice, "session.prompt", { sessionId, input: "hello" });
		await rpc(running!.url, TOKENS.alice, "session.close", { sessionId });
		expect(auth.revoked).toEqual(["grt_1"]);
	});

	it("refuses input it cannot open a grant for", async () => {
		const auth = new FakeAuth();
		const { sessionId } = await start(auth);
		auth.down = 99;
		const answer = await rpc(running!.url, TOKENS.alice, "session.prompt", { sessionId, input: "hello" });
		expect(answer.status).toBe(503);
	});

	it("will not start with a grant server but no grants section", async () => {
		await expect(
			startTestAgent({ config: { mcpServers: [{ name: "crm", transport: "http", url: "http://unused", auth: "grant" }] } }),
		).rejects.toThrow("grants section");
	});

	it("will not start grants on static tokens", async () => {
		await expect(startTestAgent({ config: { grants: CONFIG } })).rejects.toThrow("jwt");
	});
});

describe("the grants config", () => {
	const write = (grants: object) => {
		const dir = mkdtempSync(join(tmpdir(), "agent-config-"));
		const path = join(dir, "agent.json");
		writeFileSync(
			path,
			JSON.stringify({
				agent: "test",
				auth: { kind: "static", tokens: "{}" },
				models: { main: { provider: "openai", modelId: "m" } },
				profiles: { chat: { model: "main" } },
				defaultProfile: "chat",
				instructions: [],
				grants,
			}),
		);
		return path;
	};

	it("reaches the running config from a file", () => {
		const config = loadConfig(write({ url: "http://auth", clientId: "agent-pi", clientSecret: "s", actions: "agent:use,crm:read", audiences: ["agent-pi"] }));
		expect(config.grants).toEqual({ url: "http://auth", clientId: "agent-pi", clientSecret: "s", actions: ["agent:use", "crm:read"], audiences: ["agent-pi"] });
	});

	it("is off when its url is empty", () => {
		expect(loadConfig(write({ url: "", clientId: "", clientSecret: "", actions: "", audiences: "" })).grants).toBeUndefined();
	});

	it("refuses a url with no secret", () => {
		expect(() => loadConfig(write({ url: "http://auth", clientId: "agent-pi", actions: [], audiences: [] }))).toThrow("grants.clientSecret");
	});
});
