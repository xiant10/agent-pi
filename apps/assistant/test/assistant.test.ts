import { fileURLToPath } from "node:url";
import { loadConfig } from "agent-pi";
import { builtinPlugins } from "agent-pi/plugins";
import { fauxAssistantMessage, fauxText, rpc, startTestAgent, type TestAgent, TOKENS } from "agent-pi/testing";
import { afterEach, describe, expect, it } from "vitest";

let running: TestAgent | undefined;
afterEach(async () => {
	await running?.close();
	running = undefined;
});

/** App behavior with scripted main-model responses; concurrent acknowledgements have separate transport tests. */
function startAssistant(): Promise<TestAgent> {
	const { progressModel: _progressModel, ...config } = loadConfig(fileURLToPath(new URL("../config/agent.json", import.meta.url)));
	return startTestAgent({ pluginCatalog: builtinPlugins, config: { ...config, port: 0, host: "127.0.0.1" } });
}

async function session(agent: TestAgent): Promise<string> {
	return (await rpc(agent.url, TOKENS.alice, "session.create")).body.result!.sessionId as string;
}

describe("assistant plugins", () => {
	it("answers greetings and FAQs without the model", async () => {
		running = await startAssistant();
		const sessionId = await session(running);
		const hello = await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "Hello!" });
		expect(hello.body.result).toMatchObject({ answeredBy: "shortcuts", text: "Hi, I'm Ava. What can I do for you?" });
		const hours = await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "What are your opening hours?" });
		expect(hours.body.result).toMatchObject({ answeredBy: "shortcuts", text: expect.stringContaining("Monday to Friday") });
		expect(running.faux.state.callCount).toBe(0);
	});

	it("redacts card numbers before the model and adds the current time to each request", async () => {
		running = await startAssistant();
		const seen: string[] = [];
		running.faux.setResponses([
			(context) => {
				seen.push(...context.messages.filter((message) => message.role === "user").map((message) => String(message.content)));
				return fauxAssistantMessage([fauxText("Thanks.")]);
			},
		]);
		const sessionId = await session(running);
		await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "Refund to card 4111 1111 1111 1111 please" });
		expect(seen[0]).toMatch(/^<now>.+\(Asia\/Shanghai\)<\/now>$/);
		expect(seen[1]).toBe("Refund to card [card number removed] please");
	});

	it("answers in every profile", async () => {
		running = await startAssistant();
		running.faux.setResponses([fauxAssistantMessage([fauxText("From chat.")]), fauxAssistantMessage([fauxText("From voice.")])]);
		for (const [profile, text] of [["chat", "From chat."], ["voice", "From voice."]] as const) {
			const created = await rpc(running.url, TOKENS.alice, "session.create", { profile });
			const answer = await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId: created.body.result!.sessionId, input: "Summarize my week" });
			expect(answer.body.result).toMatchObject({ status: "done", text });
		}
	});
});
