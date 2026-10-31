/**
 * Time to first text for a prompt and for an interrupt, over LATENCY_TURNS turns (default 60) against the scripted
 * model. This is agent-pi's overhead plus the faux pacing, not a provider's first-token time: compare runs, never quote it.
 *
 *   node scripts/mock/latency.mjs [checkout]
 */
import { fileURLToPath, pathToFileURL } from "node:url";
const root = process.argv[2] ?? fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const { startTestAgent, rpc, TOKENS, fauxAssistantMessage: M, fauxText: X } = await import(pathToFileURL(`${root}/packages/agent-pi/src/testing.ts`).href);
const a = await startTestAgent({ tokensPerSecond: 40 });
const N = Number(process.env.LATENCY_TURNS ?? 60), first = [], interrupt = [];
const sid = async () => (await rpc(a.url, TOKENS.alice, "session.create", {})).body.result.sessionId;
const post = (sessionId, method, input) => fetch(a.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKENS.alice}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { sessionId, input } }) });
async function firstText(res) { const t = new TextDecoder(); let at; for await (const c of res.body) { if (at === undefined && t.decode(c).includes('"text.delta"')) at = performance.now(); } return at; }
for (let i = 0; i < N; i++) {
  const s = await sid();
  a.faux.setResponses([M([X("Some short answer here for timing the first token.")])]);
  let t0 = performance.now(); first.push((await firstText(await post(s, "session.prompt", "q"))) - t0);
  a.faux.setResponses([M([X("Long answer ".repeat(30))]), M([X("Second answer.")])]);
  const A = post(s, "session.prompt", "one").then(firstText); await new Promise((r) => setTimeout(r, 250));
  t0 = performance.now(); const b = await firstText(await post(s, "session.interrupt", "two")); interrupt.push(b - t0); await A;
  await rpc(a.url, TOKENS.alice, "session.close", { sessionId: s });
}
const stat = (x) => { const s = [...x].sort((p, q) => p - q); return `p50=${s[N >> 1].toFixed(0)}ms p90=${s[Math.floor(N * .9)].toFixed(0)}ms max=${s[N - 1].toFixed(0)}ms`; };
console.log("prompt->first text   ", stat(first)); console.log("interrupt->first text", stat(interrupt));
await Promise.race([a.close(), new Promise((r) => setTimeout(r, 2000))]); process.exit(0);
