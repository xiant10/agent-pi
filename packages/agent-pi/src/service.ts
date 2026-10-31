import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	AgentDoc,
	AssistantEntry,
	type Conversation,
	ConversationBusy,
	type ConversationId,
	type Harness,
	type JsonObject,
	LiveDoc,
	type Submission,
	type SubmissionRecord,
	UsageDoc,
	type UserInput,
} from "@earendil-works/pi-durable";
import { assistantText } from "./agent/core-extension.ts";
import { SessionDoc, type SessionState, ToolStateDoc } from "./agent/docs.ts";
import { pinnedTools, preloadTools, type Profile } from "./agent/profiles.ts";
import { ownerKey, type Principal } from "./auth/authenticator.ts";
import type { CredentialStore } from "./auth/credentials.ts";
import type { LimitsConfig } from "./config.ts";
import { AppError, invalidParams, RPC, rateLimited } from "./errors.ts";
import type { HubRegistry, SessionHub } from "./events/hub.ts";
import { currentTurnRecord, recordTurn } from "./identity.ts";
import { toolSpans } from "./events/tool-spans.ts";
import { appendReply, type ReplyRecord, ReplyRequestsDoc } from "./plugins/history.ts";
import { type PluginRunner, textOf } from "./plugins/runner.ts";
import type { AgentPlugin, SessionContext } from "./plugins/types.ts";
import type { SessionInfo, SessionStore } from "./sessions.ts";
import type { Skill } from "./skills/skills.ts";
import { activateTools, refreshSkills } from "./tools/activation.ts";
import type { ToolCatalog } from "./tools/catalog.ts";
import type { Logger } from "./util/log.ts";
import { startSpan, traceIdOf, type TraceSpan } from "./util/tracing.ts";

export type ServiceDeps = {
	readonly harness: Harness;
	readonly store: SessionStore;
	readonly catalog: ToolCatalog;
	readonly skills: readonly Skill[];
	readonly profiles: ReadonlyMap<string, Profile>;
	readonly defaultProfile: Profile;
	readonly credentials: CredentialStore;
	readonly hubs: HubRegistry;
	readonly plugins: PluginRunner;
	readonly limits: LimitsConfig;
	readonly log: Logger;
};

export type PromptOptions = {
	readonly requestId?: string;
	/** The client's id for this turn (one user message and the model calls it triggers); generated when absent. */
	readonly turnId?: string;
	/** The W3C trace context of the client's turn; this input's work is added to that trace. */
	readonly traceparent?: string;
	/** What to do when the session is already working. Default `followUp`: answer after the current run. */
	readonly whenBusy?: "followUp" | "steer" | "reject";
	/**
	 * For `interrupt`, what to do when tools are running. Default `abort`. `steer` lets them finish and joins the run: a
	 * tool may already have acted, and an aborted one is reported to the model as if it had not.
	 */
	readonly duringTools?: "abort" | "steer";
};

export type Admitted =
	| {
			readonly kind: "run";
			readonly submission: Submission;
			readonly conversationId: ConversationId;
			readonly profile: Profile;
			readonly turnId: string;
			/** `queued`: waits in the inbox; `placed`: in the transcript, being answered. */
			readonly placement: "queued" | "placed";
	  }
	| {
			/** A plugin answered without the model; input and reply are in the transcript (or queued to it when busy). */
			readonly kind: "reply";
			readonly conversationId: ConversationId;
			readonly profile: Profile;
			readonly turnId: string;
			readonly text: string;
			readonly plugin: string;
			/** `queued`: the session was busy; the exchange enters the transcript at the next boundary. */
			readonly placement: "placed" | "queued";
	  };

export type SessionDetails = SessionInfo & {
	readonly busy: boolean;
	readonly activeTools: readonly string[];
	readonly usage: JsonObject;
};

/**
 * Everything a transport can do with sessions, each call checked against the caller's identity. Transports stay thin:
 * they parse, authenticate, call one method here, and frame the result.
 */
export class AgentService {
	readonly #deps: ServiceDeps;
	readonly #runs = new RunTracker();

	constructor(deps: ServiceDeps) {
		this.#deps = deps;
	}

	get skills(): readonly Skill[] {
		return this.#deps.skills;
	}

	async createSession(
		principal: Principal,
		options: { readonly profile?: string; readonly metadata?: JsonObject },
		context: Context,
	): Promise<SessionInfo> {
		const profile = this.#profile(options.profile);
		const { conversation, sessionId } = await this.#deps.store.create(
			principal,
			profile,
			pinnedTools(profile, this.#deps.catalog),
			options.metadata,
			context,
		);
		this.#deps.credentials.set(conversation.id, principal);
		this.#deps.log.info("session.created", { sessionId, owner: ownerKey(principal), profile: profile.name });
		const session = await this.#deps.harness.snapshot(SessionDoc, conversation.id, context);
		if (session === undefined) throw new Error(`session ${sessionId} vanished after creation`);
		await this.#deps.plugins.sessionCreated(conversation.id, session, context);
		return this.#deps.store.info(conversation.id, session);
	}

	listSessions(principal: Principal, context: Context): Promise<SessionInfo[]> {
		return this.#deps.store.list(principal, context);
	}

	async getSession(principal: Principal, sessionId: string, context: Context): Promise<SessionDetails> {
		const { conversation, session } = await this.#deps.store.require(principal, sessionId, context);
		const [agent, live, usage] = await Promise.all([
			this.#deps.harness.snapshot(AgentDoc, conversation.id, context),
			this.#deps.harness.snapshot(LiveDoc, conversation.id, context),
			this.#deps.harness.snapshot(UsageDoc, conversation.id, context),
		]);
		return {
			...this.#deps.store.info(conversation.id, session),
			busy: live?.run !== undefined,
			activeTools: Array.isArray(agent?.tools) ? [...agent.tools] : [],
			usage: (usage ?? {}) as JsonObject,
		};
	}

	/** Admit user input. An idle session starts a run; a busy one queues it as `whenBusy` says. */
	async prompt(
		principal: Principal,
		sessionId: string,
		input: unknown,
		options: PromptOptions,
		context: Context,
	): Promise<Admitted> {
		const content = this.#input(input);
		const { conversation, session } = await this.#deps.store.require(principal, sessionId, context);
		const profile = this.#profile(session.profile);
		this.#deps.credentials.set(conversation.id, principal);
		const lease = this.#runs.reserve(ownerKey(principal), conversation.id, this.#deps.limits);
		try {
			const admitted = await this.#admit(conversation, session, principal, profile, sessionId, content, options, context);
			if (admitted.kind === "run") lease.track(admitted.submission);
			else lease.release();
			return admitted;
		} catch (error) {
			lease.release();
			if (error instanceof ConversationBusy) throw new AppError("busy", 409, RPC.busy, "session is busy");
			throw error;
		}
	}

	async #admit(
		conversation: Conversation,
		session: Readonly<SessionState>,
		principal: Principal,
		profile: Profile,
		sessionId: string,
		content: UserInput,
		options: PromptOptions,
		context: Context,
	): Promise<Admitted> {
		const { requestId } = options;
		// A turn starts when the call arrives, whether or not the client named it.
		const turnId = options.turnId ?? randomUUID();
		// A retry of an input that was already admitted gets the first outcome; plugins and preloading do not run again.
		const earlier = requestId === undefined ? undefined : await this.#earlier(conversation, requestId, context);
		if (earlier?.kind === "reply") {
			return { kind: "reply", conversationId: conversation.id, profile, ...earlier.reply };
		}
		const outcome =
			earlier?.kind === "run"
				? ({ kind: "model", input: content, activate: [] } as const)
				: await this.#deps.plugins.beforePrompt(conversation.id, session, principal, content, requestId, turnId, context);
		if (outcome.kind === "reply") {
			const reply = await appendReply(
				this.#deps.harness,
				conversation.id,
				{ input: outcome.input, text: outcome.text, plugin: outcome.plugin, turnId, ...(requestId === undefined ? {} : { requestId }) },
				context,
				options.whenBusy === "reject" ? "reject" : "queue",
			);
			this.#deps.log.debug("prompt.plugin_reply", { sessionId, plugin: reply.plugin, placement: reply.placement });
			if (!reply.duplicate) {
				this.#deps.plugins.afterRun(conversation.id, session, { turnId: reply.turnId, status: "done", text: reply.text, answeredBy: reply.plugin });
				startSpan("agent.reply", { traceparent: options.traceparent, attributes: { "agentpi.session_id": sessionId, "turn.id": turnId, "agent.answered_by": reply.plugin } }).end();
			}
			return { kind: "reply", conversationId: conversation.id, profile, turnId: reply.turnId, text: reply.text, plugin: reply.plugin, placement: reply.placement };
		}
		const submitted = outcome.input;

		// Loaded skills pick up tools listed since they loaded; then the input's likely tools are preloaded, after the
		// tools plugins routed this input to. A retry skips this: its input is already in the transcript.
		const routed = this.#deps.catalog.match(outcome.activate);
		const preload =
			earlier === undefined
				? [...new Set([...routed, ...preloadTools(textOf(submitted), profile, this.#deps.catalog, this.#deps.skills)])]
				: [];
		const state = await this.#deps.harness.snapshot(ToolStateDoc, conversation.id, context);
		const hasSkills = earlier === undefined && Object.keys(state?.skills ?? {}).length > 0;
		if (preload.length > 0 || hasSkills) {
			const policy = { pinned: pinnedTools(profile, this.#deps.catalog), maxActive: profile.maxActiveTools };
			const { refreshed, preloaded } = await conversation.commit(async (tx) => {
				const refreshed = hasSkills ? (await refreshSkills(tx, conversation.id, this.#skillTools, policy)).added : [];
				const preloaded = preload.length > 0 ? (await activateTools(tx, conversation.id, preload, policy)).added : [];
				return { refreshed, preloaded };
			}, context);
			if (refreshed.length > 0) this.#deps.log.debug("tools.skill_refreshed", { sessionId, added: refreshed });
			if (preloaded.length > 0) this.#deps.log.debug("tools.preloaded", { sessionId, added: preloaded });
		}

		// A retry's span is its first attempt's. Model and tool spans go under this one, wherever the run's work lands.
		const span = earlier === undefined
			? startSpan("agent.submission", { traceparent: options.traceparent, attributes: { "agentpi.session_id": sessionId, "turn.id": turnId } })
			: undefined;
		try {
			// With a known `requestId`, durable returns the existing submission and ignores the content.
			const submission = await conversation.submit(
				{
					type: "input",
					content: submitted,
					whenBusy: options.whenBusy ?? "followUp",
					...(requestId === undefined ? {} : { requestId }),
				},
				context,
			);
			// A retry keeps the turn its first attempt recorded.
			const turn = await recordTurn(conversation, submission.id, turnId, span?.traceparent ?? options.traceparent, context);
			if (earlier === undefined) this.#afterRun(conversation.id, session, submission, turn);
			const record = await submission.status(context);
			const placement = record.status === "queued" ? "queued" : "placed";
			this.#deps.log.info("prompt.admitted", {
				sessionId,
				turnId: turn,
				submissionId: submission.id,
				placement,
				...(requestId === undefined ? {} : { requestId }),
				...(options.traceparent === undefined ? {} : { traceId: traceIdOf(options.traceparent) }),
			});
			if (span !== undefined) this.#settleSpan(span, submission, placement);
			return { kind: "run", submission, conversationId: conversation.id, profile, turnId: turn, placement };
		} catch (error) {
			span?.end(String(error));
			throw error;
		}
	}

	#settleSpan(span: TraceSpan, submission: Submission, placement: string): void {
		span.setAttributes({ "agent.submission_id": submission.id, "agent.placement": placement });
		void submission.wait(BACKGROUND_CONTEXT).then(
			(settled) => {
				span.setAttributes({ "agent.status": settled.status, ...(settled.reason === undefined ? {} : { "agent.reason": settled.reason }) });
				span.end();
			},
			(error: unknown) => span.end(String(error)),
		);
	}

	/** What an earlier input with this `requestId` became: a plugin reply, a model run, or nothing yet. */
	async #earlier(
		conversation: Conversation,
		requestId: string,
		context: Context,
	): Promise<{ readonly kind: "reply"; readonly reply: ReplyRecord } | { readonly kind: "run" } | undefined> {
		const replies = await this.#deps.harness.snapshot(ReplyRequestsDoc, conversation.id, context);
		const reply = replies?.replies[requestId];
		if (reply !== undefined) return { kind: "reply", reply };
		const submission = await conversation.commit((tx) => tx.submissionByRequest(conversation.id, requestId), context);
		return submission?.type === "input" ? { kind: "run" } : undefined;
	}

	/** Join the running work after its current tool round; starts a run when idle. */
	steer(principal: Principal, sessionId: string, input: unknown, ids: Pick<PromptOptions, "requestId" | "turnId" | "traceparent">, context: Context) {
		return this.prompt(principal, sessionId, input, { ...ids, whenBusy: "steer" }, context);
	}

	/**
	 * Barge-in: stop generation and tool calls now, withdraw queued inputs, then answer `input` if given. The aborted
	 * partial answer stays in storage, but durable leaves it out of model context: to tell the model what it had already
	 * said, put that in `input`.
	 */
	async interrupt(
		principal: Principal,
		sessionId: string,
		input: unknown,
		ids: Pick<PromptOptions, "requestId" | "turnId" | "traceparent" | "duringTools">,
		context: Context,
	): Promise<Admitted | undefined> {
		const { requestId, turnId, traceparent } = ids;
		const prompted = {
			...(requestId === undefined ? {} : { requestId }),
			...(turnId === undefined ? {} : { turnId }),
			...(traceparent === undefined ? {} : { traceparent }),
		};
		if (input !== undefined) this.#input(input);
		const { conversation } = await this.#deps.store.require(principal, sessionId, context);
		// A retry must not abort again: that would stop the run its first attempt started. `prompt` returns that outcome.
		const retry = requestId !== undefined && (await this.#earlier(conversation, requestId, context)) !== undefined;
		if (!retry) {
			if (input !== undefined && ids.duringTools === "steer") {
				const live = await this.#deps.harness.snapshot(LiveDoc, conversation.id, context);
				if ((live?.tools?.length ?? 0) > 0) return this.prompt(principal, sessionId, input, { ...prompted, whenBusy: "steer" }, context);
			}
			await conversation.abort(context);
		}
		if (input === undefined) return undefined;
		return this.prompt(principal, sessionId, input, prompted, context);
	}

	async cancel(principal: Principal, sessionId: string, context: Context): Promise<void> {
		const { conversation } = await this.#deps.store.require(principal, sessionId, context);
		await conversation.abort(context);
	}

	async close(principal: Principal, sessionId: string, context: Context): Promise<void> {
		const { conversation, session } = await this.#deps.store.require(principal, sessionId, context);
		// Closed first, so a prompt arriving while the run aborts and plugins clean up is refused, not started.
		await this.#deps.store.markClosed(principal, conversation.id, context);
		await conversation.abort(context);
		await this.#deps.plugins.sessionClosed(conversation.id, session, context);
		await this.#deps.hubs.stop(conversation.id);
		this.#deps.credentials.delete(conversation.id);
		this.#deps.log.info("session.closed", { sessionId, owner: ownerKey(principal) });
	}

	/** The session's event hub, after the ownership check. */
	async hub(principal: Principal, sessionId: string, context: Context): Promise<SessionHub> {
		const { conversation, session } = await this.#deps.store.require(principal, sessionId, context);
		this.#deps.credentials.set(conversation.id, principal);
		const profile = this.#profile(session.profile);
		const transform = this.#deps.plugins.eventMapper({ sessionId, profile });
		return this.#deps.hubs.get(conversation.id, {
			speech: profile.speech,
			thinking: profile.thinkingEvents,
			...(transform === undefined ? {} : { transform }),
			observe: toolSpans(async () => (await currentTurnRecord(this.#deps.harness, conversation.id, BACKGROUND_CONTEXT))?.traceparent),
		});
	}

	/** Whether the session has an unsettled input, so its caller's credentials are still needed. */
	isWorking(conversationId: ConversationId): boolean {
		return this.#runs.isWorking(conversationId);
	}

	/** A plugin's JSON-RPC method. */
	pluginMethod(method: string) {
		return this.#deps.plugins.rpc(method);
	}

	/** The caller's session as a plugin sees it, for plugin JSON-RPC methods. */
	async pluginSession(plugin: AgentPlugin, principal: Principal, sessionId: string, context: Context): Promise<SessionContext> {
		const { conversation, session } = await this.#deps.store.require(principal, sessionId, context);
		this.#deps.credentials.set(conversation.id, principal);
		return this.#deps.plugins.sessionContext(plugin, conversation.id, session, context);
	}

	/** Final answer text of a settled input, for clients that want it in the response. */
	async answerText(conversationId: ConversationId, settled: SubmissionRecord): Promise<string | undefined> {
		if (settled.status !== "done" || settled.type !== "input") return undefined;
		const conversation = await this.#deps.harness.conversation(conversationId, BACKGROUND_CONTEXT);
		const entry = await conversation?.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
		return assistantText(entry?.model?.[0]);
	}

	#afterRun(conversationId: ConversationId, session: Readonly<SessionState>, submission: Submission, turnId: string): void {
		if (!this.#deps.plugins.plugins.some((plugin) => plugin.afterRun !== undefined)) return;
		void submission
			.wait(BACKGROUND_CONTEXT)
			.then(async (settled) => {
				const text = await this.answerText(conversationId, settled);
				this.#deps.plugins.afterRun(conversationId, session, {
					submissionId: settled.id,
					turnId,
					status: settled.status,
					...(settled.reason === undefined ? {} : { reason: settled.reason }),
					...(text === undefined ? {} : { text }),
					answeredBy: "model",
				});
			})
			.catch((error: unknown) => this.#deps.log.warn("plugin.after_run_failed", { error: String(error) }));
	}

	/** A skill's tools in the current catalog; `undefined` for a skill that no longer exists. */
	readonly #skillTools = (name: string): string[] | undefined => {
		const skill = this.#deps.skills.find((candidate) => candidate.name === name);
		return skill === undefined ? undefined : this.#deps.catalog.match(skill.tools);
	};

	#profile(name: string | undefined): Profile {
		if (name === undefined) return this.#deps.defaultProfile;
		const profile = this.#deps.profiles.get(name);
		if (profile === undefined) throw invalidParams(`unknown profile ${JSON.stringify(name)}`);
		return profile;
	}

	/** Text, or pi-ai user content blocks (text and base64 images). */
	#input(input: unknown): UserInput {
		const max = this.#deps.limits.maxInputChars;
		if (typeof input === "string") {
			if (input.trim().length === 0) throw invalidParams("input must not be empty");
			if (input.length > max) throw invalidParams(`input is longer than ${max} characters`);
			return input;
		}
		if (!Array.isArray(input) || input.length === 0) throw invalidParams("input must be a string or content blocks");
		let chars = 0;
		const blocks: Exclude<UserInput, string> = [];
		for (const block of input as unknown[]) {
			const value = block as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
			if (value.type === "text" && typeof value.text === "string") {
				chars += value.text.length;
				blocks.push({ type: "text", text: value.text });
			} else if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string") {
				blocks.push({ type: "image", data: value.data, mimeType: value.mimeType });
			} else {
				throw invalidParams("content blocks must be {type:'text',text} or {type:'image',data,mimeType}");
			}
		}
		if (chars > max) throw invalidParams(`input is longer than ${max} characters`);
		return blocks;
	}
}

/** A reserved run slot: `track` holds it until the submission settles, `release` frees it at once. Both are idempotent. */
type RunLease = { track(submission: Submission): void; release(): void };

/**
 * Concurrency limits in memory: per owner, the sessions with an unsettled input. A follow-up into a session that is
 * already working adds no concurrency, so it is never refused. A slot is reserved before any await, so concurrent
 * prompts cannot all pass the check before one of them is counted.
 */
class RunTracker {
	readonly #byOwner = new Map<string, Map<ConversationId, number>>();
	#total = 0;

	reserve(owner: string, conversationId: ConversationId, limits: LimitsConfig): RunLease {
		const sessions = this.#byOwner.get(owner) ?? new Map<ConversationId, number>();
		const pending = sessions.get(conversationId);
		if (pending === undefined) {
			if (sessions.size >= limits.maxConcurrentRunsPerUser) {
				throw rateLimited(`at most ${limits.maxConcurrentRunsPerUser} sessions per user may work at once`, 2);
			}
			if (this.#total >= limits.maxConcurrentRuns) throw rateLimited("the server is at capacity", 2);
			this.#total++;
		}
		sessions.set(conversationId, (pending ?? 0) + 1);
		this.#byOwner.set(owner, sessions);

		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			const left = (sessions.get(conversationId) ?? 1) - 1;
			if (left > 0) {
				sessions.set(conversationId, left);
				return;
			}
			sessions.delete(conversationId);
			this.#total--;
			if (sessions.size === 0 && this.#byOwner.get(owner) === sessions) this.#byOwner.delete(owner);
		};
		return {
			release,
			track: (submission) => {
				void submission.wait(BACKGROUND_CONTEXT).catch(() => undefined).finally(release);
			},
		};
	}

	isWorking(conversationId: ConversationId): boolean {
		for (const sessions of this.#byOwner.values()) if (sessions.has(conversationId)) return true;
		return false;
	}
}
