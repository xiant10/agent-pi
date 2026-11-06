import type { ConversationId } from "@earendil-works/pi-durable";
import { synthesizeSkillFlow, validateSkillFlow } from "../flow/engine.ts";
import type { SkillFlow } from "../flow/types.ts";
import { SILENT_LOGGER, type Logger } from "../util/log.ts";
import { type Skill, toolAllowedBySkill } from "./skills.ts";

/**
 * Tenant skills, read from `t10-agent-control` when a turn needs them rather than copied into this process: a tenant's
 * overrides of a built-in skill's workflow, and skills of its own. See t10-agent-control's `docs/tenant-skills.md`.
 */

/** One published skill, as `GET /v1/runtime/skills` returns it. */
export type TenantSkillRecord = {
	readonly name: string;
	readonly kind: "override" | "custom";
	readonly version: number;
	readonly digest: string;
	readonly content: TenantSkillContent;
};

export type TenantSkillContent = {
	readonly description?: string;
	readonly body?: string;
	readonly tools?: readonly string[];
	readonly keywords?: readonly string[];
	readonly flow?: SkillFlow;
	/** Reference files by relative path, for a custom skill. */
	readonly files?: Readonly<Record<string, string>>;
};

/** The skills one tenant sees. */
export type SkillsFor = (tenantId: string | undefined) => Promise<readonly Skill[]>;

/** A tenant's skills with one author's draft of one skill in place, for that author's test conversation. */
export type DraftSkills = (tenantId: string | undefined, author: string, name: string) => Promise<readonly Skill[]>;

/** Longest pattern a flow's extract step may run, as control also checks: it runs in this shared process. */
const MAX_PATTERN = 200;
/** A reference file's path, as control checks it: relative, with no part starting with a dot. */
const FILE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

/** Check an override's flow against the built-in skill it changes. Its tools must be the built-in's. */
export function overrideFlow(base: Skill, flow: SkillFlow): SkillFlow {
	const { tools, flow: valid } = validateSkillFlow({ ...flow, id: base.name });
	for (const tool of tools) {
		if (!toolAllowedBySkill(tool, base.tools)) {
			throw new Error(`skill ${base.name}: tool "${tool}" isn't one of the skill's tools (${base.tools.join(", ") || "none"})`);
		}
	}
	checkPatterns(valid);
	return valid;
}

/** Build a tenant's own skill. Its flow may only call tools the skill lists. */
export function customSkill(name: string, content: TenantSkillContent, source?: Skill["source"]): Skill {
	const description = content.description ?? "";
	if (description.length === 0) throw new Error(`skill ${name}: needs a description`);
	const tools = [...(content.tools ?? [])];
	const body = content.body ?? "";
	let flow: SkillFlow;
	if (content.flow === undefined) {
		flow = synthesizeSkillFlow({ name, description, tools, body });
	} else {
		const checked = validateSkillFlow({ ...content.flow, id: name });
		for (const tool of checked.tools) {
			if (!toolAllowedBySkill(tool, tools)) throw new Error(`skill ${name}: tool "${tool}" isn't in the skill's tools (${tools.join(", ") || "none"})`);
		}
		checkPatterns(checked.flow);
		flow = checked.flow;
	}
	const files = new Map<string, string>();
	for (const [path, text] of Object.entries(content.files ?? {})) {
		if (!FILE_PATH.test(path) || typeof text !== "string") throw new Error(`skill ${name}: ${JSON.stringify(path)} isn't a reference file path`);
		files.set(path, text);
	}
	return {
		name,
		description,
		tools,
		keywords: [...(content.keywords ?? [])],
		body,
		flow,
		...(files.size === 0 ? {} : { files }),
		...(source === undefined ? {} : { source }),
	};
}

function checkPatterns(flow: SkillFlow): void {
	for (const node of flow.nodes) {
		for (const [field, extract] of Object.entries(node.extract ?? {})) {
			if (extract.pattern !== undefined && extract.pattern.length > MAX_PATTERN) {
				throw new Error(`step ${node.id}: the pattern for ${field} is longer than ${MAX_PATTERN} characters`);
			}
		}
	}
}

/**
 * The built-in skills with a tenant's records applied. A record that fails its checks is skipped, so the built-in
 * stays: control can't make these checks, because it doesn't know this image's skills.
 */
export function applyTenantSkills(
	base: readonly Skill[],
	records: readonly TenantSkillRecord[],
	skipped: (record: TenantSkillRecord, reason: string) => void = () => undefined,
): Skill[] {
	const byName = new Map(base.map((skill) => [skill.name, skill]));
	const out = new Map(byName);
	for (const record of records) {
		const source = { kind: record.kind, version: record.version, digest: record.digest };
		try {
			const builtin = byName.get(record.name);
			if (record.kind === "override") {
				if (builtin === undefined) throw new Error("there's no built-in skill of that name");
				if (record.content.flow === undefined) throw new Error("an override needs a workflow");
				out.set(record.name, { ...builtin, flow: overrideFlow(builtin, record.content.flow), source });
			} else {
				if (builtin !== undefined) throw new Error("a built-in skill has that name");
				out.set(record.name, customSkill(record.name, record.content, source));
			}
		} catch (error) {
			skipped(record, error instanceof Error ? error.message : String(error));
		}
	}
	return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export type TenantSkillsOptions = {
	/** `t10-agent-control`'s base URL. */
	readonly url: string;
	/** This runtime's own service token. */
	readonly token: () => Promise<string>;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	readonly log?: Logger;
	/** How long an answer is used before it's checked again. Default 10 s. */
	readonly freshMs?: number;
	/** How long the last good answer stands in while control can't be reached. Default 5 min. */
	readonly staleMs?: number;
	/** How long a check may take on a turn's path. Default 2 s. */
	readonly timeoutMs?: number;
};

type Entry = {
	readonly etag?: string;
	readonly view: readonly Skill[];
	/** What control answered, kept so a test conversation can put one draft in its place. */
	readonly records: readonly TenantSkillRecord[];
	/** When control last answered, or 0 if it never has for this tenant. */
	readonly okAt: number;
	readonly checkedAt: number;
};

/**
 * One tenant's skills, read from control and kept for a few seconds. A check after that is a 304 when nothing changed,
 * so a publish reaches every replica within `freshMs`, and nothing is ever written to this process's disk or store.
 */
export class TenantSkills {
	readonly #base: readonly Skill[];
	readonly #url: string;
	readonly #token: () => Promise<string>;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #log: Logger;
	readonly #freshMs: number;
	readonly #staleMs: number;
	readonly #timeoutMs: number;
	readonly #entries = new Map<string, Entry>();
	readonly #checking = new Map<string, Promise<readonly Skill[]>>();
	/** Bumped when control says a tenant changed, so a check already under way can't keep what it read as fresh. */
	readonly #changes = new Map<string, number>();

	constructor(base: readonly Skill[], options: TenantSkillsOptions) {
		this.#base = base;
		this.#url = options.url.replace(/\/+$/, "");
		this.#token = options.token;
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? SILENT_LOGGER;
		this.#freshMs = options.freshMs ?? 10_000;
		this.#staleMs = options.staleMs ?? 300_000;
		this.#timeoutMs = options.timeoutMs ?? 2_000;
	}

	/** The skills a tenant sees. A session without a tenant sees the built-in ones. */
	readonly forTenant: SkillsFor = (tenantId) => {
		if (tenantId === undefined || tenantId.length === 0) return Promise.resolve(this.#base);
		const entry = this.#entries.get(tenantId);
		if (entry !== undefined && this.#now() - entry.checkedAt < this.#freshMs) return Promise.resolve(entry.view);
		const inFlight = this.#checking.get(tenantId);
		if (inFlight !== undefined) return inFlight;
		const check = this.#check(tenantId, entry).finally(() => this.#checking.delete(tenantId));
		this.#checking.set(tenantId, check);
		return check;
	};

	/**
	 * Follow control's change feed until `signal` ends, so a publish is read on the tenant's next turn rather than up to
	 * `freshMs` later. It's only a hint: if the feed is down, the checks every `freshMs` still find every change.
	 */
	async watch(signal: AbortSignal, retryMs = 5_000): Promise<void> {
		let cursor: number | undefined;
		let failing = false;
		const pause = (ms: number) =>
			new Promise((resolve) => {
				const timer = setTimeout(resolve, ms);
				signal.addEventListener("abort", () => (clearTimeout(timer), resolve(undefined)), { once: true });
			});
		while (!signal.aborted) {
			const started = this.#now();
			try {
				const response = await this.#fetch(`${this.#url}/v1/runtime/skills/changes${cursor === undefined ? "" : `?after=${cursor}`}`, {
					headers: { authorization: `Bearer ${await this.#token()}` },
					signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
				});
				if (!response.ok) throw new Error(`status ${response.status}`);
				const body = (await response.json()) as { cursor?: unknown; tenants?: unknown };
				for (const tenant of Array.isArray(body.tenants) ? body.tenants : []) if (typeof tenant === "string") this.changed(tenant);
				const moved = typeof body.cursor === "number" && body.cursor !== cursor;
				if (typeof body.cursor === "number") cursor = body.cursor;
				failing = false;
				// Control holds a request open while nothing changes; one answered at once with nothing mustn't spin.
				if (!moved && this.#now() - started < 1_000) await pause(1_000);
			} catch (error) {
				if (signal.aborted) return;
				if (!failing) this.#log.warn("skills.changes_unavailable", { error: error instanceof Error ? error.message : String(error) });
				failing = true;
				await pause(retryMs);
			}
		}
	}

	/**
	 * A tenant's skills with one author's draft of one skill in place of its published version, for that author's own
	 * test conversation. Read fresh each time, since the author is editing it. Without a draft, or if the draft fails
	 * the checks, it's the tenant's skills as published.
	 */
	readonly withDraft: DraftSkills = async (tenantId, author, name) => {
		const published = await this.forTenant(tenantId);
		if (tenantId === undefined) return published;
		const records = this.#entries.get(tenantId)?.records ?? [];
		let draft: TenantSkillRecord;
		try {
			const query = new URLSearchParams({ tenant: tenantId, name, author });
			const response = await this.#fetch(`${this.#url}/v1/runtime/skills/draft?${query}`, {
				headers: { authorization: `Bearer ${await this.#token()}` },
				signal: AbortSignal.timeout(this.#timeoutMs),
			});
			if (response.status === 404) return published;
			if (!response.ok) throw new Error(`status ${response.status}`);
			draft = (await response.json()) as TenantSkillRecord;
		} catch (error) {
			this.#log.warn("skills.draft_unavailable", { tenant: tenantId, skill: name, error: error instanceof Error ? error.message : String(error) });
			return published;
		}
		return applyTenantSkills(this.#base, [...records.filter((record) => record.name !== name), draft], (record, reason) => {
			this.#log.warn("skills.draft_skipped", { tenant: tenantId, skill: record.name, reason });
		});
	};

	/** Also told when the change feed names a tenant: its connectors may have changed too. */
	readonly listeners = new Set<(tenant: string) => void>();

	/** A tenant's skills changed: its next read asks control again. */
	changed(tenant: string): void {
		for (const listener of this.listeners) listener(tenant);
		this.#changes.set(tenant, (this.#changes.get(tenant) ?? 0) + 1);
		const entry = this.#entries.get(tenant);
		if (entry !== undefined) this.#entries.set(tenant, { ...entry, checkedAt: 0 });
	}

	async #check(tenant: string, entry: Entry | undefined): Promise<readonly Skill[]> {
		const now = this.#now();
		const generation = this.#changes.get(tenant);
		// What a check started before a change reads may predate it, so it's kept but not counted as fresh.
		const checkedAt = () => (this.#changes.get(tenant) === generation ? now : 0);
		try {
			const response = await this.#fetch(`${this.#url}/v1/runtime/skills?tenant=${encodeURIComponent(tenant)}`, {
				headers: {
					authorization: `Bearer ${await this.#token()}`,
					...(entry?.etag === undefined ? {} : { "if-none-match": entry.etag }),
				},
				signal: AbortSignal.timeout(this.#timeoutMs),
			});
			if (response.status === 304 && entry !== undefined && entry.okAt > 0) {
				this.#entries.set(tenant, { ...entry, okAt: now, checkedAt: checkedAt() });
				return entry.view;
			}
			if (!response.ok) throw new Error(`status ${response.status}`);
			const body = (await response.json()) as { skills?: TenantSkillRecord[] };
			const records = Array.isArray(body.skills) ? body.skills : [];
			const view = records.length === 0 ? this.#base : applyTenantSkills(this.#base, records, (record, reason) => {
				this.#log.warn("skills.tenant_skipped", { tenant, skill: record.name, version: record.version, reason });
			});
			const etag = response.headers.get("etag") ?? undefined;
			this.#entries.set(tenant, { ...(etag === undefined ? {} : { etag }), view, records, okAt: now, checkedAt: checkedAt() });
			return view;
		} catch (error) {
			// Checked again only after freshMs, so an outage costs one slow turn per tenant, not every one.
			const usable = entry !== undefined && entry.okAt > 0 && now - entry.okAt < this.#staleMs;
			this.#log.warn("skills.tenant_unavailable", { tenant, error: error instanceof Error ? error.message : String(error), using: usable ? "last answer" : "built-in skills" });
			const view = usable ? entry.view : this.#base;
			const records = usable ? entry.records : [];
			this.#entries.set(tenant, { ...(usable && entry.etag !== undefined ? { etag: entry.etag } : {}), view, records, okAt: usable ? entry.okAt : 0, checkedAt: now });
			return view;
		}
	}
}

/** The skills a session uses: its current turn's, else its parent's turn's for a child, else the tenant's current ones. */
export type SessionSkills = (conversationId: ConversationId, tenantId: string | undefined, parent?: number) => Promise<readonly Skill[]>;

/**
 * Pins the skills each conversation's turn started with, so a publish during a turn reaches the next one, not the
 * rest of this one. Kept in memory for the most recent conversations; one that has been forgotten, or that a restart
 * resumes, reads the tenant's current skills.
 */
export class TurnPins {
	readonly #skillsFor: SkillsFor;
	readonly #withDraft: DraftSkills | undefined;
	readonly #max: number;
	readonly #pins = new Map<number, readonly Skill[]>();

	constructor(skillsFor: SkillsFor, options: { readonly max?: number; readonly withDraft?: DraftSkills } = {}) {
		this.#skillsFor = skillsFor;
		this.#withDraft = options.withDraft;
		this.#max = options.max ?? 10_000;
	}

	/**
	 * A turn starts: read the tenant's skills and keep them for this conversation until its next turn. A test
	 * conversation names a draft, whose author is always the conversation's owner, so nobody tests another's draft.
	 */
	readonly start = async (
		conversationId: ConversationId,
		tenantId: string | undefined,
		draft?: { readonly author: string; readonly name: string },
	): Promise<readonly Skill[]> => {
		const skills =
			draft === undefined || this.#withDraft === undefined ? await this.#skillsFor(tenantId) : await this.#withDraft(tenantId, draft.author, draft.name);
		this.#pins.delete(conversationId);
		this.#pins.set(conversationId, skills);
		if (this.#pins.size > this.#max) this.#pins.delete(this.#pins.keys().next().value!);
		return skills;
	};

	readonly of: SessionSkills = (conversationId, tenantId, parent) =>
		Promise.resolve(this.#pins.get(conversationId) ?? (parent === undefined ? undefined : this.#pins.get(parent)) ?? this.#skillsFor(tenantId));
}
