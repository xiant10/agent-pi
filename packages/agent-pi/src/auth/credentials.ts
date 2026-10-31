import type { ConversationId } from "@earendil-works/pi-durable";
import type { Principal } from "./authenticator.ts";

/**
 * The newest verified principal per conversation, in memory only: bearer tokens are never written to durable storage.
 * Plugins and audit headers read it. Tools never do, because their tokens come from the conversation's grant. `sweep()`
 * drops expired tokens and those of sessions idle for a while, so abandoned sessions do not keep tokens in memory.
 */
export class CredentialStore {
	readonly #byConversation = new Map<ConversationId, { readonly principal: Principal; readonly seen: number }>();

	set(conversationId: ConversationId, principal: Principal): void {
		this.#byConversation.set(conversationId, { principal, seen: Date.now() });
	}

	/** A child conversation, such as a consulted expert, belongs to its parent's user. */
	inherit(child: ConversationId, parent: ConversationId): void {
		const entry = this.#byConversation.get(parent);
		if (entry !== undefined) this.#byConversation.set(child, { principal: entry.principal, seen: Date.now() });
	}

	get(conversationId: ConversationId): Principal | undefined {
		return this.#byConversation.get(conversationId)?.principal;
	}

	delete(conversationId: ConversationId): void {
		this.#byConversation.delete(conversationId);
	}

	/** Drop expired principals, and those not refreshed for `idleMs` whose conversation is not working. */
	sweep(idleMs: number, isWorking: (conversationId: ConversationId) => boolean, now = Date.now()): void {
		for (const [conversationId, { principal, seen }] of this.#byConversation) {
			const expired = principal.expiresAt !== undefined && principal.expiresAt <= now;
			if (expired || (now - seen >= idleMs && !isWorking(conversationId))) this.#byConversation.delete(conversationId);
		}
	}
}
