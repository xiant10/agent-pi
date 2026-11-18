# AGENTS.md

For coding agents working in this repo. The agent harness on pi-durable, in TypeScript: `/agent` over Streamable HTTP, skills, MCP tools, plugins.

## Build and test

```bash
npm ci
npm run check        # tsc
npm test             # vitest
node --disable-warning=ExperimentalWarning ../contracts/docs/conformance.ts agent-pi   # from the workspace: contracts/agent and contracts/docs
```

## Read first

- `docs/design.md`
- `docs/guides/developer-guide.md`
- `docs/api.md`
- `docs/lifecycle.md`

## Rules

- This image serves its consumer docs at `/docs/mcp` with no token (the workspace's `contracts/docs/`). Anything marked `audience: consumer` is public to whoever reaches the service, so keep secrets and internal notes out, or mark the doc `contributor`.
- A route change updates `docs/api.md` (and `docs/openapi.yaml` where there is one) in the same change.
- Every doc under `docs/` starts with front matter: `title`, `audience` (consumer, contributor or operator), `kind` (guide, reference, design or record), `status` and `summary`. Plans, reviews and validation logs go in `docs/records/`. The workspace's `make check` (`scripts/check-docs.py`) holds this and checks relative links.
- This repo is its own project inside the t10 workspace: it builds with nothing from the workspace. The workspace's `ARCHITECTURE.md` is the high-level design, and wins where they disagree.
- This repo is public: check what you add before it's pushed.
