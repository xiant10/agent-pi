import { ControlCopies } from "../util/control-copy.ts";
import { SILENT_LOGGER, type Logger } from "../util/log.ts";
import { type CatalogEntry, offeredName, ScopedCatalog, type ToolCatalog } from "./catalog.ts";

/**
 * Tenant connectors: a tenant's own MCP servers, published at `t10-agent-control` and called through
 * `ai-gateway-tools`, which holds their addresses and credentials. This process holds only what to offer the model: each
 * published tool's name, description and input schema. See t10-agent-control's `docs/tenant-connectors.md`.
 */

/** One published connector, as `GET /v1/runtime/connectors` returns it. */
export type TenantConnectorRecord = {
	readonly id: string;
	readonly name: string;
	readonly title: string;
	readonly version: number;
	readonly tools: readonly { readonly name: string; readonly description?: string; readonly input_schema?: Record<string, unknown> }[];
};

/** One tenant's connector tools. */
export type TenantTools = {
	/** The shared catalog plus these tools, for search, skills and preloading. */
	readonly catalog: ScopedCatalog;
	/** Connector ID by connector name, which is the tools' server. */
	readonly connectors: ReadonlyMap<string, string>;
	/** Changes when anything offered changes, so the registry is replaced only then. */
	readonly digest: string;
};

export type TenantConnectorsOptions = {
	/** `t10-agent-control`'s base URL. */
	readonly url: string;
	/** This runtime's own service token. */
	readonly token: () => Promise<string>;
	/** Called when a tenant's tools change, to replace its registry extension. */
	readonly changed: (tenantId: string, tools: TenantTools) => void;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	readonly log?: Logger;
	readonly freshMs?: number;
	readonly timeoutMs?: number;
	/** Where each tenant's last good answer is kept, so a restart while control is down starts from it. */
	readonly copies?: ControlCopies;
};

type Entry = { readonly etag?: string; readonly tools: TenantTools; readonly okAt: number; readonly checkedAt: number };

const MAX_DESCRIPTION = 1000;

/** A tenant's tools from what control published. */
export function tenantTools(base: ToolCatalog, records: readonly TenantConnectorRecord[]): TenantTools {
	const entries: CatalogEntry[] = [];
	const connectors = new Map<string, string>();
	for (const record of records) {
		connectors.set(record.name, record.id);
		for (const tool of record.tools) {
			const description = (tool.description ?? tool.name).trim();
			entries.push({
				name: offeredName(`${record.name}_`, tool.name),
				server: record.name,
				mcpName: tool.name,
				description: description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION - 3)}...` : description,
				inputSchema: tool.input_schema ?? { type: "object", properties: {} },
			});
		}
	}
	const unique = entries.filter((entry, index) => entries.findIndex((other) => other.name === entry.name) === index);
	const digest = JSON.stringify(records.map((record) => [record.id, record.version]));
	return { catalog: new ScopedCatalog(base, unique), connectors, digest };
}

/**
 * Each tenant's connector tools, read from control and kept for a few seconds, like `TenantSkills`, with the last good
 * answer kept on disk and standing in with no time limit. A tenant without connectors costs a 304 every `freshMs` while
 * it's in use, and nothing otherwise.
 */
export class TenantConnectors {
	readonly #base: ToolCatalog;
	readonly #url: string;
	readonly #token: () => Promise<string>;
	readonly #changed: TenantConnectorsOptions["changed"];
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #log: Logger;
	readonly #freshMs: number;
	readonly #timeoutMs: number;
	readonly #copies: ControlCopies;
	readonly #empty: TenantTools;
	readonly #entries = new Map<string, Entry>();
	readonly #checking = new Map<string, Promise<TenantTools>>();
	readonly #changes = new Map<string, number>();

	constructor(base: ToolCatalog, options: TenantConnectorsOptions) {
		this.#base = base;
		this.#url = options.url.replace(/\/+$/, "");
		this.#token = options.token;
		this.#changed = options.changed;
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? SILENT_LOGGER;
		this.#freshMs = options.freshMs ?? 10_000;
		this.#timeoutMs = options.timeoutMs ?? 2_000;
		this.#copies = options.copies ?? new ControlCopies(undefined, "connectors", this.#log);
		this.#empty = tenantTools(base, []);
	}

	/** A tenant's tools. A session without a tenant has none of its own. */
	readonly forTenant = (tenantId: string | undefined): Promise<TenantTools> => {
		if (tenantId === undefined || tenantId.length === 0) return Promise.resolve(this.#empty);
		const entry = this.#entries.get(tenantId) ?? this.#saved(tenantId);
		if (entry !== undefined && this.#now() - entry.checkedAt < this.#freshMs) return Promise.resolve(entry.tools);
		const inFlight = this.#checking.get(tenantId);
		if (inFlight !== undefined) return inFlight;
		const check = this.#check(tenantId, entry).finally(() => this.#checking.delete(tenantId));
		this.#checking.set(tenantId, check);
		return check;
	};

	/** The tools last read for a tenant, without asking control: for a tool call already under way. */
	known(tenantId: string | undefined): TenantTools {
		return (tenantId === undefined ? undefined : this.#entries.get(tenantId)?.tools) ?? this.#empty;
	}

	/** A tenant's connectors changed: its next read asks control again. Fed by the skills change feed. */
	changed(tenant: string): void {
		this.#changes.set(tenant, (this.#changes.get(tenant) ?? 0) + 1);
		const entry = this.#entries.get(tenant);
		if (entry !== undefined) this.#entries.set(tenant, { ...entry, checkedAt: 0 });
	}

	async #check(tenant: string, entry: Entry | undefined): Promise<TenantTools> {
		const now = this.#now();
		const generation = this.#changes.get(tenant);
		const checkedAt = () => (this.#changes.get(tenant) === generation ? now : 0);
		try {
			const response = await this.#fetch(`${this.#url}/v1/runtime/connectors?tenant=${encodeURIComponent(tenant)}`, {
				headers: {
					authorization: `Bearer ${await this.#token()}`,
					...(entry?.etag === undefined ? {} : { "if-none-match": entry.etag }),
				},
				signal: AbortSignal.timeout(this.#timeoutMs),
			});
			if (response.status === 304 && entry !== undefined && entry.okAt > 0) {
				this.#entries.set(tenant, { ...entry, okAt: now, checkedAt: checkedAt() });
				return entry.tools;
			}
			if (!response.ok) throw new Error(`status ${response.status}`);
			const body = (await response.json()) as { connectors?: TenantConnectorRecord[] };
			const records = Array.isArray(body.connectors) ? body.connectors : [];
			const tools = tenantTools(this.#base, records);
			const etag = response.headers.get("etag") ?? undefined;
			this.#set(tenant, entry, { ...(etag === undefined ? {} : { etag }), tools, okAt: now, checkedAt: checkedAt() });
			this.#copies.save(tenant, { ...(etag === undefined ? {} : { etag }), at: now, body: { connectors: records } });
			return tools;
		} catch (error) {
			const usable = entry !== undefined && entry.okAt > 0;
			this.#copies.failed(tenant, error, usable ? entry.okAt : 0, now, usable ? "last answer" : "none");
			const tools = usable ? entry.tools : this.#empty;
			this.#set(tenant, entry, { ...(usable && entry.etag !== undefined ? { etag: entry.etag } : {}), tools, okAt: usable ? entry.okAt : 0, checkedAt: now });
			return tools;
		}
	}

	/**
	 * The copy on disk, the first time this process needs a tenant, installed as if control had just answered it: its
	 * ETag makes the first check a 304 if nothing changed.
	 */
	#saved(tenant: string): Entry | undefined {
		const saved = this.#copies.load(tenant);
		if (saved === undefined) return undefined;
		const body = saved.body as { connectors?: TenantConnectorRecord[] };
		const tools = tenantTools(this.#base, Array.isArray(body?.connectors) ? body.connectors : []);
		const entry: Entry = { ...(saved.etag === undefined ? {} : { etag: saved.etag }), tools, okAt: saved.at, checkedAt: 0 };
		this.#set(tenant, undefined, entry);
		return entry;
	}

	#set(tenant: string, before: Entry | undefined, after: Entry): void {
		this.#entries.set(tenant, after);
		if ((before?.tools.digest ?? this.#empty.digest) !== after.tools.digest) this.#changed(tenant, after.tools);
	}
}
