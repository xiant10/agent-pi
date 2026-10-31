# Building agents on agent-pi

This guide is for developers who build a product on the `agent-pi` package: a new agent app, its configuration,
skills, tools, and plugins, and how to test and ship it. For why the harness works the way it does, read
[`design.md`](design.md); for the wire protocol, the [README](../README.md#protocol).

- [The split: harness and app](#the-split-harness-and-app)
- [Create an app](#create-an-app)
- [Configuration](#configuration)
- [Prompts and profiles](#prompts-and-profiles)
- [Tools: MCP servers and the active set](#tools-mcp-servers-and-the-active-set)
- [Skills](#skills)
- [Plugins](#plugins)
- [Durability rules for plugin code](#durability-rules-for-plugin-code)
- [Testing](#testing)
- [Deploying](#deploying)
- [Calling the agent from a client](#calling-the-agent-from-a-client)
- [Checklist](#checklist)

## The split: harness and app

`agent-pi` owns everything that is the same for every product:

| The harness (`packages/agent-pi`) | Your app (`apps/<name>`) |
|---|---|
| Streamable HTTP transport, JSON-RPC methods, SSE events, resume | `config/agent.json`: models, profiles, limits, MCP servers |
| JWT and static-token auth, session ownership, limits | Prompt files: persona, rules, per-profile instructions |
| Durable sessions, runs, and tool calls in SQLite; restart recovery | Skills: task instructions plus the tools they need |
| MCP connections, the tool catalog, search, preloading, eviction | Plugins: deterministic business logic, in-process tools, integrations |
| Steering, barge-in, speech segmentation, the expert tool | Tests of your plugins against the real harness |
| The plugin contract and an IoC container | The entry point and the Docker image |

The harness contains no prompt text, persona, model choice, or integration. If you find yourself wanting to edit
`packages/agent-pi` for one product, look for a plugin hook first; if none fits, the hook is what the harness should
gain.

## Create an app

The `assistant` app is the reference. A minimal app is four files:

```
apps/my-agent/
  package.json
  src/main.ts
  config/agent.json
  prompts/base.md
```

**`package.json`**: the workspace resolves `agent-pi` from `packages/agent-pi`.

```json
{
	"name": "my-agent",
	"private": true,
	"type": "module",
	"engines": { "node": ">=24.21.0" },
	"scripts": {
		"start": "node --disable-warning=ExperimentalWarning src/main.ts",
		"test": "vitest --run"
	},
	"dependencies": { "agent-pi": "*" }
}
```

**`src/main.ts`**: `runAgent()` loads `.env` and the config, starts the server, and handles SIGTERM.

```ts
import { runAgent } from "agent-pi";
import { plugins } from "./plugins/index.ts";

await runAgent({ config: new URL("../config/agent.json", import.meta.url), plugins });
```

Use `startAgent(config, options)` instead when you embed the agent in another process or need the `RunningAgent`
handle (its `close()`, `harness`, `catalog`, `container`).

**`config/agent.json`**: the smallest useful configuration. Paths are relative to this file.

```json
{
	"port": "${PORT:-9800}",
	"storage": { "kind": "sqlite", "path": "${AGENT_DATA_DIR:-../data}/agent.sqlite" },
	"auth": { "kind": "${AUTH_KIND:-jwt}", "tokens": "${AGENT_TOKENS:-}", "jwksUrl": "${JWT_JWKS_URL:-}", "algorithms": "RS256" },
	"models": {
		"main": {
			"provider": "openai-compatible",
			"modelId": "${MODEL_ID}",
			"baseUrl": "${LLM_BASE_URL}",
			"apiKeyEnv": "LLM_API_KEY"
		}
	},
	"profiles": { "chat": { "model": "main", "maxActiveTools": 32 } },
	"instructions": [{ "name": "base", "file": "../prompts/base.md", "tag": false }]
}
```

**Run it** (Node 24.21+ runs the `.ts` sources directly; there is no build step):

```bash
npm install
AUTH_KIND=static AGENT_TOKENS='{"dev-token":"dev"}' MODEL_ID=my-model \
  LLM_BASE_URL=http://localhost:7200/v1 LLM_API_KEY=... npm start -w my-agent

curl -s localhost:9800/agent -H 'authorization: Bearer dev-token' -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"session.create"}'
# -> {"result":{"sessionId":"<id>", ...}}
curl -s localhost:9800/agent -H 'authorization: Bearer dev-token' -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"session.prompt","params":{"sessionId":"<id>","input":"Hello"}}'
```

Add the app to the root `tsconfig.json` `include` if it lives outside `apps/*`, so `npm run check` typechecks it.

An app in its own repository depends on a published `agent-pi`. Node does not strip types under `node_modules`, so
publishing needs a `tsc` step that emits `.js` first (see the README).

## Configuration

`loadConfig()` reads JSON, substitutes `${VAR}` and `${VAR:-default}` in every string (an unset variable without a
default is a startup error), and validates each field, failing with the field's path. Numbers and booleans may arrive
as strings from substitution; lists may be comma-separated strings. `AGENT_CONFIG` replaces the config path, and
`AGENT_ENV_FILE` (default `.env`) is loaded first; variables already set in the environment win over the file.

| Key | Default | Notes |
|---|---|---|
| `port`, `host` | `9800`, `0.0.0.0` | |
| `instanceId` | generated, stored | Prefix of session ids; set one per replica (see [Deploying](#deploying)) |
| `storage` | `sqlite`, `agent.sqlite` | `{ "kind": "memory" }` for throwaway runs |
| `auth` | required | `kind: "jwt"` (`algorithms`, `jwksUrl` or `publicKeyFiles` or `hmacSecret`, `issuer`, `audience`, `requiredScopes`, `userClaim`, `nameClaim`, `tenantClaim`, `clockToleranceSec`, `requireExp`, `maxTokenAgeSec`) or `kind: "static"` with `tokens` as a JSON map of token to user id (development only) |
| `models.<name>` | at least one | `provider`: `anthropic`, `openai`, or `openai-compatible` (`baseUrl`, `apiKeyEnv`, `api`: `chat-completions` or `responses`, `reasoning`, `contextWindow`, `maxOutputTokens`, `providerId`). Models of one `providerId` must share `baseUrl`, `api`, and `apiKeyEnv` |
| `profiles.<name>` | at least one | See [Prompts and profiles](#prompts-and-profiles) |
| `defaultProfile` | first profile | Used when `session.create` names none |
| `instructions` | `[]` | `{ name, file, tag }` system prompt sections, in order; `tag: true` (default) wraps them in `<name>` |
| `skillsDir` | none | See [Skills](#skills) |
| `mcpServers` | `[]` | See [Tools](#tools-mcp-servers-and-the-active-set) |
| `limits` | 20, 3, 200, 32000, 1 MB | `maxSessionsPerUser`, `maxConcurrentRunsPerUser`, `maxConcurrentRuns`, `maxInputChars`, `maxBodyBytes` |
| `http` | `/agent`, none, 15 s | `path`, `allowedOrigins` (browser origins; `*` allows all), `keepAliveMs` |
| `durable.stream` | | `timeoutMs` per model request, `cacheRetention`: `none`, `short`, `long` |
| `durable.compaction` | | `enabled`, `reserveTokens`, `keepRecentTokens`: summarize old context in long sessions |
| `durable.retry` | | `maxRetries`, `baseDelayMs` for failed model requests |
| `logLevel` | `info` | JSON lines on stdout |

Keep secrets in the environment, never in the JSON: `apiKeyEnv` names the variable holding a model key, and
`${VAR}` brings in everything else.

## Prompts and profiles

The system prompt is assembled in a fixed order, and providers cache it as a prefix, so earlier parts should change
least:

1. `instructions` from the config, in order.
2. Each plugin's `instructions` sections, in plugin order.
3. The skill index (names and descriptions of all skills).
4. The session profile's `instructions`.

Every part renders once per session and stays the same from request to request. Do not put the time, a counter, or
anything else that changes per turn into a section; that breaks the provider cache on every request. Per-request
context goes in a `beforeModelRequest` hook instead (see [Plugins](#per-request-context)).

A **profile** is a kind of session, chosen by the client at `session.create({ profile })`. Typical apps have a
reasoning `chat` profile and a fast `voice` profile:

| Field | Default | Effect |
|---|---|---|
| `model` | required | A key of `models` |
| `thinkingLevel` | `off` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `instructionsFile` | none | The profile's prompt section, e.g. "short spoken sentences, no markdown" |
| `alwaysOnTools` | `[]` | Tool patterns offered from the start and never evicted |
| `maxActiveTools` | `32` | Most tools offered at once |
| `preload` | `{ maxTools: 0, minScore: 4 }` | Activate likely tools from the user's words before the model runs |
| `speech` | `false` | Emit `speech` events: complete, markdown-free sentences for TTS |
| `thinkingEvents` | `false` | Emit `thinking.delta` events |
| `expert` | none | `{ model, thinkingLevel }`: offer `consult_expert`, which asks a stronger model in a child conversation |

## Tools: MCP servers and the active set

Tools come from MCP servers and from plugins. All of them are registered; each session is **offered** only a small
active set, because hundreds of tool schemas per request are slow, expensive, and make the model choose worse.

A session's active set starts with `load_skill`, `search_tools`, `consult_expert` (when the profile has an expert),
and the profile's `alwaysOnTools`. It grows when:

- the model loads a skill (its `tools` patterns),
- the model calls `search_tools` (top BM25 matches over names and descriptions),
- the user's input matches before the model runs (`preload`, and skills whose `keywords` occur in the input),
- a plugin's `beforePrompt` routes the input (`activateTools`).

When it would exceed `maxActiveTools`, the least recently activated tools are evicted. Pinned tools never are.

**Configure MCP servers** in `mcpServers`:

```json
{
	"name": "crm",
	"transport": "http",
	"url": "${CRM_MCP_URL}",
	"headers": { "x-api-key": "${CRM_MCP_KEY}" },
	"include": ["list_*", "get_*"],
	"exclude": ["*_admin"],
	"callTimeoutMs": 30000
}
```

- Tools are offered as `<prefix><tool>`, with `prefix` defaulting to `<name>_` (`crm_list_accounts`); `""` offers bare
  names. Names are sanitized to 64 characters of `[A-Za-z0-9_-]`.
- `transport: "stdio"` takes `command`, `args`, `env`, `cwd` instead of `url` and `headers`.
- `auth: "forward"` calls the server over a per-user connection carrying the caller's bearer token (in
  `forwardHeader`, default `Authorization`). Tokens live in memory only; a run resumed after a restart, or a session
  idle for 30 minutes, gets a "reconnect" tool error until the user calls again.
- A server that is down at startup is retried with backoff; its tools join the catalog when it connects, and
  `tools/list_changed` re-lists them. The server never blocks startup or other servers.

**Tool patterns**, used by `alwaysOnTools`, skills, `include`/`exclude`, and `activateTools`, are `[server:]glob`:
`crm:list_*` is every `list_` tool of server `crm`; `get_weather` is that tool on any server; `crm:*` is all of `crm`.
A plugin's in-process tools are server `<plugin name>`.

## Skills

A skill is task knowledge loaded on demand: the system prompt lists only skill names and descriptions, and
`load_skill(name)` returns the instructions and activates the skill's tools in the same call.

Put skills in `skillsDir`, as `<name>.md` or as a directory `<name>/SKILL.md` with extra files:

```markdown
---
name: customer-visit
description: Use when the user prepares for a customer visit or asks for an account briefing.
tools: [crm:get_account, "crm:list_*", "calendar:*"]
keywords: [visit, meeting, briefing, 拜访]
---

# Customer visit

1. Find the account with crm_get_account. If several match, ask which one.
2. List open opportunities and the last three activities.
3. For pricing rules, call load_skill with file "references/pricing.md".
```

- `name` matches `[a-z][a-z0-9_-]*`; `description` says **when** to use the skill, since that is all the model sees
  until it loads it.
- `tools` are patterns; tools that appear later (a server connecting late) are activated for sessions that loaded the
  skill before their next input.
- `keywords` trigger preloading of the skill's tools when the input contains one (with `preload.maxTools > 0`), so the
  model can call them in its first response without loading the skill.
- A directory skill's other files are readable with `load_skill({ name, file })`; paths outside the directory are
  refused.

Plugins can contribute skills in code with `skills: [parseSkill("inline", markdown)]`.

## Plugins

A plugin is an object of optional members, made with `definePlugin()`. Plugins run in the order of the array passed
to `runAgent`; each hook sees what earlier plugins did. Put input sanitizers first.

```
startup:   register(container) ─► services built ─► setup(host) ─► unfinished runs resume ─► listen
request:   authenticate ─► session.create: sessionCreated
input:     beforePrompt ─┬─ reply ─► written to the transcript, no model
                         ├─ reject ─► 422
                         └─ input', tools ─► model: beforeModelRequest ─► model ─► afterModelResponse ─► onFinalAnswer
                                             tools: beforeToolCall ─► execute ─► afterToolCall
settled:   afterRun (background)
events:    mapEvent per client event
shutdown:  dispose (reverse order)
```

The full member list is in the [README's plugin reference](../README.md#plugin-reference) and the doc comments of
`AgentPlugin` (`packages/agent-pi/src/plugins/types.ts`). The recipes below cover the common jobs.

### Persona and fixed instructions

```ts
import { definePlugin } from "agent-pi";

export const persona = definePlugin({
	name: "persona",
	instructions: [
		{ name: "persona", render: "You are Max, the order desk of Acme. Answer in the user's language." },
		// Rendered once per session from its profile and metadata; keep it stable within a session.
		{ name: "channel", render: ({ profile, metadata }) => (profile.speech ? `Caller region: ${metadata?.region ?? "unknown"}.` : undefined) },
	],
});
```

Prefer prompt files in the config for plain text; use plugin sections when the text depends on code, the profile,
or `session.create` metadata.

### In-process tools

```ts
import { defineTool, definePlugin, Type } from "agent-pi";

const orderStatus = defineTool({
	name: "order_status",
	description: "Status and delivery date of one order, by order number.",
	parameters: Type.Object({ orderId: Type.String({ description: "Order number, digits only." }) }),
	// A read: safe to run again if the process crashed mid-call. Leave the default ("unsafe") for writes.
	replay: "safe",
	execute: async (args) => {
		const order = await orders.get(args.orderId);
		if (order === undefined) return { isError: true, output: [{ type: "text", text: "No such order." }] };
		return { output: [{ type: "text", text: `${order.status}, arriving ${order.eta}` }] };
	},
});

export const orderDesk = definePlugin({ name: "orders", tools: [orderStatus] });
```

The tool joins the catalog as server `orders`, so skills, search, and preloading find it. To offer it always, add
`"orders:*"` to a profile's `alwaysOnTools`. Tool names must be unique across all servers and plugins.

Inside `execute`, the second argument is the tool API: `api.conversationId` identifies the session (use
`host.session(api.conversationId)` from `setup` to reach its user, state, and history), and `api.commit()` writes
durable state in the tool's own step.

### Answering without the model

`beforePrompt` decides about each input before the model sees it:

```ts
export const shortcuts = definePlugin({
	name: "shortcuts",
	beforePrompt: async (turn) => {
		const match = /order (\d+) status/i.exec(turn.text);
		if (match) return { reply: await describeOrder(match[1]!) }; // no model call
		if (/refund/i.test(turn.text)) return { activateTools: ["billing:*"] }; // route: offer these tools now
		if (turn.text.length > 2000 && turn.profile.speech) return { reject: "Please keep it shorter." }; // 422
		return undefined; // pass on unchanged
	},
});
```

- `{ reply }` writes the user's input and the reply into the transcript, so the model sees the exchange in later
  turns, and clients receive it like a model answer (`message.end` carries `source: "<plugin>"`). The result has
  `placement: "queued"` when the session was busy; the exchange then enters the transcript after the current run.
- `{ input }` rewrites the input for later plugins and the model (redaction, normalization).
- The first `reply` or `reject` ends the chain.
- A retried prompt with the same `requestId` gets the first outcome back, without running `beforePrompt` again. Side
  effects in `beforePrompt` therefore run once per `requestId`, but they do run for every distinct input; keep them
  idempotent or move them to `afterRun`.

### Per-request context

Context that changes per turn (time, the user's cart, a feature flag) belongs in `beforeModelRequest`, which edits
the messages of one request and stores nothing:

```ts
export const clock = definePlugin({
	name: "clock",
	beforeModelRequest: async (messages, ctx) => {
		// memo: the same value if this request is replayed after a crash.
		const now = await ctx.memo("now", () => new Date().toISOString());
		const note = { role: "user" as const, content: `<now>${now}</now>`, timestamp: 0 };
		const last = messages.findLastIndex((message) => message.role === "user");
		return [...messages.slice(0, last), note, ...messages.slice(last)];
	},
});
```

Insert such notes **before** the latest user message: a note after it tends to get answered instead of the user.

### Guardrails around the model and tools

```ts
export const policy = definePlugin({
	name: "policy",
	beforeToolCall: (call, ctx) =>
		call.name === "billing_refund" && !ctx.principal?.scopes.includes("refunds") ? { block: "Refunds need a supervisor." } : undefined,
	afterToolCall: (_call, result) => redactResult(result), // before the result is stored or seen
	onFinalAnswer: (answer) =>
		mentionsCompetitor(answer) ? { continue: "Rewrite the answer without naming other vendors." } : undefined,
});
```

`onFinalAnswer` with `{ continue }` sends the model a correction instead of ending the run. Make sure a correction
can satisfy the check: a guardrail the model cannot pass keeps sending it back, and every round is another model call.

### Session lifecycle, history, and state

```ts
export const greeter = definePlugin({
	name: "greeter",
	sessionCreated: async (session) => {
		await session.state.set({ greetedAt: Date.now() });
		await session.history.say(`Hi ${session.userId}, how can I help?`);
	},
	sessionClosed: async (session) => crm.closeInteraction(session.sessionId),
	afterRun: async (run) => analytics.track(run.userId, { answeredBy: run.answeredBy, status: run.status }),
});
```

- `history.say(text)` adds an assistant message the model did not write; clients receive it like an answer.
- `history.exchange(input, answer)` adds a user turn and its answer.
- `history.record(type, data)` adds an `app.record` entry for UIs and audits; the model never sees it.
- `state` is this plugin's durable JSON for the session (`get`/`set`).
- While the session is busy, history writes are queued and placed at the next turn boundary.
- Failures in `sessionCreated`, `sessionClosed`, and `afterRun` are logged, not raised. To refuse sessions, reject the
  caller in `authenticate`.

### Background work and webhooks

`setup(host)` runs once, after services are built and before the server listens. Keep `host` to reach sessions from
outside a request:

```ts
import { createServer, type Server } from "node:http";
import { type ConversationId, definePlugin } from "agent-pi";

export function shipping(options: { readonly port: number }) {
	let server: Server | undefined;
	return definePlugin({
		name: "shipping",
		setup: (host) => {
			server = createServer(async (req, res) => {
				const event = JSON.parse(await body(req)) as { conversationId: ConversationId; orderId: string };
				const session = await host.session(event.conversationId);
				await session?.history.say(`Good news: order ${event.orderId} has shipped.`);
				res.writeHead(204).end();
			}).listen(options.port);
		},
		dispose: () => new Promise<void>((resolve) => server?.close(() => resolve())),
	});
}
```

Store the `conversationId` (from `SessionContext.conversationId` or a tool's `api.conversationId`) when you start
the background job, not the public session id.

### Custom JSON-RPC methods

```ts
export const cart = definePlugin({
	name: "cart",
	rpc: {
		"cart.get": async (_params, ctx) => {
			const session = await ctx.session(); // the caller's own session; 404 otherwise
			return (await session.state.get()) ?? { items: [] };
		},
	},
});
```

Methods are served on the same endpoint and auth as the core methods, whose names cannot be reused.

### Authentication hooks

`authenticate` runs after the token is verified, for every request:

```ts
export const entitlement = definePlugin({
	name: "entitlement",
	authenticate: async (principal) => {
		if (!(await billing.isActive(principal.tenantId))) throw new AuthError(403, "inactive", "Subscription inactive.");
		return { ...principal, scopes: [...principal.scopes, ...(await roles.of(principal.userId))] };
	},
});
```

Throw `AuthError(401 | 403, code, message)`. Any other error rejects with 403.

### Shaping client events

`mapEvent` sees every client event and may change it, split it, or drop it (`null`). It is synchronous and runs per
event, so keep it cheap:

```ts
export const pronunciation = definePlugin({
	name: "pronunciation",
	mapEvent: (event) => (event.type === "speech" ? { ...event, text: event.text.replaceAll("SQL", "sequel") } : undefined),
});
```

### Replacing core services

`register(container)` runs before anything is built. Rebind or wrap a core service, or bind your own for other
plugins:

```ts
export const CrmClient = token<Crm>("crm");

export const infrastructure = definePlugin({
	name: "infrastructure",
	register: (container) => {
		container.bind(CrmClient, () => new Crm(process.env.CRM_URL!));
		container.decorate(Services.authenticator, (inner) => withAuditLog(inner));
	},
	setup: async (host) => {
		crm = await host.container.get(CrmClient);
	},
});
```

Core tokens are `Services.authenticator`, `storage`, `models`, `profiles`, `skills`, `log`, `mcpTransport` (rebindable
in `register`), and `catalog`, `harness`, `config` (read in `setup`).

## Durability rules for plugin code

Sessions, runs, and tool calls are durable: after a crash or deploy, the next process continues unfinished runs.
That shapes what hook code may do.

- **Model and tool hooks may run twice.** `beforeModelRequest`, `afterModelResponse`, `onFinalAnswer`,
  `beforeToolCall`, and `afterToolCall` run inside durable task phases that replay after a crash. Keep them
  deterministic; compute changing values with `ctx.memo(name, compute)`, which returns the stored value on replay.
  Their `ctx.state` is read-only.
- **Tools declare whether they may rerun.** `replay: "safe"` reruns an interrupted call on recovery; the default
  `"unsafe"` reports the call as interrupted instead, so a payment or an email is never sent twice.
- **Unfinished runs resume after `setup()`.** Hooks of a resumed run can rely on services from `setup`, but not on a
  live request: `ctx.principal` is undefined until the user calls again.
- **Sections are rendered from durable state**, not from in-memory variables, so they come out the same after a
  restart.

## Testing

`agent-pi/testing` starts the real harness and HTTP transport on a random port with a scripted model, in-memory
storage, static tokens (`TOKENS.alice`, `TOKENS.bob`), and optional in-memory MCP servers. Test plugins through the
protocol, the way clients use them:

```ts
import { fauxAssistantMessage, fauxText, fakeMcpServer, rpc, rpcStream, startTestAgent, type TestAgent, TOKENS } from "agent-pi/testing";
import { afterEach, expect, it } from "vitest";
import { plugins } from "../src/plugins/index.ts";

let running: TestAgent | undefined;
afterEach(() => running?.close());

it("answers order status without the model", async () => {
	running = await startTestAgent({ plugins });
	const { sessionId } = (await rpc(running.url, TOKENS.alice, "session.create")).body.result!;
	const answer = await rpc(running.url, TOKENS.alice, "session.prompt", { sessionId, input: "order 42 status" });
	expect(answer.body.result).toMatchObject({ answeredBy: "shortcuts" });
	expect(running.faux.state.callCount).toBe(0);
});

it("calls the CRM tool the model picks", async () => {
	const crm = fakeMcpServer([{ name: "get_account", description: "Get an account.", call: () => ({ name: "Acme" }) }]);
	running = await startTestAgent({ plugins, mcp: crm, config: { /* AppConfig overrides */ } });
	running.faux.setResponses([
		fauxAssistantMessage([fauxText("Looking it up.")]), // or (context) => message, to inspect the request
	]);
	// ...
});
```

- `startTestAgent({ plugins, config, skills, mcp, tokensPerSecond })`: `config` overrides `testConfig()`; `mcp` is
  served as server `crm`; `tokensPerSecond` slows the faux model to test streaming, steering, and barge-in.
- `faux.setResponses([...])` scripts model responses in order; a function step receives the request context, which is
  how tests assert what the model saw (`context.messages`). `faux.state.callCount` counts model calls.
- `rpcStream()` collects an SSE response; `events(messages)` extracts the event bodies; `waitFor(check)` polls.

Run `npm test` for everything, `npm run check` to typecheck.

**Smoke test against a real model.** Unit tests use a scripted model; before shipping, run the app against a real
gateway. The assistant's smoke test starts the app from the checkout and checks auth, model turns, plugin replies,
retries, guardrails, voice streaming, barge-in, limits, disconnects, and close:

```bash
LLM_BASE_URL=http://localhost:7200/v1 npm run smoke          # starts the assistant with .env.eval's model settings
AGENT_URL=https://staging.example.com/agent AGENT_TOKEN=... npm run smoke   # an agent that is already running
```

Its checks rely on the assistant's plugins; copy `apps/assistant/scripts/smoke.ts` into a new app and adapt the
plugin-specific checks.

## Deploying

The assistant's `Dockerfile` and `docker-compose.yml` are the template. The image is built from the repository root
(`docker build -f apps/my-agent/Dockerfile .`), copies the harness sources and the app's `src`, `config`, `prompts`,
`skills`, and `content`, and runs `src/main.ts` as the unprivileged `node` user.

- **State**: the SQLite file lives on a volume (`AGENT_DATA_DIR=/data`). Losing it loses sessions.
- **Probes**: `GET /healthz` (process up), `GET /readyz` (listening, not shutting down, durable has not failed; the
  detail lists MCP server states). Neither needs auth.
- **Storage failure**: durable treats any storage error as fatal. `/readyz` turns 503 and `runAgent` drains and exits 1,
  so run it under a restart policy. Unfinished runs resume in the new process.
- **Crash loops**: a task cut off `durable.restartLimit` times in a row (default 5) without progress is parked and logged
  as `durable.task_parked`. Its session stays busy and `session.get` shows `parked`. `session.retry` runs the session's
  parked tasks again; `session.cancel` and `session.interrupt` give up on them.
- **Shutdown**: SIGTERM ends event streams (clients reconnect), finishes commits, and closes storage. Give it time
  (`stop_grace_period: 30s`); unfinished runs resume on the next start.
- **Scaling**: storage has one owner process, so run N replicas each with its own volume and `AGENT_INSTANCE_ID`.
  Session ids are `<instanceId>.<n>`; a replica receiving another's id answers 421 with an `Agent-Instance` header, so
  a gateway routes by the id prefix.
- **Auth**: use `AUTH_KIND=jwt` in production; static tokens are for development.
- **Browsers**: set `ALLOWED_ORIGINS` to your web origins; requests with any other `Origin` are refused.

## Calling the agent from a client

The [README](../README.md#protocol) has the full method and event tables. The behaviors clients most often get wrong:

- **Send a `requestId`** with every `session.prompt`, `session.steer`, and `session.interrupt`, and reuse it when
  retrying after a network error. The retry returns the first outcome instead of asking twice.
- **A `turnId` is optional**: send one (param or `X-Turn-ID` header) to correlate your own logs with the model gateway's
  audit log; otherwise it is generated on arrival and returned in every result. See the README for `identityHeaders`.
- **Choose `whenBusy`** for input that arrives while the agent works: `followUp` (default, answered after the current
  run), `steer` (joins the current run after its tool round), or `reject` (409).
- **Barge-in is `session.interrupt`**, not `steer`: it stops the current answer at once and answers the new input.
- **Keep one `GET /agent` event stream** per session for events outside your own requests (queued plugin replies,
  proactive `history.say` messages, other devices), and reconnect with `Last-Event-ID`. A stream that cannot resume
  starts with a `snapshot` event.
- **Voice clients speak `speech` events**, not `text.delta`: they are complete sentences without markdown. Play a
  filler on `tool.started` for slow tools such as `consult_expert`.
- **Handle 429** (`Retry-After`), **409** (busy with `whenBusy: "reject"`), **404** (unknown, closed, or someone
  else's session), and **421** (another replica's session).

## Checklist

Before shipping a new agent:

- [ ] Secrets come from the environment; `config/agent.json` has only `${VAR}` references.
- [ ] Prompt sections are stable within a session; per-turn context is in `beforeModelRequest`.
- [ ] Skill descriptions say when to use the skill; tool patterns match real tool names (`npm test` with a fake server).
- [ ] Profiles cap `maxActiveTools`; voice profiles set `speech` and a fast model.
- [ ] Plugins that write externally do it in `afterRun`, `sessionClosed`, or an `unsafe` tool, not in replayable hooks.
- [ ] Tools that change data keep the default `replay: "unsafe"`.
- [ ] Plugin tests run against `startTestAgent`; `npm run check` and `npm test` pass.
- [ ] The smoke test passes against the real model gateway.
- [ ] Production uses JWT auth, a volume for `/data`, a unique `AGENT_INSTANCE_ID` per replica, and `ALLOWED_ORIGINS`.
