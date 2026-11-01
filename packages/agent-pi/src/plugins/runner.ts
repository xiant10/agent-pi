import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type ConversationId,
	defineExtension,
	type Extension,
	type GenerationHooks,
	GenerationTask,
	type Harness,
	type HookApi,
	type HookRegistration,
	hook,
	type PromptSection,
	section,
	type ToolHooks,
	ToolTask,
	type UserInput,
} from "@earendil-works/pi-durable";
import { readSession, type SessionState } from "../agent/docs.ts";
import type { Profile } from "../agent/profiles.ts";
import { type Authenticator, type AuthExtension, type Principal, withExtension } from "../auth/authenticator.ts";
import type { CredentialStore } from "../auth/credentials.ts";
import type { AppConfig } from "../config.ts";
import { AppError, RPC } from "../errors.ts";
import type { ClientEventBody } from "../events/mapper.ts";
import type { McpServerConfig } from "../mcp/manager.ts";
import type { Skill } from "../skills/skills.ts";
import type { CatalogEntry, ToolCatalog } from "../tools/catalog.ts";
import { type Logger, SILENT_LOGGER } from "../util/log.ts";
import type { Container } from "./container.ts";
import { workTurn } from "../identity.ts";
import { PluginStateDoc, pluginState, sessionHistory } from "./history.ts";
import type {
	AgentPlugin,
	EventSession,
	ModelHookContext,
	PluginHost,
	RpcHandler,
	RunContext,
	SessionContext,
} from "./types.ts";

const PLUGIN_NAME = /^[a-z][a-z0-9_-]*$/;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** What the runner needs once the harness is open. */
export type PluginRuntime = {
	readonly harness: Harness;
	readonly credentials: CredentialStore;
	readonly profile: (name: string | undefined) => Profile;
	readonly publicId: (conversationId: ConversationId) => string;
	readonly log: Logger;
};

/** How an input continues after `beforePrompt`. */
export type PromptOutcome =
	| { readonly kind: "model"; readonly input: UserInput; readonly note?: string | undefined; readonly activate: readonly string[] }
	| { readonly kind: "reply"; readonly input: UserInput; readonly text: string; readonly plugin: string };

/** Runs the plugins' hooks in order and turns their contributions into harness parts. */
export class PluginRunner {
	readonly plugins: readonly AgentPlugin[];
	#log: Logger = SILENT_LOGGER;
	readonly #rpc = new Map<string, { readonly plugin: AgentPlugin; readonly handler: RpcHandler }>();
	#runtime: PluginRuntime | undefined;

	constructor(plugins: readonly AgentPlugin[], reservedMethods: readonly string[]) {
		const names = new Set<string>();
		for (const plugin of plugins) {
			if (!PLUGIN_NAME.test(plugin.name)) throw new Error(`plugin name ${JSON.stringify(plugin.name)} must match ${PLUGIN_NAME}`);
			if (names.has(plugin.name)) throw new Error(`two plugins named ${plugin.name}`);
			names.add(plugin.name);
			for (const tool of plugin.tools ?? []) {
				if (!TOOL_NAME.test(tool.name)) throw new Error(`plugin ${plugin.name}: tool name ${JSON.stringify(tool.name)} must match ${TOOL_NAME}`);
			}
			for (const [method, handler] of Object.entries(plugin.rpc ?? {})) {
				if (reservedMethods.includes(method) || this.#rpc.has(method)) {
					throw new Error(`plugin ${plugin.name}: JSON-RPC method ${method} is already defined`);
				}
				this.#rpc.set(method, { plugin, handler });
			}
		}
		this.plugins = plugins;
	}

	get skills(): Skill[] {
		return this.plugins.flatMap((plugin) => plugin.skills ?? []);
	}

	get mcpServers(): McpServerConfig[] {
		return this.plugins.flatMap((plugin) => plugin.mcpServers ?? []);
	}

	/** Catalog entries of each plugin's in-process tools, keyed by plugin name. */
	toolEntries(): Map<string, CatalogEntry[]> {
		const byPlugin = new Map<string, CatalogEntry[]>();
		for (const plugin of this.plugins) {
			if (plugin.tools === undefined || plugin.tools.length === 0) continue;
			byPlugin.set(
				plugin.name,
				plugin.tools.map((tool) => ({
					name: tool.name,
					server: plugin.name,
					mcpName: tool.name,
					description: tool.description,
					inputSchema: tool.parameters as unknown as Record<string, unknown>,
				})),
			);
		}
		return byPlugin;
	}

	rpc(method: string): { readonly plugin: AgentPlugin; readonly handler: RpcHandler } | undefined {
		return this.#rpc.get(method);
	}

	async register(container: Container): Promise<void> {
		for (const plugin of this.plugins) await plugin.register?.(container);
	}

	/** `base`, then every plugin's `authenticate` in order. */
	authenticator(base: Authenticator): Authenticator {
		const hooks = this.plugins.filter((plugin) => plugin.authenticate !== undefined);
		if (hooks.length === 0) return base;
		const extension: AuthExtension = async (principal, request) => {
			let current = principal;
			for (const plugin of hooks) current = await plugin.authenticate!(current, request);
			return current;
		};
		return withExtension(base, extension);
	}

	/** One durable extension per plugin, installed between the configured instructions and the core extension. */
	extensions(profileOf: (name: string | undefined) => Profile, credentials: CredentialStore): Extension[] {
		return this.plugins.map((plugin) =>
			defineExtension({
				name: `plugin.${plugin.name}`,
				sections: (plugin.instructions ?? []).map((instruction) => pluginSection(instruction, profileOf)),
				tools: [...(plugin.tools ?? [])],
				hooks: this.#hooks(plugin, profileOf, credentials),
			}),
		);
	}

	/** Called once the harness is open, before `setup()`. */
	attach(runtime: PluginRuntime): void {
		this.#runtime = runtime;
		this.#log = runtime.log;
	}

	async setup(container: Container, config: AppConfig, catalog: ToolCatalog): Promise<void> {
		const runtime = this.#requireRuntime();
		for (const plugin of this.plugins) {
			const host: PluginHost = {
				container,
				config,
				log: this.#log,
				harness: runtime.harness,
				catalog,
				session: (conversationId) => this.session(plugin, conversationId, BACKGROUND_CONTEXT),
			};
			await plugin.setup?.(host);
		}
	}

	async dispose(): Promise<void> {
		for (const plugin of [...this.plugins].reverse()) {
			try {
				await plugin.dispose?.();
			} catch (error) {
				this.#log.warn("plugin.dispose_failed", { plugin: plugin.name, error: message(error) });
			}
		}
	}

	/** A session as `plugin` sees it; undefined when the conversation is not a session. */
	async session(plugin: AgentPlugin, conversationId: ConversationId, context: Context): Promise<SessionContext | undefined> {
		const session = await readSession(this.#requireRuntime().harness, conversationId, context);
		return session === undefined ? undefined : this.sessionContext(plugin, conversationId, session, context);
	}

	sessionContext(plugin: AgentPlugin, conversationId: ConversationId, session: Readonly<SessionState>, context: Context): SessionContext {
		const runtime = this.#requireRuntime();
		return {
			sessionId: runtime.publicId(conversationId),
			conversationId,
			userId: session.userId,
			...(session.userName === undefined ? {} : { userName: session.userName }),
			...(session.tenantId === undefined ? {} : { tenantId: session.tenantId }),
			profile: runtime.profile(session.profile),
			...(session.metadata === undefined ? {} : { metadata: session.metadata }),
			principal: runtime.credentials.get(conversationId),
			history: sessionHistory(runtime.harness, conversationId, plugin.name, context),
			state: pluginState(runtime.harness, conversationId, plugin.name, context),
			log: this.#log,
		};
	}

	/** Failures are logged: the session exists by now, and a failed greeting must not hide it from its client. */
	async sessionCreated(conversationId: ConversationId, session: Readonly<SessionState>, context: Context): Promise<void> {
		for (const plugin of this.plugins) {
			try {
				await plugin.sessionCreated?.(this.sessionContext(plugin, conversationId, session, context));
			} catch (error) {
				this.#log.warn("plugin.session_created_failed", { plugin: plugin.name, error: message(error) });
			}
		}
	}

	async sessionClosed(conversationId: ConversationId, session: Readonly<SessionState>, context: Context): Promise<void> {
		for (const plugin of this.plugins) {
			try {
				await plugin.sessionClosed?.(this.sessionContext(plugin, conversationId, session, context));
			} catch (error) {
				this.#log.warn("plugin.session_closed_failed", { plugin: plugin.name, error: message(error) });
			}
		}
	}

	/** Every plugin's `beforePrompt`, in order, until one replies or rejects. */
	async beforePrompt(
		conversationId: ConversationId,
		session: Readonly<SessionState>,
		principal: Principal,
		input: UserInput,
		note: string | undefined,
		requestId: string | undefined,
		turnId: string,
		context: Context,
	): Promise<PromptOutcome> {
		let current = input;
		let currentNote = note;
		const activate: string[] = [];
		for (const plugin of this.plugins) {
			if (plugin.beforePrompt === undefined) continue;
			const decision = await plugin.beforePrompt({
				...this.sessionContext(plugin, conversationId, session, context),
				principal,
				input: current,
				text: textOf(current),
				...(currentNote === undefined ? {} : { note: currentNote }),
				...(requestId === undefined ? {} : { requestId }),
				turnId,
			});
			if (decision === undefined || decision === null) continue;
			if ("reject" in decision) {
				throw new AppError(decision.code ?? "rejected", 422, RPC.rejected, decision.reject);
			}
			if ("reply" in decision) return { kind: "reply", input: current, text: decision.reply, plugin: plugin.name };
			if (decision.input !== undefined) current = decision.input;
			if (decision.note !== undefined) currentNote = decision.note;
			activate.push(...(decision.activateTools ?? []));
		}
		return { kind: "model", input: current, note: currentNote, activate };
	}

	/** Each plugin's `afterRun`, in the background; failures are logged. */
	afterRun(
		conversationId: ConversationId,
		session: Readonly<SessionState>,
		run: Omit<RunContext, keyof SessionContext>,
	): void {
		const hooks = this.plugins.filter((plugin) => plugin.afterRun !== undefined);
		if (hooks.length === 0) return;
		void (async () => {
			for (const plugin of hooks) {
				try {
					await plugin.afterRun!({ ...this.sessionContext(plugin, conversationId, session, BACKGROUND_CONTEXT), ...run });
				} catch (error) {
					this.#log.warn("plugin.after_run_failed", { plugin: plugin.name, error: message(error) });
				}
			}
		})();
	}

	/** The client event transform of a session, or undefined when no plugin maps events. */
	eventMapper(session: EventSession): ((event: ClientEventBody) => ClientEventBody[]) | undefined {
		const mappers = this.plugins.filter((plugin) => plugin.mapEvent !== undefined);
		if (mappers.length === 0) return undefined;
		return (event) => {
			let events = [event];
			for (const plugin of mappers) {
				events = events.flatMap((current) => {
					try {
						const mapped = plugin.mapEvent!(current, session);
						if (mapped === undefined) return [current];
						if (mapped === null) return [];
						return Array.isArray(mapped) ? [...mapped] : [mapped as ClientEventBody];
					} catch (error) {
						this.#log.warn("plugin.map_event_failed", { plugin: plugin.name, error: message(error) });
						return [current];
					}
				});
			}
			return events;
		};
	}

	#hooks(plugin: AgentPlugin, profileOf: (name: string | undefined) => Profile, credentials: CredentialStore): HookRegistration[] {
		const ctx = (api: HookApi, context: Context) => this.#hookContext(plugin, api, profileOf, credentials, context);
		const hooks: HookRegistration[] = [];
		const generation: Partial<GenerationHooks> = {};
		if (plugin.beforeModelRequest !== undefined) {
			generation.beforeRequest = async (request, api, context) => {
				const messages = await plugin.beforeModelRequest!(request.messages, await ctx(api, context));
				return messages === undefined ? undefined : { messages };
			};
		}
		if (plugin.afterModelResponse !== undefined) {
			generation.afterResponse = async (response, api, context) => plugin.afterModelResponse!(response, await ctx(api, context));
		}
		if (plugin.onFinalAnswer !== undefined) {
			generation.onYield = async (answer, api, context) => {
				const decision = await plugin.onFinalAnswer!(answer, await ctx(api, context));
				return decision === undefined ? undefined : { continue: decision.continue };
			};
		}
		if (Object.keys(generation).length > 0) hooks.push(hook(GenerationTask, generation));

		const tool: Partial<ToolHooks> = {};
		if (plugin.beforeToolCall !== undefined) {
			tool.beforeTool = async (call, api, context) => {
				const decision = await plugin.beforeToolCall!(call, await ctx(api, context));
				if (decision === undefined) return undefined;
				return "block" in decision ? { block: decision.block } : { arguments: decision.arguments };
			};
		}
		if (plugin.afterToolCall !== undefined) {
			tool.afterTool = async (call, result, api, context) =>
				(await plugin.afterToolCall!(call, result, await ctx(api, context))) ?? undefined;
		}
		if (Object.keys(tool).length > 0) hooks.push(hook(ToolTask, tool));
		return hooks;
	}

	async #hookContext(
		plugin: AgentPlugin,
		api: HookApi,
		profileOf: (name: string | undefined) => Profile,
		credentials: CredentialStore,
		context: Context,
	): Promise<ModelHookContext> {
		const session = await readSession(api, api.conversationId, context);
		return {
			conversationId: api.conversationId,
			sessionId: session !== undefined && this.#runtime !== undefined ? this.#runtime.publicId(api.conversationId) : undefined,
			userId: session?.userId,
			userName: session?.userName,
			tenantId: session?.tenantId,
			turnId: session === undefined ? undefined : (await workTurn(api, api.conversationId, session, context))?.turnId,
			profile: profileOf(session?.profile),
			metadata: session?.metadata,
			principal: credentials.get(api.conversationId),
			state: {
				get: async <T extends JsonValue>() =>
					(await api.snapshot(PluginStateDoc, api.conversationId, plugin.name, context))?.value as T | undefined,
			},
			memo: async <T extends JsonValue>(name: string, compute: () => T | Promise<T>) => {
				const key = `${plugin.name}:${name}`;
				const stored = await api.memo<T>(key, context);
				return stored !== undefined ? stored : api.memo<T>(key, await compute(), context);
			},
			log: this.#log,
		};
	}

	#requireRuntime(): PluginRuntime {
		if (this.#runtime === undefined) throw new Error("plugins are not attached to a harness yet");
		return this.#runtime;
	}
}

function pluginSection(
	instruction: NonNullable<AgentPlugin["instructions"]>[number],
	profileOf: (name: string | undefined) => Profile,
): PromptSection {
	const options = instruction.tag === undefined ? undefined : { tag: instruction.tag };
	const { render } = instruction;
	if (typeof render === "string") return section(instruction.name, () => render, options);
	return section(
		instruction.name,
		async (input, context) => {
			const session = await readSession(input.read, input.conversationId, context);
			return render({
				profile: profileOf(session?.profile),
				...(session?.metadata === undefined ? {} : { metadata: session.metadata }),
			});
		},
		options,
	);
}

export function textOf(content: UserInput): string {
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? block.text : "")).join(" ");
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
