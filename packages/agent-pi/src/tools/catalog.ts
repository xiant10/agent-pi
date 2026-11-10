/** One tool offered by an MCP server, under the name the model sees. */
export type CatalogEntry = {
	/** Name offered to the model: the server's prefix plus the MCP name, sanitized, unique across servers. */
	readonly name: string;
	readonly server: string;
	/** Name on the MCP server, used for `tools/call`. */
	readonly mcpName: string;
	readonly description: string;
	readonly inputSchema: Readonly<Record<string, unknown>>;
	/**
	 * The module that owns the tool, when its server serves several: the tool gateway's `/mcp/modules` says so in
	 * `_meta` (`t10/module`). Otherwise the server owns it.
	 */
	readonly owner?: string;
};

export type SearchHit = { readonly entry: CatalogEntry; readonly score: number };

const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** Name tokens weigh more than description tokens: `crm_list_accounts` is about accounts. */
const NAME_WEIGHT = 3;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Tokens for search: lowercase ASCII words (camelCase and snake_case split), and for CJK text, which has no spaces,
 * every character and every adjacent pair. "查询客户" yields 查 询 客 户 查询 询客 客户.
 */
export function tokenize(text: string): string[] {
	const tokens: string[] = [];
	const spaced = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
	for (const run of spaced.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
		if (run.length === 0) continue;
		let latin = "";
		let cjk = "";
		const flushLatin = () => {
			if (latin.length > 1 || /\d/.test(latin)) tokens.push(latin);
			latin = "";
		};
		const flushCjk = () => {
			const chars = [...cjk];
			for (let i = 0; i < chars.length; i++) {
				tokens.push(chars[i]!);
				if (i + 1 < chars.length) tokens.push(chars[i]! + chars[i + 1]!);
			}
			cjk = "";
		};
		for (const char of run) {
			if (CJK.test(char)) {
				flushLatin();
				cjk += char;
			} else {
				flushCjk();
				latin += char;
			}
		}
		flushLatin();
		flushCjk();
	}
	return tokens;
}

type IndexedDoc = { readonly entry: CatalogEntry; readonly terms: Map<string, number>; readonly length: number };

/** BM25 index over tool names and descriptions; rebuilt whenever the catalog changes. */
class SearchIndex {
	readonly #docs: IndexedDoc[];
	readonly #documentFrequency = new Map<string, number>();
	readonly #averageLength: number;

	constructor(entries: readonly CatalogEntry[]) {
		this.#docs = entries.map((entry) => {
			const terms = new Map<string, number>();
			const add = (token: string, weight: number) => terms.set(token, (terms.get(token) ?? 0) + weight);
			for (const token of tokenize(`${entry.mcpName} ${entry.server}`)) add(token, NAME_WEIGHT);
			for (const token of tokenize(entry.description)) add(token, 1);
			let length = 0;
			for (const count of terms.values()) length += count;
			return { entry, terms, length };
		});
		for (const doc of this.#docs) {
			for (const term of doc.terms.keys()) {
				this.#documentFrequency.set(term, (this.#documentFrequency.get(term) ?? 0) + 1);
			}
		}
		const total = this.#docs.reduce((sum, doc) => sum + doc.length, 0);
		this.#averageLength = this.#docs.length === 0 ? 1 : total / this.#docs.length;
	}

	search(query: string, limit: number, accept: (entry: CatalogEntry) => boolean): SearchHit[] {
		const queryTerms = [...new Set(tokenize(query))];
		if (queryTerms.length === 0) return [];
		const n = this.#docs.length;
		const hits: SearchHit[] = [];
		for (const doc of this.#docs) {
			if (!accept(doc.entry)) continue;
			let score = 0;
			for (const term of queryTerms) {
				const frequency = doc.terms.get(term);
				if (frequency === undefined) continue;
				const df = this.#documentFrequency.get(term) ?? 0;
				const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
				const norm = frequency + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / this.#averageLength);
				score += (idf * frequency * (BM25_K1 + 1)) / norm;
			}
			if (score > 0) hits.push({ entry: doc.entry, score });
		}
		hits.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
		return hits.slice(0, limit);
	}
}

/** What search, skills and preloading read: the shared catalog, or a tenant's view of it. */
export type CatalogView = Pick<ToolCatalog, "get" | "entries" | "search" | "match">;

/**
 * The shared catalog plus one tenant's own tools, for that tenant's sessions only. A tenant tool whose offered name is
 * a shared tool's is dropped, so a tenant can never shadow a platform tool.
 */
export class ScopedCatalog implements CatalogView {
	readonly #base: ToolCatalog;
	readonly #own: readonly CatalogEntry[];
	readonly #byName: ReadonlyMap<string, CatalogEntry>;
	#index: SearchIndex | undefined;
	#indexedSize = -1;

	constructor(base: ToolCatalog, own: readonly CatalogEntry[]) {
		this.#base = base;
		this.#own = own;
		this.#byName = new Map(own.map((entry) => [entry.name, entry]));
	}

	/** The tenant's own tools, without any a shared tool shadows now. */
	own(): readonly CatalogEntry[] {
		return this.#own.filter((entry) => this.#base.get(entry.name) === undefined);
	}

	get(name: string): CatalogEntry | undefined {
		return this.#base.get(name) ?? this.#byName.get(name);
	}

	entries(server?: string): readonly CatalogEntry[] {
		const own = this.own();
		if (server !== undefined) return [...this.#base.entries(server), ...own.filter((entry) => entry.server === server)];
		return [...this.#base.entries(), ...own];
	}

	search(query: string, limit: number, accept: (entry: CatalogEntry) => boolean = () => true): SearchHit[] {
		// The shared catalog changes as servers connect, so the index is rebuilt when its size does.
		const entries = this.entries();
		if (this.#index === undefined || this.#indexedSize !== entries.length) {
			this.#index = new SearchIndex(entries);
			this.#indexedSize = entries.length;
		}
		return this.#index.search(query, limit, accept);
	}

	match(patterns: readonly string[]): string[] {
		const compiled = patterns.map(compilePattern);
		return this.entries()
			.filter((entry) => compiled.some((matches) => matches(entry)))
			.map((entry) => entry.name);
	}
}

/**
 * Every MCP tool of every connected server, keyed by offered name. Servers replace their own entries as a unit when
 * they connect or refresh, so one server's list never disturbs another's.
 */
export class ToolCatalog {
	readonly #byServer = new Map<string, readonly CatalogEntry[]>();
	#byName = new Map<string, CatalogEntry>();
	#index: SearchIndex | undefined;
	readonly #listeners = new Set<(server: string) => void>();

	/** Replace `server`'s entries. Names already taken by another server are dropped and returned. */
	setServer(server: string, entries: readonly CatalogEntry[]): string[] {
		const conflicts: string[] = [];
		const kept: CatalogEntry[] = [];
		for (const entry of entries) {
			const owner = this.#byName.get(entry.name)?.server;
			if ((owner !== undefined && owner !== server) || kept.some((other) => other.name === entry.name)) {
				conflicts.push(entry.name);
				continue;
			}
			kept.push(entry);
		}
		this.#byServer.set(server, kept);
		this.#rebuild();
		for (const listener of this.#listeners) listener(server);
		return conflicts;
	}

	removeServer(server: string): void {
		if (!this.#byServer.delete(server)) return;
		this.#rebuild();
		for (const listener of this.#listeners) listener(server);
	}

	onChange(listener: (server: string) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	get(name: string): CatalogEntry | undefined {
		return this.#byName.get(name);
	}

	entries(server?: string): readonly CatalogEntry[] {
		if (server !== undefined) return this.#byServer.get(server) ?? [];
		return [...this.#byServer.values()].flat();
	}

	get size(): number {
		return this.#byName.size;
	}

	search(query: string, limit: number, accept: (entry: CatalogEntry) => boolean = () => true): SearchHit[] {
		this.#index ??= new SearchIndex(this.entries());
		return this.#index.search(query, limit, accept);
	}

	/** Offered names matching any pattern, in catalog order. See `compilePattern`. */
	match(patterns: readonly string[]): string[] {
		const compiled = patterns.map(compilePattern);
		return this.entries()
			.filter((entry) => compiled.some((matches) => matches(entry)))
			.map((entry) => entry.name);
	}

	#rebuild(): void {
		this.#byName = new Map(this.entries().map((entry) => [entry.name, entry]));
		this.#index = undefined;
	}
}

/**
 * A skill's tool pattern: `[server:]glob`, where the glob (`*`, `?`) matches the MCP tool name or the offered name.
 * `crm:list_*` is every `list_` tool of server `crm`; `get_weather` is that tool on any server; `crm:*` is all of `crm`.
 */
export function compilePattern(pattern: string): (entry: CatalogEntry) => boolean {
	const colon = pattern.indexOf(":");
	const server = colon === -1 ? undefined : pattern.slice(0, colon);
	const glob = colon === -1 ? pattern : pattern.slice(colon + 1);
	const source = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	const regex = new RegExp(`^${source}$`);
	return (entry) =>
		(server === undefined || server === entry.server) && (regex.test(entry.mcpName) || regex.test(entry.name));
}

const NAME_SANITIZE = /[^A-Za-z0-9_-]/g;
const MAX_TOOL_NAME = 64;

/** Providers accept at most 64 characters of `[A-Za-z0-9_-]`. */
export function offeredName(prefix: string, mcpName: string): string {
	return `${prefix}${mcpName}`.replace(NAME_SANITIZE, "_").slice(0, MAX_TOOL_NAME);
}
