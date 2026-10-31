import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import type { ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	AssistantEntry,
	configure,
	type ConversationId,
	defineTool,
	type ModelRef,
	ProviderDoc,
	type Submission,
	type ToolExecutionApi,
	type ToolRegistration,
	UsageDoc,
} from "@earendil-works/pi-durable";
import type { CredentialStore } from "../auth/credentials.ts";
import type { GrantBroker } from "../auth/grants.ts";
import type { ToolCatalog } from "../tools/catalog.ts";
import { readSession, SessionDoc, type SessionState } from "./docs.ts";
import { META_TOOLS } from "./profiles.ts";

/** The catalog server holding every sub-agent's tool. Their code is in `agent.core`, not an MCP proxy. */
export const SUBAGENT_SERVER = "agents";
export const SUBAGENT_PREFIX = "agent_";

/** A parent keeps this many child ids, newest last, for `session.get`. */
const MAX_LISTED = 20;

const DEFAULT_TIMEOUT_MS = 300_000;

/** A sub-agent the config declares. */
export type Subagent = {
	readonly name: string;
	readonly description: string;
	readonly model: ModelRef;
	readonly thinkingLevel: ModelThinkingLevel;
	readonly instructions?: string;
	/** Catalog patterns, plus meta-tools by name: the child's starting tool set. */
	readonly tools: readonly string[];
	readonly timeoutMs?: number;
};

/** One delegated task. */
type ChildSpec = {
	readonly label: string;
	readonly requestId: string;
	readonly model: ModelRef;
	readonly thinkingLevel: ModelThinkingLevel;
	readonly instructions?: string;
	/** The child's tools given the set it copied from its parent. */
	readonly tools: (inherited: readonly string[]) => string[];
	readonly timeoutMs?: number;
};

export type ChildDeps = {
	readonly credentials: CredentialStore;
	readonly grants?: GrantBroker;
	readonly slots: ChildSlots;
	/** Whether this process is stopping, so running children will resume in the next one. */
	readonly stopping: () => boolean;
};

/** Children running per session, in memory like `RunTracker`: resumed children count once their parent's tool reruns. */
export class ChildSlots {
	readonly #max: number;
	readonly #running = new Map<ConversationId, number>();

	constructor(max: number) {
		this.#max = max;
	}

	/** A release function, or undefined when the session is at its limit. */
	take(conversationId: ConversationId): (() => void) | undefined {
		const running = this.#running.get(conversationId) ?? 0;
		if (running >= this.#max) return undefined;
		this.#running.set(conversationId, running + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const left = (this.#running.get(conversationId) ?? 1) - 1;
			if (left > 0) this.#running.set(conversationId, left);
			else this.#running.delete(conversationId);
		};
	}
}

function failure(text: string) {
	return { isError: true, output: [{ type: "text" as const, text }] };
}

/**
 * Run `task` in a child conversation owned by this tool call, so aborting the call aborts the child. The child is a
 * session with a `parent`: its profile, grant, and identity survive a restart the way any session's do.
 */
export async function runChild(deps: ChildDeps, api: ToolExecutionApi, spec: ChildSpec, task: string, context: Context) {
	const parent = await readSession(api, api.conversationId, context);
	if (parent === undefined || parent.parent !== undefined) return failure("A sub-agent cannot delegate to another agent.");
	const release = deps.slots.take(api.conversationId);
	if (release === undefined) return failure(`Too many ${spec.label}s are running. Wait for one to finish, then try again.`);
	let child: ConversationId | undefined;
	try {
		child = await api.commit(async (tx) => {
			const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
			if (existing !== undefined) return existing.id;
			const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
			await configure(tx, created.id, {
				model: spec.model,
				thinkingLevel: spec.thinkingLevel,
				...(spec.instructions === undefined ? {} : { instructions: spec.instructions }),
			});
			const agent = await tx.doc(AgentDoc, created.id);
			agent.tools = spec.tools(Array.isArray(agent.tools) ? agent.tools : []);
			Object.assign(await tx.doc(SessionDoc, created.id), childSession(parent, api.conversationId));
			await tx.doc(ProviderDoc, created.id);
			const listed = await tx.doc(SessionDoc, api.conversationId);
			listed.subagents = [...(listed.subagents ?? []), created.id].slice(-MAX_LISTED);
			return created.id;
		}, context);
		deps.credentials.inherit(child, api.conversationId);
		const grant = await deps.grants?.spawn(child, api.conversationId);
		if (grant !== undefined) {
			const id = child;
			await api.commit(async (tx) => {
				(await tx.doc(SessionDoc, id)).grantId = grant.grantId;
			}, context);
		}
		await api.details({ conversationId: child }, context);
		const handle = await api.conversation(child, context);
		if (handle === undefined) throw new Error(`${spec.label} conversation vanished`);
		const submission = await handle.submit({ type: "input", content: task, requestId: spec.requestId }, context);
		let timedOut = false;
		const timer =
			spec.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						timedOut = true;
						void handle.abort(context).catch(() => undefined);
					}, spec.timeoutMs);
		timer?.unref();
		let settled: Awaited<ReturnType<Submission["wait"]>>;
		try {
			settled = await submission.wait(context);
		} finally {
			clearTimeout(timer);
		}
		const usage = await childUsage(api, child, context);
		const spent = usage === undefined ? {} : { usage };
		if (timedOut) return { ...failure(`The ${spec.label} ran out of time.`), ...spent };
		if (settled.status !== "done" || settled.type !== "input") {
			return { ...failure(`The ${spec.label} could not answer (${settled.reason ?? settled.status}).`), ...spent };
		}
		const answer = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		return { output: [{ type: "text" as const, text: assistantText(answer?.model?.[0]) || "(no answer)" }], ...spent };
	} finally {
		release();
		if (child !== undefined) {
			deps.credentials.delete(child);
			// A stop looks like an abort from here, but only a stopped child resumes, and it needs its grant.
			if (!deps.stopping()) await deps.grants?.release(child);
		}
	}
}

/** A child's session: its parent's owner and profile, none of its grant or children. */
function childSession(parent: Readonly<SessionState>, parentId: ConversationId): SessionState {
	const { grantId: _grantId, grantParent: _grantParent, subagents: _subagents, ...inherited } = parent;
	return { ...inherited, parent: parentId, createdAt: Date.now() };
}

/** The child's whole spend, for the tool result. Durable records it under the tool's name in the parent's usage. */
async function childUsage(api: ToolExecutionApi, child: ConversationId, context: Context): Promise<Usage | undefined> {
	const state = await api.snapshot(UsageDoc, child, context);
	const buckets = [...Object.values(state?.models ?? {}), ...Object.values(state?.tools ?? {})] as unknown as Usage[];
	if (buckets.length === 0) return undefined;
	const total: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const usage of buckets) {
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.totalTokens += usage.totalTokens;
		total.cost.input += usage.cost.input;
		total.cost.output += usage.cost.output;
		total.cost.cacheRead += usage.cost.cacheRead;
		total.cost.cacheWrite += usage.cost.cacheWrite;
		total.cost.total += usage.cost.total;
	}
	return total;
}

/** The tool of a declared sub-agent. A rerun after a crash finds the same child, submission, and grant. */
export function subagentTool(subagent: Subagent, catalog: ToolCatalog, deps: ChildDeps): ToolRegistration {
	return defineTool({
		name: subagentToolName(subagent),
		description: subagent.description,
		parameters: SUBAGENT_PARAMETERS,
		replay: "safe",
		execute: (args, api, context) =>
			runChild(
				deps,
				api,
				{
					label: `${subagent.name} agent`,
					requestId: `subagent:${api.taskId}`,
					model: subagent.model,
					thinkingLevel: subagent.thinkingLevel,
					...(subagent.instructions === undefined ? {} : { instructions: subagent.instructions }),
					tools: () => startingTools(subagent, catalog),
					timeoutMs: subagent.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				},
				args.task,
				context,
			),
	});
}

export const SUBAGENT_PARAMETERS = Type.Object({
	task: Type.String({ description: "The whole task, with every fact needed to do it. The agent cannot see this conversation." }),
});

export function subagentToolName(subagent: Pick<Subagent, "name">): string {
	return `${SUBAGENT_PREFIX}${subagent.name}`;
}

function startingTools(subagent: Subagent, catalog: ToolCatalog): string[] {
	const agents = new Set(catalog.entries(SUBAGENT_SERVER).map((entry) => entry.name));
	const meta = META_TOOLS.filter((name) => subagent.tools.includes(name));
	return [...meta, ...catalog.match(subagent.tools).filter((name) => !agents.has(name))];
}

/** Text blocks of an assistant message, joined. */
export function assistantText(message: { readonly role: string; readonly content?: unknown } | undefined): string {
	if (message === undefined || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}
