import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import {
	discoverSkills,
	executeDeterministicFlow,
	type FlowRunTrace,
	type Skill,
	type SkillFlow,
	synthesizeSkillFlow,
	validateSkillFlow,
} from "../src/index.ts";
import { events, fakeMcpServer, rpc, rpcStream, startTestAgent, type TestAgent, TOKENS } from "../src/testing.ts";

let running: TestAgent | undefined;
afterEach(async () => {
	await running?.close();
	running = undefined;
});

const visitFlow = JSON.parse(
	readFileSync(new URL("./fixtures/customer-visit-preparation.flow.json", import.meta.url), "utf8"),
) as SkillFlow;

describe("SkillFlow validation & synthesis", () => {
	it("validates a well-formed DAG and collects all referenced tools", () => {
		const { tools } = validateSkillFlow(visitFlow);
		expect([...tools].sort()).toEqual(
			[
				"find_product_documents",
				"find_success_cases",
				"get_company",
				"list_activities",
				"list_companies",
				"list_contacts",
				"list_deals",
				"search_quote_catalog",
			].sort(),
		);
	});

	it("rejects cycles and unknown branch targets", () => {
		const cyclic: SkillFlow = {
			id: "cyclic",
			title: "Cyclic",
			mode: "deterministic",
			nodes: [
				{ id: "a", kind: "start", label: "A" },
				{ id: "b", kind: "tool", label: "B" },
			],
			edges: [
				{ id: "e1", source: "a", target: "b" },
				{ id: "e2", source: "b", target: "a" },
			],
		};
		expect(() => validateSkillFlow(cyclic)).toThrow(/cycle detected/);
	});

	it("synthesizes a guided visual flow from SKILL.md headings and tools when flow.json is absent", () => {
		const flow = synthesizeSkillFlow({
			name: "crm-lookup",
			description: "Look up CRM companies and contacts.",
			tools: ["list_companies", "get_company"],
			body: "### 1. Search Company\nUse `list_companies`.\n### 2. Inspect Details\nUse `get_company`.",
		});
		expect(flow.mode).toBe("guided");
		expect(flow.nodes.map((n) => n.kind)).toEqual(["start", "tool", "tool", "llm_reply"]);
		expect(validateSkillFlow(flow).tools).toEqual(["list_companies", "get_company"]);
	});
});

describe("executeDeterministicFlow", () => {
	it("runs parallel CRM and product lookups concurrently when 1 company matches, skipping ask_disambiguate", async () => {
		const calls: string[] = [];
		const updates: FlowRunTrace[] = [];
		const result = await executeDeterministicFlow(visitFlow, {
			input: "帮我准备字节跳动的客户拜访简报，客户很关心报价",
			language: "zh",
			onUpdate: (trace) => {
				updates.push(trace);
			},
			callTool: async (name, args) => {
				calls.push(`${name}:${JSON.stringify(args)}`);
				switch (name) {
					case "list_companies":
						return { output: JSON.stringify([{ id: "comp_1", name: "字节跳动", industry: "互联网" }]) };
					case "get_company":
						return { output: JSON.stringify({ id: "comp_1", name: "字节跳动", size: "10000+" }) };
					case "list_deals":
						return { output: JSON.stringify([{ id: "deal_1", title: "企业AI平台升级" }]) };
					case "list_activities":
						return { output: JSON.stringify([{ id: "act_1", note: "上周技术交流" }]) };
					case "find_product_documents":
						return { output: JSON.stringify([{ id: "doc_1", title: "智能工作台白皮书" }]) };
					case "find_success_cases":
						return { output: JSON.stringify([{ id: "case_1", title: "头部互联网客户案例" }]) };
					case "search_quote_catalog":
						return { output: JSON.stringify([{ id: "q_1", sku: "ENT-PRO", price: "¥198,000/yr" }]) };
					default:
						return { output: "[]" };
				}
			},
		});

		expect(result.status).toBe("completed");
		expect(result.vars).toMatchObject({ company: "字节跳动", relationshipOnly: false, includeQuote: true });
		expect(result.trace.llmCallsSaved).toBe(3);
		expect(result.trace.parallelToolsRun).toBe(6);
		const byStep = new Map(result.trace.steps.map((s) => [s.stepId, s.status]));
		expect(byStep.get("ask_disambiguate")).toBe("skipped");
		expect(byStep.get("crm_facts")).toBe("completed");
		expect(byStep.get("product_cases")).toBe("completed");
		expect(byStep.get("reply")).toBe("completed");
		expect(result.evidenceBlock).toContain('<step id="company_detail" status="completed">');
		expect(result.evidenceBlock).toContain("ENT-PRO");
		expect(updates.length).toBeGreaterThan(4);
	});

	it("halts at ask_disambiguate (needs_input) with 0 LLM calls when >1 candidate companies match", async () => {
		const result = await executeDeterministicFlow(visitFlow, {
			input: "准备华为的拜访简报",
			language: "zh",
			callTool: async (name) => {
				if (name === "list_companies") {
					return {
						output: JSON.stringify([
							{ id: "c1", name: "华为技术有限公司", city: "深圳" },
							{ id: "c2", name: "华为云计算技术有限公司", city: "贵阳" },
						]),
					};
				}
				throw new Error(`unexpected tool call ${name}`);
			},
		});

		expect(result.status).toBe("needs_input");
		expect(result.immediateReply).toContain("1. 华为技术有限公司 (深圳)");
		expect(result.immediateReply).toContain("2. 华为云计算技术有限公司 (贵阳)");
		const byStep = new Map(result.trace.steps.map((s) => [s.stepId, s.status]));
		expect(byStep.get("ask_disambiguate")).toBe("needs_input");
		expect(byStep.get("crm_facts")).toBe("skipped");
		expect(byStep.get("product_cases")).toBe("skipped");
		expect(byStep.get("reply")).toBe("skipped");
	});

	it("skips crm_facts when 0 companies match in CRM, but joins cleanly at product_cases", async () => {
		const called: string[] = [];
		const result = await executeDeterministicFlow(visitFlow, {
			input: "准备星辰大海科技的拜访简报",
			language: "zh",
			callTool: async (name) => {
				called.push(name);
				return { output: "[]" };
			},
		});

		expect(result.status).toBe("completed");
		expect(called).toEqual(["list_companies", "find_product_documents", "find_success_cases"]);
		const byStep = new Map(result.trace.steps.map((s) => [s.stepId, s.status]));
		expect(byStep.get("crm_facts")).toBe("skipped");
		expect(byStep.get("product_cases")).toBe("completed");
	});
});

describe("flow joins and evidence", () => {
	const joinFlow = (edges: SkillFlow["edges"]): SkillFlow => ({
		id: "j",
		title: "Join",
		mode: "deterministic",
		nodes: [
			{ id: "gate", kind: "switch", label: "Gate", branches: [], defaultTarget: "after" },
			{ id: "skipped", kind: "tool", label: "Skipped", call: { tool: "not_called" } },
			{ id: "after", kind: "tool", label: "After", call: { tool: "called" } },
		],
		edges,
	});
	const toSkipped = { id: "a", source: "gate", target: "skipped" };
	const toJoin = { id: "b", source: "gate", target: "after" };
	const skippedToJoin = { id: "c", source: "skipped", target: "after" };

	it.each([
		[[toSkipped, toJoin, skippedToJoin]],
		[[toJoin, toSkipped, skippedToJoin]],
		[[skippedToJoin, toJoin, toSkipped]],
	])("runs a join whichever order its edges are listed: %j", async (edges) => {
		const called: string[] = [];
		const result = await executeDeterministicFlow(joinFlow(edges), {
			input: "x",
			callTool: async (name) => {
				called.push(name);
				return { output: "[]" };
			},
		});
		expect(called).toEqual(["called"]);
		const byStep = new Map(result.trace.steps.map((s) => [s.stepId, s.status]));
		expect(byStep.get("after")).toBe("completed");
		expect(byStep.get("skipped")).toBe("skipped");
	});

	it("puts a stored result in the evidence once, and later steps read it by either name", async () => {
		const flow: SkillFlow = {
			id: "e",
			title: "Evidence",
			mode: "deterministic",
			nodes: [
				{ id: "look", kind: "tool", label: "Look", call: { tool: "look", storeAs: "found" } },
				{ id: "plain", kind: "tool", label: "Plain", call: { tool: "plain" } },
				{ id: "then", kind: "switch", label: "Then", branches: [{ id: "b", label: "Both", when: "steps.look.count == 1 && steps.found.count == 1", target: "yes" }] },
				{ id: "yes", kind: "llm_reply", label: "Yes" },
			],
			edges: [
				{ id: "1", source: "look", target: "plain" },
				{ id: "2", source: "plain", target: "then" },
				{ id: "3", source: "then", target: "yes" },
			],
		};
		const result = await executeDeterministicFlow(flow, {
			input: "x",
			callTool: async (name) => ({ output: name === "look" ? JSON.stringify([{ id: "a", name: "marker" }]) : "[]" }),
		});
		expect(result.evidenceBlock?.match(/marker/g)).toHaveLength(1);
		expect(result.evidenceBlock).toContain('<step id="found"');
		expect(result.evidenceBlock).toContain('<step id="plain"');
		expect(result.trace.steps.find((s) => s.stepId === "yes")?.status).toBe("completed");
	});
});

describe("agent-pi end-to-end flow events & skills.list", () => {
	it("exposes skill flows in skills.list, runs deterministic flow in load_skill, and emits flow.updated events", async () => {
		const skills = discoverSkills(new URL("../../../apps/assistant/skills", import.meta.url).pathname).filter((skill) => skill.name === "weather");
		const mcp = fakeMcpServer([
			{
				name: "get_forecast",
				description: "Get weather forecast",
				call: async (args) => JSON.stringify({ place: (args as { place?: string }).place, temp: "22°C", condition: "Sunny" }),
			},
		]);
		const weatherSkill: Skill = {
			...skills[0]!,
			tools: ["crm:get_forecast"],
			flow: {
				...skills[0]!.flow!,
				nodes: skills[0]!.flow!.nodes.map((n) =>
					n.id === "fetch_forecast"
						? { ...n, tools: ["crm:get_forecast"], call: { tool: "crm_get_forecast", args: { place: "$vars.place" }, storeAs: "forecast" } }
						: n,
				),
			},
		};
		running = await startTestAgent({ mcp, skills: [weatherSkill] });

		const listed = await rpc(running.url, TOKENS.alice, "skills.list");
		expect(listed.status).toBe(200);
		const listedSkills = listed.body.result!.skills as { name: string; flow?: SkillFlow }[];
		expect(listedSkills[0]?.name).toBe("weather");
		expect(listedSkills[0]?.flow?.mode).toBe("deterministic");

		running.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("load_skill", { name: "weather", query: "What is the weather in Tokyo?" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("Tokyo is Sunny, 22°C.")]),
		]);

		const created = await rpc(running.url, TOKENS.alice, "session.create");
		const sessionId = created.body.result!.sessionId as string;
		const { messages } = await rpcStream(running.url, TOKENS.alice, "session.prompt", {
			sessionId,
			input: "What is the weather in Tokyo?",
		});

		const bodies = events(messages);
		const flowEvents = bodies.filter((e) => e.type === "flow.updated");
		expect(flowEvents.length).toBeGreaterThan(0);
		expect(flowEvents.at(-1)).toMatchObject({
			type: "flow.updated",
			trace: { flowId: "weather", status: "completed" },
		});

		const details = await rpc(running.url, TOKENS.alice, "session.get", { sessionId });
		expect(details.body.result?.flow).toMatchObject({
			flowId: "weather",
			status: "completed",
		});

		// skills.checkFlow checks an edit as the harness will when a tenant publishes it, and saves nothing.
		const checked = await rpc(running.url, TOKENS.alice, "skills.checkFlow", {
			skill: "weather",
			flow: { ...weatherSkill.flow!, title: "Updated Weather Flow" },
		});
		expect(checked.status).toBe(200);
		expect((checked.body.result?.flow as SkillFlow).title).toBe("Updated Weather Flow");
		expect(checked.body.result?.tools).toContain("crm_get_forecast");

		// An override may only call the built-in skill's tools.
		const rejected = await rpc(running.url, TOKENS.alice, "skills.checkFlow", {
			skill: "weather",
			flow: {
				...weatherSkill.flow!,
				nodes: [...weatherSkill.flow!.nodes, { id: "bad_tool", kind: "tool", label: "Bad", tools: ["delete_everything"] }],
			},
		});
		expect(rejected.status).toBe(400);

		// A new name checks a custom skill, whose flow may only call the tools it lists.
		const flow = {
			id: "contract_risk_check",
			title: "Contract Risk Check",
			mode: "deterministic",
			nodes: [
				{ id: "start", kind: "start", label: "Start" },
				{ id: "lookup", kind: "tool", label: "Lookup", call: { tool: "crm_get_forecast" } },
				{ id: "reply", kind: "llm_reply", label: "Synthesize" },
			],
			edges: [
				{ id: "e1", source: "start", target: "lookup" },
				{ id: "e2", source: "lookup", target: "reply" },
			],
		};
		expect((await rpc(running.url, TOKENS.alice, "skills.checkFlow", { skill: "contract_risk_check", flow })).status).toBe(400);
		const custom = await rpc(running.url, TOKENS.alice, "skills.checkFlow", { skill: "contract_risk_check", flow, tools: ["crm:get_forecast"] });
		expect(custom.status).toBe(200);
		expect((custom.body.result?.flow as SkillFlow).id).toBe("contract_risk_check");

		const after = await rpc(running.url, TOKENS.alice, "skills.list", {});
		const names = (after.body.result?.skills as Array<{ name: string; flow?: SkillFlow }>).map((s) => s.name);
		expect(names).toEqual(["weather"]);
		expect((after.body.result?.skills as Array<{ flow?: SkillFlow }>)[0]?.flow?.title).not.toBe("Updated Weather Flow");
	});
});
