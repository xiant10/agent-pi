import type { ClientEventBody } from "./mapper.ts";

export type ProgressEvent = {
	type: "progress";
	submissionIds: number[];
	phase: "working" | "waiting" | "retrying" | "finished";
	text: string;
};

/** Presentation only: never calls a model, blocks execution, or writes conversation history. */
export class ProgressController {
	#ids: number[] = [];
	#timer: ReturnType<typeof setTimeout> | undefined;
	#lastText = "";
	private readonly emit: (event: ProgressEvent) => void;
	private readonly quietMs: number;
	constructor(emit: (event: ProgressEvent) => void, quietMs = 12_000) {
		this.emit = emit;
		this.quietMs = quietMs;
	}

	observe(event: ClientEventBody): void {
		if (event.type === "run.started") {
			this.resume(event.submissionIds);
		} else if (event.type === "run.finished") {
			this.stop();
			this.emit({ type: "progress", submissionIds: event.submissionIds, phase: "finished", text: "" });
		} else if (event.type === "snapshot") {
			if (!event.busy) this.stop();
		} else if (this.#ids.length > 0) {
			if (event.type === "submission") {
				if (event.status === "placed" && !this.#ids.includes(event.submissionId)) {
					this.#ids.push(event.submissionId);
					this.#lastText = "";
					this.#send("working", "I’m working on your request.");
				}
				if (event.status === "done" || event.status === "unanswered") {
					this.#ids = this.#ids.filter(id => id !== event.submissionId);
					this.emit({ type: "progress", submissionIds: [event.submissionId], phase: "finished", text: "" });
					if (this.#ids.length === 0) this.stop();
					return;
				}
			}
			if (event.type === "retry") this.#send("retrying", "The request is being retried.");
			if (event.type === "text.delta" || event.type === "tool.started" || event.type === "tool.finished") this.#arm();
		}
	}

	resume(ids: readonly number[]): void {
		this.stop();
		this.#ids = [...ids];
		if (ids.length) this.#send("working", "I’m working on your request.");
	}

	stop(): void {
		clearTimeout(this.#timer);
		this.#ids = [];
		this.#lastText = "";
	}

	#send(phase: ProgressEvent["phase"], text: string, arm = true): void {
		if (text !== this.#lastText) {
			this.#lastText = text;
			this.emit({ type: "progress", submissionIds: [...this.#ids], phase, text });
		}
		if (arm) this.#arm();
	}

	#arm(): void {
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			if (this.#ids.length) this.#send("waiting", "I’m still working on your request.", false);
		}, this.quietMs);
		this.#timer.unref();
	}
}
