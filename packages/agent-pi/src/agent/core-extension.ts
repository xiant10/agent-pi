import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type Extension,
	type PromptSection,
	section,
	type ToolExecutionApi,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { readSkillFile, renderSkillIndex, type Skill } from "../skills/skills.ts";
import { activateSkill, activateTools } from "../tools/activation.ts";
import type { ToolCatalog } from "../tools/catalog.ts";
import { readSession } from "./docs.ts";
import { EXPERT_TOOL, pinnedTools, type Profile } from "./profiles.ts";
import { type ChildDeps, runChild, type Subagent, subagentTool } from "./subagents.ts";

export const CORE_EXTENSION = "agent.core";
export const INSTRUCTIONS_EXTENSION = "agent.instructions";

/** A named system prompt block, read from its own file at startup. */
export type InstructionSection = { readonly name: string; readonly content: string; readonly tag?: boolean };

export type CoreDeps = ChildDeps & {
	readonly skills: readonly Skill[];
	readonly profiles: ReadonlyMap<string, Profile>;
	readonly defaultProfile: Profile;
	/** A profile by name; the default for an unknown or absent name. */
	readonly profileOf: (name: string | undefined) => Profile;
	readonly catalog: ToolCatalog;
	readonly subagents: readonly Subagent[];
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
	if (deps.skills.length > 0) sections.push(section("skills", () => renderSkillIndex(deps.skills)));
	sections.push(
		section("profile", async (input, context) => {
			const session = await readSession(input.read, input.conversationId, context);
			// A child has its parent's profile for tool policy; the parent's voice is not the child's.
			return session?.parent === undefined ? deps.profileOf(session?.profile).instructions : undefined;
		}),
	);

	const tools: ToolRegistration[] = [loadSkillTool(deps), searchToolsTool(deps)];
	if ([...deps.profiles.values()].some((profile) => profile.expert !== undefined)) tools.push(expertTool(deps));
	for (const subagent of deps.subagents) tools.push(subagentTool(subagent, deps.catalog, deps));
	return defineExtension({ name: CORE_EXTENSION, sections, tools });
}

/** The profile of the session a tool runs in. */
async function profileFor(deps: CoreDeps, api: ToolExecutionApi, context: Context): Promise<Profile> {
	return deps.profileOf((await readSession(api, api.conversationId, context))?.profile);
}

function loadSkillTool(deps: CoreDeps): ToolRegistration {
	const byName = new Map(deps.skills.map((skill) => [skill.name, skill]));
	return defineTool({
		name: "load_skill",
		description:
			"Load a skill by its exact name from the skills list: returns its instructions and enables its tools for the next step. " +
			"Pass `file` to read a file the skill's instructions reference.",
		parameters: Type.Object({
			name: Type.String({ description: "Exact skill name." }),
			file: Type.Optional(Type.String({ description: "Relative path of a file inside the skill." })),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
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
			const names = deps.catalog.match(skill.tools);
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
			return { output: [{ type: "text", text: `${skill.body}${footer}` }], details: { skill: skill.name, added } };
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
			const hits = deps.catalog.search(args.query, args.limit ?? 5);
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
					tools: (inherited) => inherited.filter((name) => name !== EXPERT_TOOL),
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
