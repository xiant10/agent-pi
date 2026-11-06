import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Principal } from "../src/auth/authenticator.ts";
import type { GrantsConfig } from "../src/auth/grants.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import { applyTenantSkills, readSkillFile, type Skill, type SkillFlow, type TenantSkillRecord, TenantSkills, TurnPins } from "../src/index.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall, rpc, rpcStream, startTestAgent, type TestAgent } from "../src/testing.ts";

const flow = (title: string, tool?: string): SkillFlow => ({
	id: "ignored",
	title,
	mode: "guided",
	nodes: [
		{ id: "start", kind: "start", label: "Start" },
		...(tool === undefined ? [] : [{ id: "call", kind: "tool" as const, label: "Call", call: { tool } }]),
		{ id: "reply", kind: "llm_reply", label: "Reply" },
	],
	edges:
		tool === undefined
			? [{ id: "e1", source: "start", target: "reply" }]
			: [
					{ id: "e1", source: "start", target: "call" },
					{ id: "e2", source: "call", target: "reply" },
				],
});

const weather: Skill = {
	name: "weather",
	description: "Weather forecasts",
	tools: ["crm:get_forecast"],
	keywords: [],
	body: "Built-in weather instructions.",
	flow: { ...flow("Weather"), id: "weather" },
};

const override = (title: string, tool?: string, version = 1): TenantSkillRecord => ({
	name: "weather",
	kind: "override",
	version,
	digest: `sha256:${version}`,
	content: { flow: flow(title, tool) },
});

const vip: TenantSkillRecord = {
	name: "vip-intake",
	kind: "custom",
	version: 1,
	digest: "sha256:v",
	content: {
		description: "VIP intake",
		body: "Ask for the VIP account number first.",
		tools: ["crm:get_forecast"],
		keywords: ["vip"],
		files: { "refs/tiers.md": "Tier A: over 1M ARR." },
	},
};

describe("applyTenantSkills", () => {
	it("applies an override and adds a custom skill, leaving the built-in untouched", () => {
		const view = applyTenantSkills([weather], [override("Acme weather", "crm_get_forecast"), vip]);
		expect(view.map((s) => s.name)).toEqual(["vip-intake", "weather"]);
		const changed = view.find((s) => s.name === "weather")!;
		expect(changed.flow?.title).toBe("Acme weather");
		expect(changed.flow?.id).toBe("weather");
		expect(changed.body).toBe(weather.body);
		expect(changed.source).toEqual({ kind: "override", version: 1, digest: "sha256:1" });
		expect(weather.flow?.title).toBe("Weather");
		expect(view.find((s) => s.name === "vip-intake")?.flow?.mode).toBe("guided");
	});

	it("skips what fails its checks, keeping the built-in", () => {
		const skipped: string[] = [];
		const view = applyTenantSkills(
			[weather],
			[
				override("Calls anything", "delete_everything"),
				{ ...vip, name: "weather" },
				{ ...override("No such skill"), name: "missing" },
				{ ...vip, name: "vip-bad", content: { ...vip.content, flow: flow("Bad", "delete_everything") } },
				{ ...vip, name: "vip-regex", content: { ...vip.content, flow: { ...flow("Regex"), nodes: [{ id: "start", kind: "extract", label: "x", extract: { q: { pattern: "a".repeat(201) } } }], edges: [] } } },
			],
			(record, reason) => skipped.push(`${record.name}: ${reason}`),
		);
		expect(view).toEqual([weather]);
		expect(skipped).toHaveLength(5);
	});

	it("serves a custom skill's reference files by exact path only", () => {
		const skill = applyTenantSkills([weather], [vip]).find((s) => s.name === "vip-intake")!;
		expect(readSkillFile(skill, "refs/tiers.md")).toBe("Tier A: over 1M ARR.");
		expect(readSkillFile(skill, "./refs/tiers.md")).toBe("Tier A: over 1M ARR.");
		for (const path of ["../weather/SKILL.md", "/etc/passwd", "refs/../refs/tiers.md", "refs/other.md"]) expect(() => readSkillFile(skill, path)).toThrow();
		const skipped: string[] = [];
		applyTenantSkills([], [{ ...vip, content: { ...vip.content, files: { "../x.md": "x" } } }], (_, reason) => skipped.push(reason));
		expect(skipped).toHaveLength(1);
	});
});

describe("TurnPins", () => {
	it("keeps a turn's skills until that conversation's next turn, and a child uses its parent's", async () => {
		let current: readonly Skill[] = [weather];
		const pins = new TurnPins(async () => current, { max: 2 });
		const a = 1 as ConversationId;
		expect(await pins.start(a, "acme")).toEqual([weather]);
		current = applyTenantSkills([weather], [override("Acme weather v2")]);
		expect(await pins.of(a, "acme")).toEqual([weather]);
		expect(await pins.of(9 as ConversationId, "acme", a)).toEqual([weather]);
		expect(await pins.of(9 as ConversationId, "acme")).toBe(current);
		expect((await pins.start(a, "acme"))[0]?.flow?.title).toBe("Acme weather v2");
		// Only the newest conversations are held; a forgotten one reads the current skills.
		current = [weather];
		await pins.start(2 as ConversationId, "acme");
		await pins.start(3 as ConversationId, "acme");
		expect(await pins.of(a, "acme")).toBe(current);
	});
});

describe("TenantSkills", () => {
	function control(answers: Record<string, TenantSkillRecord[]>) {
		const calls: { tenant: string; etag: string | null }[] = [];
		let down = false;
		const fetch: typeof globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe("Bearer service-token");
			const tenant = url.searchParams.get("tenant")!;
			calls.push({ tenant, etag: headers.get("if-none-match") });
			if (down) throw new Error("connection refused");
			const tag = `"${JSON.stringify(answers[tenant] ?? []).length}"`;
			if (headers.get("if-none-match") === tag) return new Response(null, { status: 304 });
			return Response.json({ skills: answers[tenant] ?? [] }, { headers: { etag: tag } });
		}) as typeof globalThis.fetch;
		return { fetch, calls, setDown: (value: boolean) => (down = value) };
	}

	it("caches for freshMs, revalidates by ETag, adopts a publish and rides out an outage", async () => {
		let now = 1_000_000;
		const answers: Record<string, TenantSkillRecord[]> = { acme: [override("Acme weather")] };
		const fake = control(answers);
		const source = new TenantSkills([weather], { url: "http://control/", token: async () => "service-token", fetch: fake.fetch, now: () => now });

		expect(await source.forTenant(undefined)).toEqual([weather]);
		expect(fake.calls).toHaveLength(0);
		const [first, second] = await Promise.all([source.forTenant("acme"), source.forTenant("acme")]);
		expect(first[0]?.flow?.title).toBe("Acme weather");
		expect(second).toBe(first);
		expect(fake.calls).toHaveLength(1);
		expect((await source.forTenant("globex"))[0]).toBe(weather);

		now += 5_000;
		await source.forTenant("acme");
		expect(fake.calls).toHaveLength(2);

		now += 10_000;
		expect(await source.forTenant("acme")).toBe(first);
		expect(fake.calls.at(-1)?.etag).not.toBeNull();

		answers.acme = [override("Acme weather v2", undefined, 2)];
		now += 10_000;
		expect((await source.forTenant("acme"))[0]?.flow?.title).toBe("Acme weather v2");

		fake.setDown(true);
		now += 10_000;
		expect((await source.forTenant("acme"))[0]?.flow?.title).toBe("Acme weather v2");
		const calls = fake.calls.length;
		expect((await source.forTenant("acme"))[0]?.flow?.title).toBe("Acme weather v2");
		expect(fake.calls).toHaveLength(calls);

		now += 300_000;
		expect(await source.forTenant("acme")).toEqual([weather]);
	});

	it("rereads a tenant the change feed names, before its cache would turn over", async () => {
		const answers: Record<string, TenantSkillRecord[]> = { acme: [override("Acme weather")] };
		const fake = control(answers);
		let feed: { cursor: number; tenants: string[] }[] = [];
		const feedCalls: string[] = [];
		const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.pathname !== "/v1/runtime/skills/changes") return fake.fetch(input, init);
			feedCalls.push(url.search);
			const next = feed.shift();
			if (next === undefined) {
				await new Promise((resolve) => setTimeout(resolve, 20));
				return Response.json({ cursor: 7, tenants: [] });
			}
			return Response.json(next);
		}) as typeof globalThis.fetch;
		const source = new TenantSkills([weather], { url: "http://control", token: async () => "service-token", fetch, freshMs: 60_000 });
		expect((await source.forTenant("acme"))[0]?.flow?.title).toBe("Acme weather");
		feed = [{ cursor: 7, tenants: [] }, { cursor: 8, tenants: ["acme"] }];
		answers.acme = [override("Acme weather v2", undefined, 2)];
		const stop = new AbortController();
		const watching = source.watch(stop.signal, 10);
		await expect.poll(async () => (await source.forTenant("acme"))[0]?.flow?.title, { timeout: 3_000 }).toBe("Acme weather v2");
		stop.abort();
		await watching;
		expect(feedCalls[0]).toBe("");
		expect(feedCalls[1]).toBe("?after=7");
	});
});

describe("tenant skills in a running agent", () => {
	let running: TestAgent | undefined;
	let server: Server | undefined;
	afterEach(async () => {
		await running?.close();
		running = undefined;
		await new Promise((resolve) => (server === undefined ? resolve(undefined) : server.close(resolve)));
		server = undefined;
	});

	it("shows each tenant only its own skills, in skills.list, the prompt's index and load_skill", async () => {
		const answers: Record<string, TenantSkillRecord[]> = { ten_acme: [override("Acme weather"), vip] };
		const reads: string[] = [];
		const changes: string[] = [];
		let cursor = 0;
		const drafts: Record<string, TenantSkillRecord> = {
			"ten_acme/ada/vip-intake": { ...vip, version: 0, digest: "draft:x", content: { ...vip.content, description: "VIP intake (draft)", body: "Draft: ask for the region too." } },
		};
		const draftReads: string[] = [];
		server = createServer((req, res) => {
			const url = new URL(req.url!, "http://control");
			if (url.pathname === "/v1/runtime/skills/changes" && req.headers.authorization === "Bearer service-token") {
				// Held open briefly when nothing changed, as control does.
				setTimeout(() => {
					const tenants = changes.splice(0);
					if (tenants.length > 0) cursor++;
					res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ cursor, tenants }));
				}, 50);
				return;
			}
			if (url.pathname === "/v1/runtime/skills/draft" && req.headers.authorization === "Bearer service-token") {
				const draft = drafts[`${url.searchParams.get("tenant")}/${url.searchParams.get("author")}/${url.searchParams.get("name")}`];
				draftReads.push(`${url.searchParams.get("author")}/${url.searchParams.get("name")}`);
				if (draft === undefined) res.writeHead(404).end();
				else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(draft));
				return;
			}
			if (url.pathname !== "/v1/runtime/skills" || req.headers.authorization !== "Bearer service-token") {
				res.writeHead(403).end();
				return;
			}
			const tenant = url.searchParams.get("tenant")!;
			reads.push(tenant);
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ skills: answers[tenant] ?? [] }));
		});
		await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
		const controlUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

		const grants: GrantsConfig = { url: "http://auth.test", clientId: "agent-pi", clientSecret: "secret", actions: ["agent:use"], audiences: ["agent-pi"] };
		const authFetch = (async (input: string | URL | Request) => {
			if (new URL(String(input)).pathname === "/v1/token") return Response.json({ access_token: "service-token", expires_in: 300 });
			if (new URL(String(input)).pathname === "/v1/grants") return Response.json({ id: "grt_1" }, { status: 201 });
			return Response.json({ chain: [{ id: "grt_1" }] });
		}) as typeof fetch;
		const person = (tenantId: string, token: string, userId = "ada"): Principal => ({ userId, tenantId, scopes: ["agent:use"], claims: {}, token });
		const principals: Record<string, Principal> = { acme: person("ten_acme", "acme"), globex: person("ten_globex", "globex") };
		running = await startTestAgent({
			skills: [weather],
			config: { auth: { kind: "jwt", algorithms: ["HS256"], hmacSecret: "unused", issuer: [], audience: [] }, grants, tenantSkills: { url: controlUrl } },
			grantOptions: { fetch: authFetch, retryDelayMs: 1 },
			authenticator: { authenticate: async ({ headers }) => principals[String(headers.authorization).slice("Bearer ".length)]! },
		});

		const list = async (token: string) => (await rpc(running!.url, token, "skills.list")).body.result!.skills as { name: string; flow?: SkillFlow; source?: unknown }[];
		const acme = await list("acme");
		expect(acme.map((s) => s.name)).toEqual(["vip-intake", "weather"]);
		expect(acme[1]?.flow?.title).toBe("Acme weather");
		expect(acme[1]?.source).toMatchObject({ kind: "override", version: 1 });
		const globex = await list("globex");
		expect(globex.map((s) => s.name)).toEqual(["weather"]);
		expect(globex[0]?.flow?.title).toBe("Weather");

		// What an editor reads: one skill as the tenant sees it, and the tools it can pick from.
		const got = await rpc(running.url, "acme", "skills.get", { skill: "vip-intake" });
		expect(got.body.result?.skill).toMatchObject({ name: "vip-intake", body: "Ask for the VIP account number first.", files: ["refs/tiers.md"], source: { kind: "custom" } });
		expect((await rpc(running.url, "acme", "skills.get", { skill: "weather" })).body.result?.skill).toMatchObject({ body: weather.body, files: [], source: { kind: "override" } });
		expect((await rpc(running.url, "globex", "skills.get", { skill: "vip-intake" })).status).toBe(404);
		expect(Array.isArray((await rpc(running.url, "acme", "skills.tools")).body.result?.tools)).toBe(true);

		const loadVip = async (token: string, args: Record<string, string> = { name: "vip-intake" }, metadata?: Record<string, string>) => {
			const prompts: string[] = [];
			running!.faux.setResponses([
				(context) => {
					// The skill index is a system prompt section; its exact place in the context is pi-durable's.
					prompts.push(JSON.stringify(context));
					return fauxAssistantMessage([fauxToolCall("load_skill", args)], { stopReason: "toolUse" });
				},
				(context) => {
					const result = context.messages.at(-1);
					const text = result?.role === "toolResult" ? result.content.map((block) => ("text" in block ? block.text : "")).join("") : "";
					return fauxAssistantMessage([fauxText(text)]);
				},
			]);
			const sessionId = (await rpc(running!.url, token, "session.create", metadata === undefined ? {} : { metadata })).body.result!.sessionId as string;
			await rpcStream(running!.url, token, "session.prompt", { sessionId, input: "VIP onboarding please" });
			const transcript = await rpc(running!.url, token, "session.messages", { sessionId });
			return { prompt: prompts[0] ?? "", transcript: JSON.stringify(transcript.body.result) };
		};
		const forAcme = await loadVip("acme");
		expect(forAcme.prompt).toContain("- vip-intake: VIP intake");
		expect(forAcme.transcript).toContain("Ask for the VIP account number first.");
		expect(forAcme.transcript).toContain("Reference files (read one with load_skill and file): refs/tiers.md");
		expect((await loadVip("acme", { name: "vip-intake", file: "refs/tiers.md" })).transcript).toContain("Tier A: over 1M ARR.");
		const forGlobex = await loadVip("globex");
		expect(forGlobex.prompt).not.toContain("vip-intake");
		expect(forGlobex.transcript).toContain("Unknown skill");
		expect(new Set(reads)).toEqual(new Set(["ten_acme", "ten_globex"]));

		// A test conversation uses its owner's draft; everyone else, and every other conversation, the published skill.
		const tested = await loadVip("acme", { name: "vip-intake" }, { skillDraft: "vip-intake" });
		expect(tested.prompt).toContain("- vip-intake: VIP intake (draft)");
		expect(tested.transcript).toContain("Draft: ask for the region too.");
		expect(draftReads).toContain("ada/vip-intake");
		const plain = await loadVip("acme");
		expect(plain.transcript).toContain("Ask for the VIP account number first.");
		principals.bob = person("ten_acme", "bob", "bob");
		const someoneElse = await loadVip("bob", { name: "vip-intake" }, { skillDraft: "vip-intake" });
		expect(someoneElse.transcript).toContain("Ask for the VIP account number first.");
		expect(draftReads).toContain("bob/vip-intake");

		// A publish reaches the next turn through the change feed, well inside the 10-second cache.
		answers.ten_acme = [override("Acme weather v2", undefined, 2), vip];
		changes.push("ten_acme");
		const started = Date.now();
		await expect.poll(async () => (await list("acme"))[1]?.flow?.title, { timeout: 5_000, interval: 100 }).toBe("Acme weather v2");
		expect(Date.now() - started).toBeLessThan(5_000);
	});
});
