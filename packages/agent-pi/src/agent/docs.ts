import type { Context } from "@earendil-works/chord";
import { type ConversationId, defineDoc, defineDocFamily, type JsonObject } from "@earendil-works/pi-durable";

/** Who owns a session and how it runs. Written once at creation; `closed` is set on close. */
export type SessionState = {
	owner: string;
	userId: string;
	userName?: string;
	tenantId?: string;
	profile: string;
	createdAt: number;
	closed?: boolean;
	/** Out of the owner's open sessions: still readable, not counted against their limit, and refuses new input. */
	archived?: boolean;
	/** The last input. Absent in older sessions, which fall back to `createdAt`. */
	lastActiveAt?: number;
	metadata?: JsonObject;
	/** The agent grant tool calls run under. Safe to store: an id is useless without this runtime's credentials. */
	grantId?: string;
	/** The caller's grant, when grantId is a child of it. */
	grantParent?: string;
	/** Set on a child conversation: the session it works for. Clients can read a child, but not drive it. */
	parent?: number;
	/** The newest child conversations of this session. */
	subagents?: number[];
	/** Set on a background child: its id in the parent's `app.tasks`. */
	task?: string;
	/** Set on a background child: the turn that started it, since it outlives that turn. */
	origin?: { turnId: string; traceparent?: string };
	/** Lives for one call, so nothing could read a background task's report. */
	transient?: boolean;
	/** Why the run that created it was running, from the token, when that wasn't a person: `schedule`, `event`, `webhook`. */
	trigger?: string;
	/** The automation that created it. */
	automation?: string;
} & JsonObject;

export const SessionDoc = defineDoc<SessionState>({
	kind: "app.session",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ owner: "", userId: "", profile: "", createdAt: 0 }),
	checkpointWhen: () => false,
});

/** Anything that reads documents: the harness, a transaction's reader, a tool or hook API. */
type SessionReader = {
	snapshot(doc: typeof SessionDoc, conversationId: ConversationId, context: Context): Promise<Readonly<SessionState> | undefined>;
};

/** The session of a conversation, or undefined for one that is not a session. */
export async function readSession(
	reader: SessionReader,
	conversationId: ConversationId,
	context: Context,
): Promise<Readonly<SessionState> | undefined> {
	const session = await reader.snapshot(SessionDoc, conversationId, context);
	return session === undefined || session.owner === "" ? undefined : session;
}

/**
 * One document per owner, listing their sessions, least recently active first. Per-owner, so listing and creating stay
 * O(own sessions). Only `sessions` counts against the owner's limit.
 */
/** `created` maps each `Agent-Request-Id` an owner created a session with to that session, oldest first, bounded. */
export const UserSessionsDoc = defineDocFamily<{ sessions: number[]; archived?: number[]; created?: Record<string, number> } & JsonObject, null>({
	kind: "app.user-sessions",
	version: 1,
	family: true,
	scope: "session",
	initial: () => ({ sessions: [] }),
	checkpointWhen: () => false,
});

/**
 * `dynamic`: tools activated after creation, oldest first, for eviction once the active set is full.
 * `skills`: each loaded skill and the tools it has activated so far, so tools that match it later are activated too.
 */
export const ToolStateDoc = defineDoc<{ dynamic: string[]; skills?: Record<string, string[]> } & JsonObject>({
	kind: "app.tools",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ dynamic: [] }),
	checkpointWhen: () => false,
});

/** Process identity, persisted so session ids stay valid across restarts of the same storage. */
/**
 * `id` is this replica's; `agent` is the agent that owns the storage, absent until a build that names agents opens it;
 * `legacyId` is the prefix of session ids issued before then, which this storage keeps accepting.
 */
export const InstanceDoc = defineDoc<{ id: string; agent?: string; legacyId?: string } & JsonObject>({
	kind: "app.instance",
	version: 1,
	scope: "session",
	initial: () => ({ id: "" }),
	checkpointWhen: () => false,
});
