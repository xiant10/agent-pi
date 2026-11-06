import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type AgentState,
	defineExtension,
	defineTool,
	type Extension,
	type ToolExecutionApi,
	type ToolRegistration,
	type Tx,
} from "@earendil-works/pi-durable";
import { type CallToolResult, toLlmContent } from "@earendil-works/pi-mcp";
import type { ConversationId } from "@earendil-works/pi-durable";
import { readSession } from "../agent/docs.ts";
import type { GrantBroker } from "../auth/grants.ts";
import { HOPS_META, TURN_META, workTurn } from "../identity.ts";
import type { McpCaller, McpManager } from "../mcp/manager.ts";
import type { CatalogEntry } from "./catalog.ts";
import type { TenantTools } from "./tenant.ts";

export function mcpExtensionName(server: string): string {
	return `mcp.${server}`;
}

const TENANT_EXTENSION = "tenant.";

/** A tenant's own connector tools: selected only by that tenant's conversations, never by default. */
export function tenantExtensionName(tenantId: string): string {
	return `${TENANT_EXTENSION}${tenantId}`;
}

export function isTenantExtension(name: string): boolean {
	return name.startsWith(TENANT_EXTENSION);
}

type Selection = { readonly extensions?: unknown } | undefined;

/** Whether a conversation's agent already adds its tenant's extension to the default selection. */
export function selectsTenant(agent: Selection, tenantId: string): boolean {
	const selected = agent?.extensions as AgentState["extensions"];
	return Array.isArray(selected) || (selected?.add?.includes(tenantExtensionName(tenantId)) ?? false);
}

/** Add a tenant's extension to a conversation's selection. An exact selection, which nothing here sets, is left alone. */
export async function selectTenantExtension(tx: Tx, conversationId: ConversationId, tenantId: string): Promise<void> {
	const agent = (await tx.doc(AgentDoc, conversationId)) as { extensions?: AgentState["extensions"] };
	if (selectsTenant(agent, tenantId)) return;
	const current = agent.extensions as { add?: string[]; remove?: string[] } | undefined;
	agent.extensions = { ...current, add: [...(current?.add ?? []), tenantExtensionName(tenantId)] };
}

/**
 * One tenant's connector tools, each calling the tool gateway at `gatewayUrl/mcp/connector/<id>` under the
 * conversation's grant. Another tenant's conversation never selects this extension, and the gateway checks the run's
 * token against the connector's tenant on every call regardless.
 */
export function tenantExtension(
	tenantId: string,
	tools: TenantTools,
	manager: McpManager,
	grants: GrantBroker | undefined,
	gatewayUrl: string,
): Extension {
	const base = gatewayUrl.replace(/\/+$/, "");
	return defineExtension({
		name: tenantExtensionName(tenantId),
		tools: tools.catalog.own().map((entry) =>
			mcpTool(entry, async (args, api, context) => {
				const session = await readSession(api, api.conversationId, context);
				// A forged or stale call from another tenant's conversation can't reach this tenant's connector.
				if (session?.tenantId !== tenantId) {
					return { content: [{ type: "text", text: "This tool isn't available to this tenant." }], isError: true };
				}
				const id = tools.connectors.get(entry.server);
				if (id === undefined || grants === undefined) throw new Error(`${entry.name} isn't available right now.`);
				return manager.callConnector(`${base}/mcp/connector/${encodeURIComponent(id)}`, id, entry, args, grantCaller(grants, api.conversationId), context.abortSignal);
			}),
		),
	});
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
	return defineExtension({
		name: mcpExtensionName(server),
		tools: entries.map((entry) =>
			mcpTool(entry, async (args, api, context) => {
				const session = await readSession(api, api.conversationId, context);
				if (!manager.allowsTenant(entry, session?.tenantId)) {
					return { content: [{ type: "text", text: "This tool isn't available to this tenant." }], isError: true };
				}
				const caller = grants === undefined ? undefined : grantCaller(grants, api.conversationId);
				return manager.callTool(entry, args, caller, context.abortSignal, () => callMeta(api, context));
			}),
		),
	});
}

/** Tool calls run under the conversation's grant, whether the user is online or not. */
function grantCaller(grants: GrantBroker, conversationId: ConversationId): McpCaller {
	return {
		key: async () => (await grants.grantOf(conversationId))?.grantId,
		token: () => grants.token(conversationId),
	};
}

/** What an agent we call needs to stay in this turn's trace and count the hops. */
async function callMeta(api: ToolExecutionApi, context: Context): Promise<Record<string, unknown>> {
	const session = await readSession(api, api.conversationId, context);
	const turn = await workTurn(api, api.conversationId, session, context);
	const hops = session?.metadata?.[HOPS_META];
	return {
		...(turn?.traceparent === undefined ? {} : { traceparent: turn.traceparent }),
		...(turn === undefined ? {} : { [TURN_META]: turn.turnId }),
		[HOPS_META]: (typeof hops === "number" ? hops : 0) + 1,
	};
}

function mcpTool(entry: CatalogEntry, run: (args: Record<string, unknown>, api: ToolExecutionApi, context: Context) => Promise<CallToolResult>): ToolRegistration {
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
				const result = await run(args, api, context);
				// MCP reports tool failures in the result, not as protocol errors.
				return { output: toLlmContent(result), isError: result.isError === true };
			} catch (error) {
				if (context.abortSignal?.aborted) throw error;
				return { output: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
			}
		},
	});
}
