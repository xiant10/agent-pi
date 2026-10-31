import { readFileSync } from "node:fs";
import { definePlugin } from "../types.ts";

export type Faq = { readonly patterns: readonly string[]; readonly answer: string };

const GREETING = /^\s*(hi|hello|hey|good (morning|afternoon|evening)|你好|您好)[\s!.,，。！]*$/i;

/**
 * Answers that need no model: a bare greeting, and questions the FAQ answers verbatim. They cost no tokens and no model
 * latency (which matters most for voice), and are written to the transcript, so the model knows what was said when the
 * conversation continues.
 */
export function shortcuts(options: { readonly faqFile: URL | string; readonly assistantName: string }) {
	const faqs = JSON.parse(readFileSync(options.faqFile, "utf8")) as Faq[];
	return definePlugin({
		name: "shortcuts",
		beforePrompt: (turn) => {
			if (GREETING.test(turn.text)) return { reply: `Hi, I'm ${options.assistantName}. What can I do for you?` };
			const lowered = turn.text.toLowerCase();
			const faq = faqs.find((candidate) => candidate.patterns.some((pattern) => lowered.includes(pattern.toLowerCase())));
			return faq === undefined ? undefined : { reply: faq.answer };
		},
	});
}
