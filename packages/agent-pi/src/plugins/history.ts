import type { Context, JsonValue } from "@earendil-works/chord";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import {
	ConversationBusy,
	type ConversationId,
	defineDoc,
	defineDocFamily,
	defineEntry,
	type EntryDraft,
	type Harness,
	InboxDoc,
	type JsonObject,
	LiveDoc,
	type Tx,
	type UserInput,
} from "@earendil-works/pi-durable";
import type { PluginState, SessionHistory } from "./types.ts";

/** A message written by a plugin, not the model; `model` holds one user or assistant message, which the model sees. */
export const MessageEntry = defineEntry<{ source: string }>("app.message");

/** A plugin record outside the model's context: for UIs, audits, and other plugins. */
export const RecordEntry = defineEntry<{ source: string; type: string; data: JsonValue }>("app.record");

/** Each plugin's state in a conversation, keyed by plugin name. */
export const PluginStateDoc = defineDocFamily<{ value?: JsonValue } & JsonObject, null>({
	kind: "app.plugin-state",
	version: 1,
	family: true,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({}),
	checkpointWhen: () => false,
});

/** A plugin's answer to an input: who wrote it, and whether it is in the transcript or queued for the next boundary. */
export type ReplyRecord = {
	readonly plugin: string;
	readonly text: string;
	readonly placement: "placed" | "queued";
	/** The turn the input started, so a retry reports the same one. */
	readonly turnId: string;
};

/**
 * Plugin replies by the `requestId` of the input they answered, so a retried prompt gets the same reply instead of a
 * second exchange. Model runs need no entry here: durable dedupes their submissions by `requestId`.
 */
export const ReplyRequestsDoc = defineDoc<{ replies: Record<string, ReplyRecord> } & JsonObject>({
	kind: "app.replies",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ replies: {} }),
	checkpointWhen: () => false,
});

/** Most remembered reply request ids per conversation; a client retries within seconds, not hundreds of turns. */
const MAX_REMEMBERED_REPLIES = 100;

/** Provider fields of messages no provider produced; `usage` is zero, so spend reports stay exact. */
const PLUGIN_API = "agent-pi.plugin";

export function assistantMessage(text: string, source: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: PLUGIN_API,
		provider: "agent-pi",
		model: `plugin:${source}`,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export function userMessage(input: UserInput): UserMessage {
	return { role: "user", content: typeof input === "string" ? input : [...input], timestamp: Date.now() };
}

/**
 * Append entries to a conversation without asking the model. One entry per message, because clients' events follow
 * each entry's first message.
 *
 * Idle: appended in one commit, in order. Busy: admitted as write submissions, which the harness places at the next
 * boundary, so a running tool round is never split; one without a model message (a `record`) is appended at once.
 */
export async function appendWithoutModel(
	harness: Harness,
	conversationId: ConversationId,
	drafts: readonly EntryDraft[],
	context: Context,
): Promise<void> {
	const conversation = await requireConversation(harness, conversationId, context);
	const appended = await conversation.commit(async (tx) => {
		if (!(await isIdle(tx, conversationId))) return false;
		for (const draft of drafts) await tx.appendEntry(conversationId, draft);
		return true;
	}, context);
	if (appended) return;
	for (const entry of drafts) await conversation.submit({ type: "write", entry }, context);
}

/**
 * Write a plugin's answer to `input` as a user and an assistant entry, like `appendWithoutModel`. With a `requestId`,
 * a retry returns the first reply and writes nothing: the idle path checks and remembers in its one commit, and the
 * busy path's write submissions carry request ids of their own, which durable dedupes.
 */
export async function appendReply(
	harness: Harness,
	conversationId: ConversationId,
	reply: { readonly input: UserInput; readonly text: string; readonly plugin: string; readonly turnId: string; readonly requestId?: string },
	context: Context,
	whenBusy: "queue" | "reject",
): Promise<ReplyRecord & { readonly duplicate: boolean }> {
	const { requestId, plugin, text, turnId } = reply;
	const drafts: EntryDraft[] = [
		{ kind: MessageEntry.kind, model: [userMessage(reply.input)], data: { source: plugin } },
		{ kind: MessageEntry.kind, model: [assistantMessage(text, plugin)], data: { source: plugin } },
	];
	const conversation = await requireConversation(harness, conversationId, context);
	const placed = await conversation.commit(async (tx) => {
		const requests = await tx.doc(ReplyRequestsDoc, conversationId);
		const earlier = requestId === undefined ? undefined : requests.replies[requestId];
		if (earlier !== undefined) return { ...earlier, duplicate: true };
		if (!(await isIdle(tx, conversationId))) return undefined;
		for (const draft of drafts) await tx.appendEntry(conversationId, draft);
		const record: ReplyRecord = { plugin, text, placement: "placed", turnId };
		if (requestId !== undefined) remember(requests, requestId, record);
		return { ...record, duplicate: false };
	}, context);
	if (placed !== undefined) return placed;
	if (whenBusy === "reject") throw new ConversationBusy(conversationId);
	// Submitted before remembering: a retry in between resubmits the same request ids, which durable ignores.
	for (const [index, entry] of drafts.entries()) {
		await conversation.submit({ type: "write", entry, ...(requestId === undefined ? {} : { requestId: `${requestId}#${index}` }) }, context);
	}
	const record: ReplyRecord = { plugin, text, placement: "queued", turnId };
	if (requestId !== undefined) {
		await conversation.commit(async (tx) => remember(await tx.doc(ReplyRequestsDoc, conversationId), requestId, record), context);
	}
	return { ...record, duplicate: false };
}

async function requireConversation(harness: Harness, conversationId: ConversationId, context: Context) {
	const conversation = await harness.conversation(conversationId, context);
	if (conversation === undefined) throw new Error(`conversation ${conversationId} does not exist`);
	return conversation;
}

/** No run, and nothing queued that would be placed before these entries. */
async function isIdle(tx: Tx, conversationId: ConversationId): Promise<boolean> {
	const live = await tx.doc(LiveDoc, conversationId);
	const inbox = await tx.doc(InboxDoc, conversationId);
	return live.run === undefined && inbox.items.length === 0;
}

function remember(requests: { replies: Record<string, ReplyRecord> }, requestId: string, record: ReplyRecord): void {
	const replies = { ...requests.replies, [requestId]: record };
	const ids = Object.keys(replies);
	for (const id of ids.slice(0, Math.max(0, ids.length - MAX_REMEMBERED_REPLIES))) delete replies[id];
	requests.replies = replies;
}

export function sessionHistory(harness: Harness, conversationId: ConversationId, source: string, context: Context): SessionHistory {
	const message = (model: UserMessage | AssistantMessage): EntryDraft => ({
		kind: MessageEntry.kind,
		model: [model],
		data: { source },
	});
	return {
		say: (text) => appendWithoutModel(harness, conversationId, [message(assistantMessage(text, source))], context),
		exchange: (input, answer) =>
			appendWithoutModel(
				harness,
				conversationId,
				[message(userMessage(input)), message(assistantMessage(answer, source))],
				context,
			),
		record: (type, data) =>
			appendWithoutModel(harness, conversationId, [{ kind: RecordEntry.kind, data: { source, type, data } }], context),
	};
}

export function pluginState(harness: Harness, conversationId: ConversationId, plugin: string, context: Context): PluginState {
	return {
		get: async <T extends JsonValue>() =>
			(await harness.snapshot(PluginStateDoc, conversationId, plugin, context))?.value as T | undefined,
		set: async (value) => {
			await harness.commit(async (tx) => {
				(await tx.doc(PluginStateDoc, conversationId, plugin, null)).value = value;
			}, context);
		},
	};
}
