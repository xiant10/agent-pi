import type { IncomingHttpHeaders } from "node:http";

/** A verified caller. Sessions are owned by `(tenantId, userId)`. */
export type Principal = {
	readonly userId: string;
	readonly tenantId?: string;
	/** Human-readable name for audit trails, when the credential carries one. */
	readonly displayName?: string;
	readonly scopes: readonly string[];
	/** Verified token claims; empty for non-JWT authenticators. */
	readonly claims: Readonly<Record<string, unknown>>;
	/** The bearer credential as presented. It goes no further than the auth service, which exchanges it for a grant. */
	readonly token: string;
	/** Epoch milliseconds after which `token` is dead. */
	readonly expiresAt?: number;
	/**
	 * Set on a delegated token: the runtime acting for the user, and the grant it acts under. `trigger` is why the run is
	 * running, from the token's `trg`, and `automation` the automation that started it.
	 */
	readonly agent?: { readonly runtime: string; readonly grantId: string; readonly trigger?: string; readonly automation?: string };
};

/** What an authenticator may inspect: headers only, so auth runs before any body is read. */
export type AuthRequest = {
	readonly headers: IncomingHttpHeaders;
	readonly method: string;
	readonly path: string;
};

/** Rejection with the HTTP status to answer: 401 for missing or invalid credentials, 403 for insufficient rights. */
export class AuthError extends Error {
	readonly status: 401 | 403;
	readonly code: string;

	constructor(status: 401 | 403, code: string, message: string) {
		super(message);
		this.name = "AuthError";
		this.status = status;
		this.code = code;
	}
}

export interface Authenticator {
	/** Resolve the caller or throw `AuthError`. Runs before routing; nothing agent-related happens first. */
	authenticate(request: AuthRequest): Promise<Principal>;
}

/**
 * Deployment-specific checks that run after an authenticator verified the credential: entitlement lookups, revocation
 * lists, role mapping. Return the (possibly changed) principal, or throw `AuthError` to reject.
 */
export type AuthExtension = (principal: Principal, request: AuthRequest) => Principal | Promise<Principal>;

export function bearerToken(headers: IncomingHttpHeaders): string | undefined {
	const header = headers.authorization;
	if (typeof header !== "string") return undefined;
	return /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1];
}

/** Apply `extension` after `base` succeeds. A non-`AuthError` throw from the extension rejects with 403. */
export function withExtension(base: Authenticator, extension: AuthExtension | undefined): Authenticator {
	if (extension === undefined) return base;
	return {
		authenticate: async (request) => {
			const principal = await base.authenticate(request);
			try {
				return await extension(principal, request);
			} catch (error) {
				if (error instanceof AuthError) throw error;
				throw new AuthError(403, "rejected", error instanceof Error ? error.message : "rejected by auth extension");
			}
		},
	};
}

/** Owner key of a principal's sessions; tenants keep equal user ids apart. */
export function ownerKey(principal: Pick<Principal, "tenantId" | "userId">): string {
	return `${principal.tenantId ?? ""}/${principal.userId}`;
}
