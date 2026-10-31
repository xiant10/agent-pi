# agent-pi design

A multi-user agent harness on `@earendil-works/pi-durable`, reached over Streamable HTTP, with JWT auth, skills that
load tool schemas on demand, hundreds of MCP tools, and an output stream a voice app can speak as it arrives.

## Requirements

| # | Requirement | Where it is handled |
|---|---|---|
| R1 | Clients connect over Streamable HTTP | `transport/streamable-http.ts` |
| R2 | Clients can steer a running agent | `session.steer`, `session.interrupt` |
| R3 | Skills, and skill configs that load tool schemas dynamically | `skills/`, `tools/activation.ts` |
| R4 | Runs in Docker | `Dockerfile`, `docker-compose.yml`, `/healthz`, graceful shutdown |
| R5 | Many users' sessions at once | one Harness, one Conversation per session, per-user limits |
| R6 | JWT verified before any agent work, with an extension hook | `auth/`, plugins' `authenticate` |
| R7 | Fast enough for voice, still able to reason | profiles, speech segmentation, tool preloading, prompt caching |
| R8 | Hundreds of MCP tools | tool catalog, per-session active set, search, eviction |

## Layers

```
 HTTP request
   │
   ▼
 transport/      Streamable HTTP (JSON-RPC over POST, SSE responses, GET event stream, resumable)
   ▼
 auth/           Authenticator.authenticate(request) -> Principal      (runs first, always)
   │             JwtAuthenticator (JWKS / PEM / HMAC) + plugins' authenticate; StaticTokenAuthenticator for dev
   ▼
 service.ts      AgentService: create/list/get/close sessions, prompt, steer, interrupt, cancel
   │             ownership checks, per-user and global limits, per-session credential cache
   ▼
 plugins/        PluginRunner: session lifecycle, beforePrompt (may answer without the model), afterRun,
   │             mapEvent; one durable extension per plugin for model/tool hooks, sections, tools
   ▼
 events/         SessionEventHub: one durable watchEvents() subscription per live session, fanned out to
   │             N subscribers; client event mapping; speech segmentation; ring buffer for Last-Event-ID
   ▼
 pi-durable      Harness (one per process) ─ Conversation per session ─ registry (tools, prompt sections)
   │
   ├── tools/    ToolCatalog (all MCP tools, BM25 index) + activation (per-conversation active set)
   ├── skills/   skill files: instructions + tool patterns; load_skill activates the skill's tools
   └── mcp/      McpConnectionManager: lazy connect, reconnect, list_changed refresh, per-user clients
```

## R6: authentication

Problem: every request must be tied to a verified user before it can touch a session, and deployments need their
own checks (tenant entitlement, revocation, role mapping) without forking the server.

Solution: one interface, applied before routing:

```ts
interface Authenticator {
	authenticate(request: AuthRequest): Promise<Principal>; // throws AuthError(401|403)
}
type Principal = { userId; tenantId?; scopes; claims; token; expiresAt? };
```

`JwtAuthenticator` verifies with `node:crypto` only (no new dependency):

- Algorithms: RS256/384/512, PS256/384/512, ES256/384/512, EdDSA, HS256/384/512. The allowed list is explicit
  config; `none` is never accepted, and an HMAC key is never used to verify an asymmetric token (prevents
  algorithm-confusion attacks).
- Keys: a JWKS URL (cached; refetched on an unknown `kid`, at most once per `jwksMinRefreshMs`), static JWKs or PEM
  public keys, or an HMAC secret read from an env var.
- Claims: `exp`, `nbf`, `iat` with `clockToleranceSec`; `iss` and `aud` when configured; `requiredScopes`.
- `userClaim` (default `sub`) and `tenantClaim` pick identity fields.
- Deployment checks are plugins' `authenticate` hooks. They run after signature and claim checks, in plugin order,
  and may return a changed principal or throw `AuthError` to reject.

A session is owned by `(tenantId, userId)`. Another user's session id returns 404, so its existence is not revealed.

## Package boundary and plugins

Problem: the harness (protocol, auth, durability, tool loading, voice output) is the same for every product, but the
persona, prompts, models, skills, integrations, and deterministic business rules differ per product. They used to live
in one tree, so a second product meant a fork.

Solution: two kinds of package.

- `packages/agent-pi`: only technical concerns. It exports `runAgent()`/`startAgent()`, the plugin contract, an IoC
  container, and test helpers. It contains no prompt text, persona, model choice, or integration.
- `apps/<product>`: the entry point. It owns `config/agent.json` (models, profiles, instructions, MCP servers, limits),
  prompt files, skills, content, and plugins, and calls `runAgent({ config, plugins })`.

### Inversion of control

`startAgent()` is the composition root. Core services are bound as lazy factories in a `Container` under `Services`
tokens: `config`, `log`, `models`, `profiles`, `skills`, `storage`, `authenticator`, `mcpTransport`. Startup runs in
phases:

```
bind defaults ─► plugin.register(container)   rebind / decorate core services, bind plugin services
              ─► build: profiles, skills, catalog, MCP, registry (instructions ─ plugin.<name> × n ─ agent.core), harness
              ─► bind catalog, harness
              ─► plugin.setup(host)            get services; keep host.session(id) for background work
              ─► harness.resume(), MCP start, listen
shutdown      ─► stop HTTP ─► plugin.dispose() (reverse) ─► MCP ─► harness
```

`harness.resume()` runs after `setup()`, so unfinished runs that call plugin hooks after a restart find the plugins'
services ready.

### Hook points

```
request ─► authenticator ─► plugin.authenticate × n
session.create ─► plugin.sessionCreated × n
session.prompt ─► limits ─► plugin.beforePrompt × n ─┬─ reply ──► write user + assistant entries (no model) ─┐
                                                     ├─ reject ─► 422                                       │
                                                     └─ input', tools ─► preload ─► submit                  │
   generation:  beforeModelRequest ─► model ─► afterModelResponse ─► onFinalAnswer (may continue)           │
   tool call:   beforeToolCall ─► execute ─► afterToolCall                                                  │
   settled ─► plugin.afterRun × n (background) ◄────────────────────────────────────────────────────────────┘
events ─► EventMapper ─► plugin.mapEvent × n ─► SSE
```

Model and tool hooks are pi-durable `GenerationTask` and `ToolTask` hooks in one extension per plugin
(`plugin.<name>`), which every conversation selects, including the `consult_expert` child. They run inside durable
task phases that replay after a crash, so they get read-only state and `memo()`. `beforeModelRequest` changes one
request and stores nothing, which keeps the transcript and the provider's cached prefix stable.

Plugin sections render between the configured instructions and the skill index, because extension install order is
section order. In-process plugin tools enter the `ToolCatalog` under the plugin's name, so they reuse skill
patterns, search, preloading, eviction, and `alwaysOnTools`. The catalog listener skips plugin servers: their code
is in the plugin's extension, not an MCP proxy.

### Answering without the model

Some inputs have a deterministic answer: greetings, FAQ lookups, an order status from an API, a refusal. Calling the
model for them adds latency and cost. But if the answer were sent to the client only, the model would not know it
happened, and the next turn ("and on weekends?") would lose its context.

So a plugin's answer is written to the transcript as `app.message` entries: one per message, holding a `UserMessage`
or an `AssistantMessage` in `model`, with `data.source` naming the plugin. Durable builds model context from every
entry's `model` messages, so the next request contains the exchange like any other. The assistant message has
`provider: "agent-pi"`, `model: "plugin:<name>"`, and zero usage, so spend reports stay exact. Durable's event stream
derives `message_start`/`message_end` from each entry's first message, so the existing `EventMapper` emits
`text.delta`, `speech`, and `message.end` (with `source`) for it. A voice client cannot tell a plugin answer from a
model answer.

Placement: when the conversation is idle (no `pi.live.run`, empty inbox), the entries are appended in one commit that
checks both. When it is busy, they are admitted as durable write submissions and placed at the next boundary, so
they never split a tool round. `app.record` entries carry no `model` messages: they are for UIs and audits only.

## R1: Streamable HTTP transport

Problem: clients, including the voice app, need a single connection model that supports request/response,
streamed responses, a long-lived event stream, and reconnects that do not lose events.

Solution: the transport semantics of MCP's Streamable HTTP (spec 2025-06-18), with agent methods instead of MCP
methods. MCP clients already implement this pattern, and it works through ordinary HTTP proxies.

- `POST /agent` with one JSON-RPC request. `Agent-Session-Id` header (or `params.sessionId`) selects the session.
  - `Accept: text/event-stream` on `session.prompt` / `session.interrupt`: the response is an SSE stream of
    `session/event` notifications for that run, ending with the JSON-RPC response, then closed. Every stream receives
    every session event; the `Agent-Submission-Id` response header names the stream's own submission, so a client can
    tell its input's `submission` events from another's. A plugin's answer has no submission, and no header.
  - Otherwise the response is `application/json` with the JSON-RPC result.
- `GET /agent` with `Agent-Session-Id` and `Accept: text/event-stream`: the session's event stream, independent of
  any request. `Last-Event-ID` resumes from an in-memory ring buffer; if the id is too old, or the process
  restarted, the stream starts with a `snapshot` event instead.
- `DELETE /agent` with `Agent-Session-Id`: close the session.
- Every SSE event has `id: <seq>`; keep-alive comments every 15 s; optional `Origin` allow-list.

Methods:

| Method | Params | Result |
|---|---|---|
| `session.create` | `{ profile?, metadata? }` | `{ sessionId, profile }` (+ `Agent-Session-Id` header) |
| `session.list` | `{}` | `{ sessions: [...] }` |
| `session.get` | `{}` | `{ sessionId, profile, busy, activeTools, usage }` |
| `session.prompt` | `{ input, requestId?, whenBusy? }` | `{ submissionId, status, text? }` |
| `session.steer` | `{ input, requestId? }` | `{ submissionId, placement }` |
| `session.interrupt` | `{ input?, requestId? }` | like `session.prompt`, or `{ aborted: true }` |
| `session.cancel` | `{}` | `{ aborted: true }` |
| `session.retry` | `{}` | `{ retried }` |
| `session.close` | `{}` | `{ closed: true }` |
| `skills.list` | `{}` | `{ skills: [{ name, description }] }` |

Client events (`session/event` notification `params`; the type is `ClientEventBody` in `events/mapper.ts`):

```
snapshot        { busy, activeTools, inbox }     state when a GET stream starts without a resumable id
run.started     { submissionIds }
run.finished    { submissionIds }
text.delta      { text }                         raw assistant text, for chat UIs
speech          { text, index }                  speakable sentences, for TTS
thinking.delta  { text }                         only when the profile sets thinkingEvents
message.end     { text, stopReason, error?, source? }   source: the plugin that wrote it without the model
tool.started    { callId, name }
tool.finished   { callId, name, isError }
tools.active    { names }                        the offered tool set changed (skill, search, preload, eviction)
inbox           { items }                        queued steers, follow-ups, and writes
submission      { submissionId, status, reason?, detail? }
retry           { attempt, at, error }           a model request is retried
compaction      { phase }                        start | end
error           { message }
```

## R2: steering

Durable places a steer at the next tool-round boundary. Without a tool round, it waits for the answer to finish,
then starts the next run.

Example trace, voice user barges in while the agent is speaking a long answer:

```
t0  prompt "summarize my pipeline"          run starts, model streams text
t1  user: "no, just the top three"          steer queued in pi.inbox
t2  model finishes the long answer          final boundary places the steer -> new run
```

The user hears the whole unwanted answer. So there are two operations:

- `session.steer`: durable steer. Use it to add constraints while the agent works through tools ("use the EU
  account"). It joins the current run after the current tool round.
- `session.interrupt`: `conversation.abort()` (stops generation and tool calls, withdraws queued inputs), then
  submits the new input as a fresh prompt. Use it for barge-in. The aborted partial answer stays in storage as an
  aborted assistant entry, but durable leaves aborted entries out of model context, so the model does not know what it
  had already said. A client that needs it to, such as a voice client that knows what was heard, says so in `input`.
  An aborted tool is reported to the model as aborted, even if it had already acted, and models then tell the user it
  did not happen (measured: "cancelled" for an email already sent). `duringTools: "steer"` avoids this: tools that are
  running finish, the input joins the run, and only text generation is aborted.

## R3 + R8: skills and dynamic tool loading

Problem: hundreds of MCP tools at roughly 100-300 tokens of schema each is 30k-90k tokens. Sending all of them every
request is slow (prefill latency matters for voice), expensive, and reduces tool-selection accuracy.

Solution: register all tools; send few.

1. **Catalog.** `McpConnectionManager` lists tools from every MCP server. Each becomes a `ToolRegistration` named
   `<prefix><tool>` (prefix defaults to `<server>_`; sanitized, at most 64 chars, unique across servers). Registering costs nothing per request; durable sends
   only the conversation's `activeTools`. A server that is down at startup is retried in the background; its tools
   appear when it connects. `notifications/tools/list_changed` triggers a re-list and an atomic registry swap.
2. **Core set.** A new session's active tools are only the meta-tools (`load_skill`, `search_tools`) plus each
   profile's `alwaysOnTools` patterns.
3. **Skills.** A skill is a Markdown file with frontmatter:

   ```markdown
   ---
   name: customer-visit-preparation
   description: Use when the user prepares for a customer visit.
   tools: [crm:get_account, "crm:list_*", "calendar:*"]
   keywords: [visit, meeting, prepare]
   ---
   ...instructions...
   ```

   The system prompt lists skill names and descriptions only. `load_skill(name)` returns the instructions and
   activates the tools matching `tools` patterns, in the same tool call. The session remembers loaded skills
   (`app.tools.skills`); when a server connects late or re-lists its tools, matching tools that are new to a loaded
   skill are activated before the next user input is answered. Tools the skill already had are not re-added, so an
   eviction holds until `load_skill` is called again. Once all of a skill's tools are evicted, the session forgets the
   skill.
4. **Search.** `search_tools(query)` runs BM25 over tool names and descriptions, activates the top matches, and returns
   their names and one-line descriptions. It covers tools no skill mentions.
5. **Preload (zero round trips).** Before a prompt is submitted, the same index scores the user's input; skills
   whose `keywords` match and tools above `preload.minScore` are activated, up to `preload.maxTools`. When this hits,
   the model calls the right tool in its first response, saving one model round trip (often 0.5-2 s).
6. **Budget.** `maxActiveTools` caps the set. When an activation would exceed it, the oldest dynamically activated
   tools are evicted (core tools never). Eviction is a durable `pi.system` entry, so the next request is
   consistent.

Why this keeps provider prompt caches warm: durable records tool changes as positional `pi.system` entries. Additions
append, so the earlier prefix of the request stays the same and the cache still matches it. Changes take effect at
the next model request, including mid-run: the model that calls `load_skill` can call the new tools in its next
response.

Mapping onto pi-durable 1.4.0: every MCP server is one extension (`mcp.<server>`) holding all of its tools; a server
refresh re-installs that extension in place. The meta-tools live in the `agent.core` extension. A conversation's
`pi.agent.tools` is a name array, the exact set offered. Activation edits that array and an `app.tools` document
(activation order, for eviction) in one commit from the tool's `api.commit()`.

## R7: speed and reasoning

Speed, in order of impact:

- **Profiles.** `session.create({ profile: "voice" })` selects a model, thinking level, extra instruction sections
  (short spoken sentences, no markdown, one question at a time), output token cap, and `alwaysOnTools`. A fast model
  for voice, a reasoning model for chat. Profile sections render conditionally, from the session document.
- **Few tools per request** (above): smaller prefill, faster first token.
- **Prompt cache**: stable prefix; `cacheRetention` passed through stream options.
- **Speech segmentation on the server**: `speech` events carry complete sentences, or clauses after `minChars` when
  a sentence runs long, with markdown stripped. TTS can start on the first sentence, not the full answer. Flushed at
  tool start and run end.
- **Tool preloading** removes the discovery round trip.
- **Parallel tool execution** (durable default) and warm MCP connections.
- Durable commits partial output at most every 100 ms; that is the floor on delta latency. Acceptable for TTS, which
  buffers at sentence granularity anyway.

Reasoning without making every turn slow: the voice profile can enable `consult_expert`, which runs a child
conversation (durable ownership: aborting the parent call aborts the child) on the profile's `expertModel` with
thinking enabled, and returns its conclusion. The fast model answers simple turns itself and delegates hard ones;
the voice app can play a filler phrase on `tool.started` for `consult_expert`.

## R5: multi-user and scaling

- One Node process, one durable Harness, one Conversation per session. Concurrent sessions are concurrent async
  work. Sessions do only network I/O (model, MCP), so the event loop is not the bottleneck; commits are serialized per
  Harness and SQLite WAL handles the write rate of dozens of concurrent streams.
- Ownership: per-conversation `app.session` document `{ userId, tenantId, profile, createdAt, closed }`,
  plus a per-user session doc family `app.user-sessions[<tenant>/<user>]` for listing. Both O(1) per
  operation, unlike a single global map.
- Limits: `maxSessionsPerUser`, `maxConcurrentRunsPerUser`, `maxConcurrentRuns` (global). Exceeding them returns 429
  with `Retry-After`. A prompt reserves its run slot before any await (plugins, commits), so concurrent prompts cannot
  all pass the check; the slot is released when the input settles or is answered by a plugin. The counts are in
  memory, so runs resumed after a restart are not counted until they settle.
- Idempotency: a `requestId` names one input. A retried model input returns its existing submission (durable dedupes
  by `requestId`) without running plugins or preloading again; a retried input that a plugin answered returns the
  same reply from `app.replies` without writing a second exchange. A retried `session.interrupt` does not abort again, so it
  cannot stop the run its first attempt started.
- Credentials for MCP: servers with `auth: "forward"` receive the caller's bearer token. The latest verified
  principal per session is kept in memory only (tokens are never written to storage), and dropped once it expires or
  the session goes 30 minutes without a request while not working. A run with no live principal (resumed after a
  restart, or after that eviction) gets a tool error asking the user to reconnect.
- Horizontal scaling: durable storage has one owner process. Run N replicas, each with its own volume. Public
  session ids are `<instanceId>.<conversationId>`; a replica receiving another instance's id answers 421 with an
  `Agent-Instance` header, so the gateway can route by the id prefix (sticky routing).
- Long sessions: pi-durable compaction (settings `compaction`) summarizes older context in the background, so a
  long voice call does not grow prefill latency without bound.
- Restart: runs left unfinished resume (`harness.resume()`); event streams restart with a `snapshot`.

## R4: Docker

- The image is built from the repository root with `apps/<app>/Dockerfile`. It runs the app's `src/main.ts` (Node strips
  types; no build step) as the unprivileged `node` user.
- `GET /healthz` (process up) and `GET /readyz` (listening, not shutting down, and durable has not failed; the detail lists each MCP server's
  state, but a server that is down does not make the replica unready, since its tools join when it connects) are
  unauthenticated.
- SIGTERM: stop accepting, send `server.shutdown` on open streams so clients reconnect, close the HTTP server, MCP
  clients, and the Harness. Unfinished runs resume on the next start.
- State volume holds the SQLite file. JWT settings and MCP server URLs come from env via `${VAR}` substitution.

## Source map

Paths are under `packages/agent-pi/src/` unless noted.

| Concern | File |
|---|---|
| Composition root, process entry | `app.ts`, `run.ts` |
| Plugins and IoC | `plugins/types.ts`, `container.ts`, `services.ts`, `runner.ts`, `history.ts` |
| Config | `config.ts` |
| Auth | `auth/authenticator.ts`, `jwt.ts`, `static-token.ts`, `credentials.ts` |
| Sessions and limits | `sessions.ts`, `service.ts` |
| Durable wiring | `agent/core-extension.ts`, `docs.ts`, `profiles.ts`, `models.ts` |
| Tools | `tools/catalog.ts`, `activation.ts`, `mcp-extension.ts`, `mcp/manager.ts` |
| Skills | `skills/skills.ts` |
| Events and speech | `events/hub.ts`, `mapper.ts`, `speech.ts` |
| Transport | `transport/http.ts`, `streamable-http.ts`, `sse.ts` |
| Test helpers (`agent-pi/testing`) | `testing.ts` |
| The assistant app | `apps/assistant/src/main.ts`, `src/plugins/`, `config/`, `prompts/`, `skills/`, `content/` |

## Not yet built

- A metrics endpoint (time to first token, run duration, tool latency per server). Logs carry request timings today.
- Per-tenant rate limits beyond the per-user and global run limits.
- An MCP tool schema cache on disk, so tools of a server that is down at startup are still listed.
