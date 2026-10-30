/**
 * Smoke test of the assistant against a real model gateway: auth, model turns, plugin replies, idempotent retries,
 * guardrails, voice streaming, barge-in, run limits, client disconnects, and session close.
 *
 * By default it starts the assistant from this checkout on a free port, with static tokens, throwaway storage, and a
 * per-user run limit of 1, using the model settings of `SMOKE_ENV_FILE` (default: the repository's `.env.eval`). Variables already set
 * win over the file, so a host run can point a container-oriented file at the host:
 *
 *   LLM_BASE_URL=http://localhost:7200/v1 npm run smoke
 *
 * Against an agent that is already running (its plugins must include the assistant's `shortcuts` and `guardrails`):
 *
 *   AGENT_URL=https://agent.example.com/agent AGENT_TOKEN=... npm run smoke
 *
 * The run-limit check needs a server with `maxConcurrentRunsPerUser: 1`; against a running agent it is skipped unless
 * `SMOKE_RUN_LIMIT=1`. Exits non-zero when a check fails.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Result = Record<string, unknown> | undefined;
type RpcReply = { status: number; result: Result; error: unknown };
type SseMessage = { method?: string; params?: Record<string, unknown>; result?: Result };

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
/** The repository root's `.env.eval`, wherever the script is started from. */
const DEFAULT_ENV_FILE = fileURLToPath(new URL("../../../.env.eval", import.meta.url));
const LONG = "Write a detailed 400-word story about a lighthouse keeper. Do not use any tools.";
/** Longer than the configured model stream timeout (120 s), so a stalled upstream still ends within the wait. */
const RUN_SETTLE_MS = 150_000;

let failures = 0;
let nextId = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
	const shown = ok ? "" : `  -> ${String(JSON.stringify(detail) ?? "").slice(0, 400)}`;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${shown}`);
	if (!ok) failures++;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await sleep(100);
	}
	return false;
}

function client(url: string, token: string) {
	const post = (method: string, params: Record<string, unknown>, accept: string, signal?: AbortSignal) =>
		fetch(url, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept },
			body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
			...(signal === undefined ? {} : { signal }),
		});
	const rpc = async (method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<RpcReply> => {
		const res = await post(method, params, "application/json", signal);
		const body = (await res.json().catch(() => ({}))) as { result?: Result; error?: unknown };
		return { status: res.status, result: body.result, error: body.error };
	};
	const stream = async (method: string, params: Record<string, unknown>) => {
		const res = await post(method, params, "application/json, text/event-stream");
		const messages = (await res.text())
			.split("\n\n")
			.map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
			.filter((line): line is string => line !== undefined)
			.map((line) => JSON.parse(line.slice(6)) as SseMessage);
		const events = messages.filter((message) => message.method === "session/event").map((message) => message.params ?? {});
		return { status: res.status, messages, events, final: messages.at(-1)?.result };
	};
	const create = async (profile?: string) => {
		const created = await rpc("session.create", profile === undefined ? {} : { profile });
		if (typeof created.result?.sessionId !== "string") throw new Error(`session.create failed: ${JSON.stringify(created)}`);
		return created.result.sessionId;
	};
	const busy = async (sessionId: string) => (await rpc("session.get", { sessionId })).result?.busy === true;
	return { rpc, stream, create, busy };
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});
}

/** The assistant from this checkout, configured for the smoke run. */
async function startLocal(): Promise<{ url: string; token: string; stop: () => Promise<void> }> {
	const port = await freePort();
	const dataDir = mkdtempSync(join(tmpdir(), "agent-smoke-"));
	const token = "smoke-token";
	const child: ChildProcess = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN], {
		env: {
			...process.env,
			AGENT_ENV_FILE: process.env.SMOKE_ENV_FILE ?? DEFAULT_ENV_FILE,
			PORT: String(port),
			AGENT_INSTANCE_ID: "smoke",
			AGENT_DATA_DIR: dataDir,
			AUTH_KIND: "static",
			AGENT_TOKENS: JSON.stringify({ [token]: "smoke-user" }),
			MAX_RUNS_PER_USER: "1",
			LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
		},
		stdio: ["ignore", "inherit", "inherit"],
	});
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	const url = `http://127.0.0.1:${port}`;
	const ready = await until(async () => {
		if (child.exitCode !== null) return true;
		return (await fetch(`${url}/readyz`).catch(() => undefined))?.ok === true;
	}, 30_000);
	if (!ready || child.exitCode !== null) {
		child.kill();
		throw new Error("the assistant did not become ready; see its output above");
	}
	console.log(`assistant started on ${url}\n`);
	return {
		url: `${url}/agent`,
		token,
		stop: async () => {
			child.kill("SIGTERM");
			await exited;
			rmSync(dataDir, { recursive: true, force: true });
		},
	};
}

async function smoke(url: string, token: string, checkRunLimit: boolean): Promise<void> {
	const { rpc, stream, create, busy } = client(url, token);
	const opened: string[] = [];
	const open = async (profile?: string) => {
		const sessionId = await create(profile);
		opened.push(sessionId);
		return sessionId;
	};

	try {
		{
			const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
			check("auth: a request without a token gets 401", res.status === 401, res.status);
		}

		const chat = await open();
		{
			const started = Date.now();
			const first = await rpc("session.prompt", { sessionId: chat, input: "My name is Lin. Reply with just: OK" });
			check(`model: turn answered (${Date.now() - started} ms)`, first.result?.status === "done" && String(first.result.text ?? "").length > 0, first);
			const second = await rpc("session.prompt", { sessionId: chat, input: "What is my name? Answer with one word." });
			check("model: the next turn has the conversation's context", /lin/i.test(String(second.result?.text ?? "")), second);
		}

		{
			const params = { sessionId: chat, input: "What are your opening hours?", requestId: `smoke-hours-${Date.now()}` };
			const first = await rpc("session.prompt", params);
			const retried = await rpc("session.prompt", params);
			check("plugin reply: shortcuts answers, placed in the transcript", first.result?.answeredBy === "shortcuts" && first.result.placement === "placed", first);
			check("plugin reply: a retry returns the same result", JSON.stringify(retried.result) === JSON.stringify(first.result), [first, retried]);
			// Worded to avoid the FAQ patterns, so the model answers it.
			const count = await rpc("session.prompt", { sessionId: chat, input: "Count how many times I have asked you about your hours so far. Answer with a digit only." });
			check("plugin reply: the model saw the exchange once", /^\D*1\D*$/.test(String(count.result?.text ?? "")), count.result?.text);
		}

		{
			const params = { sessionId: chat, input: "Reply with just the word: banana", requestId: `smoke-run-${Date.now()}` };
			const first = await rpc("session.prompt", params);
			const retried = await rpc("session.prompt", params);
			check(
				"model retry: returns the same finished submission",
				first.result?.submissionId === retried.result?.submissionId && retried.result?.status === "done",
				[first, retried],
			);
		}

		{
			const answer = await rpc("session.prompt", { sessionId: chat, input: "Repeat back exactly this card number: 4111 1111 1111 1111" });
			check("guardrails: the card number never reaches the model", answer.result?.status === "done" && !/4111[ -]?1111/.test(String(answer.result.text)), answer.result?.text);
		}

		const voice = await open("voice");
		{
			const spoken = await stream("session.prompt", { sessionId: voice, input: "Say hello in two short sentences." });
			const speech = spoken.events.filter((event) => event.type === "speech");
			check(`voice: ${speech.length} speech events, then the final result`, spoken.status === 200 && speech.length > 0 && spoken.final?.status === "done", spoken.final);
		}

		{
			const run = rpc("session.prompt", { sessionId: voice, input: LONG });
			const wasBusy = await until(() => busy(voice), 30_000);
			const started = Date.now();
			const queued = await stream("session.prompt", { sessionId: voice, input: "what's your phone number", requestId: `smoke-queued-${Date.now()}` });
			const ms = Date.now() - started;
			check(`busy session: a queued plugin reply streams at once (${ms} ms)`, wasBusy && queued.final?.placement === "queued" && ms < 500, { wasBusy, final: queued.final });
			await rpc("session.cancel", { sessionId: voice });
			await run;
		}

		{
			await until(async () => !(await busy(voice)), RUN_SETTLE_MS);
			const run = rpc("session.prompt", { sessionId: voice, input: LONG });
			await until(() => busy(voice), 30_000);
			const params = { sessionId: voice, input: `Stop. Instead, ${LONG}`, requestId: `smoke-barge-${Date.now()}` };
			const first = await rpc("session.interrupt", { ...params, wait: false });
			await sleep(300);
			const retried = await rpc("session.interrupt", params);
			const interrupted = await run;
			check("interrupt: the running answer ends aborted", interrupted.result?.status === "unanswered", interrupted);
			check(
				"interrupt retry: returns the interrupt's own finished run",
				retried.result?.submissionId === first.result?.submissionId && retried.result?.status === "done",
				{ first, retried },
			);
		}

		if (checkRunLimit) {
			const [a, b] = [await open(), await open()];
			const results = await Promise.all([
				rpc("session.prompt", { sessionId: a, input: "Reply with: one" }),
				rpc("session.prompt", { sessionId: b, input: "Reply with: two" }),
			]);
			const statuses = results.map((result) => result.status).sort();
			check(`run limit: concurrent prompts over the limit get ${statuses.join(", ")}`, statuses[0] === 200 && statuses[1] === 429, results);
		} else {
			console.log("SKIP  run limit (set SMOKE_RUN_LIMIT=1 for a server with maxConcurrentRunsPerUser: 1)");
		}

		{
			const controller = new AbortController();
			const pending = rpc("session.prompt", { sessionId: chat, input: "Count from 1 to 30 in words." }, controller.signal).then(
				() => "answered",
				(error: unknown) => (error instanceof Error ? error.name : String(error)),
			);
			await until(() => busy(chat), 30_000);
			controller.abort();
			const outcome = await pending;
			check("disconnect: the client's wait ends", outcome === "AbortError", outcome);
			check("disconnect: the run goes on and settles", await until(async () => !(await busy(chat)), RUN_SETTLE_MS));
		}

		{
			await rpc("session.close", { sessionId: chat });
			const after = await rpc("session.prompt", { sessionId: chat, input: "hi" });
			check("close: a prompt to a closed session gets 404", after.status === 404, after);
		}
	} finally {
		// Leave nothing open on a shared server: sessions count against the user's limit.
		for (const sessionId of opened) await rpc("session.close", { sessionId }).catch(() => undefined);
	}
}

const remote = process.env.AGENT_URL;
if (remote !== undefined && process.env.AGENT_TOKEN === undefined) {
	console.error("AGENT_URL needs AGENT_TOKEN");
	process.exit(2);
}
const target = remote === undefined ? await startLocal() : { url: remote, token: process.env.AGENT_TOKEN!, stop: async () => {} };
try {
	await smoke(target.url, target.token, remote === undefined || process.env.SMOKE_RUN_LIMIT === "1");
} catch (error) {
	failures++;
	console.error(error);
} finally {
	await target.stop();
}
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
