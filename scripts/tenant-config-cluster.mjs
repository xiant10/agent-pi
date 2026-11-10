// Usage, from the workspace, with the tenant agents work deployed to namespace t10 and:
//   kubectl -n t10 port-forward svc/t10-agent-control 29110:18010
//   kubectl -n t10 port-forward pod/agent-pi-0 29100:18100
//   kubectl -n t10 port-forward svc/ai-gateway-tools 29195:18095
//   AGENT_PI_SECRET=… node agent-pi/scripts/tenant-config-cluster.mjs
// AGENT_PI_SECRET is the runtime's own, from the agent-pi Secret: the script acts as the runtime
// to show the tool gateway refuses a turned-off tool whatever the harness offers. It uses the
// sample users (dev mode), calls the real model, and resets what it publishes.
// Step A6 of t10-agent-control/docs/tenant-agents.md on the local cluster, for the assistant.
import assert from 'node:assert/strict';
const AUTH = process.env.AUTH_URL ?? 'http://127.0.0.1:18000', CTL = 'http://127.0.0.1:29110', PI = 'http://127.0.0.1:29100/agent', GW = 'http://127.0.0.1:29195';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function token(user, tenant) {
  const form = new URLSearchParams({ grant_type: 'password', client_id: 't10-workbench', username: user, password: 't10-sample-password', ...(tenant ? { tenant } : {}) });
  const j = await (await fetch(AUTH + '/v1/token', { method: 'POST', body: form })).json();
  assert.ok(j.access_token, user + ': ' + JSON.stringify(j));
  return j.access_token;
}
async function ctl(tok, method, path, body) {
  const r = await fetch(CTL + path, { method, headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const t = await r.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: r.status, body: j };
}
async function rpc(tok, method, params = {}, session) {
  const r = await fetch(PI, { method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json', 'agent-method': method, ...(session ? { 'agent-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return { status: r.status, ...await r.json() };
}
async function turn(tok, session, input) {
  const ctrl = new AbortController(); const events = [];
  const done = fetch(PI, { headers: { authorization: 'Bearer ' + tok, accept: 'text/event-stream', 'agent-session-id': session }, signal: ctrl.signal }).then(async r => {
    const dec = new TextDecoder(); let buf = '';
    for await (const c of r.body) {
      buf += dec.decode(c, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const b = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = b.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
        if (!data) continue;
        const m = JSON.parse(data); const e = m.params?.event ?? m.params ?? m; events.push(e);
        if (e.type === 'run.finished') ctrl.abort();
      }
    }
  }).catch(() => { });
  await sleep(300);
  const p = await rpc(tok, 'session.prompt', { input, requestId: crypto.randomUUID(), wait: false }, session);
  assert.equal(p.status, 200, JSON.stringify(p));
  await Promise.race([done, sleep(120000)]);
  const answer = events.filter(e => e.type === 'message.end').at(-1)?.text ?? '';
  const tools = events.filter(e => e.type === 'tool.started').map(e => e.name);
  return { answer, tools, events };
}
// A run's token for the runtime, as the harness gets one: a grant from the person's live token,
// then the grant's own token, which the tool gateway accepts.
async function runToken(userToken) {
  const runtime = 'agent-pi', secret = process.env.AGENT_PI_SECRET;
  const svc = await (await fetch(AUTH + '/v1/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: runtime, client_secret: secret }) })).json();
  assert.ok(svc.access_token, runtime + ' service token: ' + JSON.stringify(svc));
  const grant = await (await fetch(AUTH + '/v1/grants', { method: 'POST', headers: { authorization: 'Bearer ' + svc.access_token, 'content-type': 'application/json' }, body: JSON.stringify({ subject_token: userToken, actions: ['agent:use', 'work:read'], audiences: ['ai-gateway-tools', 't10-collab'] }) })).json();
  assert.ok(grant.id, runtime + ' grant: ' + JSON.stringify(grant));
  const run = await (await fetch(AUTH + '/v1/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'agent_grant', grant_id: grant.id, client_id: runtime, client_secret: secret }) })).json();
  assert.ok(run.access_token, runtime + ' run token: ' + JSON.stringify(run));
  return run.access_token;
}
async function gateway(tok, method, params) {
  const r = await fetch(GW + '/mcp/collab', { method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return { status: r.status, text: await r.text() };
}

const tag = Date.now().toString(36).toUpperCase(), marker = 'ACME-' + tag;
const off = 'work_list', skillOff = 'weather';
const path = '/v1/admin/agents/assistant/config';
const acmeAdmin = await token('sample-acme-admin', 'ten_sample-acme');
const acme = await token('sample-member', 'ten_sample-acme'), globex = await token('sample-multi', 'ten_sample-globex');
let failures = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) failures++; };
const skills = async tok => ((await rpc(tok, 'skills.list')).result?.skills ?? []).map(s => s.name);
const before = await ctl(acmeAdmin, 'GET', path);
assert.equal(before.status, 200, JSON.stringify(before));
let version = before.body.config.version;
try {
  check((await skills(acme)).includes(skillOff), `acme sees ${skillOff} before the customization`);
  // 1. Publish acme's customization of the assistant.
  const content = {
    instructions: [`End every answer with the exact marker ${marker} on its own last line.`, 'Call the people you help "neighbour".'].join('\n'),
    tools: { off: ['collab:' + off] },
    skills: { off: [skillOff] },
  };
  const published = await ctl(acmeAdmin, 'PUT', path, { content, version, reason: 'A6 cluster check' });
  assert.equal(published.status, 200, JSON.stringify(published));
  version = published.body.config.version;
  console.log('published acme assistant customization version', version);
  await sleep(12000); // The gateway polls its feed every 10 s; the harness hears the change feed sooner.

  // 2. A real-model turn follows it, and the turned-off skill is gone.
  check(!(await skills(acme)).includes(skillOff), `skills.list leaves ${skillOff} out for acme`);
  const sA = (await rpc(acme, 'session.create')).result.sessionId;
  let t = await turn(acme, sA, 'In one short sentence, what can you help me with?');
  console.log('acme answer:', JSON.stringify(t.answer));
  check(t.answer.includes(marker), 'acme turn follows the tenant (marker present)');

  // 3. The removed tool, one of the profile's alwaysOnTools, is neither offered nor called, and the gateway refuses it.
  t = await turn(acme, sA, `Call the ${off} tool to list my open work items. If you have no such tool, use search_tools to look for one first.`);
  console.log('acme work turn tools:', t.tools.join(',') || '(none)', 'answer:', JSON.stringify(t.answer.slice(0, 200)));
  check(!t.tools.includes(off), `acme's run never calls ${off}`);
  const runAcme = await runToken(acme), runGlobex = await runToken(globex);
  let g = await gateway(runAcme, 'tools/call', { name: off, arguments: {} });
  console.log('gateway, assistant in acme:', g.status, g.text.slice(0, 200));
  check(g.text.includes('turned ' + off + ' off'), 'the gateway refuses the turned-off tool for the assistant in acme');

  // 4. Another tenant is unaffected.
  check((await skills(globex)).includes(skillOff), `globex still sees ${skillOff}`);
  const sG = (await rpc(globex, 'session.create')).result.sessionId;
  t = await turn(globex, sG, `In one short sentence, what can you help me with?`);
  console.log('globex answer:', JSON.stringify(t.answer));
  check(!t.answer.includes(marker), "globex gets none of acme's text");
  t = await turn(globex, sG, `Call the ${off} tool to list my open work items.`);
  console.log('globex work turn tools:', t.tools.join(',') || '(none)');
  check(t.tools.includes(off), `globex's run calls ${off}`);
  g = await gateway(runGlobex, 'tools/call', { name: off, arguments: {} });
  console.log('gateway, assistant in globex:', g.status, g.text.slice(0, 160));
  check(g.status === 200 && !g.text.includes('turned ' + off + ' off'), 'the gateway forwards the tool for the assistant in globex');

  // 5. The admin's draft reaches only their own test conversation.
  const draftMarker = 'DRAFT-' + tag;
  const saved = await ctl(acmeAdmin, 'PUT', path + '/draft', { content: { ...content, instructions: `End every answer with the exact marker ${draftMarker} on its own last line.` }, base_version: version });
  assert.equal(saved.status, 200, JSON.stringify(saved));
  const sD = (await rpc(acmeAdmin, 'session.create', { metadata: { configDraft: true } })).result.sessionId;
  t = await turn(acmeAdmin, sD, 'Say hello in five words.');
  console.log('draft answer:', JSON.stringify(t.answer));
  check(t.answer.includes(draftMarker), "the admin's test conversation uses their draft");
  const sP = (await rpc(acmeAdmin, 'session.create')).result.sessionId;
  t = await turn(acmeAdmin, sP, 'Say hello in five words.');
  console.log('published answer:', JSON.stringify(t.answer));
  check(t.answer.includes(marker) && !t.answer.includes(draftMarker), 'their other conversations use the published version');
} finally {
  await ctl(acmeAdmin, 'DELETE', path + '/draft');
  const cur = await ctl(acmeAdmin, 'GET', path);
  const reset = await ctl(acmeAdmin, 'PUT', path, { content: {}, version: cur.body.config.version, reason: 'A6 cluster check cleanup' });
  console.log('cleanup', reset.status);
}
console.log(failures ? `${failures} check(s) failed` : 'PASS A6 on the cluster');
process.exit(failures ? 1 : 0);
