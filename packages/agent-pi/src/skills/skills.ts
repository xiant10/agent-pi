import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

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
	return {
		name,
		description,
		tools: list(fields.tools),
		keywords: list(fields.keywords),
		body: content.slice(match[0].length).trim(),
		...(dir === undefined ? {} : { dir }),
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
	if (skill.dir === undefined) throw new Error(`Skill ${skill.name} has no extra files`);
	const target = resolve(skill.dir, path);
	const inside = relative(skill.dir, target);
	if (inside.startsWith("..") || inside.startsWith(sep) || inside === "") {
		throw new Error(`${JSON.stringify(path)} is outside skill ${skill.name}`);
	}
	return readFileSync(target, "utf8");
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
