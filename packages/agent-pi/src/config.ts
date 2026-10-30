import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { JwtAlgorithm, JwtConfig } from "./auth/jwt.ts";
import type { InstructionSection } from "./agent/core-extension.ts";
import type { ModelConfig } from "./agent/models.ts";
import { GATEWAY_IDENTITY_HEADERS, type IdentityHeaderNames } from "./identity.ts";
import type { McpServerConfig } from "./mcp/manager.ts";

export type ProfileConfig = {
	readonly model: string;
	readonly thinkingLevel: ModelThinkingLevel;
	readonly instructions?: string;
	readonly alwaysOnTools: readonly string[];
	readonly maxActiveTools: number;
	readonly preload: { readonly maxTools: number; readonly minScore: number };
	readonly speech: boolean;
	readonly thinkingEvents: boolean;
	readonly expert?: { readonly model: string; readonly thinkingLevel: ModelThinkingLevel };
};

export type AuthConfig =
	| ({ readonly kind: "jwt" } & JwtConfig)
	| { readonly kind: "static"; readonly tokens: string };

export type LimitsConfig = {
	readonly maxSessionsPerUser: number;
	readonly maxConcurrentRunsPerUser: number;
	readonly maxConcurrentRuns: number;
	readonly maxInputChars: number;
	readonly maxBodyBytes: number;
};

export type AppConfig = {
	readonly port: number;
	readonly host: string;
	/** Prefix of public session ids; persisted in storage when unset. */
	readonly instanceId?: string;
	readonly storage: { readonly kind: "memory" } | { readonly kind: "sqlite"; readonly path: string };
	readonly auth: AuthConfig;
	readonly models: Readonly<Record<string, ModelConfig>>;
	readonly profiles: Readonly<Record<string, ProfileConfig>>;
	readonly defaultProfile: string;
	readonly instructions: readonly InstructionSection[];
	readonly skillsDir?: string;
	readonly mcpServers: readonly McpServerConfig[];
	readonly limits: LimitsConfig;
	readonly http: { readonly path: string; readonly allowedOrigins: readonly string[]; readonly keepAliveMs: number };
	readonly durable: {
		readonly stream: { readonly timeoutMs?: number; readonly cacheRetention?: "none" | "short" | "long" };
		readonly compaction: { readonly enabled?: boolean; readonly reserveTokens?: number; readonly keepRecentTokens?: number };
		readonly retry: { readonly maxRetries?: number; readonly baseDelayMs?: number };
	};
	readonly logLevel: "debug" | "info" | "warn" | "error";
};

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g;
const SECTION_NAME = /^[a-z][a-z0-9_-]*$/;
const RESERVED_SECTIONS = new Set(["instructions", "skills", "profile"]);
const THINKING: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const JWT_ALGORITHMS: readonly JwtAlgorithm[] = [
	"RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA", "HS256", "HS384", "HS512",
];

/** Loads `.env` into `process.env` when present, before `loadConfig()` substitutes variables. */
export function loadDotEnv(path = process.env.AGENT_ENV_FILE ?? ".env"): void {
	if (existsSync(path)) process.loadEnvFile(path);
}

/** `${VAR}` and `${VAR:-default}` in every string value; an unset variable without a default is an error. */
function substitute(value: unknown, source: string): unknown {
	if (typeof value === "string") {
		return value.replace(PLACEHOLDER, (_match, name: string, hasDefault: string | undefined, fallback: string | undefined) => {
			const env = process.env[name];
			if (env !== undefined) return env;
			if (hasDefault !== undefined) return fallback ?? "";
			throw new Error(`${source}: \${${name}} is not set and has no default`);
		});
	}
	if (Array.isArray(value)) return value.map((item) => substitute(item, source));
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, source)]));
	}
	return value;
}

type Raw = Record<string, unknown>;

/** Field readers that fail with the field's path. Substituted values arrive as strings, so numbers accept numeric strings. */
class Reader {
	readonly #source: string;
	constructor(source: string) {
		this.#source = source;
	}
	fail(path: string, message: string): never {
		throw new Error(`${this.#source}: ${path} ${message}`);
	}
	object(value: unknown, path: string): Raw {
		if (typeof value !== "object" || value === null || Array.isArray(value)) this.fail(path, "must be an object");
		return value as Raw;
	}
	optionalObject(value: unknown, path: string): Raw {
		return value === undefined ? {} : this.object(value, path);
	}
	string(value: unknown, path: string): string {
		if (typeof value !== "string" || value.length === 0) this.fail(path, "must be a non-empty string");
		return value;
	}
	optionalString(value: unknown, path: string): string | undefined {
		return value === undefined || value === "" ? undefined : this.string(value, path);
	}
	number(value: unknown, path: string, fallback?: number): number {
		if (value === undefined && fallback !== undefined) return fallback;
		const number = typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
		if (typeof number !== "number" || !Number.isFinite(number)) this.fail(path, "must be a number");
		return number;
	}
	optionalNumber(value: unknown, path: string): number | undefined {
		return value === undefined ? undefined : this.number(value, path);
	}
	boolean(value: unknown, path: string, fallback: boolean): boolean {
		if (value === undefined) return fallback;
		if (value === "true") return true;
		if (value === "false") return false;
		if (typeof value !== "boolean") this.fail(path, "must be a boolean");
		return value;
	}
	strings(value: unknown, path: string): string[] {
		if (value === undefined) return [];
		if (typeof value === "string") return value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
		if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) this.fail(path, "must be a list of strings");
		return value as string[];
	}
	oneOf<T extends string>(value: unknown, path: string, options: readonly T[], fallback?: T): T {
		if (value === undefined && fallback !== undefined) return fallback;
		if (typeof value !== "string" || !(options as readonly string[]).includes(value)) {
			this.fail(path, `must be one of ${options.join(", ")}`);
		}
		return value as T;
	}
}

export function loadConfig(path: string): AppConfig {
	const source = resolve(path);
	const dir = dirname(source);
	const r = new Reader(source);
	const raw = r.object(substitute(JSON.parse(readFileSync(source, "utf8")), source), "config");
	const file = (relative: string) => resolve(dir, relative);
	const readText = (relative: string, at: string) => {
		try {
			return readFileSync(file(relative), "utf8");
		} catch (error) {
			return r.fail(at, `cannot be read (${file(relative)}): ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const storageRaw = r.optionalObject(raw.storage, "storage");
	const storageKind = r.oneOf(storageRaw.kind, "storage.kind", ["memory", "sqlite"] as const, "sqlite");
	const storage =
		storageKind === "memory"
			? ({ kind: "memory" } as const)
			: ({ kind: "sqlite", path: file(r.optionalString(storageRaw.path, "storage.path") ?? "agent.sqlite") } as const);

	const authRaw = r.object(raw.auth, "auth");
	const authKind = r.oneOf(authRaw.kind, "auth.kind", ["jwt", "static"] as const);
	let auth: AuthConfig;
	if (authKind === "static") {
		auth = { kind: "static", tokens: r.string(authRaw.tokens, "auth.tokens") };
	} else {
		const publicKeys: string[] = [];
		for (const [index, key] of r.strings(authRaw.publicKeyFiles, "auth.publicKeyFiles").entries()) {
			publicKeys.push(readText(key, `auth.publicKeyFiles[${index}]`));
		}
		const hmacSecret = r.optionalString(authRaw.hmacSecret, "auth.hmacSecret");
		const jwksUrl = r.optionalString(authRaw.jwksUrl, "auth.jwksUrl");
		const issuer = r.strings(authRaw.issuer, "auth.issuer");
		const audience = r.strings(authRaw.audience, "auth.audience");
		const maxTokenAgeSec = r.optionalNumber(authRaw.maxTokenAgeSec, "auth.maxTokenAgeSec");
		const tenantClaim = r.optionalString(authRaw.tenantClaim, "auth.tenantClaim");
		const nameClaim = r.optionalString(authRaw.nameClaim, "auth.nameClaim");
		auth = {
			kind: "jwt",
			algorithms: r.strings(authRaw.algorithms, "auth.algorithms").map((alg, index) =>
				r.oneOf(alg, `auth.algorithms[${index}]`, JWT_ALGORITHMS),
			),
			...(jwksUrl === undefined ? {} : { jwksUrl }),
			...(publicKeys.length === 0 ? {} : { publicKeys }),
			...(hmacSecret === undefined ? {} : { hmacSecret }),
			...(issuer.length === 0 ? {} : { issuer }),
			...(audience.length === 0 ? {} : { audience }),
			clockToleranceSec: r.number(authRaw.clockToleranceSec, "auth.clockToleranceSec", 60),
			requireExp: r.boolean(authRaw.requireExp, "auth.requireExp", true),
			...(maxTokenAgeSec === undefined ? {} : { maxTokenAgeSec }),
			requiredScopes: r.strings(authRaw.requiredScopes, "auth.requiredScopes"),
			userClaim: r.optionalString(authRaw.userClaim, "auth.userClaim") ?? "sub",
			...(tenantClaim === undefined ? {} : { tenantClaim }),
			...(nameClaim === undefined ? {} : { nameClaim }),
		};
	}

	const modelsRaw = r.object(raw.models, "models");
	const models: Record<string, ModelConfig> = {};
	for (const [name, value] of Object.entries(modelsRaw)) models[name] = parseModel(r, value, `models.${name}`);
	if (Object.keys(models).length === 0) r.fail("models", "must name at least one model");
	const modelName = (value: unknown, at: string) => {
		const name = r.string(value, at);
		if (models[name] === undefined) r.fail(at, `names unknown model ${JSON.stringify(name)}`);
		return name;
	};

	const profilesRaw = r.object(raw.profiles, "profiles");
	const profiles: Record<string, ProfileConfig> = {};
	for (const [name, value] of Object.entries(profilesRaw)) {
		const at = `profiles.${name}`;
		const p = r.object(value, at);
		const preload = r.optionalObject(p.preload, `${at}.preload`);
		const expertRaw = p.expert === undefined ? undefined : r.object(p.expert, `${at}.expert`);
		const instructionsFile = r.optionalString(p.instructionsFile, `${at}.instructionsFile`);
		profiles[name] = {
			model: modelName(p.model, `${at}.model`),
			thinkingLevel: r.oneOf(p.thinkingLevel, `${at}.thinkingLevel`, THINKING, "off"),
			...(instructionsFile === undefined ? {} : { instructions: readText(instructionsFile, `${at}.instructionsFile`) }),
			alwaysOnTools: r.strings(p.alwaysOnTools, `${at}.alwaysOnTools`),
			maxActiveTools: r.number(p.maxActiveTools, `${at}.maxActiveTools`, 32),
			preload: {
				maxTools: r.number(preload.maxTools, `${at}.preload.maxTools`, 0),
				minScore: r.number(preload.minScore, `${at}.preload.minScore`, 4),
			},
			speech: r.boolean(p.speech, `${at}.speech`, false),
			thinkingEvents: r.boolean(p.thinkingEvents, `${at}.thinkingEvents`, false),
			...(expertRaw === undefined
				? {}
				: {
						expert: {
							model: modelName(expertRaw.model, `${at}.expert.model`),
							thinkingLevel: r.oneOf(expertRaw.thinkingLevel, `${at}.expert.thinkingLevel`, THINKING, "high"),
						},
					}),
		};
	}
	const defaultProfile = r.optionalString(raw.defaultProfile, "defaultProfile") ?? Object.keys(profiles)[0] ?? "";
	if (profiles[defaultProfile] === undefined) r.fail("defaultProfile", "must name a configured profile");

	const instructions: InstructionSection[] = [];
	for (const [index, value] of (Array.isArray(raw.instructions) ? raw.instructions : []).entries()) {
		const at = `instructions[${index}]`;
		const entry = r.object(value, at);
		const name = r.string(entry.name, `${at}.name`);
		if (!SECTION_NAME.test(name) || RESERVED_SECTIONS.has(name)) {
			r.fail(`${at}.name`, `must match ${SECTION_NAME} and not be one of ${[...RESERVED_SECTIONS].join(", ")}`);
		}
		instructions.push({
			name,
			content: readText(r.string(entry.file, `${at}.file`), `${at}.file`),
			tag: r.boolean(entry.tag, `${at}.tag`, true),
		});
	}

	const mcpServers = (Array.isArray(raw.mcpServers) ? raw.mcpServers : []).map((value, index) =>
		parseMcpServer(r, value, `mcpServers[${index}]`),
	);

	const limits = r.optionalObject(raw.limits, "limits");
	const http = r.optionalObject(raw.http, "http");
	const durable = r.optionalObject(raw.durable, "durable");
	const stream = r.optionalObject(durable.stream, "durable.stream");
	const compaction = r.optionalObject(durable.compaction, "durable.compaction");
	const retry = r.optionalObject(durable.retry, "durable.retry");
	const skillsDir = r.optionalString(raw.skillsDir, "skillsDir");
	const instanceId = r.optionalString(raw.instanceId, "instanceId");
	if (instanceId !== undefined && !/^[A-Za-z0-9_-]+$/.test(instanceId)) r.fail("instanceId", "must match [A-Za-z0-9_-]+");
	const timeoutMs = r.optionalNumber(stream.timeoutMs, "durable.stream.timeoutMs");
	const cacheRetention =
		stream.cacheRetention === undefined
			? undefined
			: r.oneOf(stream.cacheRetention, "durable.stream.cacheRetention", ["none", "short", "long"] as const);
	const compactionEnabled = compaction.enabled === undefined ? undefined : r.boolean(compaction.enabled, "durable.compaction.enabled", true);
	const reserveTokens = r.optionalNumber(compaction.reserveTokens, "durable.compaction.reserveTokens");
	const keepRecentTokens = r.optionalNumber(compaction.keepRecentTokens, "durable.compaction.keepRecentTokens");
	const maxRetries = r.optionalNumber(retry.maxRetries, "durable.retry.maxRetries");
	const baseDelayMs = r.optionalNumber(retry.baseDelayMs, "durable.retry.baseDelayMs");

	return {
		port: r.number(raw.port, "port", 9800),
		host: r.optionalString(raw.host, "host") ?? "0.0.0.0",
		...(instanceId === undefined ? {} : { instanceId }),
		storage,
		auth,
		models,
		profiles,
		defaultProfile,
		instructions,
		...(skillsDir === undefined ? {} : { skillsDir: file(skillsDir) }),
		mcpServers,
		limits: {
			maxSessionsPerUser: r.number(limits.maxSessionsPerUser, "limits.maxSessionsPerUser", 20),
			maxConcurrentRunsPerUser: r.number(limits.maxConcurrentRunsPerUser, "limits.maxConcurrentRunsPerUser", 3),
			maxConcurrentRuns: r.number(limits.maxConcurrentRuns, "limits.maxConcurrentRuns", 200),
			maxInputChars: r.number(limits.maxInputChars, "limits.maxInputChars", 32_000),
			maxBodyBytes: r.number(limits.maxBodyBytes, "limits.maxBodyBytes", 1_000_000),
		},
		http: {
			path: r.optionalString(http.path, "http.path") ?? "/agent",
			allowedOrigins: r.strings(http.allowedOrigins, "http.allowedOrigins"),
			keepAliveMs: r.number(http.keepAliveMs, "http.keepAliveMs", 15_000),
		},
		durable: {
			stream: {
				...(timeoutMs === undefined ? {} : { timeoutMs }),
				...(cacheRetention === undefined ? {} : { cacheRetention }),
			},
			compaction: {
				...(compactionEnabled === undefined ? {} : { enabled: compactionEnabled }),
				...(reserveTokens === undefined ? {} : { reserveTokens }),
				...(keepRecentTokens === undefined ? {} : { keepRecentTokens }),
			},
			retry: {
				...(maxRetries === undefined ? {} : { maxRetries }),
				...(baseDelayMs === undefined ? {} : { baseDelayMs }),
			},
		},
		logLevel: r.oneOf(raw.logLevel, "logLevel", ["debug", "info", "warn", "error"] as const, "info"),
	};
}

function parseModel(r: Reader, value: unknown, at: string): ModelConfig {
	const m = r.object(value, at);
	const provider = r.oneOf(m.provider, `${at}.provider`, ["anthropic", "openai", "openai-compatible"] as const);
	const modelId = r.string(m.modelId, `${at}.modelId`);
	if (provider !== "openai-compatible") return { provider, modelId };
	const providerId = r.optionalString(m.providerId, `${at}.providerId`);
	const apiKeyEnv = r.optionalString(m.apiKeyEnv, `${at}.apiKeyEnv`);
	const contextWindow = r.optionalNumber(m.contextWindow, `${at}.contextWindow`);
	const maxOutputTokens = r.optionalNumber(m.maxOutputTokens, `${at}.maxOutputTokens`);
	const identityHeaders = parseIdentityHeaders(r, m.identityHeaders, `${at}.identityHeaders`);
	return {
		provider,
		modelId,
		baseUrl: r.string(m.baseUrl, `${at}.baseUrl`),
		...(providerId === undefined ? {} : { providerId }),
		...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
		api: r.oneOf(m.api, `${at}.api`, ["responses", "chat-completions"] as const, "chat-completions"),
		reasoning: r.boolean(m.reasoning, `${at}.reasoning`, false),
		...(contextWindow === undefined ? {} : { contextWindow }),
		...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
		...(identityHeaders === undefined ? {} : { identityHeaders }),
	};
}

/** `"gateway"` for the agent gateway's audit headers, or an object naming the header of each identity field. */
function parseIdentityHeaders(r: Reader, value: unknown, at: string): IdentityHeaderNames | undefined {
	if (value === undefined) return undefined;
	if (value === "gateway") return GATEWAY_IDENTITY_HEADERS;
	const fields = r.object(value, at);
	const names: Record<string, string> = {};
	for (const [field, header] of Object.entries(fields)) {
		if (!IDENTITY_FIELDS.includes(field)) r.fail(`${at}.${field}`, `must be one of ${IDENTITY_FIELDS.join(", ")}`);
		names[field] = r.string(header, `${at}.${field}`);
	}
	return names;
}

const IDENTITY_FIELDS: readonly string[] = ["sessionId", "turnId", "userId", "userName", "tenantId"];

function parseMcpServer(r: Reader, value: unknown, at: string): McpServerConfig {
	const s = r.object(value, at);
	const name = r.string(s.name, `${at}.name`);
	const prefix = typeof s.prefix === "string" ? s.prefix : undefined;
	const include = s.include === undefined ? undefined : r.strings(s.include, `${at}.include`);
	const exclude = s.exclude === undefined ? undefined : r.strings(s.exclude, `${at}.exclude`);
	const callTimeoutMs = r.optionalNumber(s.callTimeoutMs, `${at}.callTimeoutMs`);
	const maxDescriptionChars = r.optionalNumber(s.maxDescriptionChars, `${at}.maxDescriptionChars`);
	const common = {
		name,
		...(prefix === undefined ? {} : { prefix }),
		...(include === undefined ? {} : { include }),
		...(exclude === undefined ? {} : { exclude }),
		...(callTimeoutMs === undefined ? {} : { callTimeoutMs }),
		...(maxDescriptionChars === undefined ? {} : { maxDescriptionChars }),
	};
	const transport = r.oneOf(s.transport, `${at}.transport`, ["http", "stdio"] as const);
	const stringMap = (raw: unknown, path: string) => {
		const object = r.optionalObject(raw, path);
		for (const [key, item] of Object.entries(object)) if (typeof item !== "string") r.fail(`${path}.${key}`, "must be a string");
		return object as Record<string, string>;
	};
	if (transport === "stdio") {
		const cwd = r.optionalString(s.cwd, `${at}.cwd`);
		return {
			...common,
			transport,
			command: r.string(s.command, `${at}.command`),
			args: r.strings(s.args, `${at}.args`),
			env: stringMap(s.env, `${at}.env`),
			...(cwd === undefined ? {} : { cwd }),
		};
	}
	const forwardHeader = r.optionalString(s.forwardHeader, `${at}.forwardHeader`);
	return {
		...common,
		transport,
		url: r.string(s.url, `${at}.url`),
		headers: stringMap(s.headers, `${at}.headers`),
		auth: r.oneOf(s.auth, `${at}.auth`, ["static", "forward"] as const, "static"),
		...(forwardHeader === undefined ? {} : { forwardHeader }),
	};
}
