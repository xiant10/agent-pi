import { CompactionEntry, type EntryRecord, ResetEntry, type UserInput } from "@earendil-works/pi-durable";
import { NOTE_ENTRY, REPORT_ENTRY, unmarked } from "./agent/tasks.ts";
import { MessageEntry } from "./plugins/history.ts";

/** Tokens, in the shape of pi-ai's `Usage` without its costs. */
export type Spent = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };

/**
 * One line of a conversation as a client shows it. Tool results carry no content: they can hold what a user may not read.
 * `at` is when the message was written, in Unix milliseconds; `model` is the model that wrote a reply. A user's `usage` is
 * what the turn it started spent, its tools' children included.
 */
export type TranscriptMessage =
	| { id: number; role: "user"; text: string; images?: number; turnId?: string; requestId?: string; at?: number; usage?: Spent }
	| { id: number; role: "assistant"; text: string; stopReason: string; error?: string; source?: string; at?: number; model?: string }
	| { id: number; role: "tool"; callId: string; name: string; isError: boolean }
	/** What a background task told its parent. Sent as a user message so the model reads it, but nobody said it. */
	| { id: number; role: "task"; kind: "report" | "note"; taskId: string; name: string; status?: string; text: string }
	| { id: number; role: "compaction" };

type Block = { type: string; text?: string };
type ModelMessage = {
	role: string;
	content?: string | readonly Block[];
	stopReason?: string;
	errorMessage?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	timestamp?: number;
	durationMs?: number;
	model?: string;
	usage?: Partial<Spent>;
};

const NOTE_OPEN = "<turn-note>";
const NOTE_CLOSE = "</turn-note>\n\n";

/** Puts a note ahead of what the person said, in a block of its own so the transcript can leave it out. */
export function withNote(input: UserInput, note: string): UserInput {
	const blocks = typeof input === "string" ? [{ type: "text" as const, text: input }] : input;
	return [{ type: "text", text: `${NOTE_OPEN}${note}${NOTE_CLOSE}` }, ...blocks];
}

function isNote(block: Block): boolean {
	return block.type === "text" && block.text !== undefined && block.text.startsWith(NOTE_OPEN) && block.text.endsWith(NOTE_CLOSE);
}

function textOf(content: ModelMessage["content"]): string {
	if (typeof content === "string") return content;
	const blocks = content ?? [];
	return blocks
		.filter((block, index) => block.type === "text" && !(index === 0 && blocks.length > 1 && isNote(block)))
		.map((block) => block.text ?? "")
		.join("");
}

/** The lines an entry adds. System and reset entries add none, nor does an assistant entry holding only tool calls. */
export function transcriptOf(entry: EntryRecord, inputs: ReadonlyMap<number, { turnId: string; requestId?: string }>): TranscriptMessage[] {
	if (CompactionEntry.is(entry)) return [{ id: entry.id, role: "compaction" }];
	if (ResetEntry.is(entry)) return [];
	const out: TranscriptMessage[] = [];
	const report = entry.kind === REPORT_ENTRY;
	if (report || entry.kind === NOTE_ENTRY) {
		const { taskId, name, status } = (entry.data ?? {}) as { taskId?: string; name?: string; status?: string };
		const text = unmarked(textOf(((entry.model ?? []) as readonly ModelMessage[])[0]?.content));
		return [{ id: entry.id, role: "task", kind: report ? "report" : "note", taskId: taskId ?? "", name: name ?? "", ...(status === undefined ? {} : { status }), text }];
	}
	for (const message of (entry.model ?? []) as readonly ModelMessage[]) {
		if (message.role === "user") {
			const images = Array.isArray(message.content) ? message.content.filter((block) => block.type === "image").length : 0;
			const input = inputs.get(entry.id);
			out.push({
				id: entry.id,
				role: "user",
				text: textOf(message.content),
				...(images === 0 ? {} : { images }),
				...input,
				...(message.timestamp === undefined ? {} : { at: message.timestamp }),
			});
		} else if (message.role === "assistant") {
			const text = textOf(message.content);
			if (text === "" && message.errorMessage === undefined) continue;
			const source = (entry.data as { source?: unknown } | undefined)?.source;
			out.push({
				id: entry.id,
				role: "assistant",
				text,
				stopReason: message.stopReason ?? "stop",
				...(message.errorMessage === undefined ? {} : { error: message.errorMessage }),
				...(MessageEntry.is(entry) && typeof source === "string" ? { source } : {}),
				// A reply's timestamp is when its request started; show when it ended.
				...(message.timestamp === undefined ? {} : { at: message.timestamp + (message.durationMs ?? 0) }),
				...(message.model === undefined || message.model === "" || message.model.startsWith("plugin:") ? {} : { model: message.model }),
			});
		} else if (message.role === "toolResult") {
			out.push({ id: entry.id, role: "tool", callId: message.toolCallId ?? "", name: message.toolName ?? "", isError: message.isError === true });
		}
	}
	return out;
}

/** What an entry's replies and tool results spent, added to `total`, which is returned. A tool-call-only reply counts too. */
export function addSpent(total: Spent | undefined, entry: EntryRecord): Spent | undefined {
	for (const message of (entry.model ?? []) as readonly ModelMessage[]) {
		if ((message.role !== "assistant" && message.role !== "toolResult") || message.usage === undefined) continue;
		const sum = total ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) sum[key] += message.usage[key] ?? 0;
		total = sum;
	}
	return total;
}
