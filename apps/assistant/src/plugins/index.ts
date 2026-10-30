import type { AgentPlugin } from "agent-pi";
import { audit } from "./audit.ts";
import { clock } from "./clock.ts";
import { guardrails } from "./guardrails.ts";
import { shortcuts } from "./shortcuts.ts";

/** In order: redaction first, so every later plugin and the model see redacted input. */
export const plugins: readonly AgentPlugin[] = [
	guardrails,
	shortcuts({ faqFile: new URL("../../content/faq.json", import.meta.url), assistantName: "Ava" }),
	clock({ timeZone: process.env.BUSINESS_TIME_ZONE ?? "Asia/Shanghai" }),
	audit,
];
