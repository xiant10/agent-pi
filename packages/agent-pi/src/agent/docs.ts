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
	metadata?: JsonObject;
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

/** The session of a conversation, or undefined for one that is not a session, such as a consulted expert's. */
export async function readSession(
	reader: SessionReader,
	conversationId: ConversationId,
	context: Context,
): Promise<Readonly<SessionState> | undefined> {
	const session = await reader.snapshot(SessionDoc, conversationId, context);
	return session === undefined || session.owner === "" ? undefined : session;
}

/** One document per owner, listing their open sessions. Per-owner, so listing and creating stay O(own sessions). */
export const UserSessionsDoc = defineDocFamily<{ sessions: number[] } & JsonObject, null>({
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
export const InstanceDoc = defineDoc<{ id: string } & JsonObject>({
	kind: "app.instance",
	version: 1,
	scope: "session",
	initial: () => ({ id: "" }),
	checkpointWhen: () => false,
});
