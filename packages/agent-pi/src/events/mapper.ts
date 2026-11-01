import { randomBytes } from "node:crypto";
import type { AgentEvent, MessageChange, SnapshotEvent } from "@earendil-works/pi-durable";
import { SpeechSegmenter } from "./speech.ts";

/** Kind of the entries plugins write without the model (`plugins/history.ts`). */
const MESSAGE_ENTRY = "app.message";

export type TaskStatus = { taskId: string; name: string; status: string };

/** Which reply a text event belongs to. `turnId` is absent when no turn is known, as for a plugin's message. */
export type MessageRef = { turnId?: string; messageId: string };

/** The reply in progress: everything sent so far, so a client that missed deltas can pick up from `offset` `text.length`. */
export type PartialMessage = MessageRef & { text: string };

/** What a client receives in each `session/event` notification. */
export type ClientEventBody =
	| { type: "snapshot"; busy: boolean; activeTools: string[]; inbox: { id: number; mode: string }[]; tasks: TaskStatus[]; partial?: PartialMessage }
	| { type: "run.started"; submissionIds: number[] }
	| { type: "run.finished"; submissionIds: number[] }
	/** `offset`: where `text` starts in the message's text, to spot a gap or a duplicate. */
	| ({ type: "text.delta"; text: string; offset: number } & Partial<MessageRef>)
	| { type: "speech"; text: string; index: number }
	| { type: "thinking.delta"; text: string }
	/** `source`: the plugin that wrote the message without the model; absent for model answers. */
	| ({ type: "message.end"; text: string; stopReason: string; error?: string; source?: string } & Partial<MessageRef>)
	| { type: "tool.started"; callId: string; name: string }
	| { type: "tool.finished"; callId: string; name: string; isError: boolean }
	| { type: "tools.active"; names: string[] }
	/** A background task started or changed status. */
	| ({ type: "task.updated" } & TaskStatus)
	| { type: "inbox"; items: { id: number; mode: string }[] }
	| { type: "submission"; submissionId: number; status: string; reason?: string; detail?: string }
	| { type: "retry"; attempt: number; at: number; error: string }
	| { type: "compaction"; phase: "start" | "end" }
	| { type: "error"; message: string };

export type MapperOptions = { readonly speech: boolean; readonly thinking: boolean };

type Block = { type: string; text?: string; thinking?: string };

/**
 * Turns pi-durable agent events into client events. It mirrors the in-flight assistant message to derive plain text
 * deltas, whatever shape a change arrives in (delta, whole block, or whole message), and feeds them to a speech
 * segmenter. Text is emitted once: a resync snapshot re-seeds the mirror without repeating what was sent.
 */
export class EventMapper {
	readonly #options: MapperOptions;
	readonly #speech = new SpeechSegmenter();
	#blocks: Block[] = [];
	#emitted = "";
	#speechIndex = 0;
	#tools: string[] | undefined;
	#messageId: string | undefined;
	#turnId: string | undefined;

	constructor(options: MapperOptions) {
		this.#options = options;
	}

	/** Set the turn of the message about to start, or of the one a snapshot is about to seed. */
	setTurn(turnId: string | undefined): void {
		this.#turnId = turnId;
	}

	/** The reply in progress, if any. */
	get partial(): PartialMessage | undefined {
		return this.#messageId === undefined ? undefined : { ...this.#ref(), text: this.#emitted };
	}

	/** Seed from the stream's attachment snapshot; returns the client snapshot. */
	seed(snapshot: SnapshotEvent): ClientEventBody {
		const partial = snapshot.generation?.message;
		this.#blocks = partial === undefined ? [] : copyBlocks(partial.content);
		this.#emitted = textOf(this.#blocks);
		// A resync of the message already in flight keeps its id, so a client sees one message.
		this.#messageId = partial === undefined ? undefined : (this.#messageId ?? newMessageId());
		this.#speech.reset();
		this.#tools = Array.isArray(snapshot.agent.tools) ? [...snapshot.agent.tools] : undefined;
		const inFlight = this.partial;
		return {
			type: "snapshot",
			busy: snapshot.run !== undefined,
			activeTools: this.#tools ?? [],
			inbox: snapshot.inbox.map((item) => ({ id: item.id, mode: item.mode })),
			tasks: [],
			...(inFlight === undefined ? {} : { partial: inFlight }),
		};
	}

	map(event: AgentEvent): ClientEventBody[] {
		const out: ClientEventBody[] = [];
		switch (event.type) {
			case "snapshot":
				out.push(this.seed(event));
				break;
			case "run_start":
				out.push({ type: "run.started", submissionIds: [...event.inputs] });
				break;
			case "run_end":
				this.#flushSpeech(out);
				this.#messageId = undefined;
				this.#turnId = undefined;
				out.push({ type: "run.finished", submissionIds: [...event.inputs] });
				break;
			case "message_start":
				if (event.message.role === "assistant") {
					this.#blocks = copyBlocks(event.message.content);
					this.#emitted = "";
					this.#messageId = newMessageId();
					this.#emitText(out);
				}
				break;
			case "message_update":
				for (const change of event.changes) this.#apply(change, out);
				this.#emitText(out);
				break;
			case "message_end": {
				const message = event.entry.model?.[0];
				if (message?.role !== "assistant") break;
				// A plugin's message has no `message_start`.
				this.#messageId ??= newMessageId();
				if (message.stopReason === "aborted" || message.stopReason === "error") {
					// Interrupted speech is not finished: the client stops playback, nothing more is spoken.
					this.#speech.reset();
				} else {
					this.#blocks = copyBlocks(message.content);
					this.#emitText(out);
					this.#flushSpeech(out);
				}
				const source = (event.entry.data as { source?: unknown } | undefined)?.source;
				out.push({
					type: "message.end",
					...this.#ref(),
					text: textOf(copyBlocks(message.content)),
					stopReason: message.stopReason,
					...(message.errorMessage === undefined ? {} : { error: message.errorMessage }),
					...(event.entry.kind === MESSAGE_ENTRY && typeof source === "string" ? { source } : {}),
				});
				this.#blocks = [];
				this.#emitted = "";
				this.#messageId = undefined;
				this.#turnId = undefined;
				break;
			}
			case "tool_execution_start":
				this.#flushSpeech(out);
				out.push({ type: "tool.started", callId: event.toolCallId, name: event.toolName });
				break;
			case "tool_execution_end": {
				const result = event.entry?.model?.[0];
				const isError = result === undefined || (result.role === "toolResult" && result.isError === true);
				out.push({ type: "tool.finished", callId: event.toolCallId, name: event.toolName, isError });
				break;
			}
			case "agent_changed": {
				const tools = Array.isArray(event.agent.tools) ? [...event.agent.tools] : undefined;
				if (tools !== undefined && !sameList(tools, this.#tools)) out.push({ type: "tools.active", names: tools });
				this.#tools = tools;
				break;
			}
			case "inbox_update":
				out.push({ type: "inbox", items: event.items.map((item) => ({ id: item.id, mode: item.mode })) });
				break;
			case "submission": {
				const record = event.record;
				out.push({
					type: "submission",
					submissionId: record.id,
					status: record.status,
					...(record.reason === undefined ? {} : { reason: record.reason }),
					...(typeof record.detail === "string" ? { detail: record.detail } : {}),
				});
				break;
			}
			case "auto_retry_start":
				out.push({ type: "retry", attempt: event.attempt, at: event.at, error: event.errorMessage });
				break;
			case "compaction_start":
				out.push({ type: "compaction", phase: "start" });
				break;
			case "compaction_end":
				out.push({ type: "compaction", phase: "end" });
				break;
			case "task_failed":
				out.push({ type: "error", message: `${event.kind}: ${event.message}` });
				break;
			default:
				break;
		}
		return out;
	}

	#apply(change: MessageChange, out: ClientEventBody[]): void {
		switch (change.type) {
			case "text_start":
			case "thinking_start":
			case "toolcall_start":
			case "block":
				this.#blocks[change.contentIndex] = { ...(change.block as Block) };
				break;
			case "text_delta": {
				const block = (this.#blocks[change.contentIndex] ??= { type: "text", text: "" });
				block.text = (block.text ?? "") + change.delta;
				break;
			}
			case "thinking_delta": {
				const block = (this.#blocks[change.contentIndex] ??= { type: "thinking", thinking: "" });
				block.thinking = (block.thinking ?? "") + change.delta;
				if (this.#options.thinking) out.push({ type: "thinking.delta", text: change.delta });
				break;
			}
			case "toolcall_delta":
				break;
			case "message":
				this.#blocks = copyBlocks(change.message.content);
				break;
		}
	}

	/** Emit the text not yet sent. If earlier text changed, which providers do not do, it is not repeated. */
	#emitText(out: ClientEventBody[]): void {
		const text = textOf(this.#blocks);
		if (text.length <= this.#emitted.length || !text.startsWith(this.#emitted)) {
			if (!text.startsWith(this.#emitted)) this.#emitted = text;
			return;
		}
		const offset = this.#emitted.length;
		const delta = text.slice(offset);
		this.#emitted = text;
		out.push({ type: "text.delta", ...this.#ref(), offset, text: delta });
		if (!this.#options.speech) return;
		for (const segment of this.#speech.push(delta)) out.push({ type: "speech", text: segment, index: this.#speechIndex++ });
	}

	#ref(): Partial<MessageRef> & { messageId: string } {
		return {
			...(this.#turnId === undefined ? {} : { turnId: this.#turnId }),
			messageId: this.#messageId ?? newMessageId(),
		};
	}

	#flushSpeech(out: ClientEventBody[]): void {
		if (!this.#options.speech) return;
		const segment = this.#speech.flush();
		if (segment !== undefined) out.push({ type: "speech", text: segment, index: this.#speechIndex++ });
	}
}

function newMessageId(): string {
	return `m${randomBytes(6).toString("hex")}`;
}

function copyBlocks(content: unknown): Block[] {
	if (!Array.isArray(content)) return [];
	return content.map((block) => ({ ...(block as Block) }));
}

/** Concatenated text blocks; thinking and tool calls are not text. */
function textOf(blocks: readonly Block[]): string {
	return blocks
		.filter((block) => block?.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}

function sameList(a: readonly string[], b: readonly string[] | undefined): boolean {
	return b !== undefined && a.length === b.length && a.every((value, index) => value === b[index]);
}
