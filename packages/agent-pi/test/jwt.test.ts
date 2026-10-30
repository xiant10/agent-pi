import { createHmac, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuthError, withExtension } from "../src/auth/authenticator.ts";
import { JwtAuthenticator } from "../src/auth/jwt.ts";

const NOW = 1_800_000_000_000;
const now = () => NOW;

function b64(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signRs256(privateKey: KeyObject, claims: object, header: object = {}): string {
	const input = `${b64({ alg: "RS256", typ: "JWT", ...header })}.${b64(claims)}`;
	return `${input}.${sign("sha256", Buffer.from(input), privateKey).toString("base64url")}`;
}

function signEs256(privateKey: KeyObject, claims: object, header: object = {}): string {
	const input = `${b64({ alg: "ES256", ...header })}.${b64(claims)}`;
	const signature = sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" });
	return `${input}.${signature.toString("base64url")}`;
}

function signHs256(secret: string, claims: object): string {
	const input = `${b64({ alg: "HS256" })}.${b64(claims)}`;
	return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
}

function request(token: string | undefined) {
	return { headers: token === undefined ? {} : { authorization: `Bearer ${token}` }, method: "POST", path: "/agent" };
}

const valid = { sub: "alice", exp: NOW / 1000 + 300, iat: NOW / 1000, iss: "https://idp", aud: "agent" };

async function rejection(promise: Promise<unknown>): Promise<AuthError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof AuthError) return error;
		throw error;
	}
	throw new Error("expected rejection");
}

describe("JwtAuthenticator", () => {
	const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const rsaPem = rsa.publicKey.export({ type: "spki", format: "pem" }).toString();
	const auth = new JwtAuthenticator(
		{ algorithms: ["RS256"], publicKeys: [rsaPem], issuer: "https://idp", audience: "agent" },
		{ now },
	);

	it("accepts a valid RS256 token and maps sub, scope, and exp", async () => {
		const token = signRs256(rsa.privateKey, { ...valid, scope: "agent:use crm:read" });
		const principal = await auth.authenticate(request(token));
		expect(principal).toMatchObject({ userId: "alice", scopes: ["agent:use", "crm:read"], token });
		expect(principal.expiresAt).toBe(valid.exp * 1000);
	});

	it("rejects missing, malformed, tampered, and expired tokens", async () => {
		expect((await rejection(auth.authenticate(request(undefined)))).code).toBe("missing_token");
		expect((await rejection(auth.authenticate(request("a.b")))).code).toBe("invalid_token");
		const token = signRs256(rsa.privateKey, valid);
		const [header, , signature] = token.split(".");
		const tampered = `${header}.${b64({ ...valid, sub: "mallory" })}.${signature}`;
		expect((await rejection(auth.authenticate(request(tampered)))).message).toBe("bad signature");
		const expired = signRs256(rsa.privateKey, { ...valid, exp: NOW / 1000 - 120 });
		expect((await rejection(auth.authenticate(request(expired)))).code).toBe("token_expired");
	});

	it("rejects wrong issuer and audience", async () => {
		const wrongIss = signRs256(rsa.privateKey, { ...valid, iss: "https://evil" });
		expect((await rejection(auth.authenticate(request(wrongIss)))).message).toBe("issuer not accepted");
		const wrongAud = signRs256(rsa.privateKey, { ...valid, aud: ["other"] });
		expect((await rejection(auth.authenticate(request(wrongAud)))).message).toBe("audience not accepted");
	});

	it("rejects alg none and HS256 signed with the public key (algorithm confusion)", async () => {
		const none = `${b64({ alg: "none" })}.${b64(valid)}.`;
		expect((await rejection(auth.authenticate(request(none)))).message).toBe("token algorithm not accepted");
		const confused = signHs256(rsaPem, valid);
		expect((await rejection(auth.authenticate(request(confused)))).message).toBe("token algorithm not accepted");
	});

	it("verifies HS256 only with the configured secret", async () => {
		const hmac = new JwtAuthenticator({ algorithms: ["HS256"], hmacSecret: "s3cret" }, { now });
		expect((await hmac.authenticate(request(signHs256("s3cret", valid)))).userId).toBe("alice");
		const wrong = signHs256("other", valid);
		expect((await rejection(hmac.authenticate(request(wrong)))).message).toBe("bad signature");
	});

	it("fetches JWKS by kid and refetches once for a rotated key", async () => {
		const first = generateKeyPairSync("ec", { namedCurve: "P-256" });
		const second = generateKeyPairSync("ec", { namedCurve: "P-256" });
		let keys = [{ ...first.publicKey.export({ format: "jwk" }), kid: "k1", use: "sig" }];
		let fetches = 0;
		const fakeFetch = (async () => {
			fetches++;
			return new Response(JSON.stringify({ keys }), { status: 200 });
		}) as typeof fetch;
		const jwks = new JwtAuthenticator(
			{ algorithms: ["ES256"], jwksUrl: "https://idp/jwks", jwksMinRefreshMs: 0 },
			{ now, fetch: fakeFetch },
		);
		expect((await jwks.authenticate(request(signEs256(first.privateKey, valid, { kid: "k1" })))).userId).toBe(
			"alice",
		);
		expect(fetches).toBe(1);
		keys = [...keys, { ...second.publicKey.export({ format: "jwk" }), kid: "k2", use: "sig" }];
		expect((await jwks.authenticate(request(signEs256(second.privateKey, valid, { kid: "k2" })))).userId).toBe(
			"alice",
		);
		expect(fetches).toBe(2);
	});

	it("maps nested user and tenant claims and enforces required scopes", async () => {
		const scoped = new JwtAuthenticator(
			{
				algorithms: ["RS256"],
				publicKeys: [rsaPem],
				userClaim: "ext.uid",
				tenantClaim: "tid",
				requiredScopes: ["agent:use"],
			},
			{ now },
		);
		const ok = signRs256(rsa.privateKey, { ...valid, ext: { uid: "u-7" }, tid: "acme", scp: ["agent:use"] });
		expect(await scoped.authenticate(request(ok))).toMatchObject({ userId: "u-7", tenantId: "acme" });
		const noScope = signRs256(rsa.privateKey, { ...valid, ext: { uid: "u-7" }, tid: "acme" });
		expect((await rejection(scoped.authenticate(request(noScope)))).status).toBe(403);
	});

	it("runs the extension hook after verification and maps its errors to 403", async () => {
		const extended = withExtension(auth, (principal) => {
			if (principal.userId === "alice") throw new Error("account suspended");
			return principal;
		});
		const error = await rejection(extended.authenticate(request(signRs256(rsa.privateKey, valid))));
		expect(error).toMatchObject({ status: 403, message: "account suspended" });
	});
});
