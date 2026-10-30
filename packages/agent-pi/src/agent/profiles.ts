import type { ModelRef } from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Skill } from "../skills/skills.ts";
import type { ToolCatalog } from "../tools/catalog.ts";

/** How a session runs. Chosen at `session.create`; voice and chat clients want different trade-offs. */
export type Profile = {
	readonly name: string;
	readonly model: ModelRef;
	readonly thinkingLevel: ModelThinkingLevel;
	/** Extra instructions for this profile, rendered as the `profile` section. */
	readonly instructions?: string;
	/** Tool patterns offered from creation on and never evicted. */
	readonly alwaysOnTools: readonly string[];
	/** Most tools offered at once. */
	readonly maxActiveTools: number;
	/** Activate matching tools from the user's input before the model runs. `maxTools: 0` disables it. */
	readonly preload: { readonly maxTools: number; readonly minScore: number };
	/** Emit `speech` events: speakable sentences for TTS. */
	readonly speech: boolean;
	/** Emit `thinking.delta` events. */
	readonly thinkingEvents: boolean;
	/** Offer `consult_expert`, backed by this model. */
	readonly expert?: { readonly model: ModelRef; readonly thinkingLevel: ModelThinkingLevel };
};

/** Meta-tools every session is offered. */
export const META_TOOLS = ["load_skill", "search_tools"] as const;
export const EXPERT_TOOL = "consult_expert";

export function pinnedTools(profile: Profile, catalog: ToolCatalog): string[] {
	return [...META_TOOLS, ...(profile.expert === undefined ? [] : [EXPERT_TOOL]), ...catalog.match(profile.alwaysOnTools)];
}

/**
 * Tools worth offering for `input` before the model sees it, so a matching tool is callable in the first response
 * instead of after a search round trip: tools of skills whose keywords occur in the input, then the best search hits
 * above `minScore`.
 */
export function preloadTools(
	input: string,
	profile: Profile,
	catalog: ToolCatalog,
	skills: readonly Skill[],
): string[] {
	const { maxTools, minScore } = profile.preload;
	if (maxTools <= 0) return [];
	const lowered = input.toLowerCase();
	const chosen: string[] = [];
	for (const skill of skills) {
		if (!skill.keywords.some((keyword) => lowered.includes(keyword.toLowerCase()))) continue;
		for (const name of catalog.match(skill.tools)) if (!chosen.includes(name)) chosen.push(name);
	}
	for (const hit of catalog.search(input, maxTools)) {
		if (hit.score >= minScore && !chosen.includes(hit.entry.name)) chosen.push(hit.entry.name);
	}
	return chosen.slice(0, maxTools);
}
