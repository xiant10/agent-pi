import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import type { Authenticator } from "../src/auth/authenticator.ts";
import { Container, token } from "../src/plugins/container.ts";
import { Services } from "../src/plugins/services.ts";
import { type AgentPlugin, definePlugin, type RunContext } from "../src/plugins/types.ts";
import { events, recording, rpc, rpcStream, startTestAgent, type TestAgent, TOKENS, waitFor } from "../src/testing.ts";

let running: TestAgent | undefined;
afterEach(async () => {
	await running?.close();
	running = undefined;
});

async function createSession(agent: TestAgent, profile?: string): Promise<string> {
	const created = await rpc(agent.url, TOKENS.alice, "session.create", profile === undefined ? {} : { profile });
	expect(created.status).toBe(200);
	return created.body.result!.sessionId as string;
}

/** User and assistant text of the messages a model request carried, in order. */
function dialogue(messages: readonly Message[]): string[] {
	return messages
		.filter((message) => message.role === "user" || message.role === "assistant")
		.map((message) => {
			const content = message.content;
			const text = typeof content === "string" ? content : content.map((block) => ("text" in block ? block.text : "")).join("");
			return `${message.role}: ${text}`;
		});
}

/** System prompt text of a request: durable sends sections as system messages. */
function systemText(messages: readonly Message[]): string {
	return messages
		.filter((message) => (message.role as string) === "system")
		.map((message) => JSON.stringify(message))
		.join("\n");
}

describe("beforePrompt", () => {
	const hours = definePlugin({
		name: "hours",
		beforePrompt: (turn) => (/opening hours/i.test(turn.text) ? { reply: "We are open nine to five." } : undefined),
	});

	it("answers without the model, and the model sees that exchange in the next turn", async () => {
		running = await startTestAgent({ plugins: [hours] });
		const seen: string[][] = [];
		running.faux.setResponses([
			(context) => {
				seen.push(dialogue(context.messages));
				return fauxAssistantMessage([fauxText("Yes, on Saturdays too.")]);
			},
		]);
		const sessionId = await createSession(running);
		const first = await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "What are your opening hours?" });
		expect(first.body.result).toMatchObject({ status: "done", answeredBy: "hours", text: "We are open nine to five." });
		expect(running.faux.state.callCount).toBe(0);

		const second = await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "Weekends too?" });
		expect(second.body.result).toMatchObject({ status: "done", text: "Yes, on Saturdays too." });
		expect(seen[0]).toEqual([
			"user: What are your opening hours?",
			"assistant: We are open nine to five.",
			"user: Weekends too?",
		]);
	});

	it("streams a plugin reply like a model answer, with speech and its source", async () => {
		running = await startTestAgent({ plugins: [hours] });
		const sessionId = await createSession(running, "voice");
		const { status, messages } = await rpcStream(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "opening hours?" });
		expect(status).toBe(200);
		const bodies = events(messages);
		expect(bodies.filter((body) => body.type === "speech").map((body) => body.text)).toEqual(["We are open nine to five."]);
		expect(bodies.find((body) => body.type === "message.end")).toMatchObject({ source: "hours", text: "We are open nine to five." });
		expect(messages.at(-1)!.data.result).toMatchObject({ status: "done", answeredBy: "hours" });
	});

	it("rewrites input and routes tools before the first model request; rejects with 422", async () => {
		const lookup = defineTool({
			name: "order_status",
			description: "Status of an order by number.",
			parameters: Type.Object({ order: Type.String() }),
			execute: async (args) => ({ output: [{ type: "text", text: `Order ${args.order} shipped.` }] }),
		});
		const plugin = definePlugin({
			name: "orders",
			tools: [lookup],
			beforePrompt: (turn) => {
				if (turn.text.includes("password")) return { reject: "Never share passwords here." };
				if (!/order/i.test(turn.text)) return undefined;
				return { input: turn.text.replace(/\d{16}/, "[card]"), activateTools: ["orders:order_status"] };
			},
		});
		running = await startTestAgent({ plugins: [plugin] });
		const seen: string[][] = [];
		running.faux.setResponses(
			recording(running.offered, [
				(context) => {
					seen.push(dialogue(context.messages));
					return fauxAssistantMessage([fauxToolCall("order_status", { order: "42" })], { stopReason: "toolUse" });
				},
				fauxAssistantMessage([fauxText("Order 42 shipped.")]),
			]),
		);
		const sessionId = await createSession(running);
		const answer = await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "Order 42, card 4111111111111111" });
		expect(answer.body.result).toMatchObject({ status: "done", text: "Order 42 shipped." });
		expect(seen[0]).toEqual(["user: Order 42, card [card]"]);
		expect(running.offered[0]).toContain("order_status");

		const refused = await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "my password is hunter2" });
		expect(refused.status).toBe(422);
		expect(refused.body.error?.message).toBe("Never share passwords here.");
	});
});

describe("plugin replies while busy", () => {
	it("queues the exchange to the next boundary, or refuses it with whenBusy: reject", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let toolStarted = false;
		const slow = defineTool({
			name: "slow_lookup",
			description: "Slow lookup.",
			parameters: Type.Object({}),
			execute: async () => {
				toolStarted = true;
				await gate;
				return { output: [{ type: "text", text: "looked up" }] };
			},
		});
		const plugin = definePlugin({
			name: "desk",
			tools: [slow],
			beforePrompt: (turn) => (turn.text === "ping" ? { reply: "pong" } : undefined),
		});
		running = await startTestAgent({
			plugins: [plugin],
			config: {
				profiles: {
					chat: { model: "main", thinkingLevel: "off", alwaysOnTools: ["desk:*"], maxActiveTools: 12, preload: { maxTools: 0, minScore: 4 }, speech: false, thinkingEvents: false },
				},
			},
		});
		const seen: string[][] = [];
		running.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("slow_lookup", {})], { stopReason: "toolUse" }),
			(context) => {
				seen.push(dialogue(context.messages));
				return fauxAssistantMessage([fauxText("Found it.")]);
			},
		]);
		const sessionId = await createSession(running);
		const prompt = rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "Look it up" });
		await waitFor(() => toolStarted);
		const refused = await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "ping", whenBusy: "reject" });
		expect(refused.status).toBe(409);
		const queued = await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "ping", requestId: "r1" });
		expect(queued.body.result).toMatchObject({ answeredBy: "desk", text: "pong", placement: "queued" });
		// A retry of the same request is answered from the first reply; nothing more is queued.
		const retried = await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "ping", requestId: "r1" });
		expect(retried.body.result).toEqual(queued.body.result);
		// A streamed reply that has to queue answers at once instead of waiting for events that come after the run.
		const started = Date.now();
		const streamed = await rpcStream(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "ping", requestId: "r2" });
		expect(Date.now() - started).toBeLessThan(500);
		expect(streamed.messages.at(-1)!.data.result).toMatchObject({ answeredBy: "desk", placement: "queued" });
		release();
		expect((await prompt).body.result).toMatchObject({ status: "done", text: "Found it." });
		// The exchanges waited for the tool round to finish instead of splitting it.
		expect(seen[0]).toEqual([
			"user: Look it up",
			"assistant: ",
			"user: ping",
			"assistant: pong",
			"user: ping",
			"assistant: pong",
		]);
	});
});

describe("retries with a requestId", () => {
	it("answer a plugin-answered input once: one exchange in the transcript, one afterRun", async () => {
		const runs: RunContext[] = [];
		const desk = definePlugin({
			name: "desk",
			beforePrompt: (turn) => (turn.text === "ping" ? { reply: "pong" } : undefined),
			afterRun: (run) => {
				runs.push(run);
			},
		});
		running = await startTestAgent({ plugins: [desk] });
		const seen: string[][] = [];
		running.faux.setResponses([
			(context) => {
				seen.push(dialogue(context.messages));
				return fauxAssistantMessage([fauxText("ok")]);
			},
		]);
		const sessionId = await createSession(running);
		const first = await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "ping", requestId: "same" });
		const second = await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "ping", requestId: "same" });
		expect(first.body.result).toMatchObject({ answeredBy: "desk", text: "pong", placement: "placed" });
		expect(second.body.result).toEqual(first.body.result);
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "next" });
		expect(seen[0]).toEqual(["user: ping", "assistant: pong", "user: next"]);
		await waitFor(() => runs.length >= 2);
		expect(runs.map((run) => run.answeredBy)).toEqual(["desk", "model"]);
	});

	it("return the existing run of a model input without running plugins again", async () => {
		let calls = 0;
		const counter = definePlugin({
			name: "counter",
			beforePrompt: () => {
				calls++;
				return undefined;
			},
		});
		running = await startTestAgent({ plugins: [counter] });
		running.faux.setResponses([fauxAssistantMessage([fauxText("Hello.")])]);
		const sessionId = await createSession(running);
		const first = await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "hi", requestId: "once" });
		const second = await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "hi", requestId: "once" });
		expect(first.body.result).toMatchObject({ status: "done", text: "Hello." });
		expect(second.body.result).toEqual(first.body.result);
		expect(calls).toBe(1);
		expect(running.faux.state.callCount).toBe(1);
	});
});

describe("run limits", () => {
	it("count a prompt from admission on, so concurrent prompts cannot all pass the per-user limit", async () => {
		const slow = definePlugin({
			name: "slow",
			beforePrompt: async () => {
				await new Promise((resolve) => setTimeout(resolve, 100));
			},
		});
		running = await startTestAgent({
			plugins: [slow],
			config: { limits: { maxSessionsPerUser: 5, maxConcurrentRunsPerUser: 1, maxConcurrentRuns: 50, maxInputChars: 10_000, maxBodyBytes: 1_000_000 } },
		});
		running.faux.setResponses([fauxAssistantMessage([fauxText("one")]), fauxAssistantMessage([fauxText("two")])]);
		const a = await createSession(running);
		const b = await createSession(running);
		const results = await Promise.all([
			rpc(running.url, TOKENS.alice, "session.prompt", { sessionId: a, input: "first" }),
			rpc(running.url, TOKENS.alice, "session.prompt", { sessionId: b, input: "second" }),
		]);
		expect(results.map((result) => result.status).sort()).toEqual([200, 429]);
		// The slot is free again once the run settled.
		const later = await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId: b, input: "second" });
		expect(later.status).toBe(200);
	});
});

describe("session lifecycle and history", () => {
	it("greets on session creation without the model; the greeting is in the model's context", async () => {
		const greeter = definePlugin({
			name: "greeter",
			sessionCreated: async (session) => {
				await session.state.set({ greeted: true });
				await session.history.say(`Hello ${session.userId}, how can I help?`);
				await session.history.record("crm.interaction", { channel: session.profile.name });
			},
			rpc: {
				"greeter.state": async (_params, ctx) => (await ctx.session()).state.get(),
			},
		});
		running = await startTestAgent({ plugins: [greeter] });
		const seen: string[][] = [];
		running.faux.setResponses([
			(context) => {
				seen.push(dialogue(context.messages));
				return fauxAssistantMessage([fauxText("Sure.")]);
			},
		]);
		const sessionId = await createSession(running);
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "Book a table" });
		// The record is not model context; the greeting is.
		expect(seen[0]).toEqual(["assistant: Hello alice, how can I help?", "user: Book a table"]);
		const state = await rpc(running.url, TOKENS.alice, "greeter.state", { sessionId });
		expect(state.body.result).toEqual({ greeted: true });
		// Another user cannot reach the session through a plugin method either.
		expect((await rpc(running.url, TOKENS.bob, "greeter.state", { sessionId })).status).toBe(404);
	});

	it("reports every settled run to afterRun, whoever answered", async () => {
		const runs: Pick<RunContext, "answeredBy" | "status" | "text">[] = [];
		const plugins: AgentPlugin[] = [
			{ name: "shortcut", beforePrompt: (turn) => (turn.text === "ping" ? { reply: "pong" } : undefined) },
			{ name: "audit", afterRun: (run) => void runs.push({ answeredBy: run.answeredBy, status: run.status, text: run.text }) },
		];
		running = await startTestAgent({ plugins });
		running.faux.setResponses([fauxAssistantMessage([fauxText("Hi there.")])]);
		const sessionId = await createSession(running);
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "ping" });
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "hello" });
		await waitFor(() => runs.length === 2);
		expect(runs).toEqual([
			{ answeredBy: "shortcut", status: "done", text: "pong" },
			{ answeredBy: "model", status: "done", text: "Hi there." },
		]);
	});
});

describe("model and tool hooks", () => {
	it("injects per-request context, guards the final answer, and gates tools", async () => {
		const secret = defineTool({
			name: "read_secret",
			description: "Reads a secret.",
			parameters: Type.Object({}),
			execute: async () => ({ output: [{ type: "text", text: "s3cr3t" }] }),
		});
		const echo = defineTool({
			name: "echo",
			description: "Echoes.",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (args) => ({ output: [{ type: "text", text: `token=abc ${args.text}` }] }),
		});
		const policy = definePlugin({
			name: "policy",
			instructions: [{ name: "persona", render: ({ profile }) => `You are Ava, on the ${profile.name} channel.` }],
			tools: [secret, echo],
			beforeModelRequest: (messages, ctx) => [
				...messages,
				{ role: "user", content: `<context>user=${ctx.userId}</context>`, timestamp: 0 },
			],
			onFinalAnswer: async (answer, ctx) => {
				const text = answer.content.map((block) => ("text" in block ? block.text : "")).join("");
				const retried = await ctx.memo("retried", () => text.includes("guarantee"));
				return text.includes("guarantee") && retried ? { continue: "Do not promise guarantees; rephrase." } : undefined;
			},
			beforeToolCall: (call) => (call.name === "read_secret" ? { block: "Not allowed." } : undefined),
			afterToolCall: (_call, result) => ({
				...result,
				output: result.output?.map((block) => (block.type === "text" ? { ...block, text: block.text.replace(/token=\S+/, "token=***") } : block)),
			}),
		});
		running = await startTestAgent({
			plugins: [policy],
			config: {
				profiles: {
					chat: { model: "main", thinkingLevel: "off", alwaysOnTools: ["policy:*"], maxActiveTools: 12, preload: { maxTools: 0, minScore: 4 }, speech: false, thinkingEvents: false },
				},
			},
		});
		const requests: Message[][] = [];
		const capture = (step: ReturnType<typeof fauxAssistantMessage>) => (context: { messages: Message[] }) => {
			requests.push([...context.messages]);
			return step;
		};
		running.faux.setResponses([
			capture(fauxAssistantMessage([fauxToolCall("read_secret", {}), fauxToolCall("echo", { text: "hi" })], { stopReason: "toolUse" })),
			capture(fauxAssistantMessage([fauxText("I guarantee it works.")])),
			capture(fauxAssistantMessage([fauxText("It should work.")])),
		]);
		const sessionId = await createSession(running);
		const answer = await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "Do it" });
		expect(answer.body.result).toMatchObject({ status: "done", text: "It should work." });

		expect(systemText(requests[0]!)).toContain("You are Ava, on the chat channel.");
		expect(dialogue(requests[0]!).at(-1)).toBe("user: <context>user=alice</context>");
		const results = requests[1]!.filter((message) => message.role === "toolResult").map((message) => JSON.stringify(message.content));
		expect(results[0]).toContain("Not allowed.");
		expect(results[1]).toContain("token=*** hi");
		expect(dialogue(requests[2]!)).toContain("user: Do not promise guarantees; rephrase.");
		// The injected context was for each request only; it is not in the transcript.
		expect(dialogue(requests[2]!).filter((line) => line.includes("<context>"))).toHaveLength(1);
	});
});

describe("IoC and events", () => {
	it("lets plugins rebind core services and share their own", async () => {
		const Greeting = token<string>("greeting");
		const seen: string[] = [];
		const provider = definePlugin({
			name: "provider",
			register: (container: Container) => {
				container.value(Greeting, "hola");
				container.decorate(Services.authenticator, (inner: Authenticator) => ({
					authenticate: async (request) => {
						const principal = await inner.authenticate(request);
						return { ...principal, scopes: [...principal.scopes, "vip"] };
					},
				}));
			},
		});
		const consumer = definePlugin({
			name: "consumer",
			setup: async (host) => {
				seen.push(await host.container.get(Greeting));
			},
			authenticate: (principal) => {
				seen.push(principal.scopes.join(","));
				return principal;
			},
		});
		running = await startTestAgent({ plugins: [provider, consumer] });
		expect(seen).toEqual(["hola"]);
		await rpc(running.url, TOKENS.alice, "session.list");
		expect(seen).toEqual(["hola", "vip"]);
	});

	it("maps client events", async () => {
		const pronounce = definePlugin({
			name: "pronounce",
			mapEvent: (event) => {
				if (event.type === "speech") return { ...event, text: event.text.replace("ACME", "Acme") };
				if (event.type === "thinking.delta") return null;
				return undefined;
			},
		});
		running = await startTestAgent({ plugins: [pronounce] });
		running.faux.setResponses([fauxAssistantMessage([fauxText("Welcome to ACME support.")])]);
		const sessionId = await createSession(running, "voice");
		const { messages } = await rpcStream(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "hi" });
		expect(events(messages).filter((body) => body.type === "speech").map((body) => body.text)).toEqual(["Welcome to Acme support."]);
	});

	it("refuses duplicate plugins and plugin methods that shadow core ones", async () => {
		await expect(startTestAgent({ plugins: [{ name: "a" }, { name: "a" }] })).rejects.toThrow(/two plugins named a/);
		await expect(startTestAgent({ plugins: [{ name: "b", rpc: { "session.create": () => null } }] })).rejects.toThrow(/already defined/);
	});
});

describe("Container", () => {
	it("builds once, decorates the current binding, and refuses rebinding after build", async () => {
		const container = new Container();
		const Count = token<number>("count");
		let built = 0;
		container.bind(Count, () => ++built);
		container.decorate(Count, (inner) => inner * 10);
		expect(await container.get(Count)).toBe(10);
		expect(await container.get(Count)).toBe(10);
		expect(built).toBe(1);
		expect(() => container.value(Count, 5)).toThrow(/already built/);
	});
});
