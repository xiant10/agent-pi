import { readFileSync } from "node:fs";

/** The version of the agent contract in `contracts/agent/` this harness meets. 0 means it can still change. */
export const CONTRACT_VERSION = 0;

/** What `GET /v1/runtime` answers: what this harness is and what it supports. It holds no tenant data. */
export type RuntimeManifest = {
	readonly contract: number;
	readonly harness: string;
	readonly harness_version: string;
	readonly pool: string;
	readonly agent: string;
	readonly bundle?: string;
	readonly profiles: readonly string[];
	readonly capabilities: readonly string[];
	/** The model entries a tenant's customization may name, under the `tenant_config` capability. */
	readonly models: readonly string[];
	readonly builtin_tools: readonly string[];
	/** Plugin JSON-RPC methods, under the `plugin_methods` capability. */
	readonly methods: readonly string[];
};

const packageVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

/** Every session of this harness supports these. Only `durable_runs` depends on configuration. */
export function capabilitiesOf(storageKind: string, pluginMethods: readonly string[]): readonly string[] {
	return [
		"steer",
		"interrupt",
		"voice",
		"retry",
		"background_tasks",
		...(storageKind === "sqlite" ? ["durable_runs"] : []),
		...(pluginMethods.length > 0 ? ["plugin_methods"] : []),
	];
}

export function runtimeManifest(fields: {
	readonly agent: string;
	readonly bundle: string | undefined;
	readonly profiles: readonly string[];
	readonly capabilities: readonly string[];
	readonly models: readonly string[];
	readonly methods: readonly string[];
}): RuntimeManifest {
	return {
		contract: CONTRACT_VERSION,
		harness: "pi",
		harness_version: packageVersion,
		// A pi pool serves one agent under one name.
		pool: fields.agent,
		agent: fields.agent,
		...(fields.bundle === undefined || fields.bundle === "" ? {} : { bundle: fields.bundle }),
		profiles: fields.profiles,
		capabilities: fields.capabilities,
		models: fields.models,
		builtin_tools: [],
		methods: fields.methods,
	};
}
