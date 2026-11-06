import type { Models } from "@earendil-works/pi-ai/models";
import type { Harness, ModelRef, Storage } from "@earendil-works/pi-durable";
import type { McpTransport } from "@earendil-works/pi-mcp";
import type { Profile } from "../agent/profiles.ts";
import type { Authenticator } from "../auth/authenticator.ts";
import type { AppConfig } from "../config.ts";
import type { McpServerConfig } from "../mcp/manager.ts";
import type { Skill } from "../skills/skills.ts";
import type { SessionSkills, SkillsFor } from "../skills/tenant.ts";
import type { ToolCatalog } from "../tools/catalog.ts";
import type { IdentityHeaderResolver, IdentityRegistry } from "../identity.ts";
import type { Logger } from "../util/log.ts";
import { token } from "./container.ts";

export type ConfiguredModels = { readonly models: Models; readonly refs: ReadonlyMap<string, ModelRef> };

export type McpTransportFactory = (config: McpServerConfig, headers: Readonly<Record<string, string>>) => McpTransport;

/**
 * Core services in the container. The ones bound before plugins register can be rebound or decorated in a plugin's
 * `register()`; `catalog` and `harness` are bound as they are built, for `setup()` to use.
 */
export const Services = {
	config: token<AppConfig>("config"),
	log: token<Logger>("log"),
	/** Who each generating conversation is for; model providers with `identityHeaders` read it. */
	identity: token<IdentityRegistry>("identity"),
	/**
	 * Optional: computes extra or renamed identity headers per model call, merged over the models' `identityHeaders`.
	 * Bind in a plugin's `register()`; default none.
	 */
	identityHeaders: token<IdentityHeaderResolver | undefined>("identityHeaders"),
	/** pi-ai models and the `ModelRef` of each configured name; default: from `config.models`. */
	models: token<ConfiguredModels>("models"),
	/** Session kinds by name; default: from `config.profiles`, resolved against `models`. */
	profiles: token<ReadonlyMap<string, Profile>>("profiles"),
	/** Default: discovered in `config.skillsDir`. Plugins' `skills` are added to these. */
	skills: token<readonly Skill[]>("skills"),
	/** The skills one tenant sees: `skills` with its published overrides and own skills. Bound once skills are known. */
	skillsFor: token<SkillsFor>("skillsFor"),
	/** The skills a session's current turn started with; what prompts, `load_skill` and flows use. */
	sessionSkills: token<SessionSkills>("sessionSkills"),
	/** Default: from `config.storage`. */
	storage: token<Storage>("storage"),
	/** Default: from `config.auth`. Plugins' `authenticate` hooks run after it. */
	authenticator: token<Authenticator>("authenticator"),
	mcpTransport: token<McpTransportFactory>("mcpTransport"),
	catalog: token<ToolCatalog>("catalog"),
	harness: token<Harness>("harness"),
} as const;
