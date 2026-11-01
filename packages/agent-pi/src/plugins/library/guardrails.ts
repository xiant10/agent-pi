import type { ToolExecutionResult, UserInput } from "@earendil-works/pi-durable";
import { definePlugin } from "../types.ts";

/** 13 to 19 digits, optionally grouped by spaces or dashes: a payment card number. */
const CARD = /\b(?:\d[ -]?){12,18}\d\b/;

const redact = (text: string) => text.replace(new RegExp(CARD, "g"), "[card number removed]");

/**
 * Card numbers never reach the model or the transcript: they are removed from user input before the model sees it, and
 * from tool results before they are stored. Runs first, so later plugins see redacted text too.
 */
export const guardrails = definePlugin({
	name: "guardrails",
	beforePrompt: (turn) => {
		const inNote = turn.note !== undefined && CARD.test(turn.note);
		if (!CARD.test(turn.text) && !inNote) return undefined;
		const input: UserInput =
			typeof turn.input === "string"
				? redact(turn.input)
				: turn.input.map((block) => (block.type === "text" ? { ...block, text: redact(block.text) } : block));
		turn.log.info("guardrails.redacted", { sessionId: turn.sessionId });
		return { input, ...(inNote ? { note: redact(turn.note!) } : {}) };
	},
	afterToolCall: (_call, result): ToolExecutionResult | undefined => {
		if (result.output === undefined) return undefined;
		return {
			...result,
			output: result.output.map((block) => (block.type === "text" ? { ...block, text: redact(block.text) } : block)),
		};
	},
});
