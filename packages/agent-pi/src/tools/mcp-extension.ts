import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { toLlmContent } from "@earendil-works/pi-mcp";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { GrantBroker } from "../auth/grants.ts";
import type { McpCaller, McpManager } from "../mcp/manager.ts";
import type { CatalogEntry } from "./catalog.ts";

export function mcpExtensionName(server: string): string {
	return `mcp.${server}`;
}

/**
 * One extension per MCP server, holding every tool the server lists. Installing it costs nothing per request: a
 * conversation is offered only the tools named in its `pi.agent.tools`.
 */
export function mcpExtension(
	server: string,
	entries: readonly CatalogEntry[],
	manager: McpManager,
	grants: GrantBroker | undefined,
): Extension {
	return defineExtension({ name: mcpExtensionName(server), tools: entries.map((entry) => mcpTool(entry, manager, grants)) });
}

/** Tool calls run under the conversation's grant, whether the user is online or not. */
function grantCaller(grants: GrantBroker, conversationId: ConversationId): McpCaller {
	return {
		key: async () => (await grants.grantOf(conversationId))?.grantId,
		token: () => grants.token(conversationId),
	};
}

function mcpTool(entry: CatalogEntry, manager: McpManager, grants: GrantBroker | undefined): ToolRegistration {
	const schema = entry.inputSchema as { properties?: Record<string, unknown> };
	return defineTool({
		name: entry.name,
		description: entry.description,
		// Providers require an object schema, and some reject one without `properties`.
		parameters: Type.Unsafe<Record<string, unknown>>({
			...entry.inputSchema,
			type: "object",
			properties: schema.properties ?? {},
		}),
		// MCP calls may have effects; a crash mid-call reports `interrupted` rather than calling twice.
		replay: "unsafe",
		execute: async (args, api, context) => {
			try {
				const caller = grants === undefined ? undefined : grantCaller(grants, api.conversationId);
				const result = await manager.callTool(entry, args, caller, context.abortSignal);
				// MCP reports tool failures in the result, not as protocol errors.
				return { output: toLlmContent(result), isError: result.isError === true };
			} catch (error) {
				if (context.abortSignal?.aborted) throw error;
				return { output: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
			}
		},
	});
}
