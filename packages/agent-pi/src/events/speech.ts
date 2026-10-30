/**
 * Cuts streamed assistant text into speakable segments, so TTS starts on the first sentence instead of the full answer.
 *
 * A segment ends at a sentence end: `.!?;` followed by whitespace, CJK `。！？；` anywhere, or a line break. A sentence
 * longer than `maxChars` is cut at its last clause break (`,`, `，`, `、`, `:`, `：`), else its last space. Segments shorter than
 * `minChars` wait for more text, so "1." or "OK." does not become a separate utterance. Markdown is stripped from each
 * segment when it is emitted, never from the raw stream, so a `**` split across two deltas is still removed.
 */
export class SpeechSegmenter {
	readonly #minChars: number;
	readonly #maxChars: number;
	#buffer = "";

	constructor(options: { readonly minChars?: number; readonly maxChars?: number } = {}) {
		this.#minChars = options.minChars ?? 12;
		this.#maxChars = options.maxChars ?? 220;
	}

	/** Add streamed text; returns the segments that are now complete. */
	push(text: string): string[] {
		this.#buffer += text;
		const segments: string[] = [];
		for (;;) {
			const end = this.#boundary();
			if (end === -1) break;
			const segment = speakable(this.#buffer.slice(0, end));
			this.#buffer = this.#buffer.slice(end);
			if (segment.length > 0) segments.push(segment);
		}
		return segments;
	}

	/** End of the message or a pause such as a tool call: whatever is buffered, if speakable. */
	flush(): string | undefined {
		const segment = speakable(this.#buffer);
		this.#buffer = "";
		return segment.length > 0 ? segment : undefined;
	}

	/** Drop buffered text, for an aborted message. */
	reset(): void {
		this.#buffer = "";
	}

	/** Index just past the first segment end at or beyond `minChars`, or -1. */
	#boundary(): number {
		const text = this.#buffer;
		const sentence = /[.!?;](?=\s)|[。！？；]|\n+/g;
		for (let match = sentence.exec(text); match !== null; match = sentence.exec(text)) {
			const end = match.index + match[0].length;
			if (speakable(text.slice(0, end)).length >= this.#minChars) return end;
		}
		if (text.length <= this.#maxChars) return -1;
		const window = text.slice(0, this.#maxChars);
		// A clause break reads more naturally than any space, so it wins even when a space comes later.
		const clause = Math.max(...[",", "，", "、", ":", "：", ";"].map((mark) => window.lastIndexOf(mark)));
		if (clause > this.#minChars) return clause + 1;
		const space = window.lastIndexOf(" ");
		return space > this.#minChars ? space + 1 : this.#maxChars;
	}
}

/** Text as it should be spoken: no markdown emphasis, code ticks, headings, bullets, link targets, or table pipes. */
export function speakable(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
		.replace(/^\s*>\s?/gm, "")
		.replace(/(\*\*|__|\*|~~|`)/g, "")
		// `_emphasis_`, but not the underscore of `customer_id`.
		.replace(/(^|[^\p{L}\p{N}])_([^_]+)_(?=[^\p{L}\p{N}]|$)/gu, "$1$2")
		.replace(/\|/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
