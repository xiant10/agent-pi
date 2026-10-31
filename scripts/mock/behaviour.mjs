/**
 * Runs each message-ordering scenario of a live agent against the scripted model and prints the event trace of every
 * stream, plus the context the model saw. No network, no credentials.
 *
 *   node scripts/mock/behaviour.mjs [checkout]
 */
import { fileURLToPath, pathToFileURL } from "node:url";
const root = process.argv[2] ?? fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const T = await import(pathToFileURL(`${root}/packages/agent-pi/src/testing.ts`).href);
const { startTestAgent, rpc, TOKENS, fauxAssistantMessage: M, fauxText: X, fauxToolCall: C, fakeMcpServer, waitFor, parseSse, testConfig } = T;
const LONG = "This is a very long answer that keeps going and going for quite a while longer than anyone wants.";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => console.log(s);
const profile = { ...testConfig().profiles.chat, alwaysOnTools: ["crm:slow"] };
const dialogue = (ctx) => ctx.messages.filter((m) => m.role !== "system").map((m) => {
  const c = typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? (b.type === "toolCall" ? `+call ${b.name}` : b.type)).join(" ");
  return `${m.role}:${JSON.stringify(c)}`; }).join(", ");
function open(a, tag, method, params, signal) {
  let delta = ""; let buf = "";
  const flush = () => { if (delta) say(`${tag} text ${JSON.stringify(delta)}`); delta = ""; };
  const done = (async () => {
    const r = await fetch(a.url, { method: "POST", signal, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKENS.alice}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const dec = new TextDecoder();
    for await (const chunk of r.body) { buf += dec.decode(chunk, { stream: true }); let i;
      while ((i = buf.indexOf("\n\n")) >= 0) { const f = buf.slice(0, i + 2); buf = buf.slice(i + 2);
        for (const m of parseSse(f)) { const b = m.data.params;
          if (m.data.method === "session/event") {
            if (b.type === "text.delta") { delta += b.text ?? b.delta ?? ""; continue; }
            flush();
            const { type, ...rest } = b; for (const k of ["eventId", "callId", "sessionId", "seq", "turnId", "at", "time", "timestamp", "id", "usage"]) delete rest[k];
            say(`${tag} ${type} ${JSON.stringify(rest).slice(0, 130)}`);
          } else if (m.data.result || m.data.error) { flush(); const { turnId, ...res } = m.data.result ?? m.data.error; say(`${tag} RESULT ${JSON.stringify(res)}`); } } } }
    flush(); say(`${tag} EOF`);
  })().catch((e) => { flush(); say(`${tag} closed (${e.name})`); });
  return done;
}
const busy = (a, sessionId) => waitFor(async () => (await rpc(a.url, TOKENS.alice, "session.get", { sessionId })).body.result.busy === true);
const session = async (a) => (await rpc(a.url, TOKENS.alice, "session.create", {})).body.result.sessionId;
async function scenario(name, opts, fn) {
  say(`\n=== ${name}`);
  const a = await startTestAgent({ tokensPerSecond: opts.tps ?? 40, ...(opts.mcp ? { mcp: opts.mcp, config: { profiles: { chat: profile } } } : {}) });
  const sessionId = await session(a);
  try { await Promise.race([fn(a, sessionId), sleep(15000).then(() => say("!! scenario timeout"))]); } catch (e) { say(`!! ${e.message}`); }
  await Promise.race([a.close(), sleep(3000)]);
}
const see = (seen, reply) => (ctx) => { seen.push(dialogue(ctx)); return M([X(reply)]); };
const gatedMcp = () => { let release; const gate = new Promise((r) => (release = r)); const mcp = fakeMcpServer([{ name: "slow", description: "Slow.", call: async () => (await gate, "looked up") }]); return { mcp, release: () => release() }; };

await scenario("interrupt during text", {}, async (a, s) => {
  const seen = []; a.faux.setResponses([M([X(LONG)]), see(seen, "Second.")]);
  const A = open(a, "A", "session.prompt", { sessionId: s, input: "one" }); await busy(a, s); await sleep(150);
  const B = open(a, "B", "session.interrupt", { sessionId: s, input: "two" }); await Promise.all([A, B]); say(`MODEL ${seen[0]}`); });

{ const g = gatedMcp(); await scenario("interrupt during tool round", { mcp: g.mcp }, async (a, s) => {
  const seen = []; a.faux.setResponses([M([X("Let me check."), C("crm_slow", {})], { stopReason: "toolUse" }), see(seen, "Second.")]);
  const A = open(a, "A", "session.prompt", { sessionId: s, input: "one" }); await waitFor(() => g.mcp.calls.length === 1);
  const B = open(a, "B", "session.interrupt", { sessionId: s, input: "two" }); await Promise.all([A, B]); say(`MODEL ${seen[0]}`); g.release(); await sleep(50); }); }
await scenario("interrupt on idle session", {}, async (a, s) => {
  a.faux.setResponses([M([X("Idle answer.")])]); await open(a, "B", "session.interrupt", { sessionId: s, input: "two" }); });
await scenario("three in a row", {}, async (a, s) => {
  const seen = []; a.faux.setResponses([M([X(LONG)]), M([X(LONG)]), see(seen, "Third.")]);
  const A = open(a, "A", "session.prompt", { sessionId: s, input: "one" }); await busy(a, s); await sleep(120);
  const B = open(a, "B", "session.interrupt", { sessionId: s, input: "two" }); await sleep(250);
  const C2 = open(a, "C", "session.interrupt", { sessionId: s, input: "three" }); await Promise.all([A, B, C2]); say(`MODEL ${seen[0]}`); });
await scenario("two interrupts at the same moment", {}, async (a, s) => {
  const seen = []; a.faux.setResponses([M([X(LONG)]), see(seen, "Answer X."), see(seen, "Answer Y.")]);
  const A = open(a, "A", "session.prompt", { sessionId: s, input: "one" }); await busy(a, s); await sleep(120);
  const B = open(a, "B", "session.interrupt", { sessionId: s, input: "two" }); const C2 = open(a, "C", "session.interrupt", { sessionId: s, input: "three" });
  await Promise.all([A, B, C2]); seen.forEach((m) => say(`MODEL ${m}`)); });
await scenario("steer during text", {}, async (a, s) => {
  const seen = []; a.faux.setResponses([M([X("First answer that runs for a while.")]), see(seen, "Second.")]);
  const A = open(a, "A", "session.prompt", { sessionId: s, input: "one" }); await busy(a, s); await sleep(120);
  const B = open(a, "B", "session.prompt", { sessionId: s, input: "two", whenBusy: "steer" }); await Promise.all([A, B]); say(`MODEL ${seen[0]}`); });
{ const g = gatedMcp(); await scenario("steer during tool round", { mcp: g.mcp }, async (a, s) => {
  const seen = []; a.faux.setResponses([M([X("Let me check."), C("crm_slow", {})], { stopReason: "toolUse" }), see(seen, "Joined answer.")]);
  const A = open(a, "A", "session.prompt", { sessionId: s, input: "one" }); await waitFor(() => g.mcp.calls.length === 1);
  const B = open(a, "B", "session.prompt", { sessionId: s, input: "two", whenBusy: "steer" }); await sleep(300); g.release(); await Promise.all([A, B]); say(`MODEL ${seen[0]}`); }); }
await scenario("steer behind a failed run, then cancel and prompt", {}, async (a, s) => {
  a.faux.setResponses([M([X("Partial then fails, slowly enough to queue.")], { stopReason: "error", errorMessage: "boom" }), M([X("Recovered.")])]);
  const A = open(a, "A", "session.prompt", { sessionId: s, input: "one" }); await busy(a, s); await sleep(120);
  let bEnded = false; const B = open(a, "B", "session.prompt", { sessionId: s, input: "two", whenBusy: "steer" }).then(() => { bEnded = true; });
  await A; await sleep(6000); say(`B ended after 6s: ${bEnded}`);
  say(`session.get busy=${(await rpc(a.url, TOKENS.alice, "session.get", { sessionId: s })).body.result.busy}`);
  say(`CANCEL ${JSON.stringify((await rpc(a.url, TOKENS.alice, "session.cancel", { sessionId: s })).body.result)}`);
  await B; await open(a, "C", "session.prompt", { sessionId: s, input: "three", requestId: "fresh-1" }); });
await scenario("client disconnects", {}, async (a, s) => {
  const seen = []; a.faux.setResponses([M([X(LONG)]), see(seen, "Steered answer.")]);
  const ac = new AbortController();
  const A = open(a, "A", "session.prompt", { sessionId: s, input: "one" }, ac.signal); await busy(a, s); await sleep(120);
  const B = open(a, "B", "session.prompt", { sessionId: s, input: "two", whenBusy: "steer" }); await sleep(100); ac.abort(); await A; await B; say(`MODEL ${seen[0]}`); });
process.exit(0);
