import { afterEach, expect, it, vi } from "vitest";
import { ProgressController, type ProgressEvent } from "../src/events/progress.ts";
import { startTestAgent, rpc, TOKENS, fauxAssistantMessage, fauxText, parseSse, events } from "../src/testing.ts";

afterEach(() => vi.useRealTimers());

it("limits quiet notices and stops timers at completion", () => {
	vi.useFakeTimers();
	const sent: ProgressEvent[] = [];
	const progress = new ProgressController(event => sent.push(event));
	progress.observe({ type: "run.started", submissionIds: [1] });
	vi.advanceTimersByTime(36_000);
	expect(sent.map(event => event.phase)).toEqual(["working", "waiting"]);
	progress.observe({ type: "run.finished", submissionIds: [1] });
	vi.advanceTimersByTime(36_000);
	expect(sent.map(event => event.phase)).toEqual(["working", "waiting", "finished"]);
	expect(vi.getTimerCount()).toBe(0);
});

it("measures streamed feedback separately from answer tokens with a delayed model", async () => {
	const results: { progress: boolean; feedbackMs: number; answerMs: number; modelMs: number }[] = [];
	for (const enabled of [false, true]) {
		let started = 0;
		let modelMs = 0;
		const agent = await startTestAgent({
			plugins: enabled ? [] : [{ name: "baseline", mapEvent: event => event.type === "progress" ? [] : [event] }],
			responses: [async () => {
				modelMs = performance.now() - started;
				await new Promise(resolve => setTimeout(resolve, 600));
				return fauxAssistantMessage([fauxText("The answer is ready.")]);
			}],
		});
		try {
			const created = await rpc(agent.url, TOKENS.alice, "session.create", {});
			started = performance.now();
			const response = await fetch(agent.url, {
				method: "POST",
				headers: { authorization: `Bearer ${TOKENS.alice}`, "content-type": "application/json", accept: "text/event-stream" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.prompt", params: { sessionId: created.body.result!.sessionId, input: "Do the work" } }),
			});
			let pending = "";
			let feedbackMs: number | undefined;
			let answerMs: number | undefined;
			const decoder = new TextDecoder();
			for await (const chunk of response.body!) {
				pending += decoder.decode(chunk, { stream: true });
				let boundary: number;
				while ((boundary = pending.indexOf("\n\n")) >= 0) {
					const frame = pending.slice(0, boundary + 2);
					pending = pending.slice(boundary + 2);
					for (const event of events(parseSse(frame))) {
						if (event.type === "progress" || event.type === "text.delta") feedbackMs ??= performance.now() - started;
						if (event.type === "text.delta") answerMs ??= performance.now() - started;
					}
				}
			}
			expect(answerMs).toBeGreaterThanOrEqual(600);
			expect(feedbackMs).toBeDefined();
			if (enabled) expect(answerMs! - feedbackMs!).toBeGreaterThan(400);
			results.push({ progress: enabled, feedbackMs: Math.round(feedbackMs!), answerMs: Math.round(answerMs!), modelMs: Math.round(modelMs) });
		} finally { await agent.close(); }
	}
	process.stdout.write(`Progress latency (ms): ${JSON.stringify(results)}\n`);
});

it("clears settled submissions while preserving other active work", () => {
	vi.useFakeTimers();
	const sent: ProgressEvent[] = [];
	const controller = new ProgressController(event => sent.push(event));
	controller.resume([1]);
	controller.observe({ type: "submission", submissionId: 2, status: "placed" });
	expect(sent.at(-1)?.submissionIds).toEqual([1, 2]);
	controller.observe({ type: "submission", submissionId: 1, status: "done" });
	vi.advanceTimersByTime(12_000);
	expect(sent.at(-1)).toMatchObject({ phase: "waiting", submissionIds: [2] });
	controller.observe({ type: "submission", submissionId: 2, status: "unanswered" });
	expect(vi.getTimerCount()).toBe(0);
	const count = sent.length;
	vi.advanceTimersByTime(60_000);
	expect(sent).toHaveLength(count);
});

it("reconstructs resumed work and discards timers on an idle snapshot", () => {
	vi.useFakeTimers();
	const sent: ProgressEvent[] = [];
	const controller = new ProgressController(event => sent.push(event));
	controller.resume([1]);
	controller.resume([2]);
	expect(sent.at(-1)).toMatchObject({ phase: "working", submissionIds: [2] });
	expect(vi.getTimerCount()).toBe(1);
	controller.observe({ type: "snapshot", busy: false, activeTools: [], inbox: [], tasks: [] });
	expect(vi.getTimerCount()).toBe(0);
});

it("generates a request-specific acknowledgement concurrently without recording it in history", async () => {
	const calls: string[] = [];
	const response = async (context: unknown) => {
		const ack = JSON.stringify(context).includes("Write the one-line status an assistant shows");
		calls.push(ack ? "ack" : "work");
		await new Promise(resolve => setTimeout(resolve, ack ? 30 : 300));
		return fauxAssistantMessage([fauxText(ack ? "I’ll compare the vendor prices for you." : "Vendor A costs less.")]);
	};
	const agent = await startTestAgent({ config: { progressModel: "main" }, responses: [response, response] });
	try {
		const created = await rpc(agent.url, TOKENS.alice, "session.create", {});
		const sessionId = created.body.result!.sessionId;
		const { rpcStream } = await import("../src/testing.ts");
		const result = await rpcStream(agent.url, TOKENS.alice, "session.prompt", { sessionId, input: "Compare vendor prices" });
		const bodies = events(result.messages);
		expect(calls.sort()).toEqual(["ack", "work"]);
		expect(bodies.some(e => e.type === "progress" && e.text === "I’ll compare the vendor prices for you.")).toBe(true);
		expect(bodies.some(e => e.type === "progress" && e.text === "I’m working on your request.")).toBe(false);
		const history = await rpc(agent.url, TOKENS.alice, "session.messages", { sessionId });
		expect(JSON.stringify(history.body)).not.toContain("I’ll compare the vendor prices");
	} finally { await agent.close(); }
});

it("discards an acknowledgement when the answer wins the race", async () => {
	const response = async (context: unknown) => {
		const ack = JSON.stringify(context).includes("Write the one-line status an assistant shows");
		await new Promise(resolve => setTimeout(resolve, ack ? 300 : 20));
		return fauxAssistantMessage([fauxText(ack ? "Late acknowledgement" : "Done.")]);
	};
	const agent = await startTestAgent({ config: { progressModel: "main" }, responses: [response, response] });
	try {
		const created = await rpc(agent.url, TOKENS.alice, "session.create", {});
		const { rpcStream } = await import("../src/testing.ts");
		const result = await rpcStream(agent.url, TOKENS.alice, "session.prompt", { sessionId: created.body.result!.sessionId, input: "Hello" });
		expect(events(result.messages).some(e => e.type === "progress" && e.phase !== "finished")).toBe(false);
	} finally { await agent.close(); }
});
