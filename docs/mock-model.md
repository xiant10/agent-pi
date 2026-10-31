# Running without a real model

Everything here runs offline, with no API keys. agent-pi's tests and the scripts in `scripts/mock/` run the real server,
durable harness, HTTP, and SSE streams, and replace only the model and, where a scenario needs one, the MCP server.

There is no separate mock service to start. The model is pi-ai's faux provider, running in the same process.

## What is real and what is not

| Part | In these runs |
|---|---|
| HTTP, JSON-RPC, SSE, auth, plugins | Real |
| Durable harness, ordering, SQLite storage | Real |
| Model | Scripted, in process (`fauxProvider`, model `faux-1`) |
| Provider SDKs and request path in pi-ai | **Not exercised** |
| MCP tools | Fake where used (`fakeMcpServer`) |
| Prompts, model answers, token use | Not meaningful |

So they answer "did the harness change?", not "does this work against a provider?". `npm run smoke` covers that, and it
needs a real gateway. Run it as well after upgrading the pi packages, since `pi-ai` moves with them. Latency from these
scripts is agent-pi's overhead plus the faux pacing: compare two runs, but never quote it as a first-token time.

## Writing a test

`startTestAgent` in `packages/agent-pi/src/testing.ts` starts the agent on a free port, with a faux model and in-memory
storage. Script each model request in order with `faux.setResponses`:

```ts
const agent = await startTestAgent({ tokensPerSecond: 20 });
agent.faux.setResponses([
	// A fixed reply.
	fauxAssistantMessage([fauxText("Let me check."), fauxToolCall("crm_slow", {})], { stopReason: "toolUse" }),
	// A function sees the request, to assert on what the model was sent.
	(context) => {
		seen.push(context.messages);
		return fauxAssistantMessage([fauxText("Done.")]);
	},
]);
```

| Need | How |
|---|---|
| A slow answer, to act while it streams | `tokensPerSecond` |
| A model error | `fauxAssistantMessage([...], { stopReason: "error", errorMessage: "boom" })`, with `retry.maxRetries: 0` (the test default) |
| A tool that blocks until released | `fakeMcpServer([{ name, description, call }])`, with `crm:<name>` in the profile's `alwaysOnTools`. It is offered to the model as `crm_<name>`. Release it before closing the agent |
| Calls | `rpc` for JSON, `rpcStream` for SSE, `events` for the event bodies |
| A restart | `config.storage` set to SQLite with `configStorage: true`, then a second `startTestAgent` |
| A crash | Copy the live database mid-run with `VACUUM INTO`, and start on the copy. See `crashImage` in `test/resilience.test.ts` |
| A storage failure | Pass `storage`, a `MemoryStorage` whose `commit` starts rejecting. See `test/resilience.test.ts` |

## Scripts

Each script takes the checkout to run, so the same script can drive an older version.

| Script | What it shows |
|---|---|
| `scripts/mock/behaviour.mjs` | Event trace and model context for each message-ordering scenario: interrupt, steer, failed runs, disconnects |
| `scripts/mock/latency.mjs` | Time to first text for prompts and interrupts. `LATENCY_TURNS` sets the count, default 60 |
| `scripts/mock/migration.mjs` | Writes a SQLite session with one checkout and reopens it with another |
| `scripts/mock/storage-failure.mjs` | `runAgent` exits 1 when storage starts failing |
| `scripts/mock/compare.sh` | Runs the first three against a git ref and this working tree |

## After upgrading the pi packages

```bash
npm run mock:compare -- <ref before the upgrade>
```

It checks the ref out in a temporary worktree, removed afterwards, and exits 1 if the traces differ. Text chunks split
differently around the scripts' fixed sleeps from run to run, so the comparison leaves them out, along with how much
aborted text got through. What remains is behaviour: statuses, event order, results, and model context.
`docs/AGENT-PI-PROVIDER.md` in `t10-livekit-agent` depends on it, so update that document when a trace changes.

A migration is one-way when durable's schema changes, so `migration.mjs` proves only the upgrade. To see a rollback
refused, run its `reopen` phase with the older checkout on the migrated file.
