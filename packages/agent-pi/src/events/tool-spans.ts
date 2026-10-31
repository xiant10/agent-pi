import { startSpan, type TraceSpan } from "../util/tracing.ts";
import type { ClientEventBody } from "./mapper.ts";

/**
 * Spans of a session's tool calls, from its events. Events rather than durable hooks because hooks can replay, which
 * would report a call twice; a process that dies mid-call loses that span instead.
 */
export function toolSpans(traceparent: () => Promise<string | undefined>): (event: ClientEventBody) => void {
	const open = new Map<string, Promise<TraceSpan>>();
	return (event) => {
		if (event.type === "tool.started") {
			const startTime = Date.now();
			const attributes = { "tool.name": event.name, "tool.call_id": event.callId };
			open.set(
				event.callId,
				traceparent()
					.catch(() => undefined)
					.then((parent) => startSpan("agent.tool", { traceparent: parent, attributes, startTime })),
			);
		} else if (event.type === "tool.finished") {
			void open.get(event.callId)?.then((span) => span.end(event.isError ? "tool failed" : undefined));
			open.delete(event.callId);
		} else if (event.type === "run.finished") {
			// An aborted call reports no finish of its own.
			for (const span of open.values()) void span.then((tool) => tool.end("aborted with the run"));
			open.clear();
		}
	};
}
