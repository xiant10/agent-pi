import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { AgentDoc, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { ToolStateDoc } from "../src/agent/docs.ts";
import type { Principal } from "../src/auth/authenticator.ts";
import { CredentialStore } from "../src/auth/credentials.ts";
import { loadConfig } from "../src/config.ts";
import { SpeechSegmenter, speakable } from "../src/events/speech.ts";
import { discoverSkills, parseFrontmatter, readSkillFile } from "../src/skills/skills.ts";
import { activateSkill, activateTools, refreshSkills } from "../src/tools/activation.ts";
import { type CatalogEntry, ToolCatalog, tokenize } from "../src/tools/catalog.ts";

const context = BACKGROUND_CONTEXT;

describe("CredentialStore.sweep", () => {
	const principal = (expiresAt?: number): Principal => ({
		userId: "u",
		scopes: [],
		claims: {},
		token: "t",
		...(expiresAt === undefined ? {} : { expiresAt }),
	});
	const id = (n: number) => n as Parameters<CredentialStore["get"]>[0];

	it("drops expired tokens at once, and idle sessions' tokens unless the session is working", () => {
		const store = new CredentialStore();
		const now = Date.now();
		store.set(id(1), principal());
		store.set(id(2), principal());
		store.set(id(3), principal(now - 1));
		const working = (conversationId: unknown) => conversationId === id(2);
		store.sweep(60_000, working, now + 30_000);
		expect([1, 2, 3].map((n) => store.get(id(n)) !== undefined)).toEqual([true, true, false]);
		// From after the sets: `seen` can be a millisecond past `now` on a slow machine.
		store.sweep(60_000, working, Date.now() + 60_000);
		expect([1, 2].map((n) => store.get(id(n)) !== undefined)).toEqual([false, true]);
	});
});

describe("SpeechSegmenter", () => {
	it("emits whole sentences across arbitrary delta boundaries", () => {
		const segmenter = new SpeechSegmenter();
		const out: string[] = [];
		for (const chunk of ["Your next meet", "ing is at 3.30 today. It is with ", "**Acme**. Bye"]) out.push(...segmenter.push(chunk));
		// "3.30" is not a sentence end; "**" split across deltas is still stripped.
		expect(out).toEqual(["Your next meeting is at 3.30 today.", "It is with Acme."]);
		// No whitespace after the final "." yet, so it waits for more text or the flush at message end.
		expect(segmenter.push(" now.")).toEqual([]);
		expect(segmenter.flush()).toBe("Bye now.");
	});

	it("cuts CJK sentences without spaces and long sentences at a clause break", () => {
		const segmenter = new SpeechSegmenter({ minChars: 4, maxChars: 40 });
		expect(segmenter.push("您的下一个会议在三点。和客户讨论续约。")).toEqual(["您的下一个会议在三点。", "和客户讨论续约。"]);
		const long = segmenter.push("This sentence has no end in sight, it rambles on and on");
		expect(long[0]).toBe("This sentence has no end in sight,");
	});

	it("strips markdown but keeps identifiers", () => {
		expect(speakable("## Plan\n- **Call** [Acme](https://acme.test) about `customer_id` _soon_")).toBe(
			"Plan Call Acme about customer_id soon",
		);
	});
});

function entry(server: string, name: string, description: string): CatalogEntry {
	return { name: `${server}_${name}`, server, mcpName: name, description, inputSchema: { type: "object" } };
}

describe("ToolCatalog", () => {
	it("tokenizes camelCase, snake_case, and CJK bigrams", () => {
		expect(tokenize("listOpenInvoices get_account")).toEqual(["list", "open", "invoices", "get", "account"]);
		expect(tokenize("查询客户")).toEqual(["查", "查询", "询", "询客", "客", "客户", "户"]);
	});

	it("ranks by BM25 over names and descriptions, in English and Chinese", () => {
		const catalog = new ToolCatalog();
		catalog.setServer("crm", [
			entry("crm", "list_accounts", "List customer accounts."),
			entry("crm", "get_invoice", "Fetch an invoice with its due date."),
			entry("crm", "search_profile", "查询客户画像和档案"),
		]);
		expect(catalog.search("when is the invoice due", 1)[0]!.entry.mcpName).toBe("get_invoice");
		expect(catalog.search("帮我查一下客户档案", 1)[0]!.entry.mcpName).toBe("search_profile");
	});

	it("matches skill patterns by server and glob, and refuses names another server owns", () => {
		const catalog = new ToolCatalog();
		catalog.setServer("crm", [entry("crm", "list_accounts", "a"), entry("crm", "list_deals", "b"), entry("crm", "get_deal", "c")]);
		catalog.setServer("cal", [entry("cal", "list_events", "d")]);
		expect(catalog.match(["crm:list_*"])).toEqual(["crm_list_accounts", "crm_list_deals"]);
		expect(catalog.match(["list_events"])).toEqual(["cal_list_events"]);
		const conflicts = catalog.setServer("other", [{ ...entry("other", "x", "y"), name: "crm_get_deal" }]);
		expect(conflicts).toEqual(["crm_get_deal"]);
	});
});

describe("activateTools", () => {
	it("appends new tools and evicts the least recently activated unpinned ones", async () => {
		const models = createModels();
		const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		const policy = { pinned: ["load_skill"], maxActive: 4 };
		const activate = (names: string[]) => conversation.commit((tx) => activateTools(tx, conversation.id, names, policy), context);
		expect(await activate(["a", "b"])).toEqual({ added: ["a", "b"], evicted: [] });
		await activate(["a"]); // refreshes a: b is now the oldest
		expect(await activate(["c", "d"])).toEqual({ added: ["c", "d"], evicted: ["b"] });
		expect((await harness.snapshot(AgentDoc, conversation.id, context))?.tools).toEqual(["load_skill", "a", "c", "d"]);
		await harness.close(context);
	});
});

describe("refreshSkills", () => {
	it("activates tools new to a loaded skill, not ones it had, and forgets a skill whose tools are all evicted", async () => {
		const models = createModels();
		const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		const policy = { pinned: ["load_skill"], maxActive: 3 };
		let current = ["a"];
		const refresh = () =>
			conversation.commit((tx) => refreshSkills(tx, conversation.id, (name) => (name === "s" ? current : undefined), policy), context);
		await conversation.commit((tx) => activateSkill(tx, conversation.id, "s", current, policy), context);
		expect(await refresh()).toEqual({ added: [], evicted: [] });
		current = ["a", "b"];
		expect(await refresh()).toEqual({ added: ["b"], evicted: [] });
		await conversation.commit((tx) => activateTools(tx, conversation.id, ["c"], policy), context); // evicts a
		expect(await refresh()).toEqual({ added: [], evicted: [] });
		expect((await harness.snapshot(AgentDoc, conversation.id, context))?.tools).toEqual(["load_skill", "b", "c"]);
		await conversation.commit((tx) => activateSkill(tx, conversation.id, "waiting", [], policy), context);
		await conversation.commit((tx) => activateTools(tx, conversation.id, ["d", "e"], policy), context); // evicts b and c
		expect((await harness.snapshot(ToolStateDoc, conversation.id, context))?.skills).toEqual({ waiting: [] });
		current = ["a", "b", "f"];
		expect(await refresh()).toEqual({ added: [], evicted: [] }); // s is forgotten: f is not activated
		await harness.close(context);
	});
});

describe("skills", () => {
	it("parses scalars with colons, inline and block lists", () => {
		expect(
			parseFrontmatter('name: a\ndescription: Use when: the user asks. 注意：中文\ntools: [crm:list_*, "cal:*"]\nkeywords:\n  - visit\n  - 拜访'),
		).toEqual({ name: "a", description: "Use when: the user asks. 注意：中文", tools: ["crm:list_*", "cal:*"], keywords: ["visit", "拜访"] });
	});

	it("discovers file and directory skills and reads only files inside a skill", () => {
		const dir = mkdtempSync(join(tmpdir(), "skills-"));
		writeFileSync(join(dir, "single.md"), "---\nname: single\ndescription: One file.\n---\nBody one.");
		mkdirSync(join(dir, "visit", "references"), { recursive: true });
		writeFileSync(join(dir, "visit", "SKILL.md"), "---\nname: visit\ndescription: Prepare visits.\ntools: crm:*\n---\nBody two.");
		writeFileSync(join(dir, "visit", "references", "gates.md"), "gate rules");
		const skills = discoverSkills(dir);
		expect(skills.map((skill) => [skill.name, skill.tools])).toEqual([["single", []], ["visit", ["crm:*"]]]);
		expect(readSkillFile(skills[1]!, "references/gates.md")).toBe("gate rules");
		expect(() => readSkillFile(skills[1]!, "../single.md")).toThrow(/outside/);
	});
});

describe("loadConfig", () => {
	it("substitutes env vars, resolves files, and rejects unknown model references", () => {
		const dir = mkdtempSync(join(tmpdir(), "config-"));
		writeFileSync(join(dir, "base.md"), "Be brief.");
		process.env.TEST_GATEWAY = "http://gateway:7200/v1";
		const base = {
			auth: { kind: "static", tokens: "{}" },
			models: { fast: { provider: "openai-compatible", modelId: "m", baseUrl: "${TEST_GATEWAY}", identityHeaders: "gateway" } },
			profiles: { voice: { model: "fast", speech: "true", maxActiveTools: "24" } },
			instructions: [{ name: "base", file: "base.md" }],
			port: "${TEST_PORT:-9090}",
		};
		writeFileSync(join(dir, "agent.json"), JSON.stringify(base));
		const config = loadConfig(join(dir, "agent.json"));
		expect(config.port).toBe(9090);
		expect(config.models.fast).toMatchObject({ baseUrl: "http://gateway:7200/v1", api: "chat-completions" });
		expect(config.models.fast).toMatchObject({ identityHeaders: { sessionId: "X-Session-ID", turnId: "X-Turn-ID", userName: "X-User-Name" } });
		expect(config.profiles.voice).toMatchObject({ speech: true, maxActiveTools: 24 });
		expect(config.instructions[0]?.content).toBe("Be brief.");
		expect(config.storage).toEqual({ kind: "sqlite", path: join(dir, "agent.sqlite") });

		writeFileSync(join(dir, "bad.json"), JSON.stringify({ ...base, profiles: { voice: { model: "nope" } } }));
		expect(() => loadConfig(join(dir, "bad.json"))).toThrow(/unknown model "nope"/);
	});
});
