import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject } from "@earendil-works/pi-durable";
import { Services } from "../plugins/services.ts";
import { definePlugin, type PluginHost } from "../plugins/types.ts";
import type { Skill } from "../skills/skills.ts";
import { executeDeterministicFlow, type ToolCallOutcome } from "./engine.ts";
import { FlowDoc, type FlowRunTrace, recordFlowTrace, type SkillFlow } from "./types.ts";

export type FlowRunnerOptions = {
	/** Optional explicit tool executor (for MCP or custom tools). */
	readonly callTool?: (
		name: string,
		args: Record<string, unknown>,
		session: { readonly sessionId: string; readonly tenantId?: string; readonly metadata?: JsonObject },
	) => Promise<ToolCallOutcome>;
};

function matchesTrigger(text: string, skill: Skill, flow: SkillFlow): boolean {
	const lowered = text.toLowerCase();
	const triggers = flow.triggerKeywords ?? skill.keywords;
	return triggers.some((kw) => kw.length > 0 && lowered.includes(kw.toLowerCase()));
}

/**
 * Built-in plugin that:
 * 1. Runs deterministic `flow.json` skills in `beforePrompt` when `callTool` is provided and input matches trigger keywords,
 *    cutting 4–5 serial LLM tool-calling turns down to 0 (when disambiguating via `ask_user`) or 1 (final synthesis).
 * 2. Tracks step-by-step tool progress in `FlowDoc` during model-driven tool calls so the UI graph updates live.
 */
export function flowRunner(options: FlowRunnerOptions = {}) {
	let host: PluginHost | undefined;
	return definePlugin({
		name: "flow-runner",
		setup(h) {
			host = h;
		},
		async beforePrompt(turn) {
			if (options.callTool === undefined || host === undefined) return undefined;
			// The turn's own skills, so one tenant's workflows never run for another, and a publish waits for the next turn.
			const skills = await (await host.container.get(Services.sessionSkills))(turn.conversationId, turn.tenantId);
			const matched = skills.find(
				(skill) =>
					skill.flow !== undefined &&
					skill.flow.mode === "deterministic" &&
					matchesTrigger(turn.text, skill, skill.flow),
			);
			if (matched?.flow === undefined) return undefined;

			const flow = matched.flow;
			const language = /[\u4e00-\u9fa5]/.test(turn.text) ? "zh" : "en";
			const conversation = await host.harness.conversation(turn.conversationId, BACKGROUND_CONTEXT);

			const saveTrace = async (trace: FlowRunTrace) => {
				if (conversation === undefined) return;
				await conversation.commit(
					async (tx) => {
						const current = await tx.doc(FlowDoc, turn.conversationId);
						recordFlowTrace(current, trace);
					},
					BACKGROUND_CONTEXT,
				);
			};

			const result = await executeDeterministicFlow(flow, {
				input: turn.text,
				language,
				callTool: (name, args) =>
					options.callTool!(name, args, {
						sessionId: turn.sessionId,
						...(turn.tenantId === undefined ? {} : { tenantId: turn.tenantId }),
						...(turn.metadata === undefined ? {} : { metadata: turn.metadata }),
					}),
				onUpdate: saveTrace,
			});

			if (result.status === "needs_input" && result.immediateReply !== undefined) {
				return { reply: result.immediateReply };
			}
			if (result.evidenceBlock !== undefined) {
				return {
					note: `${matched.body}\n\n${result.evidenceBlock}`,
					activateTools: matched.tools,
				};
			}
			return undefined;
		},
	});
}
