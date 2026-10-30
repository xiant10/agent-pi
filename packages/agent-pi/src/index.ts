// Running
export { type RunningAgent, type StartOptions, startAgent } from "./app.ts";
export { type RunOptions, runAgent } from "./run.ts";
export { type AppConfig, loadConfig, loadDotEnv, type ProfileConfig } from "./config.ts";

// Plugins and IoC
export {
	type AgentPlugin,
	definePlugin,
	type EventSession,
	type ModelHookContext,
	type PluginHost,
	type PluginSection,
	type PluginState,
	type PromptDecision,
	type RpcContext,
	type RpcHandler,
	type RunContext,
	type SessionContext,
	type SessionHistory,
	type TurnContext,
} from "./plugins/types.ts";
export { Container, type Factory, type Token, token } from "./plugins/container.ts";
export { type ConfiguredModels, type McpTransportFactory, Services } from "./plugins/services.ts";
export { MessageEntry, RecordEntry } from "./plugins/history.ts";

// Building blocks plugins use
export type { Profile } from "./agent/profiles.ts";
export { createConfiguredModels, type ModelConfig } from "./agent/models.ts";
export { type CallContext, type CallIdentity, type IdentityHeaderResolver, GATEWAY_IDENTITY_HEADERS, type IdentityHeaderNames, IdentityRegistry } from "./identity.ts";
export { type Skill, discoverSkills, parseSkill } from "./skills/skills.ts";
export type { CatalogEntry, ToolCatalog } from "./tools/catalog.ts";
export type { ClientEventBody } from "./events/mapper.ts";
export type { McpServerConfig } from "./mcp/manager.ts";
export { AppError } from "./errors.ts";
export { createLogger, type Logger, SILENT_LOGGER } from "./util/log.ts";
export type { JsonValue } from "@earendil-works/chord";
export { Type } from "@earendil-works/pi-ai";
export {
	type ConversationId,
	defineTool,
	type JsonObject,
	type ToolExecutionResult,
	type ToolRegistration,
	type UserInput,
} from "@earendil-works/pi-durable";

// Auth
export { type Authenticator, AuthError, type AuthRequest, type Principal } from "./auth/authenticator.ts";
export { type JwtAlgorithm, JwtAuthenticator, type JwtConfig } from "./auth/jwt.ts";
export { StaticTokenAuthenticator } from "./auth/static-token.ts";
