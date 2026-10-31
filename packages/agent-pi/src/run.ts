import { fileURLToPath } from "node:url";
import { type RunningAgent, type StartOptions, startAgent } from "./app.ts";
import { type AppConfig, loadConfig, loadDotEnv } from "./config.ts";
import { setupTracing } from "./util/tracing.ts";

export type RunOptions = StartOptions & {
	/**
	 * The app's configuration: a config file (a path, or a URL such as `new URL("../config/agent.json", import.meta.url)`)
	 * or a built `AppConfig`. A file is replaced by `AGENT_CONFIG` when that is set, as in containers.
	 */
	readonly config: string | URL | AppConfig;
	/** Loaded into `process.env` before the config is read, when present. Default `AGENT_ENV_FILE`, else `.env`. */
	readonly envFile?: string;
};

/**
 * A process entry point: loads `.env` and the config, starts the agent, logs process failures as JSON lines, and
 * shuts down cleanly on SIGTERM and SIGINT, so unfinished runs resume on the next start.
 */
/** How long a failed process may drain before it exits regardless. */
const FAILURE_EXIT_MS = 10_000;

export async function runAgent(options: RunOptions): Promise<RunningAgent> {
	const { config, envFile, ...start } = options;
	loadDotEnv(envFile);
	const resolved =
		typeof config === "string" || config instanceof URL
			? loadConfig(process.env.AGENT_CONFIG ?? (config instanceof URL ? fileURLToPath(config) : config))
			: config;

	const log = (level: string, event: string, fields: Record<string, unknown> = {}) =>
		(level === "error" ? console.error : console.log)(JSON.stringify({ time: new Date().toISOString(), level, event, ...fields }));
	process.on("unhandledRejection", (reason) => {
		log("error", "process.unhandled_rejection", { error: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason) });
	});
	process.on("uncaughtException", (error) => {
		log("error", "process.uncaught_exception", { error: error.stack ?? error.message });
		process.exit(1);
	});

	const stopTracing = setupTracing();
	const agent = await startAgent(resolved, start);
	let stopping = false;
	const stop = (exitCode: number) => {
		if (stopping) return;
		stopping = true;
		agent.close().then(
			() => (stopTracing?.() ?? Promise.resolve()).finally(() => process.exit(exitCode)),
			(error: unknown) => {
				console.error(error);
				process.exit(1);
			},
		);
	};
	const onSignal = (signal: string) => {
		log("info", "agent.signal", { signal });
		stop(0);
	};
	process.once("SIGTERM", () => onSignal("SIGTERM"));
	process.once("SIGINT", () => onSignal("SIGINT"));
	// This process cannot serve again; exit so the supervisor starts one that reopens the storage.
	void agent.failed.then((error) => {
		log("error", "agent.failed", { error: error instanceof Error ? error.message : String(error) });
		setTimeout(() => process.exit(1), FAILURE_EXIT_MS).unref();
		stop(1);
	});
	return agent;
}
