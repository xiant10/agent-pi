import type { JsonValue } from "@earendil-works/chord";
import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import type {
	ConversationId,
	Harness,
	JsonObject,
	ToolExecutionResult,
	ToolRegistration,
	UserInput,
} from "@earendil-works/pi-durable";
import type { Profile } from "../agent/profiles.ts";
import type { AuthRequest, Principal } from "../auth/authenticator.ts";
import type { AppConfig } from "../config.ts";
import type { ClientEventBody } from "../events/mapper.ts";
import type { McpServerConfig } from "../mcp/manager.ts";
import type { Skill } from "../skills/skills.ts";
import type { ToolCatalog } from "../tools/catalog.ts";
import type { Logger } from "../util/log.ts";
import type { Container } from "./container.ts";

type Awaitable<T> = T | Promise<T>;

/**
 * Business logic on top of the harness. Everything is optional; a plugin brings what it needs:
 *
 * - **Contributions**: system prompt sections, in-process tools, skills, MCP servers, JSON-RPC methods.
 * - **IoC**: `register()` rebinds core services (authenticator, storage, models) before they are built.
 * - **Session pipeline**: `authenticate` → `sessionCreated` → per input `beforePrompt` (may answer without the model)
 *   → model hooks → `afterRun` → `sessionClosed`; `mapEvent` shapes what clients receive.
 * - **Model hooks** run inside durable tasks, which replay after a crash: keep them deterministic, or use `ctx.memo()`.
 *
 * Plugins run in the order given; each hook sees the effect of earlier plugins.
 */
export type AgentPlugin = {
	/** Unique; names the plugin's durable extension (`plugin.<name>`), its state, and its in-process tools' server. */
	readonly name: string;

	/** Phase 1, before any service is built: rebind or decorate core services, bind your own. */
	register?(container: Container): Awaitable<void>;
	/** Phase 2, after every service is built and before the server listens or unfinished runs resume. */
	setup?(host: PluginHost): Awaitable<void>;
	/** On shutdown, in reverse order, after the server stopped accepting requests. */
	dispose?(): Awaitable<void>;

	/** System prompt sections, rendered after the configured `instructions` and before the skill index. */
	readonly instructions?: readonly PluginSection[];
	/**
	 * In-process tools. They join the tool catalog under server `<plugin name>`, so they are found like MCP tools: by
	 * skills (`<plugin>:<tool>`), `search_tools`, preloading, or a profile's `alwaysOnTools`.
	 */
	readonly tools?: readonly ToolRegistration[];
	readonly skills?: readonly Skill[];
	readonly mcpServers?: readonly McpServerConfig[];
	/** Extra JSON-RPC methods on the agent endpoint, such as `crm.sync`. Core method names cannot be replaced. */
	readonly rpc?: Readonly<Record<string, RpcHandler>>;

	/** After the credential is verified: map roles, check entitlement, or throw `AuthError` to reject. */
	authenticate?(principal: Principal, request: AuthRequest): Awaitable<Principal>;
	/** A new session: greet with `history.say()`, seed state, start a CRM interaction. Failures are logged; to refuse
	 * sessions, reject the caller in `authenticate`. */
	sessionCreated?(session: SessionContext): Awaitable<void>;
	/** Before the model sees user input. See `PromptDecision`. */
	beforePrompt?(turn: TurnContext): Awaitable<PromptDecision | undefined | void>;
	/** After a submission settles, whoever answered it: analytics, audit, CRM logging. Errors are logged, not raised. */
	afterRun?(run: RunContext): Awaitable<void>;
	sessionClosed?(session: SessionContext): Awaitable<void>;

	/** Before each model request: the messages for that request only (dynamic context, redaction). Not stored. */
	beforeModelRequest?(messages: readonly Message[], ctx: ModelHookContext): Awaitable<readonly Message[] | undefined | void>;
	/** Every terminal model response, before the harness acts on it: metrics, logging. */
	afterModelResponse?(message: AssistantMessage, ctx: ModelHookContext): Awaitable<void>;
	/** A final answer. `{ continue }` sends the model another user message instead of ending the run (guardrails). */
	onFinalAnswer?(answer: AssistantMessage, ctx: ModelHookContext): Awaitable<{ readonly continue: string } | undefined | void>;
	/** Before a tool runs: `{ block }` returns that text as the tool's error, `{ arguments }` replaces the arguments. */
	beforeToolCall?(
		call: ToolCall,
		ctx: ModelHookContext,
	): Awaitable<{ readonly block: string } | { readonly arguments: JsonObject } | undefined | void>;
	/** After a tool ran, before its result is stored: redact or reshape the result. */
	afterToolCall?(call: ToolCall, result: ToolExecutionResult, ctx: ModelHookContext): Awaitable<ToolExecutionResult | undefined | void>;

	/** Each client event: return it changed, several events, or `null` to drop it. Synchronous; runs per event. */
	mapEvent?(event: ClientEventBody, session: EventSession): ClientEventBody | readonly ClientEventBody[] | null | undefined;
};

/**
 * What a plugin decides about one input, before the model sees it. Plugins run in order; the first `reply` or `reject`
 * ends the chain.
 *
 * - `undefined`: pass the input on unchanged.
 * - `{ input?, activateTools? }`: pass on a rewritten input (redacted, normalized, enriched), and/or offer these tools
 *   (catalog patterns, like `crm:list_*`) from the first model request on, as deterministic routing.
 * - `{ reply }`: answer without the model. The input and the reply are written to the transcript, so the model sees
 *   both in later turns, and clients receive the reply like a model answer.
 * - `{ reject }`: refuse the input with 422; nothing is written.
 */
export type PromptDecision =
	| { readonly input?: UserInput; readonly note?: string; readonly activateTools?: readonly string[] }
	| { readonly reply: string }
	| { readonly reject: string; readonly code?: string };

/** A system prompt block. Keep `render` stable within a session: a changing section defeats prompt caching. */
export type PluginSection = {
	readonly name: string;
	readonly render: string | ((session: { readonly profile: Profile; readonly metadata?: JsonObject }) => string | undefined);
	/** Wrap in `<name>` tags. Default true. */
	readonly tag?: boolean;
};

/** One session, from a plugin's point of view. */
export type SessionContext = {
	readonly sessionId: string;
	readonly conversationId: ConversationId;
	readonly userId: string;
	/** From the credential's name claim, when it had one. */
	readonly userName?: string;
	readonly tenantId?: string;
	readonly profile: Profile;
	readonly metadata?: JsonObject;
	/**
	 * The newest verified caller. Absent for work resumed after a restart, and once the token expired or the idle session
	 * was not called for 30 minutes, until the user calls again.
	 */
	readonly principal: Principal | undefined;
	/** Write into the transcript without the model. */
	readonly history: SessionHistory;
	/** This plugin's own durable state in this session. */
	readonly state: PluginState;
	readonly log: Logger;
};

export type TurnContext = SessionContext & {
	readonly principal: Principal;
	/** The input as the previous plugin left it. */
	readonly input: UserInput;
	/** The input's text blocks, joined. */
	readonly text: string;
	/**
	 * What the client told the model about this turn, which nobody said and the transcript leaves out. Not in `input` or
	 * `text`, so it cannot trip a shortcut, but it reaches the model: a plugin that filters input should filter this too.
	 */
	readonly note?: string;
	readonly requestId?: string;
	/** The turn this input starts: the client's, else generated when the call arrived. Sent to the model gateway too. */
	readonly turnId: string;
};

export type RunContext = SessionContext & {
	/** Absent for a plugin reply written while the session was idle: no submission was needed. */
	readonly submissionId?: number;
	/** The turn the input started; the same id the model gateway saw for each model call of the run. */
	readonly turnId: string;
	readonly status: "done" | "unanswered";
	readonly reason?: string;
	/** The final answer's text, when there is one. */
	readonly text?: string;
	/** `model`, or the name of the plugin whose `beforePrompt` replied. */
	readonly answeredBy: string;
};

/** Context of model and tool hooks, which run inside durable tasks. */
export type ModelHookContext = {
	readonly conversationId: ConversationId;
	/** Absent in a child conversation, such as the one `consult_expert` runs. */
	readonly sessionId: string | undefined;
	readonly userId: string | undefined;
	readonly userName: string | undefined;
	readonly tenantId: string | undefined;
	/** The turn of the input being answered; undefined outside a session or when no run is active. */
	readonly turnId: string | undefined;
	readonly profile: Profile;
	readonly metadata: JsonObject | undefined;
	readonly principal: Principal | undefined;
	/** This plugin's state, read-only here: hooks may replay, so they must not write. */
	readonly state: { get<T extends JsonValue>(): Promise<T | undefined> };
	/** Compute once and store; a replay of the same task phase returns the stored value. */
	memo<T extends JsonValue>(name: string, compute: () => Awaitable<T>): Promise<T>;
	readonly log: Logger;
};

export type EventSession = { readonly sessionId: string; readonly profile: Profile };

export interface SessionHistory {
	/** An assistant message the model did not write (a greeting, a notice). Clients receive it like a model answer. */
	say(text: string): Promise<void>;
	/** A user turn and its answer, both without the model. */
	exchange(input: UserInput, answer: string): Promise<void>;
	/** A record for UIs, audits, and other plugins; the model never sees it. */
	record(type: string, data: JsonValue): Promise<void>;
}

export interface PluginState {
	get<T extends JsonValue>(): Promise<T | undefined>;
	set(value: JsonValue): Promise<void>;
}

export type RpcContext = {
	readonly principal: Principal;
	/** The caller's session named by `params.sessionId` or the session header; 404 when not theirs. */
	session(): Promise<SessionContext>;
	readonly log: Logger;
};

export type RpcHandler = (params: Readonly<Record<string, unknown>>, ctx: RpcContext) => Awaitable<unknown>;

/** What `setup()` receives: built services, and sessions for work that starts outside a request. */
export type PluginHost = {
	readonly container: Container;
	readonly config: AppConfig;
	readonly log: Logger;
	readonly harness: Harness;
	readonly catalog: ToolCatalog;
	/**
	 * A session by its conversation id, for tools (`api.conversationId`) and background jobs, such as a webhook that
	 * tells the user an order shipped with `history.say()`. Undefined for a conversation that is not a session.
	 */
	session(conversationId: ConversationId): Promise<SessionContext | undefined>;
};

export function definePlugin(plugin: AgentPlugin): AgentPlugin {
	return plugin;
}

/** Builds the plugin a config entry names, from its `options`. Throw to refuse bad options: startup fails with the entry's path. */
export type PluginFactory = (
	options: JsonObject,
	context: { /** A path relative to the config file. */ resolve(path: string): string },
) => AgentPlugin;

/** The plugins a runtime offers, by the name configs `use`. It stays in code: a config chooses among these, never a file to load. */
export type PluginCatalog = Readonly<Record<string, PluginFactory>>;
