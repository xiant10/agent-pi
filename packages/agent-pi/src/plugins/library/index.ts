/** Ready-made plugins for agent-pi apps. Optional: the harness never loads them on its own. */
import type { JsonObject } from "@earendil-works/pi-durable";
import type { PluginCatalog } from "../types.ts";
import { audit } from "./audit.ts";
import { clock } from "./clock.ts";
import { guardrails } from "./guardrails.ts";
import { shortcuts } from "./shortcuts.ts";

export { audit, clock, guardrails, shortcuts };
export type { Faq } from "./shortcuts.ts";

function text(options: JsonObject, name: string): string {
	const value = options[name];
	if (typeof value !== "string" || value.length === 0) throw new Error(`option ${name} must be a non-empty string`);
	return value;
}

/** The library by the names configs `use`. An app with plugins of its own extends it: `{ ...builtinPlugins, orders }`. */
export const builtinPlugins: PluginCatalog = {
	audit: () => audit,
	clock: (options) => clock({ timeZone: text(options, "timeZone") }),
	guardrails: () => guardrails,
	shortcuts: (options, { resolve }) =>
		shortcuts({ faqFile: resolve(text(options, "faqFile")), assistantName: text(options, "assistantName") }),
};
