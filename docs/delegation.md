# Delegation: agents as tools

How one agent hands a task to another. There are two features, for two boundaries:

| | Sub-agents | Agent as an MCP service |
|---|---|---|
| Boundary | Same process, storage, and user | Across processes and products |
| Use it for | Keeping noisy work out of the main context; a different model or tool set | Clients outside this repo; agents with their own storage and config |
| Status | Built | Built |

Both look the same to the calling model: a tool that takes a task and returns an answer. A skill or a profile does not
need to know where the agent runs.

## Sub-agents

### Problem

`consult_expert` ran a child conversation that was not a session. It worked for a short answer from a reasoning model,
but anything longer or with tools needed what only sessions had:

| Without a session | Effect |
|---|---|
| Profile | A voice session's child used the default profile's tool policy |
| Grant | Held in memory only, because the grant store reads the session document. A rerun after a restart created a second grant and never revoked the first |
| Identity | An in-memory, one-hop parent link. A grandchild sent no audit headers |
| Plugin hooks | `session()` returned undefined, so hooks could not see the user |
| Visibility | Clients could not read a child's events, and `session.get` left out its spend |
| Limits | `RunTracker` does not count children, so one tool round could start any number |

### Design: a child is a session with a parent

A child conversation gets a `SessionDoc` in the commit that creates it, copied from its parent (owner, user, tenant,
metadata, profile), plus `parent`, the parent's conversation id. Its profile, grant, identity, and event stream then
come from the same place as any session's, and survive a restart.

A child is not a session a client can drive:

- `SessionStore.require` refuses it, so prompt, steer, cancel, retry, and close answer `session_not_found`.
- `SessionStore.readable` accepts it for `session.get` and the `GET` event stream, for its owner, while its parent is
  open.
- It is not in the owner's session index, so it is not listed and does not count toward `maxSessionsPerUser`.
- Only the root session's run holds a `RunTracker` slot.

A parent's `session.get` returns `subagents`, the public ids of its most recent children. A client reads a child from
there; there is no push event for a new child yet.

Things that must differ from a root session, because `session.profile` is now the parent's:

- The `profile` prompt section does not render in a child. A consulted expert must not get "short spoken sentences".
- A child's event hub never emits `speech`.
- Plugin sections take `profile` from the session, so a plugin section conditioned on a profile does render in a child.
  That is deliberate: plugin sections carry policy.

### Configuration

Sub-agents are declared at the top level of the agent's config. The model picks among them; it cannot write its own.

```json
"subagents": {
	"research": {
		"description": "Research a question across CRM and tickets. Give it the full question; it cannot see this chat.",
		"model": "smart",
		"thinkingLevel": "medium",
		"instructionsFile": "../prompts/research.md",
		"tools": ["crm_*", "tickets_search", "search_tools"],
		"timeoutMs": 120000
	}
}
```

| Field | Default | Meaning |
|---|---|---|
| `description` | required | What the calling model reads |
| `model` | required | A name from `models` |
| `thinkingLevel` | `off` | |
| `instructionsFile` | none | The child's instructions |
| `tools` | `[]` | The exact starting tool set: catalog patterns, plus `load_skill` and `search_tools` by name. Empty means no tools |
| `timeoutMs` | 300000 | The child is aborted after this long, and the tool reports it. The timer restarts on a rerun. `consult_expert` has none |
| `background` | `false` | Return at once, and report when the child's turn ends. See [async-tasks.md](async-tasks.md) |
| `idleTtlMs` | 600000 | With `background`: how long the child may wait for a reply, from the first user input after it stopped |
| `maxLifetimeMs` | 3600000 | With `background`: how long the task may live |

Each becomes a catalog tool `agent_<name>`, with the one parameter `task`. Being in the catalog means skills, search,
preload, and `alwaysOnTools` reach it the way they reach any tool; a profile offers one with
`"alwaysOnTools": ["agent_research"]`. The tool's code is in `agent.core`, so the catalog listener skips the `agents`
server, and an MCP server or plugin may not use that name. The `expert` profile setting stays as it is, and is the same
primitive with a fixed tool name.

`tools` is a starting set, not a security boundary, when it includes `search_tools`: that can activate any catalog
tool. Leave it out to fix the set. Grants are the boundary.

### Rules

- **The child starts empty.** It sees only `task`, so the caller's model must include what it needs. It is not a fork.
- **One level deep.** The tools refuse to run in a child. This is checked in `execute`, not by removing the tool from
  the offered list, because `search_tools` can activate a catalog tool again.
- **`limits.maxSubagentsPerSession`** (default 3) caps the children running at once for a session, `consult_expert`
  included. Past it, the tool returns an error the model can act on. The count is in memory, so children resumed after a
  restart are not counted until the parent tool reruns.
- **Spend rolls up.** The tool result reports the child's total usage, which durable records under the tool's name in
  the parent's `pi.usage`. A child's own `session.get` shows the same spend; do not add the two together.
- **Foreground only.** The parent's tool call waits for the child. A steer waits for that tool round, and a barge-in
  aborts the child, as with any tool. `duringTools: "steer"` waits for it to finish. Prefer short timeouts on voice
  profiles. For work that should not hold the parent, set `"background": true`: see [async-tasks.md](async-tasks.md).
- **`beforePrompt` does not run for a child.** The input comes from the calling model, not the user. Model and tool
  hooks do run. `afterRun` does not.

### Crash behaviour

The tool is `replay: "safe"`. A rerun finds the same child through durable's ownership index, the same submission
through its `requestId`, and the same grant through the child's session document. If the process dies after the auth
service created a child grant but before its id was committed, the grant is unreferenced and ends with its parent.

A child's grant is revoked when the tool call ends, including after a cancel, barge-in, or timeout, unless the process
is stopping. From inside the tool, a graceful stop looks exactly like a cancel, so `stopping()` comes from `startAgent`:
a stopped child resumes under its grant in the next process.

## Agent as an MCP service

An agent can offer itself as MCP tools at a second endpoint, for clients outside this repo and for other agents. Off
unless configured:

```json
"mcpEndpoint": {
	"path": "/mcp",
	"tools": [
		{ "name": "ask_assistant", "description": "Ask the assistant about accounts and tickets.", "profile": "chat" }
	]
}
```

| Field | Default | Meaning |
|---|---|---|
| `path` | `/mcp` | Must differ from `http.path` |
| `tools[].name` | required | The tool's name, `[A-Za-z0-9_-]`, at most 64 characters |
| `tools[].description` | required | What the calling model reads |
| `tools[].profile` | `defaultProfile` | The profile a call runs under |

Each tool takes the one parameter `task`.

### Server

- `transport/mcp.ts` calls `AgentService.runTask`, behind the same authenticator and `Origin` check as `/agent`.
  Guardrails, shortcuts, limits, and grants apply as for any client. It is in core because plugins cannot add routes or
  stream.
- Hand-written: `@earendil-works/pi-mcp` is client-only, and only `initialize`, `ping`, `tools/list`, `tools/call`, and
  notifications are needed. `GET` and `DELETE` answer 405, which clients handle.
- Only declared capabilities are offered. An agent's inner tools are never re-exported, which would bypass its reasoning.
- A call is one-shot: create a session, prompt, wait, close. Multi-turn is not offered. These sessions are transient:
  they are not in the owner's session index, so they are not listed and do not count toward `maxSessionsPerUser`.
  `maxConcurrentRunsPerUser` still applies. A process that dies during a call leaves nothing in the owner's list, but its
  run resumes in the next process with nobody waiting, and its grant ends with its parent or by expiry.
- A refusal (limits, guardrails, a bad task) is a tool result with `isError`, so the calling model can read and act on it.
  Protocol errors are for protocol mistakes, such as an unknown tool.
- A disconnect or `notifications/cancelled` aborts the run. This differs from `/agent`, but here nobody could read the
  answer.

`initialize` issues an `Mcp-Session-Id`. It is random and the server stores nothing for it: a call may land on any
replica, and 421 routing is not involved. It exists to scope cancels, which arrive on their own POST and name a request
id, and every client numbers its requests from 1. A gateway that does not route by it still works, except that a cancel
landing on another replica does nothing, and the run goes on to its end.

While a call runs, a client that sent a `progressToken` gets `notifications/progress` on each tool start and every
`http.keepAliveMs`, so a long model call does not look idle.

### Auth

With `auth: "grant"` on the calling agent, its token reaches the callee as a delegated principal owned by the same
user, and the callee opens a child grant. `GrantBroker` already does this for LiveKit callers. Two consequences:

- `#narrowed` intersects grants, so a caller's grant must hold every audience its downstream agents need.
- `maxConcurrentRunsPerUser` on the callee is shared with the user's direct sessions, so fan-out meets refusals, which
  the model sees as error results.

### Calling another agent

An agent calls another with an ordinary `mcpServers` entry, plus `"agentContext": true`:

```json
{ "name": "billing", "transport": "http", "url": "http://billing:9800/mcp", "auth": "grant", "agentContext": true, "callTimeoutMs": 60000 }
```

- **Timeouts.** Every MCP call now asks for progress, so `callTimeoutMs` is an idle timeout: any progress renews it.
- **Tracing.** Grant connections are shared between calls, so per-call headers cannot carry the trace. With
  `agentContext`, `tools/call` carries `traceparent`, `agent-pi/turnId`, and `agent-pi/hops` in `_meta`. A client that is
  not an agent can send a `traceparent` header instead. Third-party servers never see these: the setting is off by default.
- **Cycles.** `agent-pi/hops` counts agents along the chain, and a call past 2 is refused. This guards against accidents;
  it is not a security control, since a client sets its own count.
- **Crashes.** MCP tools are `replay: "unsafe"`, so the caller's model sees `interrupted` even if the callee acted. The
  callee's run ends with the disconnect, but what it already did stays done. If that stops being acceptable, agent-pi
  callers should use the native `/agent` protocol with a stable `requestId`, which first needs `session.create` to be
  idempotent.
