import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import type { Authenticator } from "../src/auth/authenticator.ts";
import { loadConfig } from "../src/config.ts";
import { bearerProvider } from "../src/mcp/token.ts";
import { definePlugin } from "../src/plugins/types.ts";
import { fakeMcpServer, rpc, startTestAgent, type TestAgent } from "../src/testing.ts";

const unauthorized = (token?: string) => ({ response: new Response(null, { status: 401 }), serverUrl: new URL("http://x"), fetch, ...(token === undefined ? {} : { token }) });

describe("bearer token source", () => {
	const dir = mkdtempSync(join(tmpdir(), "mcp-token-"));
	const tokenFile = join(dir, "token");

	it("serves a configured token", async () => {
		expect(await bearerProvider({ token: "abc" }).token()).toBe("abc");
	});

	it("caches a file briefly, then re-reads it", async () => {
		writeFileSync(tokenFile, "one\n");
		let now = 0;
		const provider = bearerProvider({ tokenFile }, () => now);
		expect(await provider.token()).toBe("one");
		writeFileSync(tokenFile, "two\n");
		expect(await provider.token()).toBe("one");
		now = 10_000;
		expect(await provider.token()).toBe("two");
	});

	it("re-reads at once after a 401 on the current token", async () => {
		writeFileSync(tokenFile, "one");
		const provider = bearerProvider({ tokenFile }, () => 0);
		await provider.token();
		writeFileSync(tokenFile, "two");
		await provider.onUnauthorized?.(unauthorized("one"));
		expect(await provider.token()).toBe("two");
	});

	it("fails on an empty file", async () => {
		writeFileSync(tokenFile, " \n");
		await expect(bearerProvider({ tokenFile }).token()).rejects.toThrow("empty");
	});
});

describe("a bearer server in the config", () => {
	const load = (server: object) => {
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
				mcpServers: [{ name: "ext", transport: "http", url: "http://ext/mcp", auth: "bearer", ...server }],
			}),
		);
		return () => loadConfig(path).mcpServers[0];
	};

	it("takes an inline token", () => {
		expect(load({ token: " t " })()).toMatchObject({ auth: "bearer", bearer: { token: "t" } });
	});

	it("resolves a token file against the config's directory", () => {
		expect((load({ tokenFile: "secrets/t" })() as { bearer: { tokenFile: string } }).bearer.tokenFile).toMatch(/secrets\/t$/);
	});

	it("lists the tenants it may serve", () => {
		expect(load({ token: "t", tenants: "ten_a, ten_b" })()).toMatchObject({ tenants: ["ten_a", "ten_b"] });
		expect(load({ token: "t" })()).toMatchObject({ tenants: [] });
	});

	it("needs exactly one source", () => {
		expect(load({})).toThrow("exactly one");
		expect(load({ token: "a", tokenFile: "b" })).toThrow("exactly one");
	});

	it("refuses an empty token and a custom header", () => {
		expect(load({ token: "" })).toThrow("empty");
		expect(load({ token: "a", tokenHeader: "x-key" })).toThrow("tokenHeader");
	});
});

describe("the tenants of a bearer server", () => {
	// A token here names its tenant, or none.
	const byTenant: Authenticator = {
		authenticate: async ({ headers }) => {
			const tenantId = String(headers.authorization).slice("Bearer ".length);
			return { userId: `user-of-${tenantId}`, ...(tenantId === "none" ? {} : { tenantId }), scopes: [], claims: {}, token: tenantId };
		},
	};
	let running: TestAgent | undefined;
	afterEach(async () => {
		await running?.close();
		running = undefined;
	});

	const callAs = async (tenants: readonly string[], token: string) => {
		const mcp = fakeMcpServer([{ name: "list_deals", description: "List deals.", call: () => "deals" }]);
		running = await startTestAgent({
			authenticator: byTenant,
			mcpTransport: mcp.transport,
			config: { mcpServers: [{ name: "ext", transport: "http", url: "http://ext/mcp", auth: "bearer", bearer: { token: "t" }, tenants }] },
			plugins: [definePlugin({ name: "active", beforePrompt: () => ({ activateTools: ["ext:*"] }) })],
		});
		running.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("ext_list_deals", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const created = await rpc(running.url, token, "session.create", {});
		await rpc(running.url, token, "session.prompt", { sessionId: created.body.result!.sessionId, input: "deals?" });
		return mcp.calls;
	};

	it("serves a listed tenant", async () => {
		expect(await callAs(["ten_a"], "ten_a")).toEqual([{ name: "list_deals", args: {} }]);
	});

	it("serves any tenant under *", async () => {
		expect(await callAs(["*"], "ten_b")).toHaveLength(1);
	});

	it.each([
		["another tenant", ["ten_a"], "ten_b"],
		["a caller with no tenant", ["ten_a"], "none"],
		["anyone when none are listed", [], "ten_a"],
	])("never reaches the server for %s", async (_name, tenants, token) => {
		expect(await callAs(tenants, token)).toEqual([]);
	});
});
