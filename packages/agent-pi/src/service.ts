import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { Usage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	AgentDoc,
	AssistantEntry,
	type Conversation,
	ConversationBusy,
	type ConversationId,
	type EntryId,
	type Harness,
	type JsonObject,
	LiveDoc,
	type Submission,
	type SubmissionId,
	type SubmissionRecord,
	UsageDoc,
	type UserInput,
} from "@earendil-works/pi-durable";
import { assistantText } from "./agent/subagents.ts";
import { SessionDoc, type SessionState, ToolStateDoc } from "./agent/docs.ts";
import { TasksDoc, taskUsage, tokensSpent } from "./agent/tasks.ts";
import { pinnedTools, preloadTools, type Profile } from "./agent/profiles.ts";
import { parkedTasks } from "./agent/parked.ts";
import { ownerKey, type Principal } from "./auth/authenticator.ts";
import type { CredentialStore } from "./auth/credentials.ts";
import { type GrantBroker, GrantError, type StoredGrant } from "./auth/grants.ts";
import type { LimitsConfig } from "./config.ts";
import { AppError, invalidParams, RPC } from "./errors.ts";
import type { HubRegistry, SessionHub } from "./events/hub.ts";
import type { ClientEventBody } from "./events/mapper.ts";
import { recordedTurns, recordTurn, turnOfInput, workTurn } from "./identity.ts";
import { toolSpans } from "./events/tool-spans.ts";
import { appendReply, type ReplyRecord, ReplyRequestsDoc } from "./plugins/history.ts";
import { type PluginRunner, textOf } from "./plugins/runner.ts";
import type { AgentPlugin, SessionContext } from "./plugins/types.ts";
import type { RunTracker } from "./runs.ts";
import type { SessionChanges, SessionInfo, SessionPage, SessionStore } from "./sessions.ts";
import type { Skill } from "./skills/skills.ts";
import { activateTools, refreshSkills } from "./tools/activation.ts";
import { type TranscriptMessage, transcriptOf, withNote } from "./transcript.ts";
import type { ToolCatalog } from "./tools/catalog.ts";
import type { Logger } from "./util/log.ts";
import { startSpan, traceIdOf, type TraceSpan } from "./util/tracing.ts";

export type ServiceDeps = {
	readonly acknowledgement?: (input: string, sessionId: string, turnId: string, principal: Principal, signal: AbortSignal) => Promise<string>;
	readonly harness: Harness;
	readonly store: SessionStore;
	readonly catalog: ToolCatalog;
	readonly skills: readonly Skill[];
	readonly profiles: ReadonlyMap<string, Profile>;
	readonly defaultProfile: Profile;
	readonly credentials: CredentialStore;
	readonly grants?: GrantBroker;
	readonly hubs: HubRegistry;
	readonly plugins: PluginRunner;
	readonly runs: RunTracker;
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
	/**
	 * For the model on this turn, and left out of the transcript. A voice client says here that the reply is spoken, or
	 * what was heard of the last one, without either showing as something the person said.
	 */
	readonly note?: string;
};

export type TaskOptions = Pick<PromptOptions, "turnId" | "traceparent"> & {
	readonly profile?: string;
	readonly metadata?: JsonObject;
	/** Sees the task's session events. */
	readonly onEvent?: (event: ClientEventBody) => void;
	readonly signal: AbortSignal;
};

export type TaskOutcome = { readonly status: string; readonly reason?: string; readonly text?: string };

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
	/** Tasks parked after repeated crashes; the session stays busy until `retry` or `cancel`. */
	readonly parked: number;
	readonly activeTools: readonly string[];
	readonly usage: JsonObject;
	/** The session a child conversation works for. */
	readonly parent?: string;
	/** This session's newest child conversations, which `session.get` and the event stream can read. */
	readonly subagents: readonly string[];
	/** This session's background tasks. */
	readonly tasks: readonly SessionTask[];
	/** What background tasks spent. It is not in `usage`, unlike a foreground child's: add the two for the session's total. */
	readonly taskUsage: Usage;
};

export type SessionTask = {
	readonly taskId: string;
	readonly name: string;
	readonly status: string;
	/** The child's id, for `session.get` and the event stream. */
	readonly subagent?: string;
	readonly startedAt: number;
	readonly activeAt: number;
	readonly usage?: Usage;
};

/**
 * Everything a transport can do with sessions, each call checked against the caller's identity. Transports stay thin:
 * they parse, authenticate, call one method here, and frame the result.
 */
export class AgentService {
	readonly #deps: ServiceDeps;

	constructor(deps: ServiceDeps) {
		this.#deps = deps;
	}

	get skills(): readonly Skill[] {
		return this.#deps.skills;
	}

	async createSession(
		principal: Principal,
		options: { readonly profile?: string; readonly metadata?: JsonObject; readonly transient?: boolean; readonly requestKey?: string },
		context: Context,
	): Promise<SessionInfo> {
		const profile = this.#profile(options.profile);
		const { conversation, sessionId, existing } = await this.#deps.store.create(
			principal,
			profile,
			pinnedTools(profile, this.#deps.catalog),
			options.metadata,
			context,
			options.transient,
			options.requestKey,
		);
		this.#deps.credentials.set(conversation.id, principal);
		if (existing) {
			const earlier = await this.#deps.harness.snapshot(SessionDoc, conversation.id, context);
			if (earlier === undefined) throw new Error(`session ${sessionId} vanished`);
			return this.#deps.store.info(conversation.id, earlier);
		}
		this.#deps.log.info("session.created", { sessionId, owner: ownerKey(principal), profile: profile.name });
		const session = await this.#deps.harness.snapshot(SessionDoc, conversation.id, context);
		if (session === undefined) throw new Error(`session ${sessionId} vanished after creation`);
		await this.#deps.plugins.sessionCreated(conversation.id, session, context);
		return this.#deps.store.info(conversation.id, session);
	}

	async listSessions(
		principal: Principal,
		options: { readonly archived?: boolean; readonly limit?: number; readonly cursor?: number },
		context: Context,
	): Promise<SessionPage & { readonly sessions: readonly (SessionInfo & { readonly busy: boolean })[] }> {
		const { store, harness } = this.#deps;
		const page = await store.list(principal, options, context);
		const sessions = await Promise.all(
			page.sessions.map(async (info) => {
				const live = await harness.snapshot(LiveDoc, store.parseId(info.sessionId), context);
				return { ...info, busy: live?.run !== undefined };
			}),
		);
		return { ...page, sessions };
	}

	async updateSession(principal: Principal, sessionId: string, changes: SessionChanges, context: Context): Promise<SessionInfo> {
		const info = await this.#deps.store.update(principal, sessionId, changes, context);
		if (changes.archived === true) {
			// Out of the way means nothing still spending. Archived first, so nothing new starts while these stop.
			const conversation = await this.#deps.harness.conversation(this.#deps.store.parseId(sessionId), context);
			await conversation?.abort(context, { background: true });
		}
		return info;
	}

	/**
	 * A page of the transcript, oldest first, ending before the entry `before`. The first page is the newest. A session
	 * stays readable while archived, and tools' results are left out.
	 */
	async messages(
		principal: Principal,
		sessionId: string,
		options: { readonly before?: number; readonly limit: number },
		context: Context,
	): Promise<{ readonly messages: readonly TranscriptMessage[]; readonly nextCursor?: string }> {
		const { conversation } = await this.#deps.store.readable(principal, sessionId, context);
		const inputs = await this.#inputs(conversation.id, context);
		const query = { order: "descending" as const, ...(options.before === undefined ? {} : { maxEntryId: (options.before - 1) as EntryId }) };
		const messages: TranscriptMessage[] = [];
		let oldest = options.before;
		let cursor: Awaited<ReturnType<Conversation["entries"]>>["next"];
		// Most entries show nothing, so a page of entries can come up short.
		do {
			const page = await conversation.entries(query, options.limit, cursor, context);
			for (const entry of page.items) {
				oldest = entry.id;
				messages.unshift(...transcriptOf(entry, inputs));
			}
			cursor = page.next;
		} while (cursor !== undefined && messages.length < options.limit);
		return { messages, ...(cursor === undefined ? {} : { nextCursor: String(oldest) }) };
	}

	/** Tool payloads are fetched explicitly, only by the session owner, never included in the ordinary transcript. */
	async toolPayload(principal: Principal, sessionId: string, callId: unknown, context: Context): Promise<{ request?: unknown; response?: unknown }> {
		if (typeof callId !== "string" || callId.length === 0 || callId.length > 1000) throw invalidParams("callId must be a non-empty string");
		const { conversation } = await this.#deps.store.readable(principal, sessionId, context);
		let request: unknown;
		let response: unknown;
		let cursor: Awaited<ReturnType<Conversation["entries"]>>["next"];
		do {
			const page = await conversation.entries({ order: "descending" }, 100, cursor, context);
			for (const entry of page.items) {
				for (const message of entry.model ?? []) {
					if (message.role === "assistant" && Array.isArray(message.content)) {
						for (const block of message.content) {
							if (block.type === "toolCall" && block.id === callId && request === undefined) request = block;
						}
					}
					if (message.role === "toolResult" && message.toolCallId === callId && response === undefined) response = message;
				}
			}
			cursor = page.next;
		} while (cursor !== undefined && (request === undefined || response === undefined));
		if (request === undefined && response === undefined) throw new AppError("tool_not_found", 404, RPC.notFound, "tool payload not found");
		return { ...(request === undefined ? {} : { request }), ...(response === undefined ? {} : { response }) };
	}

	/** Which turn and request wrote each user entry. Turns are kept for the newest inputs only. */
	async #inputs(conversationId: ConversationId, context: Context): Promise<Map<number, { turnId: string; requestId?: string }>> {
		const inputs = new Map<number, { turnId: string; requestId?: string }>();
		for (const [id, turnId] of await recordedTurns(this.#deps.harness, conversationId, context)) {
			const submission = await this.#deps.harness.submission(id as SubmissionId, context);
			const record = await submission?.status(context);
			if (record?.entry === undefined) continue;
			inputs.set(record.entry, { turnId, ...(record.requestId === undefined ? {} : { requestId: record.requestId }) });
		}
		return inputs;
	}

	async getSession(principal: Principal, sessionId: string, context: Context): Promise<SessionDetails> {
		const { store } = this.#deps;
		const { conversation, session } = await store.readable(principal, sessionId, context);
		const [agent, live, usage, tasks] = await Promise.all([
			this.#deps.harness.snapshot(AgentDoc, conversation.id, context),
			this.#deps.harness.snapshot(LiveDoc, conversation.id, context),
			this.#deps.harness.snapshot(UsageDoc, conversation.id, context),
			this.#deps.harness.snapshot(TasksDoc, conversation.id, context),
		]);
		const spent = await taskUsage(this.#deps.harness, tasks ?? { tasks: [] }, context);
		return {
			...this.#deps.store.info(conversation.id, session),
			busy: live?.run !== undefined,
			parked: (await parkedTasks(this.#deps.harness, conversation.id, context)).length,
			activeTools: Array.isArray(agent?.tools) ? [...agent.tools] : [],
			usage: (usage ?? {}) as JsonObject,
			...(session.parent === undefined ? {} : { parent: store.publicId(session.parent as ConversationId) }),
			subagents: (session.subagents ?? []).map((id) => store.publicId(id as ConversationId)),
			tasks: (tasks?.tasks ?? []).map((task) => ({
				taskId: task.id,
				name: task.name,
				status: task.status,
				...(task.child === undefined ? {} : { subagent: store.publicId(task.child as ConversationId) }),
				startedAt: task.startedAt,
				activeAt: task.activeAt,
				...(spent.byTask.has(task.id) ? { usage: spent.byTask.get(task.id)! } : {}),
			})),
			taskUsage: spent.total,
		};
	}

	/** Each user request opens or extends the session's grant. Only a change needs writing down. */
	async #attachGrant(
		conversationId: ConversationId,
		session: Readonly<SessionState>,
		principal: Principal,
		context: Context,
		traceparent?: string,
	): Promise<void> {
		const grants = this.#deps.grants;
		if (grants === undefined) return;
		const stored =
			session.grantId === undefined
				? undefined
				: { grantId: session.grantId, ...(session.grantParent === undefined ? {} : { parent: session.grantParent }) };
		let grant: StoredGrant;
		try {
			grant = await grants.attach(conversationId, stored, principal, traceparent);
		} catch (error) {
			if (error instanceof GrantError && error.reason === "stopped") throw new AppError("grant_refused", 403, RPC.forbidden, error.message);
			throw new AppError("auth_unavailable", 503, RPC.internal, error instanceof Error ? error.message : String(error));
		}
		if (grant.grantId !== stored?.grantId) await this.#deps.store.setGrant(conversationId, grant, context);
	}

	/**
	 * One task in a session of its own, for callers that have no session to come back to: the answer, then the session
	 * closes. Aborting `signal` stops the run, since nobody could read its answer.
	 */
	async runTask(principal: Principal, input: unknown, options: TaskOptions, context: Context): Promise<TaskOutcome> {
		const { sessionId } = await this.createSession(
			principal,
			{ ...(options.profile === undefined ? {} : { profile: options.profile }), ...(options.metadata === undefined ? {} : { metadata: options.metadata }), transient: true },
			context,
		);
		const stop = () => void this.cancel(principal, sessionId, context).catch(() => undefined);
		const { onEvent, signal } = options;
		let unsubscribe: (() => void) | undefined;
		try {
			if (onEvent !== undefined) {
				const subscription = (await this.hub(principal, sessionId, context)).subscribe({ event: (event) => onEvent(event.body), end: () => undefined });
				unsubscribe = () => subscription.unsubscribe();
			}
			const admitted = await this.prompt(
				principal,
				sessionId,
				input,
				{ ...(options.turnId === undefined ? {} : { turnId: options.turnId }), ...(options.traceparent === undefined ? {} : { traceparent: options.traceparent }) },
				context,
			);
			if (admitted.kind === "reply") return { status: "done", text: admitted.text };
			signal.addEventListener("abort", stop, { once: true });
			if (signal.aborted) stop();
			const settled = await admitted.submission.wait(context);
			const text = await this.answerText(admitted.conversationId, settled);
			return {
				status: settled.status,
				...(settled.reason === undefined ? {} : { reason: settled.reason }),
				...(text === undefined ? {} : { text }),
			};
		} finally {
			signal.removeEventListener("abort", stop);
			unsubscribe?.();
			await this.close(principal, sessionId, context).catch((error: unknown) =>
				this.#deps.log.warn("task.close_failed", { sessionId, error: String(error) }),
			);
		}
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
		this.#admissible(session, options.note);
		const profile = this.#profile(session.profile);
		this.#deps.credentials.set(conversation.id, principal);
		await this.#attachGrant(conversation.id, session, principal, context, options.traceparent);
		const lease = this.#deps.runs.reserve(ownerKey(principal), conversation.id, this.#deps.limits);
		let admitted: Admitted;
		try {
			await this.#attended(conversation, context);
			admitted = await this.#admit(conversation, session, principal, profile, sessionId, content, options, context);
			if (admitted.kind === "run") lease.track(admitted.submission);
			else lease.release();
		} catch (error) {
			lease.release();
			if (error instanceof ConversationBusy) throw new AppError("busy", 409, RPC.busy, "session is busy");
			throw error;
		}
		// Only the order of the session list. The input is in, so a failure here must not read as its failure.
		await this.#deps.store.touch(principal, conversation.id, context).catch((error: unknown) => {
			this.#deps.log.warn("session.touch_failed", { sessionId, error: String(error) });
		});
		return admitted;
	}

	/** Why this session cannot take this input, if it can't. Checked before anything is stopped to make way for it. */
	#admissible(session: Readonly<SessionState>, note: string | undefined): void {
		if (note !== undefined && note.length > this.#deps.limits.maxInputChars) {
			throw invalidParams(`note is longer than ${this.#deps.limits.maxInputChars} characters`);
		}
		if (session.archived === true) throw new AppError("session_archived", 409, RPC.rejected, "session is archived; restore it first");
	}

	/** Someone is here, so the session's background tasks may wake it again, and idle ones can be answered. */
	async #attended(conversation: Conversation, context: Context): Promise<void> {
		const tasks = await this.#deps.harness.snapshot(TasksDoc, conversation.id, context);
		if (tasks === undefined || tasks.nextId === 1) return;
		const attendedTokens = await tokensSpent(this.#deps.harness, conversation.id, tasks, context);
		await conversation.commit(async (tx) => {
			const state = await tx.doc(TasksDoc, conversation.id);
			Object.assign(state, { unattended: 0, attendedTokens });
			for (const task of state.tasks) if (task.status !== "working" && task.heardAt === undefined) task.heardAt = Date.now();
		}, context);
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
				? ({ kind: "model", input: content, note: options.note, activate: [] } as const)
				: await this.#deps.plugins.beforePrompt(conversation.id, session, principal, content, options.note, requestId, turnId, context);
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
		const { input: submitted, note } = outcome;

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
					content: note === undefined ? submitted : withNote(submitted, note),
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
			if (earlier === undefined && placement === "placed" && this.#deps.acknowledgement !== undefined) {
				const abort = new AbortController();
				const timeout = setTimeout(() => abort.abort(), 5000);
				timeout.unref();
				void submission.wait(BACKGROUND_CONTEXT).then(() => abort.abort(), () => abort.abort());
				void this.#deps.acknowledgement(textOf(submitted), sessionId, turn, principal, abort.signal).then(async text => {
					if (abort.signal.aborted) return;
					const hub = await this.hub(principal, sessionId, BACKGROUND_CONTEXT);
					if (!abort.signal.aborted) hub.acknowledge(submission.id, text);
				}).catch(() => undefined).finally(() => clearTimeout(timeout));
			}
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
		ids: Pick<PromptOptions, "requestId" | "turnId" | "traceparent" | "duringTools" | "note">,
		context: Context,
	): Promise<Admitted | undefined> {
		const { requestId, turnId, traceparent, note } = ids;
		const prompted = {
			...(requestId === undefined ? {} : { requestId }),
			...(turnId === undefined ? {} : { turnId }),
			...(traceparent === undefined ? {} : { traceparent }),
			...(note === undefined ? {} : { note }),
		};
		if (input !== undefined) this.#input(input);
		const { conversation, session } = await this.#deps.store.require(principal, sessionId, context);
		if (input !== undefined) this.#admissible(session, note);
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

	/** Stop the run. Background tasks go on, unless `tasks` says to end them too. */
	async cancel(principal: Principal, sessionId: string, context: Context, options: { readonly tasks?: boolean } = {}): Promise<void> {
		const { conversation } = await this.#deps.store.require(principal, sessionId, context);
		await conversation.abort(context, { background: options.tasks === true });
	}

	/** Run the session's tasks the crash-loop guard parked again. Each may be cut off `restartLimit` more times. */
	async retry(principal: Principal, sessionId: string, context: Context): Promise<number> {
		const { conversation } = await this.#deps.store.require(principal, sessionId, context);
		const parked = await parkedTasks(this.#deps.harness, conversation.id, context);
		for (const id of parked) await this.#deps.harness.retryTask(id, context);
		this.#deps.log.info("session.retried", { sessionId, tasks: parked });
		return parked.length;
	}

	async close(principal: Principal, sessionId: string, context: Context): Promise<void> {
		const { conversation, session } = await this.#deps.store.require(principal, sessionId, context);
		// Closed first, so a prompt arriving while the run aborts and plugins clean up is refused, not started.
		await this.#deps.store.markClosed(principal, conversation.id, context);
		await conversation.abort(context, { background: true });
		await this.#deps.plugins.sessionClosed(conversation.id, session, context);
		await this.#deps.hubs.stop(conversation.id);
		this.#deps.credentials.delete(conversation.id);
		await this.#deps.grants?.close(conversation.id);
		this.#deps.log.info("session.closed", { sessionId, owner: ownerKey(principal) });
	}

	/** The session's event hub, after the ownership check. */
	async hub(principal: Principal, sessionId: string, context: Context): Promise<SessionHub> {
		const { conversation, session } = await this.#deps.store.readable(principal, sessionId, context);
		const child = session.parent !== undefined;
		if (!child) this.#deps.credentials.set(conversation.id, principal);
		// A hub can only watch a document that exists, and this one may not until the first task.
		if (!child && (await this.#deps.harness.snapshot(TasksDoc, conversation.id, context)) === undefined) {
			await conversation.commit(async (tx) => {
				await tx.doc(TasksDoc, conversation.id);
			}, context);
		}
		const profile = this.#profile(session.profile);
		const transform = this.#deps.plugins.eventMapper({ sessionId, profile });
		const currentWork = async () => {
			// Read each time: a child's turn changes with each `task_send`.
			const current = await this.#deps.harness.snapshot(SessionDoc, conversation.id, BACKGROUND_CONTEXT);
			return workTurn(this.#deps.harness, conversation.id, current, BACKGROUND_CONTEXT);
		};
		return this.#deps.hubs.get(conversation.id, {
			generatedProgress: this.#deps.acknowledgement !== undefined,
			speech: profile.speech && !child,
			thinking: profile.thinkingEvents,
			...(transform === undefined ? {} : { transform }),
			turn: async (input) => {
				// A child's inputs have no turn of their own; its work belongs to its parent's.
				if (!child) return turnOfInput(this.#deps.harness, conversation.id, input, BACKGROUND_CONTEXT);
				return (await currentWork())?.turnId;
			},
			observe: toolSpans(async () => (await currentWork())?.traceparent),
		});
	}

	/** Whether the session has an unsettled input, so its caller's credentials are still needed. */
	isWorking(conversationId: ConversationId): boolean {
		return this.#deps.runs.isWorking(conversationId);
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

	/** A background task started a run. Plugins see it as they see a prompted one; a crash can show it to them twice. */
	woken(conversationId: ConversationId, session: Readonly<SessionState>, submission: Submission, turnId: string): void {
		this.#afterRun(conversationId, session, submission, turnId);
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
