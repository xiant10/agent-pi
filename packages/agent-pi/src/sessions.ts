import { randomBytes } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { AgentDoc, type Conversation, type ConversationId, type Harness, type JsonObject, ProviderDoc } from "@earendil-works/pi-durable";
import { InstanceDoc, SessionDoc, type SessionState, ToolStateDoc, UserSessionsDoc } from "./agent/docs.ts";
import type { Profile } from "./agent/profiles.ts";
import { ownerKey, type Principal } from "./auth/authenticator.ts";
import type { StoredGrant } from "./auth/grants.ts";
import { AppError, RPC, rateLimited, sessionNotFound } from "./errors.ts";

export type SessionInfo = {
	readonly sessionId: string;
	readonly profile: string;
	readonly createdAt: number;
	readonly metadata?: JsonObject;
};

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

	constructor(harness: Harness, instance: ResolvedInstance, maxPerUser: number) {
		this.#harness = harness;
		this.instanceId = instance.instanceId;
		this.#legacyId = instance.legacyId;
		this.#maxPerUser = maxPerUser;
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
	): Promise<{ readonly conversation: Conversation; readonly sessionId: string }> {
		const owner = ownerKey(principal);
		const conversation = await this.#harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: profile.model, thinkingLevel: profile.thinkingLevel },
				init: async (tx, id) => {
					// A transient session lives for one call. Its owner never lists it, and a crash leaves it out of their way.
					if (!transient) {
						const sessions = await tx.doc(UserSessionsDoc, owner, null);
						if (sessions.sessions.length >= this.#maxPerUser) {
							throw rateLimited(`at most ${this.#maxPerUser} open sessions per user; close one first`, 1);
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
					if (metadata !== undefined) session.metadata = metadata;
					// The exact offered set; unset would offer every installed tool, hundreds of them.
					(await tx.doc(AgentDoc, id)).tools = [...pinnedTools];
					await tx.doc(ToolStateDoc, id);
					// Created now so the model hook finds the provider session id before the first request.
					await tx.doc(ProviderDoc, id);
				},
			},
			context,
		);
		return { conversation, sessionId: this.publicId(conversation.id) };
	}

	async list(principal: Principal, context: Context): Promise<SessionInfo[]> {
		const index = await this.#harness.snapshot(UserSessionsDoc, ownerKey(principal), context);
		const infos: SessionInfo[] = [];
		for (const id of index?.sessions ?? []) {
			const session = await this.#harness.snapshot(SessionDoc, id as ConversationId, context);
			if (session === undefined || session.closed === true) continue;
			infos.push(this.info(id as ConversationId, session));
		}
		return infos;
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
		const conversation = await this.#harness.conversation(conversationId, context);
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
		const conversation = await this.#harness.conversation(conversationId, context);
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
		await this.#harness.commit(async (tx) => {
			(await tx.doc(SessionDoc, conversationId)).closed = true;
			const index = await tx.doc(UserSessionsDoc, ownerKey(principal), null);
			const at = index.sessions.indexOf(conversationId);
			if (at !== -1) index.sessions.splice(at, 1);
		}, context);
	}

	info(conversationId: ConversationId, session: Readonly<SessionState>): SessionInfo {
		return {
			sessionId: this.publicId(conversationId),
			profile: session.profile,
			createdAt: session.createdAt,
			...(session.metadata === undefined ? {} : { metadata: session.metadata }),
		};
	}
}
