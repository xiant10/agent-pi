import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { McpManager } from "../src/mcp/manager.ts";
import { ToolCatalog } from "../src/tools/catalog.ts";
import { SILENT_LOGGER } from "../src/util/log.ts";

describe("headers of one grant call", () => {
	const closing: (() => unknown)[] = [];
	afterEach(async () => {
		for (const close of closing.splice(0)) await close();
	});

	it("reach that call's request, not a shared connection's others", async () => {
		const calls: { method: string; headers: IncomingHttpHeaders }[] = [];
		const server = createServer((req, res) => {
			if (req.method !== "POST") return void res.writeHead(405).end();
			let raw = "";
			req.on("data", (part) => (raw += part));
			req.on("end", () => {
				const message = JSON.parse(raw) as { id?: number; method: string };
				calls.push({ method: message.method, headers: req.headers });
				if (message.id === undefined) return void res.writeHead(202).end();
				const result =
					message.method === "initialize"
						? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "gateway", version: "1" } }
						: message.method === "tools/list"
							? { tools: [{ name: "t", description: "t", inputSchema: { type: "object", properties: {} } }] }
							: { content: [] };
				res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
			});
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		closing.push(() => server.close());
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

		const catalog = new ToolCatalog();
		const manager = new McpManager([{ name: "gateway", transport: "http", url, auth: "grant" }], { catalog, log: SILENT_LOGGER });
		closing.push(() => manager.close());
		await manager.start();
		const entry = catalog.entries("gateway")[0]!;
		const caller = (session: string) => ({
			key: async () => "grant-1",
			token: async () => "token",
			callHeaders: async () => ({ "X-Session-ID": session, traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01` }),
		});

		await manager.callTool(entry, {}, caller("one"), undefined);
		await manager.callTool(entry, {}, caller("two"), undefined);

		const sent = calls.filter((call) => call.method === "tools/call");
		expect(sent.map((call) => call.headers["x-session-id"])).toEqual(["one", "two"]);
		expect(sent[0]!.headers.traceparent).toBe(`00-${"a".repeat(32)}-${"b".repeat(16)}-01`);
		expect(sent[0]!.headers.authorization).toBe("Bearer token");
		const setup = calls.find((call) => call.method === "initialize" && call.headers.authorization !== undefined);
		expect(setup!.headers["x-session-id"]).toBeUndefined();
	});
});
