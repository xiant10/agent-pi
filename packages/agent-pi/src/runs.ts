import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Submission } from "@earendil-works/pi-durable";
import type { LimitsConfig } from "./config.ts";
import { rateLimited } from "./errors.ts";

/** A reserved run slot: `track` holds it until the submission settles, `release` frees it at once. Both are idempotent. */
export type RunLease = { track(submission: Submission): void; release(): void };

/**
 * Concurrency limits in memory: per owner, the sessions with an unsettled input. A follow-up into a session that is
 * already working adds no concurrency, so it is never refused. A slot is reserved before any await, so concurrent
 * prompts cannot all pass the check before one of them is counted.
 */
export class RunTracker {
	readonly #byOwner = new Map<string, Map<ConversationId, number>>();
	#total = 0;

	reserve(owner: string, conversationId: ConversationId, limits: LimitsConfig): RunLease {
		const sessions = this.#byOwner.get(owner) ?? new Map<ConversationId, number>();
		const pending = sessions.get(conversationId);
		if (pending === undefined) {
			if (sessions.size >= limits.maxConcurrentRunsPerUser) {
				throw rateLimited(`at most ${limits.maxConcurrentRunsPerUser} sessions per user may work at once`, 2);
			}
			if (this.#total >= limits.maxConcurrentRuns) throw rateLimited("the server is at capacity", 2);
			this.#total++;
		}
		sessions.set(conversationId, (pending ?? 0) + 1);
		this.#byOwner.set(owner, sessions);

		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			const left = (sessions.get(conversationId) ?? 1) - 1;
			if (left > 0) {
				sessions.set(conversationId, left);
				return;
			}
			sessions.delete(conversationId);
			this.#total--;
			if (sessions.size === 0 && this.#byOwner.get(owner) === sessions) this.#byOwner.delete(owner);
		};
		return {
			release,
			track: (submission) => {
				void submission.wait(BACKGROUND_CONTEXT).catch(() => undefined).finally(release);
			},
		};
	}

	/**
	 * A slot for a background child's run. These count against `maxBackgroundRunsPerUser`, not the limit on an owner's
	 * sessions, so tasks cannot lock a person out of the conversation that started them. They do use up server capacity.
	 */
	reserveBackground(owner: string, conversationId: ConversationId, limits: LimitsConfig): RunLease {
		return this.reserve(`${owner}\0background`, conversationId, { ...limits, maxConcurrentRunsPerUser: limits.maxBackgroundRunsPerUser });
	}

	isWorking(conversationId: ConversationId): boolean {
		for (const sessions of this.#byOwner.values()) if (sessions.has(conversationId)) return true;
		return false;
	}
}
