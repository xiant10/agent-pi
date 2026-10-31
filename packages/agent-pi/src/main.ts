/**
 * The shared runtime: one agent per process, chosen by `AGENT_CONFIG`, with the plugins of `agent-pi/plugins`. An app
 * with plugins of its own has its own entry point that calls `runAgent()` with a larger catalog.
 */
import { builtinPlugins } from "./plugins/library/index.ts";
import { runAgent } from "./run.ts";

await runAgent({ pluginCatalog: builtinPlugins });
