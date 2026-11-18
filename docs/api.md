---
title: "agent-pi API"
audience: consumer
kind: reference
status: current
summary: "HTTP endpoints, JSON-RPC methods, events and errors of an agent-pi harness, beyond the agent contract."
---

# agent-pi API

The reference for calling an agent-pi harness: its HTTP endpoints, JSON-RPC methods, events and errors. It implements the agent contract in the t10 workspace's [`contracts/agent/README.md`](../../contracts/agent/README.md); this page adds what agent-pi offers beyond it. The [README](../README.md#protocol) has the short form and a voice client's flow, and [`developer-guide.md`](guides/developer-guide.md#calling-the-agent-from-a-client) lists what clients most often get wrong.

## Reaching it

| From | Base URL |
| --- | --- |
| A client in t10 | `ai-gateway-agent`, or workbench's `/api/agents/{agent}/agent`, which route to a replica |
| A service on the cluster | `http://agent-pi:18100` |
| A standalone run | `http://localhost:9800` with the bundled app's Compose file |

## Endpoints

| Method and path | Does |
| --- | --- |
| `POST /agent` | One JSON-RPC 2.0 request. `session.prompt` and `session.interrupt` answer as SSE when `Accept` includes `text/event-stream`, with the stream's submission in `Agent-Submission-Id` |
| `GET /agent` | The session's events, as SSE. Send `Last-Event-ID` to resume |
| `DELETE /agent` | Close the session in `Agent-Session-Id` |
| `POST /mcp` | The agent offered as MCP tools, when `mcpEndpoint` is configured. Each tool takes a `task`, runs it in a one-shot session, and returns the answer |
| `GET /v1/runtime` | The manifest, with no token (below) |
| `GET /healthz` | `{"ok": true}`, with no token |
| `GET /readyz` | `{ready, detail}`, `503` while not ready, with no token |

## Headers

| Header | Means |
| --- | --- |
| `Authorization: Bearer <token>` | Required on `/agent` and `/mcp`. A t10 access token, or a delegated token for a run. The tenant comes only from the token |
| `Agent-Session-Id` | The session. `params.sessionId` also works |
| `Agent-Name` | Must name this harness's agent, or it answers `400 unknown_agent` |
| `Agent-Request-Id` | Makes `session.create` idempotent: a repeat answers the first session it made |
| `X-Turn-ID` | Names the turn (1 to 128 of `A-Za-z0-9._:-`). Generated when absent, and returned as `turnId` |
| `traceparent` | Joins the caller's trace |
| `Origin` | A browser origin must be in `allowedOrigins`, or it answers `403 origin_not_allowed` |

## The manifest

```json
{
  "contract": 0, "harness": "pi", "harness_version": "0.2.0",
  "pool": "assistant", "agent": "assistant", "bundle": "assistant@2026-11-02",
  "profiles": ["chat", "voice"],
  "capabilities": ["steer", "interrupt", "voice", "retry", "background_tasks", "durable_runs"],
  "builtin_tools": [], "methods": []
}
```

`capabilities` says which methods and events below this harness supports, and `methods` names a plugin's extra methods.

## Methods

Session IDs are `<pool>.<replica>.<n>`. A session belongs to its tenant and person, and anyone else's answers `404`, as an unknown or closed one does.

| Method | Params | Result |
| --- | --- | --- |
| `agents.list` | | `{agents: [{name}]}`, this harness's agent |
| `session.create` | `profile?`, `metadata?` | `{sessionId, profile, createdAt, origin, capabilities}` |
| `session.list` | `archived?`, `limit?` (1 to 200), `cursor?` | `{sessions, nextCursor?}`, most recently active first, each with `lastActiveAt`, `busy`, `origin`, `capabilities`, and `archived` when set. Without `limit`, every session |
| `session.get` | | `{sessionId, profile, busy, parked, activeTools, usage, subagents, tasks, taskUsage}` |
| `session.messages` | `limit?` (1 to 200, default 50), `cursor?` | `{messages, nextCursor?}`, oldest first, newest page first. Lines are `user`, `assistant`, `tool` (no result), `task` and `compaction`. Readable while archived |
| `session.tool` | `callId` | `{request?, response?}`: one recorded tool call and its result, for the session's owner |
| `session.update` | `title?`, `pinned?`, `archived?` | The session's info. Archiving stops its run and its background tasks, and refuses input until restored |
| `session.prompt` | `input`, `requestId?`, `turnId?`, `whenBusy?` (`followUp`, `steer`, `reject`), `wait?`, `abortOnDisconnect?` | `{turnId, submissionId, status, reason?, detail?, text?}`, or `{turnId, status: "done", answeredBy, text, placement}` when a plugin answered |
| `session.steer` | `input`, `requestId?`, `turnId?` | `{turnId, submissionId, placement}`. Joins the current run after its tool round |
| `session.interrupt` | `input?`, `requestId?`, `turnId?`, `duringTools?` (`abort`, `steer`) | As `session.prompt`, or `{aborted: true}`. Stops the current answer at once |
| `session.cancel` | `tasks?` | `{aborted: true}`. With `tasks`, also ends background tasks |
| `session.retry` | | `{retried}`: runs tasks parked after repeated crashes again |
| `session.close` | | `{closed: true}` |
| `skills.list` | | The caller's tenant's skills, with `flow`, and `source` for a tenant's own |
| `skills.get` | `skill` | One skill as the tenant sees it, with `body`, `keywords` and its file names |
| `skills.checkFlow` | `skill`, `flow`, `tools?` | `{flow, tools}`: checks a tenant's workflow as the harness reads it, saving nothing |
| `skills.tools` | | `{tools: [{name, server, tool, description}]}`: the tools the tenant can give a skill |
| Plugin methods | As the plugin defines | As the plugin returns |

`input` is a string, or content blocks: `{type: "text", text}` and `{type: "image", data, mimeType}`. Send a `requestId` with every `prompt`, `steer` and `interrupt`, and reuse it when retrying: a retry returns the first outcome and keeps its first turn.

```http
POST /agent
Authorization: Bearer <token>
Agent-Session-Id: assistant.0.17
Accept: application/json, text/event-stream

{"jsonrpc": "2.0", "id": "1", "method": "session.prompt",
 "params": {"input": "Summarize my open tasks", "requestId": "r-81f2", "whenBusy": "followUp"}}
```

## Events

Each arrives as `{"jsonrpc": "2.0", "method": "session/event", "params": {sessionId, eventId, type, …}}`. A client ignores types it doesn't know.

| `type` | Fields | Use |
| --- | --- | --- |
| `snapshot` | `busy`, `activeTools`, `inbox`, `tasks`, `partial?` | State when a stream starts without a resumable ID, or after a gap. `partial` is the reply in progress |
| `run.started`, `run.finished` | `submissionIds` | |
| `text.delta` | `text`, `turnId`, `messageId`, `offset` | Reply text. `offset` is where it starts in the message, to spot gaps and duplicates |
| `speech` | `text`, `index` | For voice: a complete sentence without markdown |
| `thinking.delta` | `text` | Only when the profile sets `thinkingEvents` |
| `message.end` | `text`, `stopReason`, `error?`, `source?` | The full message. `stopReason` is `aborted` after a cancel; `source` names a plugin that answered |
| `tool.started`, `tool.finished` | `callId`, `name`, `isError` | Progress, or a filler phrase on a call |
| `tools.active` | `names` | The tools offered changed |
| `task.updated` | `taskId`, `name`, `status` | A background task started or changed |
| `inbox` | `items` | Queued steers and follow-ups |
| `submission` | `submissionId`, `status`, `reason?`, `detail?` | |
| `retry`, `compaction`, `error` | | |

The stream lives past the run that started it: keep one per open session, for queued replies, background tasks and other devices. A stream ends when the token that opened it expires; reconnect with a fresh token and `Last-Event-ID`. The harness replays up to 1,024 buffered events, and sends `snapshot` past that.

## Errors

A JSON-RPC error has an HTTP status, a JSON-RPC code, and `data.code`:

| Status | `code` | Means |
| --- | --- | --- |
| 400 | `parse_error`, `invalid_request`, `invalid_params`, `unknown_agent` | A malformed request |
| 401 | `missing_token`, `invalid_token`, `token_expired` | A token problem. Get a fresh token |
| 403 | `insufficient_scope`, `grant_not_live`, `grant_refused`, `rejected`, `origin_not_allowed` | Not allowed, or the run's grant ended |
| 404 | `session_not_found`, `not_found`, `method_not_found`, `tool_not_found` | Unknown, closed or someone else's session, or an unknown method |
| 409 | `busy` | Busy, with `whenBusy: "reject"` |
| 409 | `session_archived` | Restore the session first |
| 410 | `session_ended` | The session is gone |
| 413 | `too_large` | The body is over the limit |
| 421 | `misdirected` | Another replica's session. A router sends it on |
| 422 | `too_many_hops` | Agents calling agents went too deep |
| 429 | `rate_limited` | Wait `Retry-After` seconds |
| 503 | `auth_unavailable` | Tokens can't be checked right now |
| 500 | `internal` | Something failed here |

## Docs for coding agents

`POST /docs/mcp` serves this repo's docs for people building on t10, over MCP and with no token, as the workspace's [docs contract](../../contracts/docs/README.md) describes. `node packages/agent-pi/src/docs.ts <addr>` serves only that route, for the contract's suite.
