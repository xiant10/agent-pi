import type { ConversationId } from "@earendil-works/pi-durable";
import type { Principal } from "./authenticator.ts";

export type GrantsConfig = {
	/** Base URL of the auth service. */
	readonly url: string;
	/** This runtime's service account. */
	readonly clientId: string;
	readonly clientSecret: string;
	/** What a run may do, at most. A delegated caller's grant can narrow this. */
	readonly actions: readonly string[];
	/** The services a run may call, at most. */
	readonly audiences: readonly string[];
};

/** What a session keeps. The ids are safe to store, unlike a token: alone they prove nothing. */
export type StoredGrant = {
	readonly grantId: string;
	/** The caller's own grant when this one is a child of it, as on a LiveKit call. */
	readonly parent?: string;
};

/** Raised when a grant ended. The run should stop, or wait for the user. */
export class GrantError extends Error {
	readonly reason: "expired" | "stopped" | "unavailable";

	constructor(reason: GrantError["reason"], message: string) {
		super(message);
		this.name = "GrantError";
		this.reason = reason;
	}
}

type Cached = { readonly token: string; readonly expiresAt: number };

export type GrantBrokerOptions = {
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	/** First retry delay when the auth service is unreachable. Default 200 ms. */
	readonly retryDelayMs?: number;
};

/** Replace a token this long before it expires, so a call that just left can't arrive with a dead one. */
const RENEW_BEFORE_MS = 60_000;
const ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;
/** A revocation reaches this service within this long, as `service-api.md` requires. */
const CHAIN_CACHE_MS = 60_000;

/**
 * Holds no user token. A user's request opens or renews a grant for the conversation, and tool calls then get short
 * tokens minted from it, so a run goes on while the user is offline and resumes after a restart from the stored id.
 * Every mint rechecks the grant chain, the user and the membership at the auth service.
 */
export class GrantBroker {
	readonly #config: GrantsConfig;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #retryDelayMs: number;
	readonly #byConversation = new Map<ConversationId, StoredGrant>();
	readonly #tokens = new Map<string, Cached>();
	readonly #minting = new Map<string, Promise<string>>();
	readonly #confirmed = new Map<string, number>();
	#service: Cached | undefined;
	#read: ((conversationId: ConversationId) => Promise<StoredGrant | undefined>) | undefined;

	constructor(config: GrantsConfig, options: GrantBrokerOptions = {}) {
		this.#config = { ...config, url: config.url.replace(/\/+$/, "") };
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#now = options.now ?? Date.now;
		this.#retryDelayMs = options.retryDelayMs ?? 200;
	}

	/** Where to find a grant this process has not seen, such as one from before a restart. */
	attachStore(read: (conversationId: ConversationId) => Promise<StoredGrant | undefined>): void {
		this.#read = read;
	}

	/**
	 * Give a conversation a grant for this request, and return it for storing. A user token opens a root or extends the
	 * current one. A delegated token opens a child of the caller's grant. With a grant already in hand, an outage does
	 * not stop the request: the grant lasts hours, and the next request extends it.
	 */
	async attach(conversationId: ConversationId, stored: StoredGrant | undefined, principal: Principal): Promise<StoredGrant> {
		const parent = typeof principal.claims.grant === "string" ? principal.claims.grant : undefined;
		const current = stored ?? this.#byConversation.get(conversationId);
		let grant: StoredGrant | undefined;
		if (current !== undefined && current.parent === parent) {
			grant = parent === undefined ? await this.#extended(current, principal) : current;
		}
		grant ??= await this.#open(principal, parent);
		this.#byConversation.set(conversationId, grant);
		return grant;
	}

	async #extended(current: StoredGrant, principal: Principal): Promise<StoredGrant | undefined> {
		try {
			await this.#serviceCall(`/v1/grants/${encodeURIComponent(current.grantId)}/extend`, { subject_token: principal.token });
			return current;
		} catch (error) {
			if (error instanceof GrantError && error.reason === "unavailable") return current;
			return undefined;
		}
	}

	async #open(principal: Principal, parent: string | undefined): Promise<StoredGrant> {
		const created = await this.#create(principal.token, this.#narrowed(principal));
		return { grantId: created, ...(parent === undefined ? {} : { parent }) };
	}

	/** A delegated caller can't pass on more than it holds, so ask for the overlap. */
	#narrowed(principal: Principal): { actions: readonly string[]; audiences: readonly string[] } {
		const { actions, audiences } = this.#config;
		if (typeof principal.claims.grant !== "string") return { actions, audiences };
		const aud = principal.claims.aud;
		const held = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
		return {
			actions: actions.filter((action) => principal.scopes.includes(action)),
			audiences: audiences.filter((audience) => held.includes(audience)),
		};
	}

	async #create(subjectToken: string, wanted: { actions: readonly string[]; audiences: readonly string[] }): Promise<string> {
		const body = await this.#serviceCall("/v1/grants", { subject_token: subjectToken, ...wanted });
		if (typeof body.id !== "string") throw new GrantError("unavailable", "the auth service returned no grant id");
		return body.id;
	}

	/** A token for the conversation's grant, from the cache or minted now. */
	async token(conversationId: ConversationId): Promise<string> {
		const grant = await this.grantOf(conversationId);
		if (grant === undefined) throw new GrantError("stopped", "this conversation has no agent grant");
		return this.#mint(grant.grantId);
	}

	/** The conversation's grant. Tool connections are keyed by it, so tokens never mix across users or grants. */
	async grantOf(conversationId: ConversationId): Promise<StoredGrant | undefined> {
		const known = this.#byConversation.get(conversationId);
		if (known !== undefined) return known;
		const stored = await this.#read?.(conversationId);
		if (stored !== undefined) this.#byConversation.set(conversationId, stored);
		return stored;
	}

	/**
	 * Give a spawned agent its own grant under the parent's, for storing, unless it has one, as on a rerun after a
	 * restart. It holds no secret: its tokens come through this broker.
	 */
	async spawn(child: ConversationId, parent: ConversationId): Promise<StoredGrant> {
		const known = await this.grantOf(child);
		if (known !== undefined) return known;
		const grant = await this.grantOf(parent);
		if (grant === undefined) throw new GrantError("stopped", "the parent conversation has no agent grant");
		const token = await this.#mint(grant.grantId);
		const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
			scope?: string;
			aud?: string | string[];
		};
		const created = await this.#create(token, {
			actions: (claims.scope ?? "").split(" ").filter((action) => action.length > 0),
			audiences: typeof claims.aud === "string" ? [claims.aud] : (claims.aud ?? []),
		});
		const spawned = { grantId: created };
		this.#byConversation.set(child, spawned);
		return spawned;
	}

	/** End a spawned agent's grant. Best effort: it would expire with its parent anyway. */
	async release(conversationId: ConversationId): Promise<void> {
		const grant = this.#byConversation.get(conversationId);
		this.#byConversation.delete(conversationId);
		if (grant === undefined) return;
		this.#tokens.delete(grant.grantId);
		await this.#serviceCall(`/v1/grants/${encodeURIComponent(grant.grantId)}/revoke`, undefined).catch(() => undefined);
	}

	/** Forget a closed session and stop its grant. */
	async close(conversationId: ConversationId): Promise<void> {
		await this.grantOf(conversationId);
		await this.release(conversationId);
	}

	#mint(grantId: string): Promise<string> {
		const cached = this.#tokens.get(grantId);
		if (cached !== undefined && cached.expiresAt - this.#now() > RENEW_BEFORE_MS) return Promise.resolve(cached.token);
		const inFlight = this.#minting.get(grantId);
		if (inFlight !== undefined) return inFlight;
		const minting = (async () => {
			try {
				const entry = await this.#tokenRequest({ grant_type: "agent_grant", grant_id: grantId });
				this.#tokens.set(grantId, entry);
				return entry.token;
			} catch (error) {
				this.#tokens.delete(grantId);
				throw error;
			} finally {
				this.#minting.delete(grantId);
			}
		})();
		this.#minting.set(grantId, minting);
		return minting;
	}

	async #tokenRequest(request: Record<string, string>): Promise<Cached> {
		const body = await this.#post("/v1/token", undefined, {
			...request,
			client_id: this.#config.clientId,
			client_secret: this.#config.clientSecret,
		});
		if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
			throw new GrantError("unavailable", "the auth service returned no token");
		}
		return { token: body.access_token, expiresAt: this.#now() + body.expires_in * 1000 };
	}

	/**
	 * Throw unless a delegated token's grant and its ancestors are live. A token outlives a revocation by up to its
	 * 5 minutes, and this is what cuts that to a minute. Only a live answer is remembered, so an outage refuses.
	 */
	async confirmChain(grantId: string): Promise<void> {
		const confirmed = this.#confirmed.get(grantId);
		if (confirmed !== undefined && this.#now() - confirmed < CHAIN_CACHE_MS) return;
		this.#confirmed.delete(grantId);
		const service = await this.#serviceToken();
		let response: Response;
		try {
			response = await this.#fetch(`${this.#config.url}/v1/grants/${encodeURIComponent(grantId)}/chain`, {
				headers: { authorization: `Bearer ${service}` },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			throw new GrantError("unavailable", error instanceof Error ? error.message : String(error));
		}
		if (response.status >= 500) throw new GrantError("unavailable", `the auth service answered ${response.status}`);
		if (!response.ok) throw new GrantError("stopped", "the grant is no longer live");
		for (const [id, at] of this.#confirmed) if (this.#now() - at >= CHAIN_CACHE_MS) this.#confirmed.delete(id);
		this.#confirmed.set(grantId, this.#now());
	}

	async #serviceToken(): Promise<string> {
		if (this.#service === undefined || this.#service.expiresAt - this.#now() <= RENEW_BEFORE_MS) {
			this.#service = await this.#tokenRequest({ grant_type: "client_credentials" });
		}
		return this.#service.token;
	}

	async #serviceCall(path: string, body: unknown): Promise<Record<string, unknown>> {
		return this.#post(path, await this.#serviceToken(), body);
	}

	/** Retries while the auth service is unreachable or failing. A refusal is an answer, so it isn't retried. */
	async #post(path: string, bearer: string | undefined, body: unknown): Promise<Record<string, unknown>> {
		let lastError = "no attempt";
		for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
			if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, this.#retryDelayMs * 2 ** (attempt - 1)));
			let response: Response;
			try {
				response = await this.#fetch(`${this.#config.url}${path}`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				});
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
				continue;
			}
			if (response.status >= 500) {
				lastError = `status ${response.status}`;
				continue;
			}
			const text = await response.text();
			const parsed = (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>;
			if (response.ok) return parsed;
			if (parsed.error === "grant_expired") {
				throw new GrantError("expired", "The agent's access has expired; ask the user to send a message to renew it.");
			}
			if (parsed.error === "invalid_grant") {
				throw new GrantError("stopped", "The agent's access was stopped; end this task and tell the user.");
			}
			throw new GrantError("unavailable", `the auth service refused the request: ${String(parsed.error ?? response.status)}`);
		}
		throw new GrantError("unavailable", `the auth service is unavailable: ${lastError}`);
	}
}
