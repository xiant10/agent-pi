import type { Context } from "@earendil-works/chord";
import type { ProviderHeaders, ProviderStreams, SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationId,
	defineDoc,
	defineExtension,
	type Extension,
	GenerationTask,
	type Harness,
	hook,
	type JsonObject,
	LiveDoc,
	ProviderDoc,
} from "@earendil-works/pi-durable";
import { readSession, type SessionState } from "./agent/docs.ts";
import type { Principal } from "./auth/authenticator.ts";
import type { CredentialStore } from "./auth/credentials.ts";
import { startSpan } from "./util/tracing.ts";

/**
 * Who a model call is for, so a gateway in front of the model can audit it: the session (a whole conversation), the
 * turn (one user message and every model call it triggers, tool loops and retries included), and the user.
 */
export type CallIdentity = {
	/** The agent making the call. */
	readonly agent?: string;
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
	/** Where this call's span belongs in the turn's trace, when the client is tracing it. */
	readonly traceparent?: string;
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

/** The header names `ai-gateway` reads from a model call. */
export const GATEWAY_IDENTITY_HEADERS: IdentityHeaderNames = {
	agent: "X-Agent-Name",
	sessionId: "X-Session-ID",
	turnId: "X-Turn-ID",
	userId: "X-User-Id",
	userName: "X-User-Name",
	tenantId: "X-Tenant-ID",
};

/** `_meta` keys of a `tools/call` between agents. */
export const TURN_META = "agent-pi/turnId";
export const HOPS_META = "agent-pi/hops";

const TURN_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Whether a client-supplied turn id is safe as a header value and log key. */
export function validTurnId(value: string): boolean {
	return TURN_ID.test(value);
}

/**
 * The turn each submission belongs to, newest last; old ones are dropped. `traceparents` holds where that turn's work
 * goes in its trace. It is durable so a run resumed after a restart stays in its trace, and absent in older documents.
 */
const TurnsDoc = defineDoc<{ bySubmission: Record<string, string>; traceparents?: Record<string, string> } & JsonObject>({
	kind: "app.turns",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ bySubmission: {} }),
	checkpointWhen: () => false,
});

const MAX_TURNS = 200;

/** Remember `turnId` for a submission; a retry of the same submission keeps its first turn id, which is returned. */
export function recordTurn(
	conversation: Conversation,
	submissionId: number,
	turnId: string,
	traceparent: string | undefined,
	context: Context,
): Promise<string> {
	return conversation.commit(async (tx) => {
		const doc = await tx.doc(TurnsDoc, conversation.id);
		const key = String(submissionId);
		const existing = doc.bySubmission[key];
		if (existing !== undefined) return existing;
		doc.bySubmission[key] = turnId;
		// Assigned whole: a document keeps a copy of a new object, so a write through the original would be lost.
		if (traceparent !== undefined) doc.traceparents = { ...doc.traceparents, [key]: traceparent };
		const keys = Object.keys(doc.bySubmission);
		for (const old of keys.slice(0, Math.max(0, keys.length - MAX_TURNS))) {
			delete doc.bySubmission[old];
			if (doc.traceparents !== undefined) delete doc.traceparents[old];
		}
		return turnId;
	}, context);
}

/** The input submissions with a known turn, newest last. Older ones have been dropped. */
export async function recordedTurns(reader: Harness, conversationId: ConversationId, context: Context): Promise<ReadonlyMap<number, string>> {
	const turns = await reader.snapshot(TurnsDoc, conversationId, context);
	return new Map(Object.entries(turns?.bySubmission ?? {}).map(([id, turnId]) => [Number(id), turnId]));
}

/**
 * The turn of the input a run is answering now: the newest input of the run, so a steering message starts a new turn.
 * `recordTurn` runs just after the submission is admitted, so a run that starts at once may look a few milliseconds
 * before the record exists; wait for it briefly.
 */
export async function currentTurn(reader: unknown, conversationId: ConversationId, context: Context): Promise<string | undefined> {
	return (await currentTurnRecord(reader, conversationId, context))?.turnId;
}

/** `currentTurn`, with where its work goes in the turn's trace. */
export async function currentTurnRecord(
	reader: unknown,
	conversationId: ConversationId,
	context: Context,
): Promise<{ readonly turnId: string; readonly traceparent?: string } | undefined> {
	const read = reader as {
		snapshot(doc: typeof LiveDoc, id: ConversationId, context: Context): Promise<Readonly<{ run?: { inputs: number[] } }> | undefined>;
		snapshot(
			doc: typeof TurnsDoc,
			id: ConversationId,
			context: Context,
		): Promise<Readonly<{ bySubmission: Record<string, string>; traceparents?: Record<string, string> }> | undefined>;
	};
	for (let attempt = 0; attempt < 12; attempt++) {
		const live = await read.snapshot(LiveDoc, conversationId, context);
		const inputs = live?.run?.inputs ?? [];
		if (inputs.length === 0) return undefined;
		const turns = await read.snapshot(TurnsDoc, conversationId, context);
		for (let at = inputs.length - 1; at >= 0; at--) {
			const key = String(inputs[at]);
			const turnId = turns?.bySubmission[key];
			if (turnId === undefined) continue;
			const traceparent = turns?.traceparents?.[key];
			return traceparent === undefined ? { turnId } : { turnId, traceparent };
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return undefined;
}

/**
 * The turn a conversation's work is for: a child's is its parent's, and a background child keeps the turn that started
 * it, because by the time it works its parent may be idle or in another turn.
 */
export async function workTurn(
	reader: unknown,
	conversationId: ConversationId,
	session: Readonly<SessionState> | undefined,
	context: Context,
): Promise<{ readonly turnId: string; readonly traceparent?: string } | undefined> {
	return session?.origin ?? currentTurnRecord(reader, (session?.parent as ConversationId | undefined) ?? conversationId, context);
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

/**
 * `streams` that record a span for every model request of a conversation in a traced turn. This wraps the provider call
 * itself rather than a durable hook, so a request that really was sent twice shows twice and a replay shows nothing.
 * With `forward`, the gateway gets the span as its `traceparent`, to continue the trace.
 */
export function withModelSpans(streams: ProviderStreams, registry: IdentityRegistry, forward: boolean): ProviderStreams {
	const traced = <T extends StreamOptions | SimpleStreamOptions>(
		model: Parameters<ProviderStreams["stream"]>[0],
		options: T | undefined,
		send: (options: T | undefined) => ReturnType<ProviderStreams["stream"]>,
	) => {
		const parent = registry.get(options?.sessionId)?.traceparent;
		if (parent === undefined) return send(options);
		const span = startSpan("agent.model", {
			traceparent: parent,
			attributes: { "gen_ai.provider.name": model.provider, "gen_ai.request.model": model.id },
		});
		const headers: ProviderHeaders = { ...options?.headers };
		if (forward && span.traceparent !== undefined) headers.traceparent = span.traceparent;
		const stream = send({ ...options, headers } as T);
		void stream.result().then(
			(message) => {
				span.setAttributes({
					"gen_ai.response.finish_reason": message.stopReason,
					"gen_ai.usage.input_tokens": message.usage.input,
					"gen_ai.usage.output_tokens": message.usage.output,
				});
				span.end(message.stopReason === "error" ? (message.errorMessage ?? "model error") : undefined);
			},
			(error: unknown) => span.end(String(error)),
		);
		return stream;
	};
	return {
		...streams,
		stream: (model, context, options) => traced(model, options, (sent) => streams.stream(model, context, sent)),
		streamSimple: (model, context, options) => traced(model, options, (sent) => streams.streamSimple(model, context, sent)),
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
	agent: string,
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
					// A child conversation makes its model calls for its parent's session and turn.
					const owner = (session.parent as ConversationId | undefined) ?? api.conversationId;
					const provider = await api.snapshot(ProviderDoc, api.conversationId, context);
					if (provider === undefined) return undefined;
					const principal = credentials.get(api.conversationId);
					const turn = await workTurn(api, api.conversationId, session, context);
					registry.set(provider.sessionId, {
						agent,
						sessionId: publicId(owner),
						...(turn === undefined ? {} : { turnId: turn.turnId }),
						...(turn?.traceparent === undefined ? {} : { traceparent: turn.traceparent }),
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
