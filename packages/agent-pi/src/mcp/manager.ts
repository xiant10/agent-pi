import {
	type CallToolResult,
	McpClient,
	type McpTransport,
	type Tool as McpTool,
	StdioTransport,
	StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import { ownerKey, type Principal } from "../auth/authenticator.ts";
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
			/** Sent on every request; with `auth: "forward"`, used only for listing tools. */
			readonly headers?: Readonly<Record<string, string>>;
			/**
			 * `static` (default): one shared connection with `headers`. `forward`: calls go over a per-user connection that
			 * carries the caller's bearer token in `forwardHeader` (default `Authorization`).
			 */
			readonly auth?: "static" | "forward";
			readonly forwardHeader?: string;
	  })
	| (CommonServerConfig & {
			readonly transport: "stdio";
			readonly command: string;
			readonly args?: readonly string[];
			readonly env?: Readonly<Record<string, string>>;
			readonly cwd?: string;
	  });

export type McpManagerOptions = {
	readonly catalog: ToolCatalog;
	readonly log: Logger;
	/** Most per-user connections kept open. Default 256. */
	readonly maxUserClients?: number;
	/** Per-user connections idle this long are closed. Default 5 minutes. */
	readonly userClientIdleMs?: number;
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

type UserClient = { client: Promise<McpClient>; token: string; lastUsed: number };

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
	readonly #userClients = new Map<string, UserClient>();
	readonly #maxUserClients: number;
	readonly #userClientIdleMs: number;
	readonly #createTransport: NonNullable<McpManagerOptions["createTransport"]>;
	readonly #sweep: ReturnType<typeof setInterval>;
	#closed = false;

	constructor(configs: readonly McpServerConfig[], options: McpManagerOptions) {
		this.#catalog = options.catalog;
		this.#log = options.log;
		this.#maxUserClients = options.maxUserClients ?? 256;
		this.#userClientIdleMs = options.userClientIdleMs ?? 300_000;
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
		this.#sweep = setInterval(() => this.#sweepUserClients(), 30_000);
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

	/** Call `entry` for `principal`. Forwarding servers use the caller's own connection. */
	async callTool(
		entry: CatalogEntry,
		args: Record<string, unknown>,
		principal: Principal | undefined,
		signal: AbortSignal | undefined,
	): Promise<CallToolResult> {
		const server = this.#servers.get(entry.server);
		if (server === undefined) throw new McpUnavailableError(`MCP server ${entry.server} is not configured`);
		const config = server.config;
		const options = { timeoutMs: config.callTimeoutMs ?? 30_000, ...(signal === undefined ? {} : { signal }) };
		if (config.transport === "http" && config.auth === "forward") {
			if (principal === undefined) {
				throw new McpUnavailableError("This tool needs the user's credentials; ask the user to reconnect.");
			}
			if (principal.expiresAt !== undefined && principal.expiresAt <= Date.now()) {
				throw new McpUnavailableError("The user's credentials expired; ask the user to reconnect.");
			}
			const client = await this.#userClient(server, principal);
			return client.callTool(entry.mcpName, args, options);
		}
		const client = server.client ?? (await this.#connect(server));
		return client.callTool(entry.mcpName, args, options);
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
		for (const user of this.#userClients.values()) closing.push(user.client.then((client) => client.close()));
		this.#userClients.clear();
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

	async #userClient(server: ServerState, principal: Principal): Promise<McpClient> {
		const config = server.config as Extract<McpServerConfig, { transport: "http" }>;
		const key = `${config.name}\0${ownerKey(principal)}`;
		const existing = this.#userClients.get(key);
		if (existing !== undefined && existing.token === principal.token) {
			existing.lastUsed = Date.now();
			// LRU order: most recently used last.
			this.#userClients.delete(key);
			this.#userClients.set(key, existing);
			return existing.client;
		}
		if (existing !== undefined) {
			this.#userClients.delete(key);
			void existing.client.then((client) => client.close()).catch(() => undefined);
		}
		const header = config.forwardHeader ?? "Authorization";
		const headers = {
			...config.headers,
			[header]: header.toLowerCase() === "authorization" ? `Bearer ${principal.token}` : principal.token,
		};
		const connecting = (async () => {
			const client = new McpClient(CLIENT_INFO);
			try {
				await client.connect(this.#createTransport(config, headers));
			} catch (error) {
				this.#userClients.delete(key);
				await client.close().catch(() => undefined);
				throw new McpUnavailableError(`MCP server ${config.name} is unavailable: ${message(error)}`);
			}
			client.onClose(() => {
				if (this.#userClients.get(key)?.client === connecting) this.#userClients.delete(key);
			});
			return client;
		})();
		this.#userClients.set(key, { client: connecting, token: principal.token, lastUsed: Date.now() });
		while (this.#userClients.size > this.#maxUserClients) {
			const [oldestKey, oldest] = this.#userClients.entries().next().value as [string, UserClient];
			this.#userClients.delete(oldestKey);
			void oldest.client.then((client) => client.close()).catch(() => undefined);
		}
		return connecting;
	}

	#sweepUserClients(): void {
		const cutoff = Date.now() - this.#userClientIdleMs;
		for (const [key, user] of this.#userClients) {
			if (user.lastUsed >= cutoff) continue;
			this.#userClients.delete(key);
			void user.client.then((client) => client.close()).catch(() => undefined);
		}
	}
}

function toEntry(server: string, prefix: string, tool: McpTool, maxDescription: number): CatalogEntry {
	const description = (tool.description ?? tool.title ?? tool.name).trim();
	return {
		name: offeredName(prefix, tool.name),
		server,
		mcpName: tool.name,
		description: description.length > maxDescription ? `${description.slice(0, maxDescription - 3)}...` : description,
		inputSchema: tool.inputSchema as Record<string, unknown>,
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
	return new StreamableHttpTransport({ url: config.url, headers: { ...headers } });
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
