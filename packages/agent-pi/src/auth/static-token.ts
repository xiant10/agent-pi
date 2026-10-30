import { createHash, timingSafeEqual } from "node:crypto";
import { type Authenticator, AuthError, type AuthRequest, bearerToken, type Principal } from "./authenticator.ts";

/**
 * Static bearer-token -> userId map, for development and service callers. Tokens are compared by SHA-256 digest in
 * constant time, so response timing does not reveal a matching prefix.
 */
export class StaticTokenAuthenticator implements Authenticator {
	readonly #tokens: readonly { readonly digest: Buffer; readonly userId: string }[];

	constructor(tokens: ReadonlyMap<string, string>) {
		this.#tokens = [...tokens].map(([token, userId]) => ({ digest: digest(token), userId }));
	}

	/** `raw` is a JSON object of `{ token: userId }`. */
	static fromJson(raw: string, source = "tokens"): StaticTokenAuthenticator {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error(`${source} must be a JSON object of {token: userId}`);
		}
		const entries = Object.entries(parsed as Record<string, unknown>).map(([token, userId]) => {
			if (typeof userId !== "string" || userId.length === 0) {
				throw new Error(`${source}: each value must be a non-empty userId string`);
			}
			return [token, userId] as const;
		});
		return new StaticTokenAuthenticator(new Map(entries));
	}

	async authenticate(request: AuthRequest): Promise<Principal> {
		const token = bearerToken(request.headers);
		if (token === undefined) throw new AuthError(401, "missing_token", "missing bearer token");
		const presented = digest(token);
		let userId: string | undefined;
		// No early exit: every entry is compared.
		for (const entry of this.#tokens) if (timingSafeEqual(entry.digest, presented)) userId = entry.userId;
		if (userId === undefined) throw new AuthError(401, "invalid_token", "invalid bearer token");
		return { userId, scopes: [], claims: {}, token };
	}
}

function digest(token: string): Buffer {
	return createHash("sha256").update(token).digest();
}
