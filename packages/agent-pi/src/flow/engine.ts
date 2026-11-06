import type {
	FlowEdge,
	FlowExtractField,
	FlowNode,
	FlowRunTrace,
	FlowStepToolCall,
	FlowStepTrace,
	SkillFlow,
} from "./types.ts";

export type ToolCallOutcome = {
	readonly output: string;
	readonly parsed?: unknown;
	readonly isError?: boolean;
};

export type FlowExecuteOptions = {
	readonly input: string;
	readonly language?: "zh" | "en";
	readonly initialVars?: Readonly<Record<string, unknown>>;
	readonly callTool: (name: string, args: Record<string, unknown>) => Promise<ToolCallOutcome>;
	readonly onUpdate?: (trace: FlowRunTrace) => void | Promise<void>;
};

export type FlowExecutionResult = {
	readonly status: "completed" | "needs_input" | "failed";
	readonly trace: FlowRunTrace;
	readonly vars: Readonly<Record<string, unknown>>;
	readonly stepOutputs: Readonly<Record<string, unknown>>;
	/** Present when an `ask_user` node halted the flow to disambiguate or request missing input. */
	readonly immediateReply?: string;
	/** Structured evidence block to feed into the final LLM synthesis turn. */
	readonly evidenceBlock?: string;
	readonly toolsUsed: readonly string[];
};

/** Validates a `SkillFlow` for unique node IDs, valid edge endpoints, switch targets, and DAG acyclicity. */
export function validateSkillFlow(flow: SkillFlow): { readonly tools: readonly string[]; readonly flow: SkillFlow } {
	if (!flow.id || typeof flow.id !== "string") throw new Error("SkillFlow requires a non-empty id");
	if (!Array.isArray(flow.nodes) || flow.nodes.length === 0) throw new Error(`SkillFlow ${flow.id}: nodes must be non-empty`);
	const byId = new Map<string, FlowNode>();
	const tools = new Set<string>();
	const normalizedNodes: FlowNode[] = [];
	for (const node of flow.nodes) {
		if (!node.id) throw new Error(`SkillFlow ${flow.id}: node missing id`);
		if (byId.has(node.id)) throw new Error(`SkillFlow ${flow.id}: duplicate node id ${node.id}`);
		const nodeTools = new Set<string>(node.tools ?? []);
		if (node.call?.tool) nodeTools.add(node.call.tool);
		for (const item of node.parallel ?? []) nodeTools.add(item.tool);
		for (const tool of nodeTools) tools.add(tool);
		const normalized: FlowNode = nodeTools.size > 0 && (node.tools === undefined || node.tools.length === 0)
			? { ...node, tools: [...nodeTools] }
			: node;
		byId.set(node.id, normalized);
		normalizedNodes.push(normalized);
	}
	const adj = new Map<string, string[]>();
	for (const edge of flow.edges) {
		if (!byId.has(edge.source)) throw new Error(`SkillFlow ${flow.id}: edge ${edge.id} references unknown source ${edge.source}`);
		if (!byId.has(edge.target)) throw new Error(`SkillFlow ${flow.id}: edge ${edge.id} references unknown target ${edge.target}`);
		const list = adj.get(edge.source) ?? [];
		list.push(edge.target);
		adj.set(edge.source, list);
	}
	for (const node of flow.nodes) {
		if (node.kind === "switch") {
			for (const branch of node.branches ?? []) {
				if (!byId.has(branch.target)) {
					throw new Error(`SkillFlow ${flow.id}: switch ${node.id} branch ${branch.id} targets unknown node ${branch.target}`);
				}
			}
			if (node.defaultTarget !== undefined && !byId.has(node.defaultTarget)) {
				throw new Error(`SkillFlow ${flow.id}: switch ${node.id} defaultTarget references unknown node ${node.defaultTarget}`);
			}
		}
	}
	// Cycle detection (3-color DFS)
	const color = new Map<string, 0 | 1 | 2>();
	const visit = (id: string): void => {
		color.set(id, 1);
		for (const next of adj.get(id) ?? []) {
			const c = color.get(next) ?? 0;
			if (c === 1) throw new Error(`SkillFlow ${flow.id}: cycle detected involving node ${next}`);
			if (c === 0) visit(next);
		}
		color.set(id, 2);
	};
	for (const node of flow.nodes) {
		if ((color.get(node.id) ?? 0) === 0) visit(node.id);
	}
	return { tools: [...tools], flow: { ...flow, nodes: normalizedNodes } };
}

/**
 * Synthesizes a visual `SkillFlow` (`mode: "guided"`) from a skill's markdown headings and tool list when no explicit
 * `flow.json` is present, so every skill in the catalog can be visualized.
 */
export function synthesizeSkillFlow(skill: {
	readonly name: string;
	readonly description: string;
	readonly tools: readonly string[];
	readonly body: string;
}): SkillFlow {
	const headings: { title: string; body: string }[] = [];
	const lines = skill.body.split(/\r?\n/);
	let current: { title: string; lines: string[] } | undefined;
	for (const line of lines) {
		const h3 = /^#{2,3}\s+(?:\d+\.\s*)?(.+)$/.exec(line.trim());
		const numbered = headings.length === 0 ? /^\d+\.\s+(.+)$/.exec(line.trim()) : null;
		if (h3 !== null) {
			if (current !== undefined) headings.push({ title: current.title, body: current.lines.join("\n") });
			current = { title: h3[1]!.trim(), lines: [] };
		} else if (numbered !== null) {
			headings.push({ title: numbered[1]!.slice(0, 48), body: line });
		} else if (current !== undefined) {
			current.lines.push(line);
		}
	}
	if (current !== undefined) headings.push({ title: current.title, body: current.lines.join("\n") });

	const bareTools = skill.tools.map((t) => (t.includes(":") ? t.split(":")[1]! : t));
	const nodes: FlowNode[] = [
		{
			id: "start",
			kind: "start",
			label: "User Request",
			labelZh: "用户请求",
			description: `Match skill: ${skill.name}`,
			descriptionZh: `匹配技能：${skill.name}`,
		},
	];
	const edges: FlowEdge[] = [];
	let prevId = "start";

	const steps = headings.slice(0, 4);
	if (steps.length > 0) {
		steps.forEach((sec, idx) => {
			const id = `step_${idx + 1}`;
			const matched = bareTools.filter((tool) => !tool.includes("*") && sec.body.includes(tool));
			const assigned = matched.length > 0 ? matched : idx === 0 && bareTools.length > 0 ? bareTools.slice(0, 3) : [];
			nodes.push({
				id,
				kind: assigned.length > 1 ? "parallel" : assigned.length === 1 ? "tool" : "extract",
				label: sec.title,
				labelZh: sec.title,
				...(assigned.length > 0 ? { tools: assigned } : {}),
			});
			edges.push({ id: `${prevId}->${id}`, source: prevId, target: id });
			prevId = id;
		});
	} else if (bareTools.length > 0) {
		const id = "tools";
		nodes.push({
			id,
			kind: bareTools.length > 1 ? "parallel" : "tool",
			label: bareTools.length > 1 ? "Execute Skill Tools" : `Call ${bareTools[0]}`,
			labelZh: bareTools.length > 1 ? "并行调用技能工具" : `调用 ${bareTools[0]}`,
			tools: bareTools,
		});
		edges.push({ id: `${prevId}->${id}`, source: prevId, target: id });
		prevId = id;
	}

	nodes.push({
		id: "reply",
		kind: "llm_reply",
		label: "Synthesize Response",
		labelZh: "生成结构化回复",
		description: skill.description,
		descriptionZh: skill.description,
	});
	edges.push({ id: `${prevId}->reply`, source: prevId, target: "reply" });

	return {
		id: skill.name,
		title: skill.name,
		titleZh: skill.name,
		mode: "guided",
		nodes,
		edges,
	};
}

function extractValue(input: string, field: FlowExtractField): unknown {
	if (field.keywords !== undefined) {
		const lowered = input.toLowerCase();
		for (const [kw, mapped] of Object.entries(field.keywords)) {
			if (lowered.includes(kw.toLowerCase())) return mapped;
		}
	}
	if (field.pattern !== undefined) {
		const regex = new RegExp(field.pattern, "i");
		// Bounded, because a tenant writes the pattern and it runs in the shared process.
		const match = regex.exec(input.slice(0, 2000));
		const captured = match?.[1]?.trim() ?? match?.[0]?.trim();
		if (captured !== undefined && captured.length > 0) return captured;
	}
	if (field.fallbackInput === true) {
		return cleanQueryInput(input);
	}
	return field.default;
}

/** Strips common conversational prefixes/suffixes to isolate an entity name or query when fallbackInput is used. */
export function cleanQueryInput(input: string): string {
	return input
		.replace(/^(请|帮我|麻烦|能|可以)?(准备|生成|整理|查询|查一下|看看|看看关于|获取|做一份)?/u, "")
		.replace(/(的)?(客户)?(拜访简报|拜访准备|拜访材料|沟通材料|客户背景|项目交流|天气预报|天气|销售日报|销售周报|销售月报).*$/u, "")
		.replace(/^(what('s| is) the )?(weather|forecast) (in|for|at) /i, "")
		.replace(/[?？!！。.，,\s]+$/u, "")
		.trim() || input.trim();
}

function lookupPath(path: string, context: { vars: Record<string, unknown>; steps: Record<string, unknown>; input: string }): unknown {
	const trimmed = path.trim();
	if (trimmed === "$input" || trimmed === "input") return context.input;
	const normalized = trimmed.startsWith("$") ? trimmed.slice(1) : trimmed;
	const parts = normalized.split(".");
	let cursor: unknown = context;
	for (const part of parts) {
		if (cursor === null || cursor === undefined || typeof cursor !== "object") return undefined;
		cursor = (cursor as Record<string, unknown>)[part];
	}
	return cursor;
}

function resolveTemplateValue(value: unknown, context: { vars: Record<string, unknown>; steps: Record<string, unknown>; input: string }): unknown {
	if (typeof value === "string") {
		if (value.startsWith("$")) return lookupPath(value, context);
		return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
			const resolved = lookupPath(expr, context);
			if (resolved === undefined || resolved === null) return "";
			return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
		});
	}
	if (Array.isArray(value)) return value.map((item) => resolveTemplateValue(item, context));
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			const resolved = resolveTemplateValue(v, context);
			if (resolved !== undefined && resolved !== "") out[k] = resolved;
		}
		return out;
	}
	return value;
}

/** Evaluates simple deterministic expressions like `steps.lookup.count > 1` or `vars.period == 'weekly'`. */
export function evaluateCondition(expr: string, context: { vars: Record<string, unknown>; steps: Record<string, unknown>; input: string }): boolean {
	const orParts = expr.split(/\s*\|\|\s*/);
	if (orParts.length > 1) return orParts.some((part) => evaluateCondition(part, context));
	const andParts = expr.split(/\s*&&\s*/);
	if (andParts.length > 1) return andParts.every((part) => evaluateCondition(part, context));

	const match = /^([a-zA-Z0-9_$.]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/.exec(expr.trim());
	if (match === null) {
		const val = lookupPath(expr.trim(), context);
		return Boolean(val);
	}
	const [, lhsPath, op, rhsRaw] = match;
	const lhs = lookupPath(lhsPath!, context);
	const rhsTrim = rhsRaw!.trim();
	let rhs: unknown = rhsTrim;
	if ((rhsTrim.startsWith("'") && rhsTrim.endsWith("'")) || (rhsTrim.startsWith('"') && rhsTrim.endsWith('"'))) {
		rhs = rhsTrim.slice(1, -1);
	} else if (rhsTrim === "true") rhs = true;
	else if (rhsTrim === "false") rhs = false;
	else if (rhsTrim === "null" || rhsTrim === "undefined") rhs = undefined;
	else if (!Number.isNaN(Number(rhsTrim))) rhs = Number(rhsTrim);

	switch (op) {
		case "==":
			return lhs === rhs;
		case "!=":
			return lhs !== rhs;
		case ">":
			return typeof lhs === "number" && typeof rhs === "number" && lhs > rhs;
		case "<":
			return typeof lhs === "number" && typeof rhs === "number" && lhs < rhs;
		case ">=":
			return typeof lhs === "number" && typeof rhs === "number" && lhs >= rhs;
		case "<=":
			return typeof lhs === "number" && typeof rhs === "number" && lhs <= rhs;
		default:
			return false;
	}
}

function summarizeToolOutput(raw: string, parsed: unknown): {
	readonly count: number;
	readonly items: readonly Record<string, unknown>[];
	readonly firstId?: string;
	readonly firstName?: string;
	readonly candidateNames: string;
	readonly summary: string;
	readonly data: unknown;
} {
	let items: Record<string, unknown>[] = [];
	if (Array.isArray(parsed)) {
		items = parsed.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object");
	} else if (parsed !== null && typeof parsed === "object") {
		const record = parsed as Record<string, unknown>;
		for (const key of ["items", "companies", "contacts", "deals", "activities", "documents", "cases", "results", "data"]) {
			if (Array.isArray(record[key])) {
				items = (record[key] as unknown[]).filter((item): item is Record<string, unknown> => item !== null && typeof item === "object");
				break;
			}
		}
		if (items.length === 0 && ("id" in record || "name" in record || "companyId" in record)) {
			items = [record];
		}
	}
	const first = items[0];
	const firstId = typeof first?.id === "string" ? first.id : typeof first?.companyId === "string" ? first.companyId : undefined;
	const firstName = typeof first?.name === "string" ? first.name : typeof first?.title === "string" ? first.title : undefined;
	const names = items
		.map((item, idx) => {
			const label = typeof item.name === "string" ? item.name : typeof item.title === "string" ? item.title : `#${idx + 1}`;
			const extra = typeof item.industry === "string" ? ` (${item.industry})` : typeof item.city === "string" ? ` (${item.city})` : "";
			return `${idx + 1}. ${label}${extra}`;
		})
		.join("\n");
	return {
		count: items.length,
		items,
		...(firstId === undefined ? {} : { firstId }),
		...(firstName === undefined ? {} : { firstName }),
		candidateNames: names,
		summary: items.length > 0 ? `${items.length} record(s)` : raw.slice(0, 80),
		data: parsed ?? raw,
	};
}

/**
 * Executes a deterministic `SkillFlow` step-by-step:
 * - Resolves `extract` slots without an LLM call
 * - Runs `tool` and `parallel` (`Promise.all`) MCP tool calls directly
 * - Evaluates `switch` conditions and propagates `skipped` (`SKIP`) across untaken branches
 * - Halts with `immediateReply` on `ask_user` (`needs_input`)
 * - Produces a structured `<flow_evidence>` block for the final `llm_reply` synthesis
 */
export async function executeDeterministicFlow(flow: SkillFlow, options: FlowExecuteOptions): Promise<FlowExecutionResult> {
	validateSkillFlow(flow);
	const startedAt = Date.now();
	const vars: Record<string, unknown> = { ...(options.initialVars ?? {}) };
	const steps: Record<string, unknown> = {};
	const toolsUsed: string[] = [];
	let llmCallsSaved = 0;
	let parallelToolsRun = 0;

	const nodesById = new Map(flow.nodes.map((node) => [node.id, node]));
	const outEdges = new Map<string, FlowEdge[]>();
	const inEdges = new Map<string, FlowEdge[]>();
	for (const edge of flow.edges) {
		const o = outEdges.get(edge.source) ?? [];
		o.push(edge);
		outEdges.set(edge.source, o);
		const i = inEdges.get(edge.target) ?? [];
		i.push(edge);
		inEdges.set(edge.target, i);
	}

	const traces = new Map<string, FlowStepTrace>(
		flow.nodes.map((node) => [node.id, { stepId: node.id, status: "pending" }]),
	);
	const edgeState = new Map<string, "pending" | "active" | "skipped">(
		flow.edges.map((edge) => [edge.id, "pending"]),
	);

	const snapshot = (status: FlowRunTrace["status"]): FlowRunTrace => ({
		flowId: flow.id,
		skill: flow.id,
		title: flow.title,
		...(flow.titleZh === undefined ? {} : { titleZh: flow.titleZh }),
		mode: flow.mode,
		status,
		startedAt,
		totalDurationMs: Math.max(1, Date.now() - startedAt),
		llmCallsSaved,
		parallelToolsRun,
		steps: flow.nodes.map((node) => traces.get(node.id)!),
	});

	const notify = async (status: FlowRunTrace["status"] = "running") => {
		await options.onUpdate?.(snapshot(status));
	};

	// Skips a node and what only it leads to, and returns the nodes this leaves ready: a step another
	// branch reached can be waiting on nothing but this one's edge.
	const propagateSkip = (nodeId: string): string[] => {
		const current = traces.get(nodeId);
		if (current !== undefined && current.status === "pending") {
			traces.set(nodeId, { stepId: nodeId, status: "skipped" });
		}
		const ready: string[] = [];
		for (const edge of outEdges.get(nodeId) ?? []) {
			if (edgeState.get(edge.id) === "pending") {
				edgeState.set(edge.id, "skipped");
				const incoming = inEdges.get(edge.target) ?? [];
				if (incoming.every((inc) => edgeState.get(inc.id) === "skipped")) {
					ready.push(...propagateSkip(edge.target));
				} else if (!incoming.some((inc) => edgeState.get(inc.id) === "pending") && traces.get(edge.target)?.status === "pending") {
					ready.push(edge.target);
				}
			}
		}
		return ready;
	};

	const activateOutEdges = (nodeId: string, chosenTarget?: string): string[] => {
		const nextReady: string[] = [];
		for (const edge of outEdges.get(nodeId) ?? []) {
			if (chosenTarget === undefined || edge.target === chosenTarget || edge.branch === chosenTarget) {
				edgeState.set(edge.id, "active");
			} else {
				edgeState.set(edge.id, "skipped");
			}
		}
		for (const edge of outEdges.get(nodeId) ?? []) {
			const target = edge.target;
			const incoming = inEdges.get(target) ?? [];
			if (incoming.some((inc) => edgeState.get(inc.id) === "pending")) continue;
			if (incoming.every((inc) => edgeState.get(inc.id) === "skipped")) {
				nextReady.push(...propagateSkip(target));
			} else if (traces.get(target)?.status === "pending") {
				nextReady.push(target);
			}
		}
		return nextReady;
	};

	const roots = flow.nodes.filter((node) => (inEdges.get(node.id)?.length ?? 0) === 0).map((node) => node.id);
	const queue: string[] = [...roots];

	while (queue.length > 0) {
		const nodeId = queue.shift()!;
		const node = nodesById.get(nodeId);
		if (node === undefined || traces.get(nodeId)?.status !== "pending") continue;

		const stepStart = Date.now();
		traces.set(nodeId, { stepId: nodeId, status: "running" });
		await notify("running");

		const ctx = { vars, steps, input: options.input };

		if (node.kind === "start") {
			traces.set(nodeId, { stepId: nodeId, status: "completed", durationMs: Math.max(1, Date.now() - stepStart) });
			queue.push(...activateOutEdges(nodeId));
			await notify("running");
			continue;
		}

		if (node.kind === "extract") {
			for (const [key, spec] of Object.entries(node.extract ?? {})) {
				const extracted = extractValue(options.input, spec);
				if (extracted !== undefined) vars[key] = extracted;
			}
			steps[nodeId] = { ...vars };
			traces.set(nodeId, {
				stepId: nodeId,
				status: "completed",
				durationMs: Math.max(1, Date.now() - stepStart),
				summary: Object.entries(vars)
					.map(([k, v]) => `${k}=${String(v)}`)
					.join(", "),
			});
			queue.push(...activateOutEdges(nodeId));
			await notify("running");
			continue;
		}

		if (node.kind === "tool" && node.call !== undefined) {
			const toolName = node.call.tool;
			const args = (resolveTemplateValue(node.call.args ?? {}, ctx) ?? {}) as Record<string, unknown>;
			traces.set(nodeId, {
				stepId: nodeId,
				status: "running",
				toolCalls: [{ name: toolName, status: "running" }],
			});
			await notify("running");

			const callStart = Date.now();
			const outcome = await options.callTool(toolName, args);
			const callDuration = Math.max(1, Date.now() - callStart);
			toolsUsed.push(toolName);
			llmCallsSaved += 1;

			let parsed = outcome.parsed;
			if (parsed === undefined && outcome.output.trim().startsWith("{") || outcome.output.trim().startsWith("[")) {
				try {
					parsed = JSON.parse(outcome.output);
				} catch {
					// text output
				}
			}
			const info = summarizeToolOutput(outcome.output, parsed);
			const key = node.call.storeAs ?? nodeId;
			steps[key] = { ...info, isError: outcome.isError === true, raw: outcome.output };
			steps[nodeId] = steps[key];

			traces.set(nodeId, {
				stepId: nodeId,
				status: outcome.isError === true ? "failed" : "completed",
				durationMs: callDuration,
				summary: info.summary,
				toolCalls: [{ name: toolName, status: outcome.isError === true ? "failed" : "done", durationMs: callDuration }],
			});
			queue.push(...activateOutEdges(nodeId));
			await notify("running");
			continue;
		}

		if (node.kind === "parallel" && node.parallel !== undefined) {
			const runnable = node.parallel.filter((item) => item.when === undefined || evaluateCondition(item.when, ctx));
			const skippedCalls: FlowStepToolCall[] = node.parallel
				.filter((item) => !runnable.includes(item))
				.map((item) => ({ name: item.tool, status: "skipped" as const }));

			traces.set(nodeId, {
				stepId: nodeId,
				status: "running",
				toolCalls: [...runnable.map((item) => ({ name: item.tool, status: "running" as const })), ...skippedCalls],
			});
			await notify("running");

			const outcomes = await Promise.all(
				runnable.map(async (item) => {
					const callStart = Date.now();
					const args = (resolveTemplateValue(item.args ?? {}, ctx) ?? {}) as Record<string, unknown>;
					const outcome = await options.callTool(item.tool, args);
					const durationMs = Math.max(1, Date.now() - callStart);
					let parsed = outcome.parsed;
					if (parsed === undefined && (outcome.output.trim().startsWith("{") || outcome.output.trim().startsWith("["))) {
						try {
							parsed = JSON.parse(outcome.output);
						} catch {
							// text output
						}
					}
					const info = summarizeToolOutput(outcome.output, parsed);
					return { item, outcome, durationMs, info };
				}),
			);

			const parallelResult: Record<string, unknown> = {};
			const callTraces: FlowStepToolCall[] = [];
			for (const { item, outcome, durationMs, info } of outcomes) {
				toolsUsed.push(item.tool);
				const storeKey = item.storeAs ?? item.id;
				parallelResult[storeKey] = { ...info, isError: outcome.isError === true, raw: outcome.output };
				steps[storeKey] = parallelResult[storeKey];
				callTraces.push({
					name: item.tool,
					status: outcome.isError === true ? "failed" : "done",
					durationMs,
				});
			}
			callTraces.push(...skippedCalls);
			if (runnable.length > 0) {
				llmCallsSaved += 1;
				parallelToolsRun += runnable.length;
			}
			steps[nodeId] = parallelResult;

			traces.set(nodeId, {
				stepId: nodeId,
				status: runnable.length === 0 ? "skipped" : "completed",
				durationMs: Math.max(1, Date.now() - stepStart),
				summary: runnable.length === 0 ? "Skipped (not applicable)" : `${runnable.length} tools in parallel`,
				toolCalls: callTraces,
			});
			queue.push(...activateOutEdges(nodeId));
			await notify("running");
			continue;
		}

		if (node.kind === "switch") {
			let chosenTarget = node.defaultTarget;
			let chosenLabel = "default";
			for (const branch of node.branches ?? []) {
				if (evaluateCondition(branch.when, ctx)) {
					chosenTarget = branch.target;
					chosenLabel = branch.label;
					break;
				}
			}
			traces.set(nodeId, {
				stepId: nodeId,
				status: "completed",
				durationMs: Math.max(1, Date.now() - stepStart),
				branchId: chosenTarget,
				summary: chosenLabel,
			});
			queue.push(...activateOutEdges(nodeId, chosenTarget));
			await notify("running");
			continue;
		}

		if (node.kind === "ask_user") {
			const template =
				options.language === "en"
					? (node.promptTemplate ?? node.promptTemplateZh ?? "Please clarify your selection.")
					: (node.promptTemplateZh ?? node.promptTemplate ?? "请确认您要选择的对象。");
			const rendered = String(resolveTemplateValue(template, ctx));
			llmCallsSaved += 1;
			traces.set(nodeId, {
				stepId: nodeId,
				status: "needs_input",
				durationMs: Math.max(1, Date.now() - stepStart),
				summary: "Waiting for user disambiguation",
			});
			// Mark remaining pending nodes as skipped
			for (const [id, st] of traces) {
				if (id !== nodeId && st.status === "pending") traces.set(id, { stepId: id, status: "skipped" });
			}
			const finalTrace = snapshot("needs_input");
			await options.onUpdate?.(finalTrace);
			return {
				status: "needs_input",
				trace: finalTrace,
				vars,
				stepOutputs: steps,
				immediateReply: rendered,
				toolsUsed,
			};
		}

		if (node.kind === "llm_reply") {
			traces.set(nodeId, {
				stepId: nodeId,
				status: "completed",
				durationMs: Math.max(1, Date.now() - stepStart),
				summary: "Evidence assembled for synthesis",
			});
			queue.push(...activateOutEdges(nodeId));
			await notify("running");
		}
	}

	const finalTrace = snapshot("completed");
	await options.onUpdate?.(finalTrace);

	const evidenceLines: string[] = [
		`<flow_evidence skill="${flow.id}" mode="deterministic" duration_ms="${finalTrace.totalDurationMs ?? 0}" llm_calls_saved="${llmCallsSaved}">`,
		` Extracted Variables: ${JSON.stringify(vars)}`,
	];
	// A result stored under another name is also kept under its step's, for later steps to read; the model gets it once.
	const renamed = new Set(flow.nodes.filter((node) => node.call?.storeAs !== undefined && node.call.storeAs !== node.id).map((node) => node.id));
	for (const [key, value] of Object.entries(steps)) {
		if (renamed.has(key)) continue;
		if (value !== null && typeof value === "object" && "raw" in (value as Record<string, unknown>)) {
			const record = value as { raw: string; isError?: boolean; count?: number };
			const statusTag = record.isError ? "failed" : record.count === 0 ? "not_found" : "completed";
			evidenceLines.push(`  <step id="${key}" status="${statusTag}">\n${record.raw}\n  </step>`);
		}
	}
	evidenceLines.push("</flow_evidence>");

	return {
		status: "completed",
		trace: finalTrace,
		vars,
		stepOutputs: steps,
		evidenceBlock: evidenceLines.join("\n"),
		toolsUsed: [...new Set(toolsUsed)],
	};
}
