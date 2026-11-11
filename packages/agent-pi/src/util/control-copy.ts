import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SILENT_LOGGER, type Logger } from "./log.ts";

/**
 * The last good copy of what `t10-agent-control` answered, one file per tenant and feed. Control is never on a turn's
 * path for long: a read is fresh for a few seconds, and when control can't be reached the last good copy stands in with
 * no time limit, because an older copy of the tenant's choice is better than none. The copy is kept on disk, so a
 * replica that restarts while control is down starts from it. Past `STALE_AFTER_MS` without an answer, each failed read
 * logs `control.feed_stale` at error level, which is what alerts. See "Reading control" in t10-agent-control's
 * `docs/design.md`.
 */

/** How long a copy may go without an answer from control before it's reported stale. The same for every feed. */
export const STALE_AFTER_MS = 15 * 60_000;

/** One saved answer: its ETag, when control sent it, and the body. */
export type SavedAnswer = { readonly etag?: string; readonly at: number; readonly body: unknown };

export class ControlCopies {
	readonly #dir: string | undefined;
	readonly #feed: string;
	readonly #log: Logger;

	/** `dir` undefined keeps nothing on disk. */
	constructor(dir: string | undefined, feed: string, log: Logger = SILENT_LOGGER) {
		this.#dir = dir === undefined ? undefined : join(dir, feed);
		this.#feed = feed;
		this.#log = log;
		if (this.#dir !== undefined) mkdirSync(this.#dir, { recursive: true });
	}

	/** The saved answer for a key, read when this process first needs it. */
	load(key: string): SavedAnswer | undefined {
		if (this.#dir === undefined) return undefined;
		try {
			const saved = JSON.parse(readFileSync(this.#file(key), "utf8")) as Partial<SavedAnswer>;
			if (typeof saved.at !== "number" || !("body" in saved)) return undefined;
			return { ...(typeof saved.etag === "string" ? { etag: saved.etag } : {}), at: saved.at, body: saved.body };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				this.#log.warn("control.copy_unreadable", { feed: this.#feed, error: error instanceof Error ? error.message : String(error) });
			}
			return undefined;
		}
	}

	/** Keep an answer control just sent. Written beside the old one, then renamed over it. */
	save(key: string, answer: SavedAnswer): void {
		if (this.#dir === undefined) return;
		const file = this.#file(key);
		try {
			writeFileSync(`${file}.tmp`, JSON.stringify(answer), { mode: 0o600 });
			renameSync(`${file}.tmp`, file);
		} catch (error) {
			this.#log.warn("control.copy_not_saved", { feed: this.#feed, error: error instanceof Error ? error.message : String(error) });
		}
	}

	/** Log a failed read that falls back to a copy answered at `okAt`, or to the shipped default when there's none. */
	failed(tenant: string, error: unknown, okAt: number, now: number, using: string): void {
		const message = error instanceof Error ? error.message : String(error);
		const ageSeconds = okAt > 0 ? Math.round((now - okAt) / 1000) : undefined;
		if (okAt > 0 && now - okAt < STALE_AFTER_MS) {
			this.#log.warn("control.feed_unavailable", { feed: this.#feed, tenant, error: message, using, ageSeconds });
			return;
		}
		this.#log.error("control.feed_stale", { feed: this.#feed, tenant, error: message, using, ...(ageSeconds === undefined ? {} : { ageSeconds }) });
	}

	/** Tenant IDs and principals aren't file names, so each key is hashed. */
	#file(key: string): string {
		return join(this.#dir!, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
	}
}
