import { definePlugin } from "../types.ts";

/**
 * Tells the model the current date and time in the business's time zone. Added to each model request only, just before
 * the latest user message: the stored transcript and the cached prompt prefix stay the same from request to request,
 * and the user's message stays the last thing the model reads (a trailing note gets answered instead of the user).
 */
export function clock(options: { readonly timeZone: string }) {
	const format = new Intl.DateTimeFormat("en-US", {
		timeZone: options.timeZone,
		dateStyle: "full",
		timeStyle: "short",
	});
	return definePlugin({
		name: "clock",
		beforeModelRequest: async (messages, ctx) => {
			// Fixed per task phase, so a request retried after a crash sees the same time.
			const now = await ctx.memo("now", () => format.format(new Date()));
			const note = { role: "user" as const, content: `<now>${now} (${options.timeZone})</now>`, timestamp: 0 };
			const last = messages.findLastIndex((message) => message.role === "user");
			return last === -1 ? [note, ...messages] : [...messages.slice(0, last), note, ...messages.slice(last)];
		},
	});
}
