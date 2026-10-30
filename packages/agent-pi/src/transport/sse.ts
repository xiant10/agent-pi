import type { ServerResponse } from "node:http";

/** Undelivered bytes past which a client counts as stuck; it is dropped and resumes with Last-Event-ID. */
const MAX_PENDING_BYTES = 4 * 1024 * 1024;

/** One `text/event-stream` response: JSON messages with optional ids, keep-alive comments, slow-client protection. */
export class SseStream {
	readonly #res: ServerResponse;
	readonly #keepAlive: ReturnType<typeof setInterval>;
	readonly #closeListeners: (() => void)[] = [];
	#closed = false;

	constructor(res: ServerResponse, keepAliveMs: number, headers: Readonly<Record<string, string>> = {}) {
		this.#res = res;
		res.writeHead(200, {
			...headers,
			"content-type": "text/event-stream",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			// Proxies such as nginx must not buffer the stream; TTS needs each segment as it is produced.
			"x-accel-buffering": "no",
		});
		res.flushHeaders();
		this.#keepAlive = setInterval(() => this.#write(": keep-alive\n\n"), keepAliveMs);
		this.#keepAlive.unref();
		res.on("close", () => this.#markClosed());
	}

	get closed(): boolean {
		return this.#closed;
	}

	send(message: unknown, id?: string): void {
		this.#write(`${id === undefined ? "" : `id: ${id}\n`}event: message\ndata: ${JSON.stringify(message)}\n\n`);
	}

	end(): void {
		if (this.#closed) return;
		this.#res.end();
		this.#markClosed();
	}

	onClose(listener: () => void): void {
		if (this.#closed) listener();
		else this.#closeListeners.push(listener);
	}

	#write(chunk: string): void {
		if (this.#closed) return;
		this.#res.write(chunk);
		if (this.#res.writableLength > MAX_PENDING_BYTES) this.#res.destroy();
	}

	#markClosed(): void {
		if (this.#closed) return;
		this.#closed = true;
		clearInterval(this.#keepAlive);
		for (const listener of this.#closeListeners.splice(0)) listener();
	}
}
