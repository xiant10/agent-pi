import { defineDoc } from "@earendil-works/pi-durable";

export type FlowNodeKind = "start" | "extract" | "tool" | "parallel" | "switch" | "ask_user" | "llm_reply";

export type FlowStepStatus = "pending" | "running" | "completed" | "skipped" | "needs_input" | "failed";

export type FlowExtractField = {
	/** Optional regex with a capture group, applied to the user's message. */
	readonly pattern?: string;
	/** Keyword map (`{ "日报": "daily", "周报": "weekly" }`) matched against the user's message. */
	readonly keywords?: Readonly<Record<string, string | boolean>>;
	/** Use cleaned user input when no regex/keyword matched. */
	readonly fallbackInput?: boolean;
	readonly default?: string | boolean;
};

export type FlowParallelCall = {
	readonly id: string;
	readonly label: string;
	readonly labelZh?: string;
	readonly tool: string;
	readonly args?: Readonly<Record<string, unknown>>;
	/** Optional condition (`vars.relationshipOnly != true`) deciding whether this parallel branch runs or skips. */
	readonly when?: string;
	readonly storeAs?: string;
};

export type FlowBranchRule = {
	readonly id: string;
	readonly label: string;
	readonly labelZh?: string;
	readonly when: string;
	readonly target: string;
};

export type FlowNode = {
	readonly id: string;
	readonly kind: FlowNodeKind;
	readonly label: string;
	readonly labelZh?: string;
	readonly description?: string;
	readonly descriptionZh?: string;
	readonly tools?: readonly string[];
	readonly extract?: Readonly<Record<string, FlowExtractField>>;
	readonly call?: {
		readonly tool: string;
		readonly args?: Readonly<Record<string, unknown>>;
		readonly storeAs?: string;
	};
	readonly parallel?: readonly FlowParallelCall[];
	readonly branches?: readonly FlowBranchRule[];
	readonly defaultTarget?: string;
	readonly promptTemplate?: string;
	readonly promptTemplateZh?: string;
};

export type FlowEdge = {
	readonly id: string;
	readonly source: string;
	readonly target: string;
	readonly label?: string;
	readonly labelZh?: string;
	readonly branch?: string;
};

export type SkillFlow = {
	readonly id: string;
	readonly title: string;
	readonly titleZh?: string;
	readonly mode: "deterministic" | "guided";
	/** Optional keywords/phrases that trigger deterministic execution before or during skill loading. */
	readonly triggerKeywords?: readonly string[];
	readonly nodes: readonly FlowNode[];
	readonly edges: readonly FlowEdge[];
};

export type FlowStepToolCall = {
	name: string;
	status: "running" | "done" | "failed" | "skipped";
	durationMs?: number;
};

export type FlowStepTrace = {
	stepId: string;
	status: FlowStepStatus;
	durationMs?: number;
	summary?: string;
	branchId?: string;
	toolCalls?: FlowStepToolCall[];
};

export type FlowRunTrace = {
	flowId: string;
	skill: string;
	title: string;
	titleZh?: string;
	mode: "deterministic" | "guided";
	status: "running" | "completed" | "needs_input" | "failed";
	startedAt: number;
	totalDurationMs?: number;
	llmCallsSaved?: number;
	parallelToolsRun?: number;
	steps: FlowStepTrace[];
};

export type FlowDocState = {
	latest?: FlowRunTrace;
	history: FlowRunTrace[];
};

export const FlowDoc = defineDoc<FlowDocState>({
	kind: "app.flow",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ history: [] }),
	checkpointWhen: () => false,
});

export function recordFlowTrace(doc: { latest?: unknown; history: unknown[] }, trace: FlowRunTrace): void {
	doc.latest = trace;
	doc.history = [...doc.history.slice(-9), trace];
}
