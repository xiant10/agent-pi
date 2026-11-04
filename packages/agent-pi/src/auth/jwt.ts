import {
	createHmac,
	createPublicKey,
	type JsonWebKey,
	type KeyObject,
	constants as cryptoConstants,
	timingSafeEqual,
	verify as verifySignature,
} from "node:crypto";
import { type Authenticator, AuthError, type AuthRequest, bearerToken, type Principal } from "./authenticator.ts";

export type JwtAlgorithm =
	| "RS256"
	| "RS384"
	| "RS512"
	| "PS256"
	| "PS384"
	| "PS512"
	| "ES256"
	| "ES384"
	| "ES512"
	| "EdDSA"
	| "HS256"
	| "HS384"
	| "HS512";

export type JwtConfig = {
	/** Accepted `alg` values. `none` is never accepted. */
	readonly algorithms: readonly JwtAlgorithm[];
	/** JWKS endpoint for asymmetric keys, selected by `kid`. */
	readonly jwksUrl?: string;
	/** Static public keys: PEM strings or JWKs. */
	readonly publicKeys?: readonly (string | JsonWebKey)[];
	/** Shared secret for HS* algorithms. */
	readonly hmacSecret?: string;
	/** Accepted `iss` values; unset skips the check. */
	readonly issuer?: string | readonly string[];
	/** Required `aud` values (any one); unset skips the check. */
	readonly audience?: string | readonly string[];
	/** Default 60. */
	readonly clockToleranceSec?: number;
	/** Reject tokens without `exp`. Default true. */
	readonly requireExp?: boolean;
	/** Reject tokens older than this, by `iat`. */
	readonly maxTokenAgeSec?: number;
	/** Every one of these scopes must be granted (`scope` or `scp`). */
	readonly requiredScopes?: readonly string[];
	/** Claim path holding the user id. Default `sub`. Dotted paths reach nested claims. */
	readonly userClaim?: string;
	/** Claim path holding the user's display name, recorded in audit headers. Default `name`; absent claims are fine. */
	readonly nameClaim?: string;
	/** Claim path holding the tenant id, when tenants share the server. */
	readonly tenantClaim?: string;
	/** JWKS cache lifetime. Default 10 minutes. */
	readonly jwksCacheMs?: number;
	/** Minimum interval between JWKS refetches triggered by an unknown `kid`. Default 30 s. */
	readonly jwksMinRefreshMs?: number;
	/** Default 5 s. */
	readonly jwksTimeoutMs?: number;
};

type Header = { readonly alg?: unknown; readonly kid?: unknown; readonly typ?: unknown; readonly crit?: unknown };
type Claims = Record<string, unknown>;

type AlgorithmSpec = {
	readonly family: "RSA" | "PSS" | "EC" | "OKP" | "HMAC";
	/** Node digest name; `null` for EdDSA. */
	readonly hash: string | null;
	readonly curve?: string;
	readonly hashBytes?: number;
};

const ALGORITHMS: Readonly<Record<JwtAlgorithm, AlgorithmSpec>> = {
	RS256: { family: "RSA", hash: "sha256" },
	RS384: { family: "RSA", hash: "sha384" },
	RS512: { family: "RSA", hash: "sha512" },
	PS256: { family: "PSS", hash: "sha256", hashBytes: 32 },
	PS384: { family: "PSS", hash: "sha384", hashBytes: 48 },
	PS512: { family: "PSS", hash: "sha512", hashBytes: 64 },
	ES256: { family: "EC", hash: "sha256", curve: "prime256v1" },
	ES384: { family: "EC", hash: "sha384", curve: "secp384r1" },
	ES512: { family: "EC", hash: "sha512", curve: "secp521r1" },
	EdDSA: { family: "OKP", hash: null },
	HS256: { family: "HMAC", hash: "sha256" },
	HS384: { family: "HMAC", hash: "sha384" },
	HS512: { family: "HMAC", hash: "sha512" },
};

type VerificationKey = { readonly kid?: string; readonly alg?: string; readonly key: KeyObject };

/**
 * Verifies `Authorization: Bearer <jwt>` with `node:crypto` only.
 *
 * Algorithm confusion is ruled out structurally: the header's `alg` must be in the configured list, HS* tokens verify
 * only against `hmacSecret`, and asymmetric tokens only against public keys whose type matches the algorithm family.
 */
export class JwtAuthenticator implements Authenticator {
	readonly #config: JwtConfig;
	readonly #staticKeys: readonly VerificationKey[];
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	#jwks: readonly VerificationKey[] = [];
	#jwksFetchedAt = Number.NEGATIVE_INFINITY;
	#jwksInFlight: Promise<void> | undefined;

	constructor(config: JwtConfig, options: { readonly fetch?: typeof fetch; readonly now?: () => number } = {}) {
		if (config.algorithms.length === 0) throw new Error("jwt: algorithms must not be empty");
		for (const alg of config.algorithms) {
			if (!(alg in ALGORITHMS)) throw new Error(`jwt: unsupported algorithm ${JSON.stringify(alg)}`);
		}
		const usesHmac = config.algorithms.some((alg) => ALGORITHMS[alg].family === "HMAC");
		const usesAsymmetric = config.algorithms.some((alg) => ALGORITHMS[alg].family !== "HMAC");
		if (usesHmac && !config.hmacSecret) throw new Error("jwt: HS* algorithms need hmacSecret");
		if (usesAsymmetric && !config.jwksUrl && (config.publicKeys ?? []).length === 0) {
			throw new Error("jwt: asymmetric algorithms need jwksUrl or publicKeys");
		}
		this.#config = config;
		this.#staticKeys = (config.publicKeys ?? []).map(importKey);
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#now = options.now ?? Date.now;
	}

	async authenticate(request: AuthRequest): Promise<Principal> {
		const token = bearerToken(request.headers);
		if (token === undefined) throw new AuthError(401, "missing_token", "missing bearer token");
		const claims = await this.verify(token);
		return this.#principal(token, claims);
	}

	/** Verify signature and registered claims; returns the payload. */
	async verify(token: string): Promise<Claims> {
		const parts = token.split(".");
		if (parts.length !== 3) throw invalid("malformed token");
		const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
		const header = decodeJson(encodedHeader) as Header;
		const alg = header.alg;
		if (typeof alg !== "string" || !(this.#config.algorithms as readonly string[]).includes(alg)) {
			throw invalid("token algorithm not accepted");
		}
		// No extensions are understood, so any critical header must be rejected (RFC 7515 §4.1.11).
		if (header.crit !== undefined) throw invalid("unsupported critical header");
		const spec = ALGORITHMS[alg as JwtAlgorithm];
		const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii");
		const signature = decodeBase64Url(encodedSignature);
		const kid = typeof header.kid === "string" ? header.kid : undefined;

		if (spec.family === "HMAC") {
			const expected = createHmac(spec.hash!, this.#config.hmacSecret!).update(signingInput).digest();
			if (expected.length !== signature.length || !timingSafeEqual(expected, signature)) {
				throw invalid("bad signature");
			}
		} else {
			const candidates = await this.#candidateKeys(alg as JwtAlgorithm, kid);
			if (candidates.length === 0) throw invalid("no matching key");
			if (!candidates.some((candidate) => verifyWith(spec, candidate, signingInput, signature))) {
				throw invalid("bad signature");
			}
		}

		const claims = decodeJson(encodedPayload);
		if (typeof claims !== "object" || claims === null || Array.isArray(claims)) throw invalid("malformed claims");
		this.#checkClaims(claims as Claims);
		return claims as Claims;
	}

	#checkClaims(claims: Claims): void {
		const config = this.#config;
		const now = this.#now() / 1000;
		const tolerance = config.clockToleranceSec ?? 60;
		const exp = claims.exp;
		if (exp === undefined) {
			if (config.requireExp ?? true) throw invalid("token has no exp");
		} else if (typeof exp !== "number" || now > exp + tolerance) {
			throw new AuthError(401, "token_expired", "token expired");
		}
		const nbf = claims.nbf;
		if (nbf !== undefined && (typeof nbf !== "number" || now + tolerance < nbf)) throw invalid("token not yet valid");
		const iat = claims.iat;
		if (iat !== undefined) {
			if (typeof iat !== "number" || iat > now + tolerance) throw invalid("token issued in the future");
			if (config.maxTokenAgeSec !== undefined && now - iat > config.maxTokenAgeSec + tolerance) {
				throw new AuthError(401, "token_expired", "token too old");
			}
		} else if (config.maxTokenAgeSec !== undefined) {
			throw invalid("token has no iat");
		}
		if (config.issuer !== undefined) {
			const issuers = typeof config.issuer === "string" ? [config.issuer] : config.issuer;
			if (typeof claims.iss !== "string" || !issuers.includes(claims.iss)) throw invalid("issuer not accepted");
		}
		if (config.audience !== undefined) {
			const wanted = typeof config.audience === "string" ? [config.audience] : config.audience;
			const aud = claims.aud;
			const presented = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
			if (!presented.some((value) => typeof value === "string" && wanted.includes(value))) {
				throw invalid("audience not accepted");
			}
		}
		const scopes = scopesOf(claims);
		for (const scope of config.requiredScopes ?? []) {
			if (!scopes.includes(scope)) throw new AuthError(403, "insufficient_scope", `missing scope ${scope}`);
		}
	}

	#principal(token: string, claims: Claims): Principal {
		const userId = claimAt(claims, this.#config.userClaim ?? "sub");
		if (typeof userId !== "string" || userId.length === 0) throw invalid("token has no user id claim");
		const tenant = this.#config.tenantClaim === undefined ? undefined : claimAt(claims, this.#config.tenantClaim);
		if (this.#config.tenantClaim !== undefined && (typeof tenant !== "string" || tenant.length === 0)) {
			throw invalid("token has no tenant claim");
		}
		const name = claimAt(claims, this.#config.nameClaim ?? "name");
		const runtime = claimAt(claims, "act.sub");
		return {
			userId,
			...(typeof tenant === "string" ? { tenantId: tenant } : {}),
			...(typeof name === "string" && name.length > 0 ? { displayName: name } : {}),
			scopes: scopesOf(claims),
			claims,
			token,
			...(typeof claims.exp === "number" ? { expiresAt: claims.exp * 1000 } : {}),
			...(typeof runtime === "string" && typeof claims.grant === "string"
				? {
						agent: {
							runtime,
							grantId: claims.grant,
							...(typeof claims.trg === "string" && claims.trg !== "" ? { trigger: claims.trg } : {}),
							...(typeof claims.automation === "string" && claims.automation !== "" ? { automation: claims.automation } : {}),
						},
					}
				: {}),
		};
	}

	/** Keys that may have signed a token with `alg` and `kid`: static keys, then JWKS, refetched once for a new kid. */
	async #candidateKeys(alg: JwtAlgorithm, kid: string | undefined): Promise<VerificationKey[]> {
		const spec = ALGORITHMS[alg];
		const pick = (keys: readonly VerificationKey[]) =>
			keys.filter(
				(key) =>
					(kid === undefined || key.kid === undefined || key.kid === kid) &&
					(key.alg === undefined || key.alg === alg) &&
					keyMatches(spec, key.key),
			);
		const found = pick(this.#staticKeys);
		if (this.#config.jwksUrl === undefined) return found;
		const cacheMs = this.#config.jwksCacheMs ?? 600_000;
		const minRefreshMs = this.#config.jwksMinRefreshMs ?? 30_000;
		const age = this.#now() - this.#jwksFetchedAt;
		const knowsKid = kid !== undefined && this.#jwks.some((key) => key.kid === kid);
		if (age > cacheMs || (kid !== undefined && !knowsKid && age >= minRefreshMs)) await this.#refreshJwks();
		return [...found, ...pick(this.#jwks)];
	}

	/** One fetch at a time. A failed fetch keeps the stale keys; a token whose key is not among them is rejected. */
	async #refreshJwks(): Promise<void> {
		this.#jwksInFlight ??= (async () => {
			try {
				const response = await this.#fetch(this.#config.jwksUrl!, {
					headers: { accept: "application/json" },
					signal: AbortSignal.timeout(this.#config.jwksTimeoutMs ?? 5_000),
				});
				if (!response.ok) throw new Error(`JWKS fetch returned ${response.status}`);
				const body = (await response.json()) as { keys?: unknown };
				if (!Array.isArray(body.keys)) throw new Error("JWKS response has no keys array");
				const keys: VerificationKey[] = [];
				for (const jwk of body.keys as JsonWebKey[]) {
					if (jwk.use !== undefined && jwk.use !== "sig") continue;
					try {
						keys.push(importKey(jwk));
					} catch {
						// A key of an unsupported type must not block the others.
					}
				}
				this.#jwks = keys;
			} catch (error) {
				console.error(`jwt: JWKS refresh failed: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				// Failures count as fetches too, so an unreachable JWKS endpoint is not hammered.
				this.#jwksFetchedAt = this.#now();
				this.#jwksInFlight = undefined;
			}
		})();
		await this.#jwksInFlight;
	}
}

function importKey(source: string | JsonWebKey): VerificationKey {
	if (typeof source === "string") return { key: createPublicKey(source) };
	if (source.kty === "oct") throw new Error("jwt: symmetric JWKs are not accepted as public keys");
	return {
		...(typeof source.kid === "string" ? { kid: source.kid } : {}),
		...(typeof source.alg === "string" ? { alg: source.alg } : {}),
		key: createPublicKey({ key: source, format: "jwk" }),
	};
}

function keyMatches(spec: AlgorithmSpec, key: KeyObject): boolean {
	const type = key.asymmetricKeyType;
	switch (spec.family) {
		case "RSA":
			return type === "rsa";
		case "PSS":
			return type === "rsa" || type === "rsa-pss";
		case "EC":
			return type === "ec" && key.asymmetricKeyDetails?.namedCurve === spec.curve;
		case "OKP":
			return type === "ed25519" || type === "ed448";
		case "HMAC":
			return false;
	}
}

function verifyWith(spec: AlgorithmSpec, candidate: VerificationKey, data: Buffer, signature: Buffer): boolean {
	try {
		if (spec.family === "PSS") {
			return verifySignature(
				spec.hash,
				data,
				{ key: candidate.key, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: spec.hashBytes! },
				signature,
			);
		}
		if (spec.family === "EC") {
			return verifySignature(spec.hash, data, { key: candidate.key, dsaEncoding: "ieee-p1363" }, signature);
		}
		return verifySignature(spec.hash, data, candidate.key, signature);
	} catch {
		return false;
	}
}

function scopesOf(claims: Claims): string[] {
	const scope = claims.scope ?? claims.scp;
	if (typeof scope === "string") return scope.split(" ").filter((value) => value.length > 0);
	if (Array.isArray(scope)) return scope.filter((value): value is string => typeof value === "string");
	return [];
}

function claimAt(claims: Claims, path: string): unknown {
	let value: unknown = claims;
	for (const part of path.split(".")) {
		if (typeof value !== "object" || value === null) return undefined;
		value = (value as Record<string, unknown>)[part];
	}
	return value;
}

function decodeBase64Url(part: string): Buffer {
	if (!/^[A-Za-z0-9_-]*$/.test(part)) throw invalid("malformed token");
	return Buffer.from(part, "base64url");
}

function decodeJson(part: string): unknown {
	try {
		return JSON.parse(decodeBase64Url(part).toString("utf8"));
	} catch (error) {
		if (error instanceof AuthError) throw error;
		throw invalid("malformed token");
	}
}

function invalid(message: string): AuthError {
	return new AuthError(401, "invalid_token", message);
}
