# agent-pi

A reusable multi-user agent harness on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable), and the apps built on it.

- **Streamable HTTP** (the MCP 2025-06-18 transport shape) with JSON-RPC methods, SSE responses, and a resumable event stream.
- **JWT auth** before anything else runs.
- **Steering and barge-in**: `session.steer` joins running work; `session.interrupt` stops it and answers the new input.
- **Skills** that load instructions and activate their tools on demand.
- **Hundreds of MCP tools**: all registered, few offered per request, found by skills, search, or preloading.
- **Delegation**: declared sub-agents as tools, and an agent offered to others over MCP. See [docs/delegation.md](docs/delegation.md).
- **Voice output**: `speech` events carry speakable sentences as they stream; a fast model talks, `consult_expert` reasons.
- **Durable**: sessions, runs, and tool calls are committed to SQLite; a restarted container continues unfinished runs.
- **Plugins and IoC**: business logic lives in the app; the harness exposes hooks before and after the model, around
  tools, and on the session lifecycle, and plugins can answer without the model while still writing to the conversation history.

Building a new agent on the package: [`docs/developer-guide.md`](docs/developer-guide.md). Design and rationale:
[`docs/design.md`](docs/design.md). End-to-end lifecycle with every plugin hook point:
[`docs/lifecycle.md`](docs/lifecycle.md). Testing without a real model:
[`docs/mock-model.md`](docs/mock-model.md).

## Layout

```
packages/agent-pi/     the harness: protocol, auth, durable wiring, MCP, skills machinery, events, plugin system
  src/index.ts           public API: runAgent, startAgent, definePlugin, Services, Container, ...
  src/main.ts            the shared runtime: runs the agent AGENT_CONFIG names, one agent per process
  src/plugins/library/   agent-pi/plugins: ready-made guardrails, shortcuts (answers without the model), clock, audit
  src/testing.ts         agent-pi/testing: the real harness with a scripted model, for app tests
apps/assistant/        one agent on the runtime: configuration only, no code of its own
  config/agent.json      agent name, models, profiles (personas), instructions, plugins, skills dir, MCP servers, limits
  prompts/ skills/ content/
  scripts/smoke.ts       smoke test against a real model gateway: npm run smoke
Dockerfile             one image holding every agent; AGENT_CONFIG picks the agent a container runs
```

A new agent is another `apps/<name>` with its own config, prompts, and skills. It runs on the shared runtime, or on its
own entry point if it has plugins of its own (see the [developer guide](docs/developer-guide.md#create-an-app)).

## Quick start

```bash
npm ci
AUTH_KIND=static AGENT_TOKENS='{"dev-token":"dev"}' LLM_BASE_URL=http://localhost:8000/v1 npm start
```

Docker (build context is the repository root):

```bash
cp .env.example .env   # set JWT_* and LLM_* values
docker compose -f apps/assistant/docker-compose.yml up -d --build
curl localhost:9800/readyz
```

Node 24.21+ runs the `.ts` sources directly (type stripping); there is no build step. Workspace packages resolve
through symlinks to their real paths, so type stripping applies to them. To publish `agent-pi` to a registry, add a
`tsc` build step that emits `.js` first, because Node does not strip types under `node_modules`.

## Building an app

```ts
// apps/my-app/src/main.ts
import { definePlugin, runAgent } from "agent-pi";

const orders = definePlugin({
	name: "orders",
	instructions: [{ name: "persona", render: ({ profile }) => `You are Max, the order desk (${profile.name}).` }],
	beforePrompt: async (turn) => {
		const match = /order (\d+) status/i.exec(turn.text);
		if (match) return { reply: await orderStatus(match[1]) }; // no model call; still in the transcript
		return undefined;
	},
	afterRun: (run) => crm.logInteraction(run.userId, run.text),
});

await runAgent({ config: new URL("../config/agent.json", import.meta.url), plugins: [orders] });
```

### Plugin reference

Everything is optional. Plugins run in the order given.

| Member | When | Can |
|---|---|---|
| `register(container)` | Before any service is built | Rebind or `decorate` core services (`Services.authenticator`, `storage`, `models`, `profiles`, `skills`, `log`, `mcpTransport`); bind your own |
| `setup(host)` | After everything is built, before listening and resuming runs | Read services; keep `host.session(id)` for background work (webhooks, schedulers) |
| `dispose()` | Shutdown, reverse order | Close clients |
| `instructions` | Every request | System prompt sections, after the configured ones and before the skill index |
| `tools` | Like MCP tools | In-process tools under server `<plugin>`: `alwaysOnTools: ["<plugin>:*"]`, skills, search, preload |
| `skills`, `mcpServers` | Startup | Added to the configured ones |
| `rpc` | `POST /agent` | Extra JSON-RPC methods; `ctx.session()` resolves the caller's own session |
| `authenticate` | Each request, after the credential is verified | Map roles, check entitlement, throw `AuthError` |
| `sessionCreated` / `sessionClosed` | Session lifecycle | Greet, seed state, open or close a CRM interaction |
| `beforePrompt` | Each input, before the model | `{ input }` rewrite, `{ activateTools }` route, `{ reply }` answer without the model, `{ reject }` refuse (422) |
| `beforeModelRequest` | Each model request | Messages for this request only (dynamic context); not stored |
| `afterModelResponse` | Each model response | Observe (metrics) |
| `onFinalAnswer` | A final answer | `{ continue }`: send the model a correction instead of ending (guardrail) |
| `beforeToolCall` / `afterToolCall` | Around each tool | Block, rewrite arguments, redact results |
| `afterRun` | A submission settled | Audit, analytics; background, never delays the answer |
| `mapEvent` | Each client event | Change, split, or drop events (pronunciation fixes, custom UI events) |

Writing to the conversation without the model (`session.history`, on every session context):

- `say(text)`: an assistant message, such as a greeting or a proactive notice. Clients receive it like a model answer (`text.delta`, `speech`, `message.end` with `source`), and the model sees it in later turns.
- `exchange(input, answer)`: a user turn and its answer; this is what a `{ reply }` decision writes.
- `record(type, data)`: an `app.record` entry for UIs, audits, and other plugins. The model never sees it.

While the session is idle these entries are appended in one commit. While it is busy they are queued and placed at
the next turn boundary, so they never land in the middle of a tool round.

`session.state` is the plugin's own durable per-session JSON. Model and tool hooks run inside durable tasks that
replay after a crash, so they get read-only state and `ctx.memo(name, compute)` for values that must not change on
replay.

Test plugins against the real harness with `agent-pi/testing` (`startTestAgent({ plugins })`, `rpc`, `rpcStream`, faux
model responses). See `apps/assistant/test`.

## Protocol

One endpoint, `/agent`. Every request needs `Authorization: Bearer <jwt>`.

| HTTP | Purpose |
|---|---|
| `POST /agent` | One JSON-RPC 2.0 request. `session.prompt`/`session.interrupt` stream SSE when `Accept` includes `text/event-stream`; the `Agent-Submission-Id` response header names the stream's submission (absent when a plugin answered). |
| `GET /agent` | The session's event stream (`Accept: text/event-stream`). Send `Last-Event-ID` to resume. |
| `DELETE /agent` | Close the session in `Agent-Session-Id`. |
| `GET /healthz`, `/readyz` | Probes, no auth. |

The session is named by the `Agent-Session-Id` header or `params.sessionId`.

| Method | Params | Result |
|---|---|---|
| `session.create` | `profile?`, `metadata?` | `{ sessionId, profile, createdAt }` |
| `session.list` | `archived?`, `limit?` (1-200), `cursor?` | `{ sessions, nextCursor? }`, most recently active first. Each has `lastActiveAt`, `busy`, and `archived` when set. Without `limit`, every session |
| `session.messages` | `limit?` (1-200, default 50), `cursor?` | `{ messages, nextCursor? }`, oldest first, the newest page first. A `user` line has `text`, `images?`, and `turnId?` and `requestId?` for the newest 200 inputs; an `assistant` line has `text`, `stopReason`, `error?`, `source?`; a `tool` line has `callId`, `name`, `isError`, with no result; a `task` line, what a background task told the session, has `kind` (`report` or `note`), `taskId`, `name`, `status?`, `text`; a `compaction` line marks a summary. Readable while archived |
| `session.update` | `title?`, `pinned?`, `archived?` | The session's info. `title` and `pinned` go in `metadata`. An archived session stays readable, doesn't count against `maxSessionsPerUser`, and refuses input with `session_archived` until restored. Archiving stops the current run and ends the session's background tasks |
| `session.get` | | `{ sessionId, profile, busy, parked, activeTools, usage, subagents, tasks, taskUsage }`: `taskUsage` is what background tasks spent, on top of `usage` |
| `session.prompt` | `input`, `requestId?`, `turnId?`, `whenBusy?` (`followUp`, `steer`, `reject`), `wait?`, `abortOnDisconnect?` | `{ turnId, submissionId, status, reason?, detail?, text? }`, or `{ turnId, status: "done", answeredBy, text, placement }` when a plugin answered (`placement: "queued"` when the session was busy) |
| `session.steer` | `input`, `requestId?`, `turnId?` | `{ turnId, submissionId, placement }` |
| `session.interrupt` | `input?`, `requestId?`, `turnId?`, `duringTools?` (`abort`, `steer`) | like `session.prompt`, or `{ aborted: true }` |
| `session.cancel` | `tasks?` (also end background tasks) | `{ aborted: true }` |
| `session.retry` | | `{ retried }`: runs tasks parked after repeated crashes again |
| `session.close` | | `{ closed: true }` |
| `skills.list` | | `{ skills }` |
| *plugin methods* | as the plugin defines | as the plugin returns |

`input` is a string or pi-ai content blocks (`{type:"text",text}`, `{type:"image",data,mimeType}`). `requestId` makes a retried prompt idempotent.

`duringTools: "steer"` on `session.interrupt` lets running tools finish and joins the run instead of aborting them. An aborted tool is reported to the model as aborted even if it had already acted, so a client whose tools change things should send it: the model then knows what actually happened. Text being generated is aborted either way.

A **turn** is one user message and every model call it triggers (tool loops, retries). Send `turnId` (param, or the `X-Turn-ID` header; 1-128 of `A-Za-z0-9._:-`) to name it; otherwise agent-pi generates one when the call arrives and returns it as `turnId`. A retried `requestId` keeps its first turn. Plugins see it as `turn.turnId`, `run.turnId`, and `ctx.turnId`.

**Audit identity to the model gateway.** A model with `identityHeaders` sends who the call is for on every request: `"gateway"` means `X-Agent-Name` (the config's `agent`), `X-Session-ID` (the public session id), `X-Turn-ID`, `X-User-Id`, `X-User-Name` (the JWT `nameClaim`, default `name`; percent-encoded when not ASCII), and `X-Tenant-ID`, as `ai-gateway` expects. Or name your own headers: `{ "agent": "X-Agent", "sessionId": "X-Session", "turnId": "X-Turn", "userId": "X-User", "userName": "X-Name", "tenantId": "X-Tenant" }`. Only `openai-compatible` models support it.

**Tracing.** Send a W3C `traceparent` header with a prompt and its work joins your trace: an `agent.submission` span, with an `agent.model` span per model request and an `agent.tool` span per tool call under it. Without one, the input starts a trace of its own. Set `OTEL_EXPORTER_OTLP_ENDPOINT` (a URL such as `http://collector:4318`; `OTEL_SERVICE_NAME` defaults to `agent-pi`) to export them over OTLP/HTTP. A model with `identityHeaders` also passes its `agent.model` span to the gateway as `traceparent`. `agent.model` spans cover `openai-compatible` models only.

For downstream systems that need more than a field-to-name map (a header from a claim or from session metadata, a different value format, dropping one), bind a resolver in a plugin's `register()`. It runs on every model request and is merged over the model's `identityHeaders`: a string sets or replaces a header, `null` removes it.

```ts
definePlugin({
	name: "downstream",
	register: (container) =>
		container.value(Services.identityHeaders, (call) => ({
			"X-Account": call.userId,
			"X-Workspace": String(call.metadata?.workspace ?? ""),   // session.create metadata; "" sends nothing
			"X-User-Name": null,                                      // drop what the config sent
		})),
});
```

`call` has `sessionId`, `turnId`, `userId`, `userName`, `tenantId`, `metadata`, and `principal` (with its claims; absent for work resumed after a restart until the user calls again).

Events arrive as `{"jsonrpc":"2.0","method":"session/event","params":{ sessionId, eventId, type, ... }}`:

| `type` | Fields | Use |
|---|---|---|
| `snapshot` | `busy`, `activeTools`, `inbox`, `tasks` | State when a GET stream starts without a resumable id |
| `run.started` / `run.finished` | `submissionIds` | |
| `text.delta` | `text` | Chat UI |
| `speech` | `text`, `index` | TTS: a complete, markdown-free sentence |
| `thinking.delta` | `text` | Only when the profile sets `thinkingEvents` |
| `message.end` | `text`, `stopReason`, `error?`, `source?` | `source`: the plugin that wrote it without the model |
| `tool.started` / `tool.finished` | `callId`, `name`, `isError` | Play a filler phrase; show progress |
| `tools.active` | `names` | The offered tool set changed |
| `task.updated` | `taskId`, `name`, `status` | A background task started or changed status |
| `inbox` | `items` | Queued steers and follow-ups |
| `submission` | `submissionId`, `status`, `reason?`, `detail?` | |
| `retry`, `compaction`, `error` | | |

### Voice client flow

```ts
const headers = { authorization: `Bearer ${jwt}`, "content-type": "application/json" };
const call = (method: string, params: object, accept = "application/json") =>
	fetch("https://agent/agent", { method: "POST", headers: { ...headers, accept }, body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }) });

const { result } = await (await call("session.create", { profile: "voice" })).json();
const sessionId = result.sessionId;

// A user turn: speak each `speech` event as it arrives.
const response = await call("session.prompt", { sessionId, input: transcript }, "application/json, text/event-stream");
// ...parse SSE; on params.type === "speech" -> tts.enqueue(params.text)

// The user talks over the agent: stop playback, then
await call("session.interrupt", { sessionId, input: newTranscript }, "application/json, text/event-stream");

// The user adds a constraint while tools run ("use the EU account"):
await call("session.steer", { sessionId, input: "Use the EU account" });
```

If the connection drops mid-run, the run continues; reconnect with `GET /agent` and `Last-Event-ID` to receive what was missed.

## Configuration

Each agent owns its config file (`apps/assistant/config/agent.json`), with `${VAR}` and `${VAR:-default}` substituted from the environment (and `.env`). Relative paths resolve against the config file. `AGENT_CONFIG` names the file; the shared runtime requires it. `agent` is the required name of the agent, and `plugins` lists what it runs, such as `{ "use": "clock", "options": { "timeZone": "UTC" } }`.

- `auth`: `{ kind: "jwt", algorithms, jwksUrl | publicKeyFiles | hmacSecret, issuer, audience, requiredScopes, userClaim, nameClaim, tenantClaim, maxTokenAgeSec }` or `{ kind: "static", tokens: "{\"token\":\"user\"}" }`.
- `models`: named models. `openai-compatible` models of one gateway share a `providerId`; `anthropic` and `openai` read their usual API key env vars.
- `profiles`: per session kind (the persona a client picks at `session.create`): `model`, `thinkingLevel`, `instructionsFile`, `alwaysOnTools` (patterns), `maxActiveTools`, `preload { maxTools, minScore }`, `speech`, `thinkingEvents`, `expert { model, thinkingLevel }`.
- `instructions`: system prompt sections, one file each.
- `skillsDir`: skills (below).
- `mcpServers`: see below.
- `limits`: `maxSessionsPerUser`, `maxConcurrentRunsPerUser`, `maxConcurrentRuns`, `maxInputChars`, `maxBodyBytes`.
- `http`: `path`, `allowedOrigins` (browser origins; others are refused), `keepAliveMs`.
- `durable`: `stream { timeoutMs, cacheRetention }`, `compaction`, `retry`.

Models and profiles can also come from code: bind `Services.models` or `Services.profiles` in a plugin's `register()`.

### MCP servers

```json
"mcpServers": [
	{ "name": "crm", "transport": "http", "url": "http://crm-mcp:7002/mcp", "auth": "grant", "headers": { "x-api-key": "${CRM_SERVICE_KEY}" } },
	{ "name": "search", "transport": "stdio", "command": "npx", "args": ["-y", "some-mcp-server"], "exclude": ["admin_*"] }
]
```

Tools are offered as `<prefix><tool>` (default prefix `<name>_`; `"prefix": ""` for bare names). `auth: "grant"` calls the server with a short token minted from the conversation's agent grant, over a connection of that grant's own; `headers` are then used only to list tools, and the config needs a `grants` section. The user's token never reaches the server. `include`/`exclude` filter tools by glob. An empty `url` turns a server off. Servers connect in the background with backoff and re-list on `tools/list_changed`; `/readyz` reports each server's state.

### Skills

`skills/<name>/SKILL.md` (may reference other files in its directory) or `skills/<name>.md`:

```markdown
---
name: customer-visit
description: Use when the user prepares a customer visit.
tools: [crm:get_account, "crm:list_*", calendar:*]
keywords: [visit, meeting, 拜访]
---
Instructions...
```

The prompt lists only names and descriptions. `load_skill` returns the instructions and activates the tools matching `tools` (`[server:]glob`); tools that match a loaded skill later (a server that connects late or re-lists) are activated at the session's next input. `keywords` let preloading activate those tools before the model's first response.

## Extending auth

```ts
const entitlement = definePlugin({
	name: "entitlement",
	authenticate: async (principal) => {
		if (await isSuspended(principal.userId)) throw new AuthError(403, "suspended", "account suspended");
		return { ...principal, scopes: [...principal.scopes, ...(await rolesOf(principal.userId))] };
	},
});
```

To replace the scheme entirely, bind `Services.authenticator` in `register()`.

## Scaling

One process runs one agent and holds one SQLite storage: a second process on the same file is refused at startup, as is a different agent. To scale out, run replicas with distinct `AGENT_INSTANCE_ID`s and their own volumes. Session ids are `<agent>.<replica>.<n>`; a process that receives another's id answers 421 with `Agent-Instance`, so route by everything before the last dot (sticky routing). Storage from before agents had names keeps accepting its old `<replica>.<n>` ids.

## Development

```bash
npm run check   # tsc
npm test        # vitest over packages/* and apps/*: faux model, in-memory MCP, no network
```

### Progress feedback

Streaming clients receive a `progress` event when execution starts, without waiting for a model response.
It carries `submissionIds`, `phase` (`working`, `waiting`, `retrying`, or `finished`), and `text`.
Render it in a replaceable status area, separate from answer text. A quiet run gets a waiting notice after
12 seconds without text or tool activity; identical notices are suppressed. Retry events update the status.
Clear the status on `finished` or a terminal submission event. Reconnecting clients get the latest status in
`snapshot.progress`; existing event IDs also support replay. Progress does not enter model history or TTS.
A queued request is not described as working until execution starts. Clients can show an immediate local
pending indicator while admission is in progress.

Set `progressModel` to a configured model name for concurrent LLM-generated acknowledgements (the assistant uses `fast`). Generated acknowledgements have a five-second timeout, never enter history, and are discarded if answer text has begun. Generated mode suppresses canned status sentences; without this option, feedback uses generic execution events. Plugins can
customize or suppress `progress` using `mapEvent`. Clients must opt into rendering the new event; no frontend
is bundled here. JSON-only callers continue to receive their normal result, or can use `wait: false` with the
GET event stream.

To measure feedback latency independently of model time to first token:

```bash
npx vitest run packages/agent-pi/test/progress.test.ts --silent=false
```

The test streams real HTTP responses against a scripted model with a 600 ms delay, comparing progress hidden
and visible. It reports first readable feedback, first answer text, and model-start time. This measures local
transport behavior; it is not a production model benchmark. The generic-mode benchmark adds no model request. LLM-generated acknowledgements add one separate inference request and do not make the main model generate its first answer token sooner.

Progress architecture, lifecycle, client integration, and measurement limits: [docs/progress.md](docs/progress.md).
