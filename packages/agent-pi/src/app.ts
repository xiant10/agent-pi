import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createRegistry,
	defineExtension,
	Harness,
	type HarnessSettings,
	type ModelRef,
	MemoryStorage,
	type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { coreExtension, instructionsExtension } from "./agent/core-extension.ts";
import { createConfiguredModels } from "./agent/models.ts";
import type { Profile } from "./agent/profiles.ts";
import { parkedTasks } from "./agent/parked.ts";
import type { Authenticator } from "./auth/authenticator.ts";
import { CredentialStore } from "./auth/credentials.ts";
import { JwtAuthenticator } from "./auth/jwt.ts";
import { StaticTokenAuthenticator } from "./auth/static-token.ts";
import type { AppConfig } from "./config.ts";
import { HubRegistry } from "./events/hub.ts";
import { defaultTransport, McpManager } from "./mcp/manager.ts";
import { Container } from "./plugins/container.ts";
import { IdentityRegistry, identityExtension } from "./identity.ts";
import { PluginRunner } from "./plugins/runner.ts";
import { type ConfiguredModels, type McpTransportFactory, Services } from "./plugins/services.ts";
import type { AgentPlugin } from "./plugins/types.ts";
import { AgentService } from "./service.ts";
import { resolveInstanceId, SessionStore } from "./sessions.ts";
import { discoverSkills, type Skill } from "./skills/skills.ts";
import { ToolCatalog } from "./tools/catalog.ts";
import { mcpExtension, mcpExtensionName } from "./tools/mcp-extension.ts";
import { createHttpServer } from "./transport/http.ts";
import { CORE_METHODS } from "./transport/streamable-http.ts";
import { createLogger, type Logger } from "./util/log.ts";

/** A session's caller credentials are dropped after this long without a request, unless it is working. */
const CREDENTIAL_IDLE_MS = 30 * 60_000;

export type StartOptions = {
	/** Business logic, in order. See `AgentPlugin`. */
	readonly plugins?: readonly AgentPlugin[];
	/**
	 * Shorthands for binding core services before plugins register (tests, small hosts). A plugin's `register()` can
	 * bind the same services through `Services` tokens.
	 */
	readonly log?: Logger;
	readonly models?: ConfiguredModels;
	readonly storage?: Storage;
	readonly authenticator?: Authenticator;
	readonly mcpTransport?: McpTransportFactory;
	/** How long startup waits for MCP servers' first connection attempts. Default 10 s. */
	readonly mcpStartupWaitMs?: number;
};

export type RunningAgent = {
	readonly port: number;
	readonly server: Server;
	readonly harness: Harness;
	readonly service: AgentService;
	readonly catalog: ToolCatalog;
	readonly container: Container;
	readonly instanceId: string;
	/**
	 * Settles, with the cause, if durable fails: after a storage error every call rejects until a new process opens the
	 * storage, so a host should `close()` and exit. Never rejects, and stays pending otherwise.
	 */
	readonly failed: Promise<unknown>;
	/** Stop accepting, end streams, finish commits, close MCP and storage. Unfinished runs resume on the next start. */
	close(): Promise<void>;
};

/**
 * The composition root. Core services are bound in a container, plugins rebind them (`register`), the harness is built
 * from the result with one durable extension per plugin, plugins get the built services (`setup`), then unfinished runs
 * resume and the server listens.
 */
export async function startAgent(config: AppConfig, options: StartOptions = {}): Promise<RunningAgent> {
	const context = BACKGROUND_CONTEXT;
	const container = new Container();
	bindDefaults(container, config, options);
	const plugins = new PluginRunner(options.plugins ?? [], CORE_METHODS);
	await plugins.register(container);

	const log = await container.get(Services.log);
	const profiles = await container.get(Services.profiles);
	const defaultProfile = profiles.get(config.defaultProfile);
	if (defaultProfile === undefined) throw new Error(`defaultProfile ${config.defaultProfile} is not a profile`);
	const profileOf = (name: string | undefined) => (name === undefined ? undefined : profiles.get(name)) ?? defaultProfile;
	const skills = uniqueSkills([...(await container.get(Services.skills)), ...plugins.skills]);

	const catalog = new ToolCatalog();
	container.value(Services.catalog, catalog);
	const credentials = new CredentialStore();
	const mcpServers = [...config.mcpServers, ...plugins.mcpServers];
	const pluginServers = new Set(plugins.plugins.map((plugin) => plugin.name));
	for (const server of mcpServers) {
		if (pluginServers.has(server.name)) throw new Error(`MCP server ${server.name} has the name of a plugin`);
	}
	const mcp = new McpManager(mcpServers, { catalog, log, createTransport: await container.get(Services.mcpTransport) });

	// Extension order is prompt order: configured instructions, plugin sections, then the skill index and profile.
	const identity = await container.get(Services.identity);
	const registry = createRegistry();
	registry.install(instructionsExtension(config.instructions));
	for (const extension of plugins.extensions(profileOf, credentials)) registry.install(extension);
	registry.install(coreExtension({ skills, profiles, defaultProfile, profileOf, catalog, credentials, identity }));
	registry.install(identityExtension(identity, (id) => store.publicId(id), credentials));
	// A server's tools enter the registry as one extension, replaced in place when the server re-lists its tools.
	// Plugins' in-process tools are catalogued too, so skills and search find them, but their extension holds the code.
	catalog.onChange((server) => {
		if (pluginServers.has(server)) return;
		const entries = catalog.entries(server);
		if (entries.length === 0) registry.uninstall(defineExtension({ name: mcpExtensionName(server) }));
		else registry.install(mcpExtension(server, entries, mcp, credentials));
	});
	for (const [plugin, entries] of plugins.toolEntries()) {
		const conflicts = catalog.setServer(plugin, entries);
		if (conflicts.length > 0) throw new Error(`plugin ${plugin}: tool names already taken: ${conflicts.join(", ")}`);
	}

	const storage = await container.get(Services.storage);
	const settings: HarnessSettings = {
		stream: config.durable.stream,
		retry: config.durable.retry,
		compaction: config.durable.compaction,
		...(config.durable.restartLimit === undefined ? {} : { restartLimit: config.durable.restartLimit }),
	};
	const failure = Promise.withResolvers<unknown>();
	let failed = false;
	const { models } = await container.get(Services.models);
	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			settings,
			onReport: (error, info) => {
				const message = error instanceof Error ? error.message : String(error);
				if (info.type === "session_failed") {
					failed = true;
					log.error("durable.session_failed", { error: message });
					failure.resolve(error);
				} else if (info.type === "task_parked") {
					log.error("durable.task_parked", { error: message, ...info.task });
				} else {
					log.warn("durable.report", { type: info.type, error: message });
				}
			},
		},
		context,
	);
	container.value(Services.harness, harness);

	const instanceId = await resolveInstanceId(harness, config.instanceId, context);
	const store = new SessionStore(harness, instanceId, config.limits.maxSessionsPerUser);
	const hubs = new HubRegistry(harness, {}, log);
	plugins.attach({ harness, credentials, profile: profileOf, publicId: (id) => store.publicId(id), log });
	const service = new AgentService({
		harness,
		store,
		catalog,
		skills,
		profiles,
		defaultProfile,
		credentials,
		hubs,
		plugins,
		limits: config.limits,
		log,
	});

	await plugins.setup(container, config, catalog);
	// Continue runs the previous process left unfinished, now that plugin hooks have their services.
	harness.resume();
	// Durable reports a task once, when it parks it; one parked by an earlier process would otherwise go unnoticed.
	const parked = await parkedTasks(harness, undefined, context);
	if (parked.length > 0) log.error("durable.tasks_parked", { tasks: parked });
	// Sessions created right after startup should see the tools of every reachable server; slow servers join later.
	await mcp.start(options.mcpStartupWaitMs ?? 10_000);

	const authenticator = plugins.authenticator(await container.get(Services.authenticator));
	let closing = false;
	const server = createHttpServer({
		authenticator,
		service,
		log,
		path: config.http.path,
		allowedOrigins: config.http.allowedOrigins,
		keepAliveMs: config.http.keepAliveMs,
		maxBodyBytes: config.limits.maxBodyBytes,
		readiness: () => ({ ready: !closing && !failed, detail: { instanceId, tools: catalog.size, mcp: mcp.status() } }),
	});
	// Tokens of sessions nobody has called for a while leave memory; a working session keeps its caller's token.
	const credentialSweep = setInterval(() => credentials.sweep(CREDENTIAL_IDLE_MS, (id) => service.isWorking(id)), 60_000);
	credentialSweep.unref();
	await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
	const port = (server.address() as AddressInfo).port;
	log.info("agent.started", {
		port,
		instanceId,
		tools: catalog.size,
		skills: skills.length,
		profiles: [...profiles.keys()],
		plugins: plugins.plugins.map((plugin) => plugin.name),
	});

	return {
		port,
		server,
		harness,
		service,
		catalog,
		container,
		instanceId,
		failed: failure.promise,
		close: async () => {
			if (closing) return;
			closing = true;
			clearInterval(credentialSweep);
			const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
			// Ending streams lets clients reconnect elsewhere at once instead of waiting for a timeout.
			await hubs.stopAll();
			server.closeIdleConnections();
			setTimeout(() => server.closeAllConnections(), 5_000).unref();
			await stopped;
			await plugins.dispose();
			await mcp.close();
			await harness.close(context);
			log.info("agent.stopped", { instanceId });
		},
	};
}

function bindDefaults(container: Container, config: AppConfig, options: StartOptions): void {
	container.value(Services.config, config);
	container.bind(Services.log, () => options.log ?? createLogger(config.logLevel));
	container.bind(Services.models, async (c) => options.models ?? createConfiguredModels(config.models, await c.get(Services.identity), await c.get(Services.identityHeaders)));
	container.value(Services.identity, new IdentityRegistry());
	container.value(Services.identityHeaders, undefined);
	container.bind(Services.profiles, async (c) => buildProfiles(config, (await c.get(Services.models)).refs));
	container.bind(Services.skills, () => (config.skillsDir === undefined ? [] : discoverSkills(config.skillsDir)));
	container.bind(Services.storage, () => options.storage ?? openStorage(config));
	container.bind(Services.authenticator, () => options.authenticator ?? configuredAuthenticator(config));
	container.bind(Services.mcpTransport, () => options.mcpTransport ?? defaultTransport);
}

function buildProfiles(config: AppConfig, refs: ReadonlyMap<string, ModelRef>): Map<string, Profile> {
	const ref = (name: string) => {
		const model = refs.get(name);
		if (model === undefined) throw new Error(`model ${name} is not configured`);
		return model;
	};
	const profiles = new Map<string, Profile>();
	for (const [name, profile] of Object.entries(config.profiles)) {
		profiles.set(name, {
			name,
			model: ref(profile.model),
			thinkingLevel: profile.thinkingLevel,
			...(profile.instructions === undefined ? {} : { instructions: profile.instructions }),
			alwaysOnTools: profile.alwaysOnTools,
			maxActiveTools: profile.maxActiveTools,
			preload: profile.preload,
			speech: profile.speech,
			thinkingEvents: profile.thinkingEvents,
			...(profile.expert === undefined
				? {}
				: { expert: { model: ref(profile.expert.model), thinkingLevel: profile.expert.thinkingLevel } }),
		});
	}
	return profiles;
}

function uniqueSkills(skills: readonly Skill[]): Skill[] {
	const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
	for (let i = 1; i < sorted.length; i++) {
		if (sorted[i]!.name === sorted[i - 1]!.name) throw new Error(`two skills named ${sorted[i]!.name}`);
	}
	return sorted;
}

function configuredAuthenticator(config: AppConfig): Authenticator {
	const auth = config.auth;
	if (auth.kind === "static") return StaticTokenAuthenticator.fromJson(auth.tokens, "auth.tokens");
	const { kind: _kind, ...jwt } = auth;
	return new JwtAuthenticator(jwt);
}

async function openStorage(config: AppConfig): Promise<Storage> {
	if (config.storage.kind === "memory") return new MemoryStorage();
	mkdirSync(dirname(config.storage.path), { recursive: true });
	return openNodeSqliteStorage(config.storage.path);
}
