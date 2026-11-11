import { AsyncLocalStorage } from "node:async_hooks";
import {
	type CallToolResult,
	McpClient,
	type McpTransport,
	type Tool as McpTool,
	StdioTransport,
	StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import { bearerProvider, type BearerSource } from "./token.ts";
import { type CatalogEntry, compilePattern, offeredName, type ToolCatalog } from "../tools/catalog.ts";
import type { Logger } from "../util/log.ts";

type CommonServerConfig = {
	readonly name: string;
	/** Prepended to every tool name. Default `<name>_`; `""` offers bare MCP names. */
	readonly prefix?: string;
	/** Only these tools (`compilePattern` globs) enter the catalog. */
	readonly include?: readonly string[];
	readonly exclude?: readonly string[];
	/** Per call. Default 30 s. */
	readonly callTimeoutMs?: number;
	/** Descriptions longer than this are cut, to keep tool schemas small. Default 1000. */
	readonly maxDescriptionChars?: number;
};

export type McpServerConfig =
	| (CommonServerConfig & {
			readonly transport: "http";
			readonly url: string;
			/** Sent on every request; with `auth: "grant"`, used only for listing tools. */
			readonly headers?: Readonly<Record<string, string>>;
			/**
			 * `static` (default): one shared connection with `headers`. `grant`: calls go over a per-grant connection that
			 * carries a token minted from the conversation's grant in `tokenHeader` (default `Authorization`). `bearer`:
			 * one shared connection that sends `bearer` as `Authorization: Bearer`, for a service with its own token.
			 */
			readonly auth?: "static" | "grant" | "bearer";
			readonly bearer?: BearerSource;
			/**
			 * The tenants a `bearer` server may be used for, or `*` for all. Its one token is one identity on the far side, so
			 * every tenant it serves shares that identity's data. None listed means none.
			 */
			readonly tenants?: readonly string[];
			readonly tokenHeader?: string;
			/** The server is another agent: `tools/call` carries the trace, turn, and hop count in `_meta`. */
			readonly agentContext?: boolean;
	  })
	| (CommonServerConfig & {
			readonly transport: "stdio";
			readonly command: string;
			readonly args?: readonly string[];
			readonly env?: Readonly<Record<string, string>>;
			readonly cwd?: string;
	  });

type HttpServerConfig = Extract<McpServerConfig, { transport: "http" }>;

export type McpManagerOptions = {
	readonly catalog: ToolCatalog;
	readonly log: Logger;
	/** Most per-grant connections kept open. Default 256. */
	readonly maxGrantClients?: number;
	/** Per-grant connections idle this long are closed. Default 5 minutes. */
	readonly grantClientIdleMs?: number;
	/** For tests. */
	readonly createTransport?: (config: McpServerConfig, headers: Readonly<Record<string, string>>) => McpTransport;
};

export type ServerStatus = {
	readonly name: string;
	readonly state: "connecting" | "connected" | "retrying" | "closed";
	readonly tools: number;
	readonly lastError?: string;
};

type ServerState = {
	readonly config: McpServerConfig;
	client: McpClient | undefined;
	connecting: Promise<McpClient> | undefined;
	state: ServerStatus["state"];
	lastError?: string;
	attempts: number;
	retryTimer: ReturnType<typeof setTimeout> | undefined;
	/** Settles after the first connection attempt, successful or not. */
	readonly firstAttempt: Promise<void>;
	settleFirstAttempt: () => void;
};

/** One token's connection. A newer token retires it, and it closes once its last call returns. */
type GrantClient = { client: Promise<McpClient>; token: string; lastUsed: number; calls: number; retired: boolean };

/** Who a call runs for: the grant its connection is keyed by, and a current token for it. */
export type McpCaller = {
	readonly key: () => Promise<string | undefined>;
	readonly token: () => Promise<string>;
	/** Headers for this call alone: its turn, session and trace, for the tool gateway's spans and audit record. */
	readonly callHeaders?: () => Promise<Readonly<Record<string, string>>>;
};

/** A connection is shared between calls, so what belongs to one call reaches its request from here. */
const callHeaders = new AsyncLocalStorage<Readonly<Record<string, string>>>();

const fetchWithCallHeaders: typeof fetch = (input, init) => {
	const extra = callHeaders.getStore();
	if (extra === undefined) return fetch(input, init);
	const headers = new Headers(init?.headers);
	for (const [name, value] of Object.entries(extra)) headers.set(name, value);
	return fetch(input, { ...init, headers });
};

const CLIENT_INFO = { name: "agent-pi", version: "0.1.0" };
const MAX_BACKOFF_MS = 60_000;

/** Raised for a call that cannot reach its server; becomes the model's error result. */
export class McpUnavailableError extends Error {}

/**
 * Owns every MCP connection. Servers connect in the background with backoff, so one dead server never blocks startup
 * or other servers; its tools appear in the catalog once it connects, and are re-listed on `tools/list_changed`.
 */
export class McpManager {
	readonly #catalog: ToolCatalog;
	readonly #log: Logger;
	readonly #servers = new Map<string, ServerState>();
	readonly #grantClients = new Map<string, GrantClient>();
	readonly #maxGrantClients: number;
	readonly #grantClientIdleMs: number;
	readonly #createTransport: NonNullable<McpManagerOptions["createTransport"]>;
	readonly #sweep: ReturnType<typeof setInterval>;
	#closed = false;

	constructor(configs: readonly McpServerConfig[], options: McpManagerOptions) {
		this.#catalog = options.catalog;
		this.#log = options.log;
		this.#maxGrantClients = options.maxGrantClients ?? 256;
		this.#grantClientIdleMs = options.grantClientIdleMs ?? 300_000;
		this.#createTransport = options.createTransport ?? defaultTransport;
		for (const config of configs) {
			if (this.#servers.has(config.name)) throw new Error(`mcp: duplicate server name ${config.name}`);
			if (!/^[a-z][a-z0-9_-]*$/.test(config.name)) {
				throw new Error(`mcp: server name ${JSON.stringify(config.name)} must match /^[a-z][a-z0-9_-]*$/`);
			}
			let settleFirstAttempt!: () => void;
			const firstAttempt = new Promise<void>((resolve) => {
				settleFirstAttempt = resolve;
			});
			this.#servers.set(config.name, {
				config,
				client: undefined,
				connecting: undefined,
				state: "connecting",
				attempts: 0,
				retryTimer: undefined,
				firstAttempt,
				settleFirstAttempt,
			});
		}
		this.#sweep = setInterval(() => this.#sweepGrantClients(), 30_000);
		this.#sweep.unref();
	}

	/** Start connecting every server; resolves when each has made its first attempt or `waitMs` passed. */
	async start(waitMs = 10_000): Promise<void> {
		for (const server of this.#servers.values()) void this.#connect(server).catch(() => undefined);
		const attempts = Promise.all([...this.#servers.values()].map((server) => server.firstAttempt));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, waitMs);
		});
		await Promise.race([attempts, timeout]);
		clearTimeout(timer);
	}

	status(): ServerStatus[] {
		return [...this.#servers.values()].map((server) => ({
			name: server.config.name,
			state: server.state,
			tools: this.#catalog.entries(server.config.name).length,
			...(server.lastError === undefined ? {} : { lastError: server.lastError }),
		}));
	}

	/** Whether a conversation of this tenant may call `entry`. Only a `bearer` server limits this; the others check each caller. */
	allowsTenant(entry: CatalogEntry, tenantId: string | undefined): boolean {
		const config = this.#servers.get(entry.server)?.config;
		if (config?.transport !== "http" || config.auth !== "bearer") return true;
		const tenants = config.tenants ?? [];
		return tenants.includes("*") || (tenantId !== undefined && tenants.includes(tenantId));
	}

	/** Call `entry` for `caller`. Grant servers use a connection of that grant's own. */
	async callTool(
		entry: CatalogEntry,
		args: Record<string, unknown>,
		caller: McpCaller | undefined,
		signal: AbortSignal | undefined,
		meta?: () => Promise<Record<string, unknown>>,
	): Promise<CallToolResult> {
		const server = this.#servers.get(entry.server);
		if (server === undefined) throw new McpUnavailableError(`MCP server ${entry.server} is not configured`);
		const config = server.config;
		// Asking for progress makes the timeout an idle one: a server still working renews it.
		const options = { timeoutMs: config.callTimeoutMs ?? 30_000, onProgress: () => undefined, ...(signal === undefined ? {} : { signal }) };
		const _meta = config.transport === "http" && config.agentContext === true ? await meta?.() : undefined;
		const call = (client: McpClient) =>
			_meta === undefined
				? client.callTool(entry.mcpName, args, options)
				: client.request<CallToolResult>("tools/call", { name: entry.mcpName, arguments: args, _meta }, options);
		if (config.transport === "http" && config.auth === "grant") return this.#viaGrant(config, entry, caller, call);
		const client = server.client ?? (await this.#connect(server));
		return call(client);
	}

	/**
	 * Call a tenant connector's tool through the tool gateway at `url`, over a connection of the run's own grant. The
	 * gateway holds the connector's address and credential; this process never does.
	 */
	async callConnector(
		url: string,
		connectorId: string,
		entry: CatalogEntry,
		args: Record<string, unknown>,
		caller: McpCaller | undefined,
		signal: AbortSignal | undefined,
	): Promise<CallToolResult> {
		if (this.#closed) throw new McpUnavailableError("MCP manager is closed");
		// Keyed by connector ID, never its name, which another tenant may also use.
		const config: HttpServerConfig = { name: `connector:${connectorId}`, transport: "http", url, auth: "grant" };
		const options = { timeoutMs: 60_000, onProgress: () => undefined, ...(signal === undefined ? {} : { signal }) };
		return this.#viaGrant(config, entry, caller, (client) => client.callTool(entry.mcpName, args, options));
	}

	async #viaGrant(
		config: HttpServerConfig,
		entry: CatalogEntry,
		caller: McpCaller | undefined,
		call: (client: McpClient) => Promise<CallToolResult>,
	): Promise<CallToolResult> {
		const key = await caller?.key();
		if (caller === undefined || key === undefined) throw new McpUnavailableError(`${entry.name} needs an agent grant, and this run has none.`);
		const user = this.#grantClient(config, key, await caller.token());
		user.calls++;
		try {
			const client = await user.client;
			// Only grant servers get these: they're t10's own, and the gateway strips them before a tenant's server.
			const headers = await caller.callHeaders?.().catch(() => undefined);
			return await (headers === undefined ? call(client) : callHeaders.run(headers, () => call(client)));
		} finally {
			user.calls--;
			if (user.retired && user.calls === 0) this.#closeClient(user);
		}
	}

	async close(): Promise<void> {
		this.#closed = true;
		clearInterval(this.#sweep);
		const closing: Promise<unknown>[] = [];
		for (const server of this.#servers.values()) {
			clearTimeout(server.retryTimer);
			server.state = "closed";
			if (server.client !== undefined) closing.push(server.client.close());
		}
		for (const user of this.#grantClients.values()) closing.push(user.client.then((client) => client.close()));
		this.#grantClients.clear();
		await Promise.allSettled(closing);
	}

	/** Connect `server` once; concurrent callers share the attempt. Failure schedules a retry with backoff. */
	#connect(server: ServerState): Promise<McpClient> {
		if (this.#closed) return Promise.reject(new McpUnavailableError("MCP manager is closed"));
		if (server.client !== undefined) return Promise.resolve(server.client);
		server.connecting ??= (async () => {
			const config = server.config;
			const client = new McpClient(CLIENT_INFO);
			try {
				await client.connect(this.#createTransport(config, config.transport === "http" ? (config.headers ?? {}) : {}));
				await this.#list(server, client);
				client.onNotification("notifications/tools/list_changed", () => {
					void this.#list(server, client).catch((error: unknown) =>
						this.#log.warn("mcp.relist_failed", { server: config.name, error: message(error) }),
					);
				});
				client.onClose(() => {
					if (server.client !== client || this.#closed) return;
					server.client = undefined;
					this.#log.warn("mcp.disconnected", { server: config.name });
					this.#scheduleRetry(server, "connection closed");
				});
				server.client = client;
				// A call may connect while a retry is pending; the retry must not open a second client.
				clearTimeout(server.retryTimer);
				server.retryTimer = undefined;
				server.state = "connected";
				server.attempts = 0;
				delete server.lastError;
				this.#log.info("mcp.connected", { server: config.name, tools: this.#catalog.entries(config.name).length });
				return client;
			} catch (error) {
				await client.close().catch(() => undefined);
				this.#scheduleRetry(server, message(error));
				throw new McpUnavailableError(`MCP server ${config.name} is unavailable: ${message(error)}`);
			} finally {
				server.connecting = undefined;
				server.settleFirstAttempt();
			}
		})();
		return server.connecting;
	}

	#scheduleRetry(server: ServerState, reason: string): void {
		if (this.#closed || server.retryTimer !== undefined) return;
		server.state = "retrying";
		server.lastError = reason;
		server.attempts++;
		const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(server.attempts - 1, 6));
		this.#log.warn("mcp.retry", { server: server.config.name, reason, delayMs: delay });
		server.retryTimer = setTimeout(() => {
			server.retryTimer = undefined;
			void this.#connect(server).catch(() => undefined);
		}, delay);
		server.retryTimer.unref();
	}

	async #list(server: ServerState, client: McpClient): Promise<void> {
		const config = server.config;
		const include = config.include?.map(compilePattern);
		const exclude = config.exclude?.map(compilePattern);
		const prefix = config.prefix ?? `${config.name}_`;
		const maxDescription = config.maxDescriptionChars ?? 1000;
		const entries: CatalogEntry[] = [];
		for (const tool of await client.listTools()) {
			const entry = toEntry(config.name, prefix, tool, maxDescription);
			if (include !== undefined && !include.some((matches) => matches(entry))) continue;
			if (exclude?.some((matches) => matches(entry))) continue;
			entries.push(entry);
		}
		const conflicts = this.#catalog.setServer(config.name, entries);
		if (conflicts.length > 0) {
			this.#log.warn("mcp.name_conflicts", { server: config.name, dropped: conflicts });
		}
	}

	/** The grant's connection for this token. Tokens last minutes, so rotation must not touch a call still running. */
	#grantClient(config: HttpServerConfig, grantId: string, token: string): GrantClient {
		const key = `${config.name}\0${grantId}`;
		const existing = this.#grantClients.get(key);
		if (existing !== undefined && existing.token === token) {
			existing.lastUsed = Date.now();
			// LRU order: most recently used last.
			this.#grantClients.delete(key);
			this.#grantClients.set(key, existing);
			return existing;
		}
		if (existing !== undefined) {
			this.#grantClients.delete(key);
			this.#retire(existing);
		}
		const header = config.tokenHeader ?? "Authorization";
		const headers = {
			...config.headers,
			[header]: header.toLowerCase() === "authorization" ? `Bearer ${token}` : token,
		};
		const connecting = (async () => {
			const client = new McpClient(CLIENT_INFO);
			try {
				await client.connect(this.#createTransport(config, headers));
			} catch (error) {
				this.#grantClients.delete(key);
				await client.close().catch(() => undefined);
				throw new McpUnavailableError(`MCP server ${config.name} is unavailable: ${message(error)}`);
			}
			client.onClose(() => {
				if (this.#grantClients.get(key)?.client === connecting) this.#grantClients.delete(key);
			});
			return client;
		})();
		const created: GrantClient = { client: connecting, token, lastUsed: Date.now(), calls: 0, retired: false };
		this.#grantClients.set(key, created);
		while (this.#grantClients.size > this.#maxGrantClients) {
			const [oldestKey, oldest] = this.#grantClients.entries().next().value as [string, GrantClient];
			this.#grantClients.delete(oldestKey);
			this.#retire(oldest);
		}
		return created;
	}

	#retire(user: GrantClient): void {
		user.retired = true;
		if (user.calls === 0) this.#closeClient(user);
	}

	#closeClient(user: GrantClient): void {
		void user.client.then((client) => client.close()).catch(() => undefined);
	}

	#sweepGrantClients(): void {
		const cutoff = Date.now() - this.#grantClientIdleMs;
		for (const [key, user] of this.#grantClients) {
			if (user.lastUsed >= cutoff || user.calls > 0) continue;
			this.#grantClients.delete(key);
			this.#retire(user);
		}
	}
}

function toEntry(server: string, prefix: string, tool: McpTool, maxDescription: number): CatalogEntry {
	const description = (tool.description ?? tool.title ?? tool.name).trim();
	const owner = tool._meta?.["t10/module"];
	return {
		name: offeredName(prefix, tool.name),
		server,
		mcpName: tool.name,
		description: description.length > maxDescription ? `${description.slice(0, maxDescription - 3)}...` : description,
		inputSchema: tool.inputSchema as Record<string, unknown>,
		...(typeof owner === "string" && owner !== "" ? { owner } : {}),
	};
}

export function defaultTransport(config: McpServerConfig, headers: Readonly<Record<string, string>>): McpTransport {
	if (config.transport === "stdio") {
		return new StdioTransport({
			command: config.command,
			...(config.args === undefined ? {} : { args: config.args }),
			...(config.env === undefined ? {} : { env: { ...config.env } }),
			...(config.cwd === undefined ? {} : { cwd: config.cwd }),
		});
	}
	return new StreamableHttpTransport({
		url: config.url,
		headers: { ...headers },
		fetch: fetchWithCallHeaders,
		...(config.auth === "bearer" && config.bearer !== undefined ? { authProvider: bearerProvider(config.bearer) } : {}),
	});
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
