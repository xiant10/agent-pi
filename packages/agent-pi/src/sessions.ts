import { randomBytes } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { AgentDoc, type Conversation, type ConversationId, type Harness, type JsonObject, ProviderDoc } from "@earendil-works/pi-durable";
import { InstanceDoc, SessionDoc, type SessionState, ToolStateDoc, UserSessionsDoc } from "./agent/docs.ts";
import type { Profile } from "./agent/profiles.ts";
import { ownerKey, type Principal } from "./auth/authenticator.ts";
import { AppError, RPC, rateLimited, sessionNotFound } from "./errors.ts";

export type SessionInfo = {
	readonly sessionId: string;
	readonly profile: string;
	readonly createdAt: number;
	readonly metadata?: JsonObject;
};

/** Read and stored once at startup: the configured id, else the one this storage was first opened with. */
export async function resolveInstanceId(harness: Harness, configured: string | undefined, context: Context): Promise<string> {
	return harness.commit(async (tx) => {
		const instance = await tx.doc(InstanceDoc);
		if (configured !== undefined) instance.id = configured;
		else if (instance.id === "") instance.id = randomBytes(4).toString("hex");
		return instance.id;
	}, context);
}

/**
 * Sessions are ownerless durable conversations tagged with their owner. Public ids are `<instanceId>.<conversationId>`:
 * storage belongs to one process, so with several replicas the prefix tells a gateway which replica holds a session.
 */
export class SessionStore {
	readonly #harness: Harness;
	readonly instanceId: string;
	readonly #maxPerUser: number;

	constructor(harness: Harness, instanceId: string, maxPerUser: number) {
		this.#harness = harness;
		this.instanceId = instanceId;
		this.#maxPerUser = maxPerUser;
	}

	publicId(conversationId: ConversationId): string {
		return `${this.instanceId}.${conversationId}`;
	}

	/** The conversation id of a public session id; another instance's id answers 421 naming that instance. */
	parseId(sessionId: string): ConversationId {
		const match = /^([A-Za-z0-9_-]+)\.(\d+)$/.exec(sessionId);
		if (match === null) throw sessionNotFound();
		if (match[1] !== this.instanceId) {
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
	): Promise<{ readonly conversation: Conversation; readonly sessionId: string }> {
		const owner = ownerKey(principal);
		const conversation = await this.#harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: profile.model, thinkingLevel: profile.thinkingLevel },
				init: async (tx, id) => {
					const sessions = await tx.doc(UserSessionsDoc, owner, null);
					if (sessions.sessions.length >= this.#maxPerUser) {
						throw rateLimited(`at most ${this.#maxPerUser} open sessions per user; close one first`, 1);
					}
					sessions.sessions.push(id);
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
		if (session === undefined || session.owner !== ownerKey(principal) || session.closed === true) throw sessionNotFound();
		const conversation = await this.#harness.conversation(conversationId, context);
		if (conversation === undefined) throw sessionNotFound();
		return { conversation, session };
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
