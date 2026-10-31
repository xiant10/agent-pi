#!/usr/bin/env bash
# Compares a git ref with this working tree on the scripted model: event traces, first-text latency, and whether the
# working tree opens a SQLite file the ref wrote. Run it around any upgrade of the pi packages. No network to a model.
#
#   npm run mock:compare -- <ref>
#
# Exits 1 when the traces differ. How text splits into chunks around the scripts' fixed sleeps jitters between runs, so
# the comparison leaves out chunks and the length of aborted text; final answers and model context still count.
set -euo pipefail
ref="${1:?usage: compare.sh <git-ref>}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
base="$work/base"
node_run() { node --disable-warning=ExperimentalWarning "$@"; }
# Ids and chunk timing change on every run; everything else in a trace should not.
normalize() {
	sed -E -e '/^[A-Z] text /d' -e 's/"text":"[^"]*","stopReason":"aborted"/"stopReason":"aborted"/' \
		-e 's/"eventId":"[^"]*",//g' -e 's/"callId":"[^"]*",//g' -e 's/"(submissionId|submission|id)":[0-9]+/"\1":N/g' -e 's/\[[0-9, ]+\]/[..]/g'
}
cleanup() { git -C "$repo" worktree remove --force "$base" 2>/dev/null || true; git -C "$repo" worktree prune; rm -rf "$work"; }
trap cleanup EXIT

git -C "$repo" worktree add -q --detach "$base" "$ref"
(cd "$base" && npm ci --silent)
echo "== versions"
for root in "$base" "$repo"; do
	echo "$root: pi-durable $(node -p "require('$root/node_modules/@earendil-works/pi-durable/package.json').version")"
done

echo "== migration"
node_run "$repo/scripts/mock/migration.mjs" "$base" write "$work/agent.sqlite"
node_run "$repo/scripts/mock/migration.mjs" "$repo" reopen "$work/agent.sqlite"

echo "== latency: $ref"
node_run "$repo/scripts/mock/latency.mjs" "$base"
echo "== latency: working tree"
node_run "$repo/scripts/mock/latency.mjs" "$repo"

echo "== traces"
node_run "$repo/scripts/mock/behaviour.mjs" "$base" | normalize >"$work/base.txt"
node_run "$repo/scripts/mock/behaviour.mjs" "$repo" | normalize >"$work/head.txt"
diff "$work/base.txt" "$work/head.txt" && echo "identical ($(wc -l <"$work/head.txt" | tr -d ' ') lines)"
