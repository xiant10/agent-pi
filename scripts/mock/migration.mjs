/**
 * Writes a session to a SQLite file with one checkout and reopens it with another, to prove a storage upgrade.
 *
 *   node scripts/mock/migration.mjs <checkout> write <file>
 *   node scripts/mock/migration.mjs <checkout> reopen <file>
 */
import { pathToFileURL } from "node:url";
const [root, phase, db] = process.argv.slice(2);
if (db === undefined) throw new Error("usage: migration.mjs <checkout> write|reopen <file>");
const { startTestAgent, rpc, TOKENS, fauxAssistantMessage, fauxText } = await import(pathToFileURL(`${root}/packages/agent-pi/src/testing.ts`).href);
const config = { storage: { kind: "sqlite", path: db }, instanceId: undefined };
const a = await startTestAgent({ config, configStorage: true });
if (phase === "write") {
  a.faux.setResponses([fauxAssistantMessage([fauxText("first answer")])]);
  const c = await rpc(a.url, TOKENS.alice, "session.create", {});
  const sessionId = c.body.result.sessionId;
  const p = await rpc(a.url, TOKENS.alice, "session.prompt", { sessionId, input: "remember me" });
  console.log("write", sessionId, JSON.stringify(p.body.result));
} else {
  const l = await rpc(a.url, TOKENS.alice, "session.list", {});
  console.log("list", JSON.stringify(l.body.result));
  const sessionId = l.body.result.sessions[0].sessionId;
  let seen;
  a.faux.setResponses([(ctx) => { seen = ctx.messages.map((m) => `${m.role}:${typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? b.type).join("")}`); return fauxAssistantMessage([fauxText("second answer")]); }]);
  const p = await rpc(a.url, TOKENS.alice, "session.prompt", { sessionId, input: "still there?" });
  console.log("prompt", JSON.stringify(p.body.result ?? p.body));
  console.log("model saw", JSON.stringify(seen));
}
await a.close();
