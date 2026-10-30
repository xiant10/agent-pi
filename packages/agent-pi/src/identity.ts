import type { Context } from "@earendil-works/chord";
import type { ProviderHeaders, ProviderStreams, SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationId,
	defineDoc,
	defineExtension,
	type Extension,
	GenerationTask,
	hook,
	type JsonObject,
	LiveDoc,
	ProviderDoc,
} from "@earendil-works/pi-durable";
import { readSession } from "./agent/docs.ts";
import type { Principal } from "./auth/authenticator.ts";
import type { CredentialStore } from "./auth/credentials.ts";

/**
 * Who a model call is for, so a gateway in front of the model can audit it: the session (a whole conversation), the
 * turn (one user message and every model call it triggers, tool loops and retries included), and the user.
 */
export type CallIdentity = {
	readonly sessionId: string;
	readonly turnId?: string;
	readonly userId?: string;
	readonly userName?: string;
	readonly tenantId?: string;
};

/** What a header resolver sees: the identity, plus what only the session knows. */
export type CallContext = CallIdentity & {
	/** The `metadata` the client gave `session.create`. */
	readonly metadata?: JsonObject;
	/** The newest verified caller, with its claims; absent for work resumed after a restart until the user calls again. */
	readonly principal?: Principal;
};

/**
 * Decides the identity headers of a model call, for downstream systems whose names or values differ from the config's
 * plain field-to-header map: add a header (a workspace from a claim, a scene from session metadata), rename, or
 * reformat. The result is merged over the configured map: a string sets or replaces a header, `null` removes it.
 * Bind it with `container.value(Services.identityHeaders, resolver)` in a plugin's `register()`. It runs on every
 * model request, so keep it cheap and synchronous.
 */
export type IdentityHeaderResolver = (call: CallContext) => Readonly<Record<string, string | null | undefined>>;

/** HTTP header carrying each field of a `CallIdentity`; omit a field to not send it. */
export type IdentityHeaderNames = { readonly [Field in keyof CallIdentity]?: string };

/** The header names of the Kaidan agent gateway's audit log. */
export const GATEWAY_IDENTITY_HEADERS: IdentityHeaderNames = {
	sessionId: "X-Session-ID",
	turnId: "X-Turn-ID",
	userId: "X-User-Id",
	userName: "X-User-Name",
};

const TURN_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Whether a client-supplied turn id is safe as a header value and log key. */
export function validTurnId(value: string): boolean {
	return TURN_ID.test(value);
}

/** The turn each submission belongs to, newest last; old ones are dropped. */
const TurnsDoc = defineDoc<{ bySubmission: Record<string, string> } & JsonObject>({
	kind: "app.turns",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ bySubmission: {} }),
});

const MAX_TURNS = 200;

/** Remember `turnId` for a submission; a retry of the same submission keeps its first turn id, which is returned. */
export function recordTurn(conversation: Conversation, submissionId: number, turnId: string, context: Context): Promise<string> {
	return conversation.commit(async (tx) => {
		const doc = await tx.doc(TurnsDoc, conversation.id);
		const key = String(submissionId);
		const existing = doc.bySubmission[key];
		if (existing !== undefined) return existing;
		doc.bySubmission[key] = turnId;
		const keys = Object.keys(doc.bySubmission);
		for (const old of keys.slice(0, Math.max(0, keys.length - MAX_TURNS))) delete doc.bySubmission[old];
		return turnId;
	}, context);
}

/**
 * The turn of the input a run is answering now: the newest input of the run, so a steering message starts a new turn.
 * `recordTurn` runs just after the submission is admitted, so a run that starts at once may look a few milliseconds
 * before the record exists; wait for it briefly.
 */
export async function currentTurn(reader: unknown, conversationId: ConversationId, context: Context): Promise<string | undefined> {
	const read = reader as {
		snapshot(doc: typeof LiveDoc, id: ConversationId, context: Context): Promise<Readonly<{ run?: { inputs: number[] } }> | undefined>;
		snapshot(doc: typeof TurnsDoc, id: ConversationId, context: Context): Promise<Readonly<{ bySubmission: Record<string, string> }> | undefined>;
	};
	for (let attempt = 0; attempt < 12; attempt++) {
		const live = await read.snapshot(LiveDoc, conversationId, context);
		const inputs = live?.run?.inputs ?? [];
		if (inputs.length === 0) return undefined;
		const turns = await read.snapshot(TurnsDoc, conversationId, context);
		for (let at = inputs.length - 1; at >= 0; at--) {
			const turn = turns?.bySubmission[String(inputs[at])];
			if (turn !== undefined) return turn;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return undefined;
}

/** Identities of the conversations that are generating, by the provider session id pi-durable passes to the model. */
export class IdentityRegistry {
	readonly #byProviderSession = new Map<string, CallContext>();

	set(providerSessionId: string, identity: CallContext): void {
		this.#byProviderSession.delete(providerSessionId);
		this.#byProviderSession.set(providerSessionId, identity);
		// One entry per conversation; keep the newest so a long-lived process stays bounded.
		if (this.#byProviderSession.size > 10_000) {
			const oldest = this.#byProviderSession.keys().next().value;
			if (oldest !== undefined) this.#byProviderSession.delete(oldest);
		}
	}

	get(providerSessionId: string | undefined): CallContext | undefined {
		return providerSessionId === undefined ? undefined : this.#byProviderSession.get(providerSessionId);
	}
}

/** `streams` that add the caller's identity headers to every request of a conversation they know. */
export function withIdentityHeaders(
	streams: ProviderStreams,
	registry: IdentityRegistry,
	names: IdentityHeaderNames,
	resolver?: IdentityHeaderResolver,
): ProviderStreams {
	const apply = <T extends StreamOptions | SimpleStreamOptions>(options: T | undefined): T | undefined => {
		const identity = registry.get(options?.sessionId);
		if (identity === undefined) return options;
		const headers: ProviderHeaders = { ...options?.headers };
		for (const field of Object.keys(names) as (keyof CallIdentity)[]) {
			const name = names[field];
			const value = identity[field];
			if (name !== undefined && value !== undefined && value !== "") headers[name] = headerValue(value);
		}
		if (resolver !== undefined) {
			for (const [name, value] of Object.entries(resolver(identity))) {
				if (value === null) headers[name] = null;
				else if (value !== undefined && value !== "") headers[name] = headerValue(value);
			}
		}
		return { ...options, headers } as T;
	};
	return {
		...streams,
		stream: (model, context, options) => streams.stream(model, context, apply(options)),
		streamSimple: (model, context, options) => streams.streamSimple(model, context, apply(options)),
		...(streams.fetchDeferred === undefined ? {} : { fetchDeferred: streams.fetchDeferred.bind(streams) }),
		...(streams.cancelDeferred === undefined ? {} : { cancelDeferred: streams.cancelDeferred.bind(streams) }),
	};
}

/** Header values are Latin-1 and single-line; anything else, such as a Chinese display name, is percent-encoded. */
function headerValue(value: string): string {
	const text = value.replace(/[\r\n]+/g, " ").trim();
	return /^[\x20-\x7e]*$/.test(text) ? text : encodeURIComponent(text);
}

/**
 * Before each model request, publish who it is for. The hook runs just before pi-durable calls the model with the
 * conversation's provider session id, which is how `withIdentityHeaders` finds it again.
 */
export function identityExtension(
	registry: IdentityRegistry,
	publicId: (conversationId: ConversationId) => string,
	credentials: CredentialStore,
): Extension {
	return defineExtension({
		name: "core.identity",
		hooks: [
			hook(GenerationTask, {
				beforeRequest: async (_request, api, context) => {
					const session = await readSession(api, api.conversationId, context);
					if (session === undefined) return undefined;
					const provider = await api.snapshot(ProviderDoc, api.conversationId, context);
					if (provider === undefined) return undefined;
					const principal = credentials.get(api.conversationId);
					const turnId = await currentTurn(api, api.conversationId, context);
					registry.set(provider.sessionId, {
						sessionId: publicId(api.conversationId),
						...(turnId === undefined ? {} : { turnId }),
						userId: session.userId,
						...(session.userName === undefined ? {} : { userName: session.userName }),
						...(session.tenantId === undefined ? {} : { tenantId: session.tenantId }),
						...(session.metadata === undefined ? {} : { metadata: session.metadata }),
						...(principal === undefined ? {} : { principal }),
					});
					return undefined;
				},
			}),
		],
	});
}
