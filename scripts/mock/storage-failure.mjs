/**
 * Starts `runAgent` on a storage that begins to fail and shows the process exit. Expected: `durable.session_failed`,
 * `agent.failed`, exit code 1 once connections have drained, and never "STILL ALIVE".
 *
 *   node scripts/mock/storage-failure.mjs [checkout]
 */
import { fileURLToPath, pathToFileURL } from "node:url";
const root = process.argv[2] ?? fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const { runAgent } = await import(pathToFileURL(`${root}/packages/agent-pi/src/index.ts`).href);
const { testConfig, rpc, TOKENS, startTestAgent } = await import(pathToFileURL(`${root}/packages/agent-pi/src/testing.ts`).href);
const { MemoryStorage } = await import(pathToFileURL(`${root}/node_modules/@earendil-works/pi-durable/dist/index.js`).href);
const { createModels } = await import(pathToFileURL(`${root}/node_modules/@earendil-works/pi-ai/dist/index.js`).href);
const { fauxProvider } = await import(pathToFileURL(`${root}/node_modules/@earendil-works/pi-ai/dist/providers/faux.js`).href);
const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
const storage = new MemoryStorage(); const commit = storage.commit.bind(storage); let broken = false;
storage.commit = (...a) => broken ? Promise.reject(new Error("disk full")) : commit(...a);
const agent = await runAgent({
  config: testConfig({ auth: { kind: "static", tokens: JSON.stringify({ t: "u" }) } }), storage, envFile: "/nonexistent",
  models: { models, refs: new Map([["main", { provider: faux.provider.id, modelId: "faux-1" }]]) },
});
const url = `http://127.0.0.1:${agent.port}/agent`;
const c = await rpc(url, "t", "session.create");
console.log("created", c.status, JSON.stringify(c.body).slice(0,120));
broken = true;
const t0 = Date.now(); process.on("exit", (code) => console.log("exit handler", code, "after_ms", Date.now() - t0));
await rpc(url, "t", "session.create").then((r) => console.log("rpc", r.status), (e) => console.log("rpc threw", e.message));
setInterval(() => {}, 1000);
setTimeout(() => { console.log("STILL ALIVE after 15s"); process.exit(99); }, 15000);
