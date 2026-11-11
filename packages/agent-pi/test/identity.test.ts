import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningAgent, startAgent } from "../src/app.ts";
import { forModelGateway, GATEWAY_IDENTITY_HEADERS, type IdentityHeaderNames, IdentityRegistry, withIdentityHeaders } from "../src/identity.ts";
import { StaticTokenAuthenticator } from "../src/auth/static-token.ts";
import { Services } from "../src/plugins/services.ts";
import { type AgentPlugin, definePlugin, type RunContext } from "../src/plugins/types.ts";
import { rpc, TOKENS, testConfig, waitFor } from "../src/testing.ts";
import { SILENT_LOGGER } from "../src/util/log.ts";

let gateway: Server | undefined;
let agent: RunningAgent | undefined;
afterEach(async () => {
	await agent?.close();
	await new Promise((resolve) => (gateway === undefined ? resolve(undefined) : gateway.close(resolve)));
	agent = undefined;
	gateway = undefined;
});

/** A chat-completions endpoint that answers "ok" and records the headers of each request. */
async function startGateway(): Promise<{ readonly url: string; readonly seen: IncomingHttpHeaders[] }> {
	const seen: IncomingHttpHeaders[] = [];
	gateway = createServer((req, res) => {
		seen.push(req.headers);
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta: object, finish: string | null) =>
				`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			res.write(chunk({ role: "assistant", content: "ok" }, null));
			res.write(chunk({}, "stop"));
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => gateway!.listen(0, "127.0.0.1", resolve));
	return { url: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`, seen };
}

async function start(
	url: string,
	runs: RunContext[],
	identityHeaders: IdentityHeaderNames | null = GATEWAY_IDENTITY_HEADERS,
	extra: readonly AgentPlugin[] = [],
) {
	process.env.OPENAI_API_KEY ??= "test-key";
	const naming = definePlugin({
		name: "naming",
		authenticate: (principal) => ({ ...principal, displayName: "Alice 李" }),
		afterRun: (run) => {
			runs.push(run);
		},
	});
	agent = await startAgent(
		testConfig({
			models: { main: { provider: "openai-compatible", modelId: "m", baseUrl: url, ...(identityHeaders === null ? {} : { identityHeaders }) } },
		}),
		{
			log: SILENT_LOGGER,
			storage: new MemoryStorage(),
			authenticator: new StaticTokenAuthenticator(new Map([[TOKENS.alice, "alice"]])),
			plugins: [naming, ...extra],
		},
	);
	return `http://127.0.0.1:${agent.port}/agent`;
}

describe("identity headers", () => {
	it("sends the session, a generated turn id, and the user to the model gateway", async () => {
		const { url, seen } = await startGateway();
		const runs: RunContext[] = [];
		const agentUrl = await start(url, runs);
		const created = await rpc(agentUrl, TOKENS.alice, "session.create", {});
		const sessionId = created.body.result!.sessionId as string;

		const first = await rpc(agentUrl, TOKENS.alice, "session.prompt", { sessionId, input: "hi" });
		const turnId = first.body.result!.turnId as string;
		expect(turnId).toMatch(/^[0-9a-f-]{36}$/);
		const second = await rpc(agentUrl, TOKENS.alice, "session.prompt", { sessionId, input: "again" });
		expect(second.body.result!.turnId).not.toBe(turnId);

		expect(seen).toHaveLength(2);
		expect(seen[0]).toMatchObject({
			"x-agent-name": "test",
			"x-session-id": sessionId,
			"x-turn-id": turnId,
			"x-user-id": "alice",
			"x-user-name": encodeURIComponent("Alice 李"),
		});
		// No grant, so no run token: the gateway trusts the tenant header, as before.
		expect(seen[0]!["x-run-token"]).toBeUndefined();
		expect(seen[1]!["x-turn-id"]).toBe(second.body.result!.turnId);
		await waitFor(() => runs.length === 2);
		expect(runs.map((run) => run.turnId)).toEqual([turnId, second.body.result!.turnId]);
	});

	it("uses the client's turn id from the param or the X-Turn-ID header, and rejects an unusable one", async () => {
		const { url, seen } = await startGateway();
		const agentUrl = await start(url, []);
		const sessionId = (await rpc(agentUrl, TOKENS.alice, "session.create", {})).body.result!.sessionId as string;

		const byParam = await rpc(agentUrl, TOKENS.alice, "session.prompt", { sessionId, input: "hi", turnId: "turn-1" });
		expect(byParam.body.result).toMatchObject({ turnId: "turn-1", status: "done" });

		const byHeader = await fetch(agentUrl, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
				authorization: `Bearer ${TOKENS.alice}`,
				"x-turn-id": "turn-2",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.prompt", params: { sessionId, input: "hi" } }),
		});
		expect(((await byHeader.json()) as { result: { turnId: string } }).result.turnId).toBe("turn-2");
		expect(seen.map((headers) => headers["x-turn-id"])).toEqual(["turn-1", "turn-2"]);

		const bad = await rpc(agentUrl, TOKENS.alice, "session.prompt", { sessionId, input: "hi", turnId: "bad id\n" });
		expect(bad.status).toBe(400);
	});

	it("keeps the first turn id when the same requestId is retried", async () => {
		const { url, seen } = await startGateway();
		const agentUrl = await start(url, []);
		const sessionId = (await rpc(agentUrl, TOKENS.alice, "session.create", {})).body.result!.sessionId as string;
		const first = await rpc(agentUrl, TOKENS.alice, "session.prompt", { sessionId, input: "hi", requestId: "r1" });
		const retry = await rpc(agentUrl, TOKENS.alice, "session.prompt", { sessionId, input: "hi", requestId: "r1" });
		expect(retry.body.result!.turnId).toBe(first.body.result!.turnId);
		expect(seen).toHaveLength(1);
	});

	it("lets a plugin add, rename, and drop headers for a downstream system with other names", async () => {
		const { url, seen } = await startGateway();
		const downstream = definePlugin({
			name: "downstream",
			register: (container) => {
				container.value(Services.identityHeaders, (call) => ({
					"X-Account": call.userId,
					"X-Workspace": typeof call.metadata?.workspace === "string" ? call.metadata.workspace : undefined,
					"X-Caller-Scopes": call.principal?.scopes.join(","),
					"X-User-Name": null,
				}));
			},
		});
		const agentUrl = await start(url, [], GATEWAY_IDENTITY_HEADERS, [downstream]);
		const sessionId = (await rpc(agentUrl, TOKENS.alice, "session.create", { metadata: { workspace: "w9" } })).body.result!.sessionId as string;
		await rpc(agentUrl, TOKENS.alice, "session.prompt", { sessionId, input: "hi", turnId: "t1" });
		expect(seen[0]).toMatchObject({ "x-account": "alice", "x-workspace": "w9", "x-turn-id": "t1", "x-session-id": sessionId });
		expect(seen[0]).not.toHaveProperty("x-user-name");
	});

	it("sends no identity headers unless the model is configured for them", async () => {
		const { url, seen } = await startGateway();
		const agentUrl = await start(url, [], null);
		const sessionId = (await rpc(agentUrl, TOKENS.alice, "session.create", {})).body.result!.sessionId as string;
		await rpc(agentUrl, TOKENS.alice, "session.prompt", { sessionId, input: "hi" });
		expect(seen[0]).not.toHaveProperty("x-turn-id");
		expect(seen[0]).not.toHaveProperty("x-session-id");
	});

	it("propagates every turn id without delay across concurrent prompts", async () => {
		const { url, seen } = await startGateway();
		const runs: RunContext[] = [];
		const agentUrl = await start(url, runs);
		const sessions = await Promise.all(
			Array.from({ length: 3 }, async () => (await rpc(agentUrl, TOKENS.alice, "session.create", {})).body.result!.sessionId as string),
		);
		const answers = await Promise.all(
			sessions.map((sessionId, index) => rpc(agentUrl, TOKENS.alice, "session.prompt", { sessionId, input: `hi ${index}`, turnId: `concurrent-${index}` })),
		);
		expect(answers.map((answer) => answer.body.result!.turnId)).toEqual(["concurrent-0", "concurrent-1", "concurrent-2"]);
		expect(seen.map((headers) => headers["x-turn-id"]).sort()).toEqual(["concurrent-0", "concurrent-1", "concurrent-2"]);
	});
});

describe("run tokens on model calls", () => {
	const token = (aud: string | string[]) => `e30.${Buffer.from(JSON.stringify({ aud })).toString("base64url")}.sig`;

	it("goes only with a token the model gateway accepts", () => {
		expect(forModelGateway(token(["ai-gateway-tools", "ai-gateway-llm"]))).toBe(true);
		expect(forModelGateway(token("ai-gateway-llm"))).toBe(true);
		expect(forModelGateway(token(["ai-gateway-tools"]))).toBe(false);
		expect(forModelGateway("not a token")).toBe(false);
	});

	it("is a gateway header, and never sent where the headers are off", async () => {
		const registry = new IdentityRegistry();
		registry.set("p1", { sessionId: "s1", tenantId: "ten_acme", runToken: "run-token" });
		const sent: (Record<string, string | null> | undefined)[] = [];
		const streams = {
			stream: (_model: unknown, _context: unknown, options?: { headers?: Record<string, string | null> }) => {
				sent.push(options?.headers);
				return undefined as never;
			},
			streamSimple: () => undefined as never,
		} as unknown as Parameters<typeof withIdentityHeaders>[0];
		withIdentityHeaders(streams, registry, GATEWAY_IDENTITY_HEADERS).stream({} as never, {} as never, { sessionId: "p1" });
		withIdentityHeaders(streams, registry, { sessionId: "X-Session" }).stream({} as never, {} as never, { sessionId: "p1" });
		expect(sent[0]).toMatchObject({ "X-Run-Token": "run-token", "X-Tenant-ID": "ten_acme" });
		expect(sent[1]).toEqual({ "X-Session": "s1" });
	});
});
