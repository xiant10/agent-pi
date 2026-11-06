import { randomBytes } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { AgentDoc, type Conversation, type ConversationId, type Harness, type JsonObject, ProviderDoc } from "@earendil-works/pi-durable";
import { InstanceDoc, SessionDoc, type SessionState, ToolStateDoc, UserSessionsDoc } from "./agent/docs.ts";
import type { Profile } from "./agent/profiles.ts";
import { TasksDoc } from "./agent/tasks.ts";
import { FlowDoc } from "./flow/types.ts";
import { ownerKey, type Principal } from "./auth/authenticator.ts";
import type { StoredGrant } from "./auth/grants.ts";
import { AppError, RPC, rateLimited, sessionNotFound } from "./errors.ts";
import { TurnsDoc } from "./identity.ts";

/** Fields of a session its owner can change after creation. */
export type SessionChanges = { readonly title?: string; readonly pinned?: boolean; readonly archived?: boolean };

export type SessionPage = { readonly sessions: readonly SessionInfo[]; readonly nextCursor?: string };

export type SessionInfo = {
	readonly sessionId: string;
	readonly profile: string;
	readonly createdAt: number;
	readonly lastActiveAt: number;
	readonly archived?: true;
	readonly metadata?: JsonObject;
	/** What this session supports, so a client can hide what it doesn't. */
	readonly capabilities: readonly string[];
	/** Why it was started: `user` unless an automation's run created it. */
	readonly origin: { readonly trigger: string; readonly automation?: string };
};

/** How many `Agent-Request-Id` keys an owner's index remembers. A repeat older than that creates a new session. */
const CREATE_KEYS = 200;

/** Thrown inside a create's transaction when the key was claimed meanwhile, so nothing is created. */
class AlreadyCreated extends Error {
	readonly conversationId: number;

	constructor(conversationId: number) {
		super("already created");
		this.conversationId = conversationId;
	}
}

export type ResolvedInstance = {
	/** `<agent>.<replica>`, unique across agents even when they configure the same replica id. */
	readonly instanceId: string;
	/** The prefix of session ids this storage issued before agents had names. */
	readonly legacyId: string | undefined;
};

/**
 * Read and stored once at startup: the configured replica id, else the one this storage was first opened with. A
 * storage belongs to one agent, so opening it as another is refused.
 */
export async function resolveInstance(
	harness: Harness,
	agent: string,
	configured: string | undefined,
	context: Context,
): Promise<ResolvedInstance> {
	const resolved = await harness.commit(async (tx) => {
		const instance = await tx.doc(InstanceDoc);
		if (instance.agent !== undefined && instance.agent !== agent) return { owner: instance.agent };
		if (instance.agent === undefined && instance.id !== "") instance.legacyId = instance.id;
		instance.agent = agent;
		if (configured !== undefined) instance.id = configured;
		else if (instance.id === "") instance.id = randomBytes(4).toString("hex");
		return { instanceId: `${agent}.${instance.id}`, legacyId: instance.legacyId };
	}, context);
	if ("owner" in resolved) throw new Error(`storage belongs to agent ${resolved.owner}, not ${agent}`);
	return resolved;
}

/**
 * Sessions are ownerless durable conversations tagged with their owner. Public ids are `<agent>.<replica>.<conversationId>`:
 * storage belongs to one process, so with several agents or replicas everything before the last dot tells a gateway
 * which one holds a session.
 */
export class SessionStore {
	readonly #harness: Harness;
	readonly instanceId: string;
	readonly #legacyId: string | undefined;
	readonly #maxPerUser: number;
	readonly #capabilities: readonly string[];
	readonly #conversations = new Map<ConversationId, Conversation>();

	constructor(harness: Harness, instance: ResolvedInstance, maxPerUser: number, capabilities: readonly string[]) {
		this.#harness = harness;
		this.instanceId = instance.instanceId;
		this.#legacyId = instance.legacyId;
		this.#maxPerUser = maxPerUser;
		this.#capabilities = capabilities;
	}

	publicId(conversationId: ConversationId): string {
		return `${this.instanceId}.${conversationId}`;
	}

	/** The conversation id of a public session id; another instance's id answers 421 naming that instance. */
	parseId(sessionId: string): ConversationId {
		const match = /^([A-Za-z0-9_.-]+)\.(\d+)$/.exec(sessionId);
		if (match === null) throw sessionNotFound();
		if (match[1] !== this.instanceId && match[1] !== this.#legacyId) {
			throw new AppError("misdirected", 421, RPC.misdirected, "session belongs to another instance", {
				"agent-instance": match[1]!,
			});
		}
		return Number(match[2]) as ConversationId;
	}

	async create(
		principal: Principal,
		profile: Profile,
		pinnedTools: readonly string[],
		metadata: JsonObject | undefined,
		context: Context,
		transient = false,
		requestKey?: string,
	): Promise<{ readonly conversation: Conversation; readonly sessionId: string; readonly existing: boolean }> {
		const owner = ownerKey(principal);
		// A repeat of a create answers the session the first one made, so a timer that fires twice makes one conversation.
		if (requestKey !== undefined) {
			const index = await this.#harness.snapshot(UserSessionsDoc, owner, context);
			const earlier = index?.created?.[requestKey];
			if (earlier !== undefined) return this.#existing(principal, earlier, context);
		}
		let conversation: Conversation;
		try {
			conversation = await this.#harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: { model: profile.model, thinkingLevel: profile.thinkingLevel },
					init: async (tx, id) => {
						// A transient session lives for one call. Its owner never lists it, and a crash leaves it out of their way.
						if (!transient) {
							const sessions = await tx.doc(UserSessionsDoc, owner, null);
							if (requestKey !== undefined) {
								// Checked again here: a create racing this one with the same key may have won.
								const won = sessions.created?.[requestKey];
								if (won !== undefined) throw new AlreadyCreated(won);
								const created = { ...(JSON.parse(JSON.stringify(sessions.created ?? {})) as Record<string, number>), [requestKey]: id };
								for (const old of Object.keys(created).slice(0, Math.max(0, Object.keys(created).length - CREATE_KEYS))) delete created[old];
								// Assigned whole: a document keeps a copy of a new object, so a write through the original would be lost.
								sessions.created = created;
							}
							if (sessions.sessions.length >= this.#maxPerUser) {
								throw rateLimited(`at most ${this.#maxPerUser} open sessions per user; archive or close one first`, 1);
							}
							sessions.sessions.push(id);
						}
						const session = await tx.doc(SessionDoc, id);
						session.owner = owner;
						session.userId = principal.userId;
						if (principal.displayName !== undefined) session.userName = principal.displayName;
						if (principal.tenantId !== undefined) session.tenantId = principal.tenantId;
						session.profile = profile.name;
						session.createdAt = Date.now();
						session.lastActiveAt = session.createdAt;
						if (transient) session.transient = true;
						if (metadata !== undefined) session.metadata = metadata;
						const trigger = principal.agent?.trigger;
						if (trigger !== undefined && trigger !== "user") session.trigger = trigger;
						if (principal.agent?.automation !== undefined) session.automation = principal.agent.automation;
						// The exact offered set; unset would offer every installed tool, hundreds of them.
						(await tx.doc(AgentDoc, id)).tools = [...pinnedTools];
						await tx.doc(ToolStateDoc, id);
						// Created now so the model hook finds the provider session id before the first request.
						await tx.doc(ProviderDoc, id);
						// Warmed now so prompts and event hubs read them from memory without negative lookups or setup commits.
						await tx.doc(TasksDoc, id);
						await tx.doc(FlowDoc, id);
						await tx.doc(TurnsDoc, id);
					},
				},
				context,
			);
		} catch (error) {
			if (error instanceof AlreadyCreated) return this.#existing(principal, error.conversationId, context);
			throw error;
		}
		this.#conversations.set(conversation.id, conversation);
		return { conversation, sessionId: this.publicId(conversation.id), existing: false };
	}

	/** The session an earlier create with the same key made, while its owner still has it open. */
	async #existing(
		principal: Principal,
		conversationId: number,
		context: Context,
	): Promise<{ readonly conversation: Conversation; readonly sessionId: string; readonly existing: true }> {
		const { conversation } = await this.require(principal, this.publicId(conversationId as ConversationId), context);
		return { conversation, sessionId: this.publicId(conversation.id), existing: true };
	}

	/** The caller's sessions, most recently active first. The cursor is an offset, so activity can shift a later page by one. */
	async list(
		principal: Principal,
		options: { readonly archived?: boolean; readonly limit?: number; readonly cursor?: number },
		context: Context,
	): Promise<SessionPage> {
		const index = await this.#harness.snapshot(UserSessionsDoc, ownerKey(principal), context);
		const ids = [...((options.archived === true ? index?.archived : index?.sessions) ?? [])].reverse();
		const start = options.cursor ?? 0;
		const end = options.limit === undefined ? ids.length : Math.min(ids.length, start + options.limit);
		const loaded = await Promise.all(
			ids.slice(start, end).map(async (id) => ({
				id: id as ConversationId,
				session: await this.#harness.snapshot(SessionDoc, id as ConversationId, context),
			})),
		);
		const sessions: SessionInfo[] = [];
		for (const { id, session } of loaded) {
			if (session === undefined || session.closed === true) continue;
			sessions.push(this.info(id, session));
		}
		return { sessions, ...(end < ids.length ? { nextCursor: String(end) } : {}) };
	}

	/** Note new input: the session moves to the top of its owner's list. */
	async touch(principal: Principal, conversationId: ConversationId, context: Context): Promise<void> {
		const current = await this.#harness.snapshot(SessionDoc, conversationId, context);
		if (current === undefined || current.transient === true || current.parent !== undefined) return;
		await this.#harness.commit(async (tx) => {
			const session = await tx.doc(SessionDoc, conversationId);
			session.lastActiveAt = Date.now();
			if (session.transient === true || session.parent !== undefined) return;
			const index = await tx.doc(UserSessionsDoc, ownerKey(principal), null);
			const at = index.sessions.indexOf(conversationId);
			if (at === -1 || at === index.sessions.length - 1) return;
			index.sessions.splice(at, 1);
			index.sessions.push(conversationId);
		}, context);
	}

	async update(principal: Principal, sessionId: string, changes: SessionChanges, context: Context): Promise<SessionInfo> {
		const { conversation } = await this.require(principal, sessionId, context);
		const owner = ownerKey(principal);
		await this.#harness.commit(async (tx) => {
			const session = await tx.doc(SessionDoc, conversation.id);
			if (changes.title !== undefined || changes.pinned !== undefined) {
				// Copied out first: a document's nested values are live views, and can't be spread back into it.
				session.metadata = {
					...(JSON.parse(JSON.stringify(session.metadata ?? {})) as JsonObject),
					...(changes.title === undefined ? {} : { title: changes.title }),
					...(changes.pinned === undefined ? {} : { pinned: changes.pinned }),
				};
			}
			if (changes.archived !== undefined && changes.archived !== (session.archived === true)) {
				const index = await tx.doc(UserSessionsDoc, owner, null);
				const open = index.sessions.filter((id) => id !== conversation.id);
				const archived = (index.archived ?? []).filter((id) => id !== conversation.id);
				if (changes.archived) {
					archived.push(conversation.id);
					session.archived = true;
				} else {
					if (open.length >= this.#maxPerUser) throw rateLimited(`at most ${this.#maxPerUser} open sessions per user; archive one first`, 1);
					open.push(conversation.id);
					delete session.archived;
				}
				index.sessions = open;
				index.archived = archived;
			}
		}, context);
		const updated = await this.#harness.snapshot(SessionDoc, conversation.id, context);
		if (updated === undefined) throw sessionNotFound();
		return this.info(conversation.id, updated);
	}

	/** The conversation handle for `conversationId`, cached in memory once loaded. */
	async conversation(conversationId: ConversationId, context: Context): Promise<Conversation | undefined> {
		const cached = this.#conversations.get(conversationId);
		if (cached !== undefined) return cached;
		const loaded = await this.#harness.conversation(conversationId, context);
		if (loaded !== undefined) this.#conversations.set(conversationId, loaded);
		return loaded;
	}

	/** The caller's open session, or `session_not_found`. */
	async require(
		principal: Principal,
		sessionId: string,
		context: Context,
	): Promise<{ readonly conversation: Conversation; readonly session: Readonly<SessionState> }> {
		const conversationId = this.parseId(sessionId);
		const session = await this.#harness.snapshot(SessionDoc, conversationId, context);
		if (session === undefined || session.owner !== ownerKey(principal) || session.closed === true || session.parent !== undefined) {
			throw sessionNotFound();
		}
		const conversation = await this.conversation(conversationId, context);
		if (conversation === undefined) throw sessionNotFound();
		return { conversation, session };
	}

	/**
	 * The caller's session or child conversation, for reading only. A child stays readable while its parent is open.
	 */
	async readable(
		principal: Principal,
		sessionId: string,
		context: Context,
	): Promise<{ readonly conversation: Conversation; readonly session: Readonly<SessionState> }> {
		const conversationId = this.parseId(sessionId);
		const session = await this.#harness.snapshot(SessionDoc, conversationId, context);
		if (session === undefined || session.owner !== ownerKey(principal) || session.closed === true) throw sessionNotFound();
		if (session.parent !== undefined) {
			const parent = await this.#harness.snapshot(SessionDoc, session.parent as ConversationId, context);
			if (parent === undefined || parent.closed === true) throw sessionNotFound();
		}
		const conversation = await this.conversation(conversationId, context);
		if (conversation === undefined) throw sessionNotFound();
		return { conversation, session };
	}

	/** Remember a conversation's grant, so a run resumed after a restart mints tokens without its user. */
	async setGrant(conversationId: ConversationId, grant: StoredGrant, context: Context): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const session = await tx.doc(SessionDoc, conversationId);
			session.grantId = grant.grantId;
			if (grant.parent === undefined) delete session.grantParent;
			else session.grantParent = grant.parent;
		}, context);
	}

	/** Mark closed and drop from the owner's index. The transcript stays in storage. */
	async markClosed(principal: Principal, conversationId: ConversationId, context: Context): Promise<void> {
		this.#conversations.delete(conversationId);
		await this.#harness.commit(async (tx) => {
			(await tx.doc(SessionDoc, conversationId)).closed = true;
			const index = await tx.doc(UserSessionsDoc, ownerKey(principal), null);
			const at = index.sessions.indexOf(conversationId);
			if (at !== -1) index.sessions.splice(at, 1);
			if (index.archived !== undefined) index.archived = index.archived.filter((id) => id !== conversationId);
		}, context);
	}

	info(conversationId: ConversationId, session: Readonly<SessionState>): SessionInfo {
		return {
			sessionId: this.publicId(conversationId),
			profile: session.profile,
			createdAt: session.createdAt,
			lastActiveAt: session.lastActiveAt ?? session.createdAt,
			...(session.archived === true ? { archived: true as const } : {}),
			...(session.metadata === undefined ? {} : { metadata: session.metadata }),
			capabilities: this.#capabilities,
			origin: { trigger: session.trigger ?? "user", ...(session.automation === undefined ? {} : { automation: session.automation }) },
		};
	}
}
