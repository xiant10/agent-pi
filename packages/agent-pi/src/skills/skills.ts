import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { synthesizeSkillFlow, validateSkillFlow } from "../flow/engine.ts";
import type { SkillFlow } from "../flow/types.ts";

export type Skill = {
	readonly name: string;
	readonly description: string;
	/** Tool patterns (`[server:]glob`) activated when the skill loads. */
	readonly tools: readonly string[];
	/** Words that make the skill's tools worth preloading for an input that contains them. */
	readonly keywords: readonly string[];
	/** Markdown body, without frontmatter. */
	readonly body: string;
	/** Directory of a `<name>/SKILL.md` skill, whose other files `load_skill` can read; absent for a single file. */
	readonly dir?: string;
	/** Optional visual and/or deterministic workflow graph for this skill. */
	readonly flow?: SkillFlow;
	/** A tenant skill's reference files by relative path, which `load_skill` reads with `file`; held in memory, never on disk. */
	readonly files?: ReadonlyMap<string, string>;
	/** Set when a tenant's published version changed or added this skill; absent for a built-in one. */
	readonly source?: TenantSkillSource;
};

/** Which tenant version a skill came from, so a log line or trace can say exactly what ran. */
export type TenantSkillSource = {
	readonly kind: "override" | "custom";
	readonly version: number;
	readonly digest: string;
};

const SKILL_NAME = /^[a-z][a-z0-9_-]*$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

type Frontmatter = Record<string, string | string[]>;

/**
 * A small frontmatter reader: `key: value` scalars (quotes optional), inline lists `[a, "b"]`, block lists of `- item`
 * lines, and indented continuation lines folded into the value. Values are not YAML-parsed, so long free-text
 * descriptions containing `: ` stay intact.
 */
export function parseFrontmatter(text: string): Frontmatter {
	const fields: Frontmatter = {};
	let current: string | undefined;
	for (const line of text.split(/\r?\n/)) {
		if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
		const indented = /^\s/.test(line);
		const item = /^\s*-\s+(.*)$/.exec(line);
		if (current !== undefined && item !== null) {
			const existing = fields[current];
			const list = Array.isArray(existing) ? existing : existing === undefined || existing === "" ? [] : [existing];
			list.push(unquote(item[1]!.trim()));
			fields[current] = list;
			continue;
		}
		if (current !== undefined && indented) {
			const existing = fields[current];
			if (typeof existing === "string") fields[current] = existing === "" ? line.trim() : `${existing} ${line.trim()}`;
			continue;
		}
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		current = line.slice(0, colon).trim();
		let value = line.slice(colon + 1).trim();
		if (value === ">" || value === "|" || value === ">-" || value === "|-") value = "";
		if (value.startsWith("[") && value.endsWith("]")) {
			fields[current] = value
				.slice(1, -1)
				.split(",")
				.map((part) => unquote(part.trim()))
				.filter((part) => part.length > 0);
		} else {
			fields[current] = unquote(value);
		}
	}
	return fields;
}

function unquote(value: string): string {
	if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
		return value.slice(1, -1);
	}
	return value;
}

function list(value: string | string[] | undefined): string[] {
	if (value === undefined || value === "") return [];
	if (Array.isArray(value)) return value;
	return value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

export function parseSkill(file: string, content: string, dir?: string): Skill {
	const match = FRONTMATTER.exec(content);
	if (match === null) throw new Error(`${file}: must start with a --- frontmatter block holding name and description`);
	const fields = parseFrontmatter(match[1]!);
	const name = fields.name;
	const description = fields.description;
	if (typeof name !== "string" || !SKILL_NAME.test(name)) {
		throw new Error(`${file}: frontmatter "name" must match ${SKILL_NAME}`);
	}
	if (typeof description !== "string" || description.length === 0) {
		throw new Error(`${file}: frontmatter needs a non-empty "description"`);
	}
	const tools = list(fields.tools);
	const keywords = list(fields.keywords);
	const body = content.slice(match[0].length).trim();
	let flow: SkillFlow | undefined;
	if (dir !== undefined) {
		const flowFile = join(dir, "flow.json");
		if (statSync(flowFile, { throwIfNoEntry: false })?.isFile()) {
			const parsed = JSON.parse(readFileSync(flowFile, "utf8")) as SkillFlow;
			flow = validateSkillFlow(parsed).flow;
		}
	}
	flow ??= synthesizeSkillFlow({ name, description, tools, body });
	return {
		name,
		description,
		tools,
		keywords,
		body,
		...(dir === undefined ? {} : { dir }),
		flow,
	};
}

/** Skills in `dir`: every `*.md` file, and every `<name>/SKILL.md`. Sorted by name; duplicate names are an error. */
export function discoverSkills(dir: string): Skill[] {
	const skills: Skill[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isFile() && entry.name.endsWith(".md")) {
			skills.push(parseSkill(path, readFileSync(path, "utf8")));
		} else if (entry.isDirectory()) {
			const skillFile = join(path, "SKILL.md");
			if (statSync(skillFile, { throwIfNoEntry: false })?.isFile()) {
				skills.push(parseSkill(skillFile, readFileSync(skillFile, "utf8"), path));
			}
		}
	}
	skills.sort((a, b) => a.name.localeCompare(b.name));
	for (let i = 1; i < skills.length; i++) {
		if (skills[i]!.name === skills[i - 1]!.name) throw new Error(`${dir}: two skills named ${skills[i]!.name}`);
	}

	return skills;
}

/** Read a file that a directory skill references, refusing paths outside its directory. */
export function readSkillFile(skill: Skill, path: string): string {
	if (skill.files !== undefined) {
		// Looked up by exact path, so nothing outside the published version can be named.
		const text = skill.files.get(path.replace(/^\.\//, ""));
		if (text === undefined) throw new Error(`${JSON.stringify(path)} isn't one of skill ${skill.name}'s files: ${[...skill.files.keys()].join(", ") || "none"}`);
		return text;
	}
	if (skill.dir === undefined) throw new Error(`Skill ${skill.name} has no extra files`);
	const target = resolve(skill.dir, path);
	const inside = relative(skill.dir, target);
	if (inside.startsWith("..") || inside.startsWith(sep) || inside === "") {
		throw new Error(`${JSON.stringify(path)} is outside skill ${skill.name}`);
	}
	return readFileSync(target, "utf8");
}

/** Most file names `skillFiles` lists for one built-in skill. */
const MAX_LISTED_FILES = 200;

/** The files `load_skill` can read for a skill, by relative path: a tenant skill's own, or a skill directory's other files. */
export function skillFiles(skill: Skill): string[] {
	if (skill.files !== undefined) return [...skill.files.keys()].sort();
	if (skill.dir === undefined) return [];
	const out: string[] = [];
	const walk = (dir: string, prefix: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (out.length >= MAX_LISTED_FILES || entry.name.startsWith(".")) continue;
			const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) walk(join(dir, entry.name), path);
			else if (entry.isFile() && path !== "SKILL.md" && path !== "flow.json") out.push(path);
		}
	};
	walk(skill.dir, "");
	return out.sort();
}

/** The always-on prompt section: names and descriptions only, so skills cost little until one is used. */
export function renderSkillIndex(skills: readonly Skill[]): string {
	const lines = skills.map((skill) => `- ${skill.name}: ${skill.description}`);
	return [
		"Skills hold instructions and tools for specific tasks. When a request matches one, call load_skill with its exact",
		"name before acting; it returns the instructions and enables the skill's tools. Do not guess a skill's contents.",
		...lines,
	].join("\n");
}

/** Whether a skill's tool patterns cover a tool. A skill that lists no tools covers none. */
export function toolAllowedBySkill(tool: string, patterns: readonly string[]): boolean {
	if (patterns.length === 0) return false;
	return patterns.some((pattern) => {
		const bare = pattern.includes(":") ? pattern.slice(pattern.indexOf(":") + 1) : pattern;
		const underscored = pattern.replace(":", "_");
		if (bare === "*" || bare === tool || pattern === tool || underscored === tool) return true;
		for (const candidate of [bare, underscored]) {
			if (candidate.includes("*")) {
				const regex = new RegExp(`^${candidate.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
				if (regex.test(tool)) return true;
			}
		}
		return false;
	});
}
