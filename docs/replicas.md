# Replicas

How `agent-pi` replicas own sessions, how callers find them, and what that means for scaling. [`design.md`](design.md), "R5", is how a replica guards its storage, and the workspace's [`ARCHITECTURE.md`](../../ARCHITECTURE.md), "Scaling", places it among the other components.

Status: routing, placement and merged listing are built. The local cluster runs one replica of each agent.

`agent-pi` scales by owning less, not by sharing storage. Each replica holds its sessions in its own SQLite volume, and a session stays on its replica for life. The session ID `<agent>.<replica>.<n>` names that replica, and a wrong replica answers `421`. Its configuration offers only `memory` and `sqlite` storage.

Routing, placement and merged listing are implemented. The local cluster runs one replica each of `assistant` and `sales`; routing within each agent can use more replicas once configured and validated:

| Need | Implemented state | Deployment requirement |
| --- | --- | --- |
| Find a session's replica | `ai-gateway-agent` and voice workers route by ID; workbench also supports direct routing | Keep one `AGENT_URLS` entry per replica in each router |
| Stable replica names | `agent-pi` and `agent-sales` StatefulSets are deployed locally, with one volume per pod | Preserve `AGENT_INSTANCE_ID`, DNS names and volumes across restarts |
| Place a new session | `ai-gateway-agent` applies tenant access and routes, then uses rendezvous hashing over ready replicas of the chosen pool, keyed by tenant and user | Configure every replica. A call names its agent with `Agent-Name`, or takes the tenant's default, then the platform's |
| List a person's sessions | `ai-gateway-agent` asks every replica of the selected agent, across its pools, merges by `lastActiveAt`, and returns `partial` if one fails | Route clients through the gateway before adding replicas; a direct single-replica list would be incomplete |

**Limits are per replica.** `maxSessionsPerUser` and `maxConcurrentRunsPerUser` are counted per process. Hashing keeps most people on one replica, so the limits still mean roughly what they say. They aren't a guarantee, and `ai-gateway-llm` checks tenant-wide model usage only within its own process, as described under "Tenant limits".

**Replicas can only be added.** A new replica takes new sessions, and existing load stays put. A replica can't be removed, because its sessions live on its volume. Removing one needs a way to move sessions, which isn't designed.

**A lost replica takes its conversations with it, for a while.** Text and calls on those sessions stop until the volume remounts, and unfinished runs then resume. Other replicas carry on. A lost volume loses its conversations, because nothing replicates them yet.

Before adding replicas of an agent, keep clients routed through `ai-gateway-agent`, add each replica to the gateway and voice-worker configuration, and validate merged listing and reconnects. The local deployment already uses the gateway.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Shared storage for `agent-pi` | Would remove pinning, but `agent-pi` offers only SQLite, and its single-owner lock is built around that |
