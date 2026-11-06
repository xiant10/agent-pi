import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Principal } from "../src/auth/authenticator.ts";
import type { GrantsConfig } from "../src/auth/grants.ts";
import { ToolCatalog } from "../src/tools/catalog.ts";
import { type TenantConnectorRecord, tenantTools } from "../src/tools/tenant.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall, rpc, rpcStream, startTestAgent, type TestAgent } from "../src/testing.ts";

const crm = (id: string, tools: string[]): TenantConnectorRecord => ({
	id,
	name: "crm",
	title: "CRM",
	version: 1,
	tools: tools.map((name) => ({ name, description: `CRM ${name} for the account`, input_schema: { type: "object", properties: { text: { type: "string" } } } })),
});

function listen(server: Server): Promise<string> {
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

describe("tenantTools", () => {
	it("offers a tenant's tools as <name>_<tool>, never over a platform tool", () => {
		const base = new ToolCatalog();
		base.setServer("collab", [{ name: "crm_whoami", server: "collab", mcpName: "x", description: "platform", inputSchema: {} }]);
		const tools = tenantTools(base, [crm("con_a", ["whoami", "echo"])]);
		expect(tools.catalog.own().map((entry) => entry.name)).toEqual(["crm_echo"]);
		expect(tools.catalog.get("crm_whoami")?.server).toBe("collab");
		expect(tools.catalog.match(["crm:*"])).toEqual(["crm_echo"]);
		expect(tools.catalog.search("echo account", 3)[0]?.entry.name).toBe("crm_echo");
		expect(tools.connectors.get("crm")).toBe("con_a");
	});
});

describe("tenant connectors in a running agent", () => {
	let running: TestAgent | undefined;
	const servers: Server[] = [];
	afterEach(async () => {
		await running?.close();
		running = undefined;
		await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
	});

	it("gives each tenant only its own connector's tools, and calls them through the gateway under the run's grant", async () => {
		const published: Record<string, TenantConnectorRecord[]> = { ten_acme: [crm("con_a", ["whoami", "echo"])], ten_globex: [crm("con_b", ["whoami"])] };
		const control = createServer((req, res) => {
			const url = new URL(req.url!, "http://control");
			if (req.headers.authorization !== "Bearer service-token") return void res.writeHead(403).end();
			if (url.pathname === "/v1/runtime/skills/changes") return void setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end('{"cursor":0,"tenants":[]}'), 50);
			if (url.pathname === "/v1/runtime/skills") return void res.writeHead(200, { "content-type": "application/json" }).end('{"skills":[]}');
			if (url.pathname === "/v1/runtime/connectors") {
				return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ connectors: published[url.searchParams.get("tenant")!] ?? [] }));
			}
			res.writeHead(404).end();
		});
		servers.push(control);
		const calls: { path: string; authorization: string | undefined; tool: string }[] = [];
		const gateway = createServer((req, res) => {
			if (req.method !== "POST") return void res.writeHead(405).end();
			let body = "";
			req.on("data", (chunk) => (body += chunk));
			req.on("end", () => {
				const message = JSON.parse(body) as { id?: number; method: string; params?: { name?: string } };
				if (message.id === undefined) return void res.writeHead(202).end();
				let result: unknown = {};
				if (message.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "gateway", version: "1" } };
				if (message.method === "tools/call") {
					calls.push({ path: req.url!, authorization: req.headers.authorization, tool: message.params!.name! });
					result = { content: [{ type: "text", text: `answered at ${req.url}` }] };
				}
				res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
			});
		});
		servers.push(gateway);
		const [controlUrl, gatewayUrl] = await Promise.all([listen(control), listen(gateway)]);

		const grants: GrantsConfig = { url: "http://auth.test", clientId: "agent-pi", clientSecret: "secret", actions: ["agent:use"], audiences: ["agent-pi"] };
		const authFetch = (async (input: string | URL | Request) => {
			const path = new URL(String(input)).pathname;
			if (path === "/v1/token") return Response.json({ access_token: "service-token", expires_in: 300 });
			if (path === "/v1/grants") return Response.json({ id: "grt_1" }, { status: 201 });
			return Response.json({ chain: [{ id: "grt_1" }] });
		}) as typeof fetch;
		const person = (tenantId: string, token: string): Principal => ({ userId: "ada", tenantId, scopes: ["agent:use"], claims: {}, token });
		const principals: Record<string, Principal> = { acme: person("ten_acme", "acme"), globex: person("ten_globex", "globex") };
		running = await startTestAgent({
			config: {
				auth: { kind: "jwt", algorithms: ["HS256"], hmacSecret: "unused", issuer: [], audience: [] },
				grants,
				tenantSkills: { url: controlUrl },
				tenantConnectors: { gatewayUrl: `${gatewayUrl}/` },
			},
			grantOptions: { fetch: authFetch, retryDelayMs: 1 },
			authenticator: { authenticate: async ({ headers }) => principals[String(headers.authorization).slice("Bearer ".length)]! },
		});

		const tools = async (token: string) =>
			((await rpc(running!.url, token, "skills.tools")).body.result!.tools as { name: string }[]).map((tool) => tool.name);
		expect(await tools("acme")).toEqual(expect.arrayContaining(["crm_whoami", "crm_echo"]));
		expect(await tools("globex")).toContain("crm_whoami");
		expect(await tools("globex")).not.toContain("crm_echo");

		const ask = async (token: string, tool: string) => {
			running!.faux.setResponses([
				() => {
					return fauxAssistantMessage([fauxToolCall("search_tools", { query: "echo the account" })], { stopReason: "toolUse" });
				},
				() => {
					return fauxAssistantMessage([fauxToolCall(tool, { text: "hi" })], { stopReason: "toolUse" });
				},
				(context) => {
					const result = context.messages.at(-1);
					return fauxAssistantMessage([fauxText(result?.role === "toolResult" ? result.content.map((block) => ("text" in block ? block.text : "")).join("") : "none")]);
				},
			]);
			const sessionId = (await rpc(running!.url, token, "session.create", {})).body.result!.sessionId as string;
			await rpcStream(running!.url, token, "session.prompt", { sessionId, input: "please look this up" });
			const transcript = JSON.stringify((await rpc(running!.url, token, "session.messages", { sessionId })).body.result);
			return { transcript };
		};

		const acme = await ask("acme", "crm_echo");
		expect(acme.transcript).toContain(`"name":"crm_echo","isError":false`);
		expect(acme.transcript).toContain("answered at /mcp/connector/con_a");
		expect(calls.at(-1)).toMatchObject({ path: "/mcp/connector/con_a", tool: "echo" });
		expect(calls.at(-1)?.authorization).toMatch(/^Bearer /);

		// Globex has a crm too, without echo: the name finds nothing there, and its whoami goes to its own connector.
		const globex = await ask("globex", "crm_echo");
		expect(globex.transcript).not.toContain("answered at");
		expect(calls).toHaveLength(1);
		await ask("globex", "crm_whoami");
		expect(calls.at(-1)).toMatchObject({ path: "/mcp/connector/con_b", tool: "whoami" });
	});
});
