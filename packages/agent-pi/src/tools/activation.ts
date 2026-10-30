import { AgentDoc, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { ToolStateDoc } from "../agent/docs.ts";

export type ActivationPolicy = {
	/** Never evicted: meta-tools and a profile's always-on tools. */
	readonly pinned: readonly string[];
	/** Most tools offered at once, pinned included. */
	readonly maxActive: number;
};

export type ActivationResult = { readonly added: string[]; readonly evicted: string[] };

/**
 * Offer `names` from the next request on. The conversation's `pi.agent.tools` is the exact offered set; this appends to
 * it, so earlier tool declarations, and the provider prompt cache over them, stay as they were. When the set would
 * exceed `maxActive`, the least recently activated unpinned tools not named in this call are evicted.
 */
export async function activateTools(
	tx: Tx,
	conversationId: ConversationId,
	names: readonly string[],
	policy: ActivationPolicy,
): Promise<ActivationResult> {
	const agent = await tx.doc(AgentDoc, conversationId);
	const state = await tx.doc(ToolStateDoc, conversationId);
	const pinned = new Set(policy.pinned);
	const offered = Array.isArray(agent.tools) ? [...agent.tools] : [...policy.pinned];
	const dynamic = [...state.dynamic];
	const requested = new Set(names);
	const added: string[] = [];
	for (const name of requested) {
		if (!offered.includes(name)) {
			offered.push(name);
			added.push(name);
		}
		if (pinned.has(name)) continue;
		const index = dynamic.indexOf(name);
		if (index !== -1) dynamic.splice(index, 1);
		dynamic.push(name);
	}
	const evicted: string[] = [];
	const room = Math.max(0, policy.maxActive - pinned.size);
	for (let index = 0; dynamic.length > room && index < dynamic.length; ) {
		const name = dynamic[index]!;
		if (requested.has(name)) {
			index++;
			continue;
		}
		dynamic.splice(index, 1);
		const at = offered.indexOf(name);
		if (at !== -1) offered.splice(at, 1);
		evicted.push(name);
	}
	if (added.length > 0 || evicted.length > 0 || !Array.isArray(agent.tools)) agent.tools = offered;
	state.dynamic = dynamic;
	if (evicted.length > 0) forgetEvictedSkills(state, offered);
	return { added, evicted };
}

/**
 * Forget loaded skills none of whose tools are offered any more, so they stop picking up new tools. A skill that has
 * activated no tools yet is kept: it is waiting for its server.
 */
function forgetEvictedSkills(state: { skills?: Record<string, string[]> }, offered: readonly string[]): void {
	if (state.skills === undefined) return;
	const skills = { ...state.skills };
	let changed = false;
	for (const [skill, known] of Object.entries(skills)) {
		if (known.length === 0 || known.some((name) => offered.includes(name))) continue;
		delete skills[skill];
		changed = true;
	}
	if (changed) state.skills = skills;
}

/** Activate a skill's tools and remember the skill, so tools matching it later are activated too. */
export async function activateSkill(
	tx: Tx,
	conversationId: ConversationId,
	skill: string,
	names: readonly string[],
	policy: ActivationPolicy,
): Promise<ActivationResult> {
	const state = await tx.doc(ToolStateDoc, conversationId);
	state.skills = { ...state.skills, [skill]: [...names] };
	return activateTools(tx, conversationId, names, policy);
}

/**
 * Activate tools that match a loaded skill but were not there when it loaded: a server that connected late or re-listed
 * its tools. Tools a skill already activated are not re-added, so an eviction holds until the skill is loaded again;
 * once all of a skill's tools are evicted, the skill is forgotten.
 * `matches` gives a skill's current tool names, or `undefined` for a skill that no longer exists.
 */
export async function refreshSkills(
	tx: Tx,
	conversationId: ConversationId,
	matches: (skill: string) => readonly string[] | undefined,
	policy: ActivationPolicy,
): Promise<ActivationResult> {
	const state = await tx.doc(ToolStateDoc, conversationId);
	const skills = { ...state.skills };
	const fresh: string[] = [];
	for (const [skill, known] of Object.entries(skills)) {
		const added = (matches(skill) ?? []).filter((name) => !known.includes(name));
		if (added.length === 0) continue;
		skills[skill] = [...known, ...added];
		fresh.push(...added);
	}
	if (fresh.length === 0) return { added: [], evicted: [] };
	state.skills = skills;
	return activateTools(tx, conversationId, fresh, policy);
}
