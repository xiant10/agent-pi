import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	defineExtension,
	defineTool,
	type Extension,
	GenerationTask,
	type Harness,
	hook,
	type PromptSection,
	section,
	type Submission,
	type ToolExecutionApi,
	type ToolRegistration,
	ToolTask,
} from "@earendil-works/pi-durable";
import type { LimitsConfig } from "../config.ts";
import { executeDeterministicFlow, type ToolCallOutcome } from "../flow/engine.ts";
import { FlowDoc, type FlowRunTrace, type FlowStepTrace, recordFlowTrace } from "../flow/types.ts";
import type { RunTracker } from "../runs.ts";
import { readSkillFile, renderSkillIndex, type Skill } from "../skills/skills.ts";
import type { SessionSkills } from "../skills/tenant.ts";
import { activateSkill, activateTools } from "../tools/activation.ts";
import type { CatalogView, ToolCatalog } from "../tools/catalog.ts";
import { readSession, type SessionState } from "./docs.ts";
import { EXPERT_TOOL, pinnedTools, type Profile } from "./profiles.ts";
import { type ChildDeps, runChild, type Subagent, subagentTool } from "./subagents.ts";
import { backgroundTasks, CHILD_TASK_SECTION, PARENT_TASK_SECTION, PARENT_TASK_TOOLS } from "./tasks.ts";

export const CORE_EXTENSION = "agent.core";
export const INSTRUCTIONS_EXTENSION = "agent.instructions";

/** A named system prompt block, read from its own file at startup. */
export type InstructionSection = { readonly name: string; readonly content: string; readonly tag?: boolean };

export type CoreDeps = ChildDeps & {
	/** The skills a session's turn started with, which the index and `load_skill` use. */
	readonly sessionSkills: SessionSkills;
	readonly skills: readonly Skill[];
	readonly profiles: ReadonlyMap<string, Profile>;
	readonly defaultProfile: Profile;
	/** A profile by name; the default for an unknown or absent name. */
	readonly profileOf: (name: string | undefined) => Profile;
	readonly catalog: ToolCatalog;
	/** The tools a tenant's sessions can find and turn on: the catalog plus the tenant's own connectors. */
	readonly toolsFor: (tenantId: string | undefined) => Promise<CatalogView>;
	readonly subagents: readonly Subagent[];
	readonly limits: LimitsConfig;
	readonly runs: RunTracker;
	readonly harness: () => Harness;
	readonly woken: (conversationId: ConversationId, session: Readonly<SessionState>, submission: Submission, turnId: string) => void;
	readonly callCatalogTool?: (
		api: ToolExecutionApi,
		context: Context,
		toolName: string,
		args: Record<string, unknown>,
	) => Promise<ToolCallOutcome>;
};

const SEARCH_LIMIT = 8;

/**
 * The configured system prompt sections, installed first so they lead the prompt; plugin sections follow, then the
 * core extension's skill index and profile section.
 */
export function instructionsExtension(instructions: readonly InstructionSection[]): Extension {
	return defineExtension({
		name: INSTRUCTIONS_EXTENSION,
		sections: instructions.map((instruction) =>
			section(instruction.name, () => instruction.content, instruction.tag === undefined ? undefined : { tag: instruction.tag }),
		),
	});
}

/**
 * The always-selected extension: the skill index, the profile section, and the meta-tools that grow a session's tool
 * set. Sections render the same text for every request of a session, so provider prompt caches stay warm.
 */
export function coreExtension(deps: CoreDeps): Extension {
	const sections: PromptSection[] = [];
	// Per tenant: a tenant's own skills and overrides are in its index only. It changes only when the tenant publishes.
	sections.push(
		section("skills", async (input, context) => {
			const session = await readSession(input.read, input.conversationId, context);
			const skills = await deps.sessionSkills(input.conversationId, session?.tenantId, session?.parent);
			return skills.length > 0 ? renderSkillIndex(skills) : undefined;
		}),
	);
	sections.push(
		section("profile", async (input, context) => {
			const session = await readSession(input.read, input.conversationId, context);
			// A child has its parent's profile for tool policy; the parent's voice is not the child's.
			return session?.parent === undefined ? deps.profileOf(session?.profile).instructions : undefined;
		}),
	);

	const tools: ToolRegistration[] = [loadSkillTool(deps), searchToolsTool(deps)];
	if ([...deps.profiles.values()].some((profile) => profile.expert !== undefined)) tools.push(expertTool(deps));
	const background = backgroundTasks(deps);
	for (const subagent of deps.subagents) tools.push(subagent.background === true ? background.tool(subagent) : subagentTool(subagent, deps.catalog, deps));
	if (deps.subagents.some((subagent) => subagent.background === true)) {
		tools.push(...background.tools);
		sections.push(
			section("tasks", async (input, context) => {
				const session = await readSession(input.read, input.conversationId, context);
				if (session?.parent === undefined) return PARENT_TASK_SECTION;
				return session.task === undefined ? undefined : CHILD_TASK_SECTION;
			}),
		);
	}
	const hooks = [
		hook(ToolTask, {
			afterTool: async (call, result, api, context) => {
				if (call.name === "load_skill") return undefined;
				const flowState = await api.snapshot(FlowDoc, api.conversationId, context);
				const latest = flowState?.latest;
				if (latest === undefined || latest.status !== "running") return undefined;
				const conversation = await deps.harness().conversation(api.conversationId, context);
				if (conversation === undefined) return undefined;
				await conversation.commit(async (tx) => {
					const current = await tx.doc(FlowDoc, api.conversationId);
					if (current.latest === undefined) return;
					const updatedSteps: FlowStepTrace[] = current.latest.steps.map((step, idx) => {
						if (step.status === "running" || (idx === 1 && step.status === "pending")) {
							return {
								...step,
								status: result.isError === true ? "failed" : "completed",
								durationMs: Math.max(1, Date.now() - current.latest!.startedAt),
								toolCalls: [...(step.toolCalls ?? []), { name: call.name, status: result.isError === true ? "failed" : "done" }],
							};
						}
						return step;
					});
					const nextPendingIdx = updatedSteps.findIndex((s) => s.status === "pending");
					if (nextPendingIdx !== -1) {
						updatedSteps[nextPendingIdx] = { ...updatedSteps[nextPendingIdx]!, status: "running" };
					}
					const nextTrace: FlowRunTrace = {
						...(current.latest as FlowRunTrace),
						totalDurationMs: Math.max(1, Date.now() - current.latest.startedAt),
						steps: updatedSteps,
					};
					recordFlowTrace(current, nextTrace);
				}, context);
				return undefined;
			},
		}),
		hook(GenerationTask, {
			afterResponse: async (response, api, context) => {
				if (response.stopReason === "toolUse") return;
				const flowState = await api.snapshot(FlowDoc, api.conversationId, context);
				const latest = flowState?.latest;
				if (latest === undefined || latest.status !== "running") return;
				const conversation = await deps.harness().conversation(api.conversationId, context);
				if (conversation === undefined) return;
				await conversation.commit(async (tx) => {
					const current = await tx.doc(FlowDoc, api.conversationId);
					if (current.latest === undefined || current.latest.status !== "running") return;
					const steps: FlowStepTrace[] = current.latest.steps.map((step) =>
						step.status === "running" || step.stepId === "reply"
							? { ...step, status: "completed", durationMs: step.durationMs ?? Math.max(1, Date.now() - current.latest!.startedAt) }
							: step,
					);
					const nextTrace: FlowRunTrace = {
						...(current.latest as FlowRunTrace),
						status: "completed",
						totalDurationMs: Math.max(1, Date.now() - current.latest.startedAt),
						steps,
					};
					recordFlowTrace(current, nextTrace);
				}, context);
			},
		}),
	];
	return defineExtension({ name: CORE_EXTENSION, sections, tools, tasks: background.tasks, hooks });
}

/** The profile of the session a tool runs in. */
async function profileFor(deps: CoreDeps, api: ToolExecutionApi, context: Context): Promise<Profile> {
	return deps.profileOf((await readSession(api, api.conversationId, context))?.profile);
}

function loadSkillTool(deps: CoreDeps): ToolRegistration {
	return defineTool({
		name: "load_skill",
		description:
			"Load a skill by its exact name from the skills list: returns its instructions and enables its tools for the next step. " +
			"Pass `file` to read a file the skill's instructions reference. Pass `query` when the skill has a deterministic flow to execute its lookup steps immediately.",
		parameters: Type.Object({
			name: Type.String({ description: "Exact skill name." }),
			file: Type.Optional(Type.String({ description: "Relative path of a file inside the skill." })),
			query: Type.Optional(Type.String({ description: "Optional user query or entity name to run the skill's deterministic flow immediately." })),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			const session = await readSession(api, api.conversationId, context);
			const byName = new Map((await deps.sessionSkills(api.conversationId, session?.tenantId, session?.parent)).map((skill) => [skill.name, skill]));
			const skill = byName.get(args.name);
			if (skill === undefined) {
				const available = [...byName.keys()].join(", ") || "none";
				return { isError: true, output: [{ type: "text", text: `Unknown skill ${JSON.stringify(args.name)}. Available: ${available}` }] };
			}
			if (args.file !== undefined) {
				try {
					return { output: [{ type: "text", text: readSkillFile(skill, args.file) }] };
				} catch (error) {
					return { isError: true, output: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
				}
			}
			const profile = await profileFor(deps, api, context);
			const names = (await deps.toolsFor(session?.tenantId)).match(skill.tools);
			const { added } = await api.commit(
				(tx) => activateSkill(tx, api.conversationId, skill.name, names, policyOf(deps, profile)),
				context,
			);
			const missing = skill.tools.length > 0 && names.length === 0;
			const footer = missing
				? "\n\n(The tools this skill uses are unavailable right now; they are enabled automatically once their server connects.)"
				: names.length > 0
					? `\n\nTools enabled for this skill: ${names.join(", ")}`
					: "";

			let flowAppendix = "";
			if (skill.flow !== undefined) {
				if (skill.flow.mode === "deterministic" && args.query !== undefined && deps.callCatalogTool !== undefined && names.length > 0) {
					const language = /[\u4e00-\u9fa5]/.test(args.query) ? "zh" : "en";
					const result = await executeDeterministicFlow(skill.flow, {
						input: args.query,
						language,
						callTool: (toolName, toolArgs) => deps.callCatalogTool!(api, context, toolName, toolArgs),
						onUpdate: async (trace) => {
							await api.commit(async (tx) => {
								const current = await tx.doc(FlowDoc, api.conversationId);
								recordFlowTrace(current, trace);
							}, context);
						},
					});
					if (result.status === "needs_input" && result.immediateReply !== undefined) {
						flowAppendix = `\n\n<flow_needs_input>\n${result.immediateReply}\n</flow_needs_input>`;
					} else if (result.evidenceBlock !== undefined) {
						flowAppendix = `\n\n${result.evidenceBlock}`;
					}
				} else {
					const startedAt = Date.now();
					const steps: FlowStepTrace[] = skill.flow.nodes.map((node, index) => ({
						stepId: node.id,
						status: index === 0 ? "completed" : index === 1 ? "running" : "pending",
						...(index === 0 ? { durationMs: 1 } : {}),
					}));
					const initialTrace: FlowRunTrace = {
						flowId: skill.flow.id,
						skill: skill.name,
						title: skill.flow.title,
						...(skill.flow.titleZh === undefined ? {} : { titleZh: skill.flow.titleZh }),
						mode: skill.flow.mode,
						status: "running",
						startedAt,
						steps,
					};
					await api.commit(async (tx) => {
						const current = await tx.doc(FlowDoc, api.conversationId);
						recordFlowTrace(current, initialTrace);
					}, context);
				}
			}

			// A tenant skill's files aren't on disk to browse, so say what there is to read.
			const files = skill.files === undefined ? "" : `\n\nReference files (read one with load_skill and file): ${[...skill.files.keys()].join(", ")}`;
			return { output: [{ type: "text", text: `${skill.body}${footer}${files}${flowAppendix}` }], details: { skill: skill.name, added } };
		},
	});
}

function searchToolsTool(deps: CoreDeps): ToolRegistration {
	return defineTool({
		name: "search_tools",
		description:
			"Find tools for a task when no offered tool or skill fits. Describe the action in a few words, for example " +
			'"list open invoices for a customer". The best matches are enabled for the next step.',
		parameters: Type.Object({
			query: Type.String({ description: "What the tool should do." }),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: SEARCH_LIMIT, description: `At most ${SEARCH_LIMIT}.` })),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			const session = await readSession(api, api.conversationId, context);
			const hits = (await deps.toolsFor(session?.tenantId)).search(args.query, args.limit ?? 5);
			if (hits.length === 0) return { output: [{ type: "text", text: "No tools matched. Try other words." }] };
			const profile = await profileFor(deps, api, context);
			const names = hits.map((hit) => hit.entry.name);
			const { added } = await api.commit(
				(tx) => activateTools(tx, api.conversationId, names, policyOf(deps, profile)),
				context,
			);
			const lines = hits.map((hit) => `- ${hit.entry.name}: ${firstSentence(hit.entry.description)}`);
			return {
				output: [{ type: "text", text: `Enabled these tools; call them directly:\n${lines.join("\n")}` }],
				details: { added },
			};
		},
	});
}

/**
 * Hard questions go to a slower reasoning model while the fast model keeps the conversation going. The child
 * conversation is owned by this call, so aborting the call (a barge-in) aborts the expert too.
 */
function expertTool(deps: CoreDeps): ToolRegistration {
	return defineTool({
		name: EXPERT_TOOL,
		description:
			"Ask a slower, stronger reasoning model a hard question: multi-step analysis, planning, or a decision with " +
			"trade-offs. Include the facts it needs. Returns its conclusion. Do not use it for simple lookups.",
		parameters: Type.Object({
			question: Type.String({ description: "The question, with every fact needed to answer it." }),
		}),
		// A rerun after a crash finds the same child and the same submission.
		replay: "safe",
		execute: async (args, api, context) => {
			const profile = await profileFor(deps, api, context);
			const expert = profile.expert ?? deps.defaultProfile.expert;
			if (expert === undefined) {
				return { isError: true, output: [{ type: "text", text: "No expert model is configured for this session." }] };
			}
			return runChild(
				deps,
				api,
				{
					label: "expert",
					requestId: `expert:${api.taskId}`,
					model: expert.model,
					thinkingLevel: expert.thinkingLevel,
					instructions:
						"You are consulted by another assistant that is talking with a user. Think the problem through, then " +
						"answer with the conclusion first and only the reasoning the assistant needs to relay it.",
					tools: (inherited) => inherited.filter((name) => name !== EXPERT_TOOL && !PARENT_TASK_TOOLS.includes(name)),
				},
				args.question,
				context,
			);
		},
	});
}

function policyOf(deps: CoreDeps, profile: Profile) {
	return { pinned: pinnedTools(profile, deps.catalog), maxActive: profile.maxActiveTools };
}

function firstSentence(text: string): string {
	const match = /^(.{1,200}?[.!?。！？])(\s|$)/su.exec(text);
	return (match?.[1] ?? text.slice(0, 200)).replace(/\s+/g, " ");
}
