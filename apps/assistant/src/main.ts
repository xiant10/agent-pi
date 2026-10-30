/**
 * The assistant's entry point: the agent-pi harness with this product's configuration (models, profiles, prompts,
 * skills, MCP servers in `config/agent.json`) and business plugins. Run `node apps/assistant/src/main.ts`.
 */
import { runAgent } from "agent-pi";
import { plugins } from "./plugins/index.ts";

await runAgent({ config: new URL("../config/agent.json", import.meta.url), plugins });
