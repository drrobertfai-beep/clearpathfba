// ClearPathFBA — optimistic-concurrency / conflict-detection tests (node --test).
// Isolated from the dev database: a temp sqlite file is created before the
// server modules are imported, so tests never touch dev data. The same file
// runs against Postgres when DATABASE_URL is set (DATABASE_PATH is ignored in
// that mode; rows this test creates are deleted in after()).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATABASE_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'cpf-conflict-')), 'test.sqlite');
process.env.VERCEL = '1'; // index.js exports app/bootstrap without listening; we bind an ephemeral port.

const { app, bootstrap } = await import('../src/index.js');
const db = (await import('../src/db.js')).default;

let server, baseUrl, token;
const created = { clients: [], assessments: [], behaviors: [], dataPoints: [] };

before(async () => {
 await bootstrap(); // creates schema + seeds admin/bcba in the empty temp DB
 await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
 baseUrl = `http://127.0.0.1:${server.address().port}`;
 const r = await fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
 });
 assert.equal(r.status, 200);
 token = (await r.json()).token;
});

after(async () => {
 // Remove rows this test created (matters for the shared Postgres dev DB;
 // the temp sqlite file is discarded either way). Child rows first so the
 // foreign keys resolve: data_points -> target_behaviors -> assessments -> clients.
 for (const id of created.dataPoints) { try { await db.prepare('DELETE FROM data_points WHERE id=?').run(id); } catch { /* row already gone */ } }
 for (const id of created.behaviors) { try { await db.prepare('DELETE FROM target_behaviors WHERE id=?').run(id); } catch { /* FK already gone */ } }
 for (const id of created.assessments) { try { await db.prepare('DELETE FROM assessments WHERE id=?').run(id); } catch { /* FK already gone */ } }
 for (const id of created.clients) { try { await db.prepare('DELETE FROM clients WHERE id=?').run(id); } catch { /* row already gone */ } }
 server?.close();
});

async function api(method, p, body) {
 const res = await fetch(baseUrl + p, {
  method,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: body === undefined ? undefined : JSON.stringify(body),
 });
 const text = await res.text();
 return { status: res.status, json: text ? JSON.parse(text) : null };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/; // 'YYYY-MM-DD HH:MM:SS' UTC

// (a) create sets updated_at, and every read path returns it.
test('create sets updated_at; GET single, GET list and POST responses return it', async () => {
 const { status, json: c } = await api('POST', '/api/clients', { first_name: 'Conflict', last_name: `One-${Date.now()}`, consent_status: 'obtained' });
 assert.equal(status, 201);
 assert.match(c.updated_at, TS_RE);
 created.clients.push(c.id);
 const single = await api('GET', `/api/clients/${c.id}`);
 assert.equal(single.json.updated_at, c.updated_at);
 const list = await api('GET', '/api/clients');
 assert.equal(list.json.find((x) => x.id === c.id).updated_at, c.updated_at);
});

// (b) update with the correct base succeeds and bumps updated_at,
// (c) update with a stale base -> 409 with the current server record,
// (d) update without a base still works (backward compatible).
test('client PUT: correct base succeeds + bumps; stale base -> 409; no base -> 200', async () => {
 const { json: c } = await api('POST', '/api/clients', { first_name: 'Conflict', last_name: `Two-${Date.now()}` });
 assert.match(c.updated_at, TS_RE);
 created.clients.push(c.id);
 const t1 = c.updated_at;
 await sleep(1100); // timestamps are second-precision — guarantee the bump is visible
 // (b) correct base succeeds and bumps updated_at
 const ok = await api('PUT', `/api/clients/${c.id}`, { first_name: 'Conflict', last_name: `Two-${Date.now()}`, notes: 'edited with base', base_updated_at: t1 });
 assert.equal(ok.status, 200);
 assert.match(ok.json.updated_at, TS_RE);
 assert.notEqual(ok.json.updated_at, t1);
 assert.ok(ok.json.updated_at > t1, 'updated_at advanced'); // same-format UTC strings compare lexicographically
 const t2 = ok.json.updated_at;
 // (c) stale base -> 409 carrying the current record
 const stale = await api('PUT', `/api/clients/${c.id}`, { first_name: 'Conflict', last_name: `Two-${Date.now()}`, base_updated_at: '2000-01-01 00:00:00' });
 assert.equal(stale.status, 409);
 assert.equal(stale.json.conflict, true);
 assert.equal(stale.json.entity, 'client');
 assert.equal(stale.json.id, c.id);
 assert.ok(stale.json.error.length > 0);
 assert.equal(stale.json.current.updated_at, t2);
 assert.equal(typeof stale.json.current.dbhds_flags, 'object'); // row() shape, not a JSON string
 // a base that was valid before the last bump also conflicts
 const mid = await api('PUT', `/api/clients/${c.id}`, { first_name: 'Conflict', last_name: `Two-${Date.now()}`, base_updated_at: t1 });
 assert.equal(mid.status, 409);
 // ISO-8601 spelling of the current value is accepted (normalized comparison)
 const iso = await api('PUT', `/api/clients/${c.id}`, { first_name: 'Conflict', last_name: `Two-${Date.now()}`, base_updated_at: t2.replace(' ', 'T') + 'Z' });
 assert.equal(iso.status, 200);
 // (d) no base supplied -> still works
 const nobase = await api('PUT', `/api/clients/${c.id}`, { first_name: 'Conflict', last_name: `Two-${Date.now()}-nobase` });
 assert.equal(nobase.status, 200);
});

test('assessment PUT: create/list return updated_at; correct base works; stale base -> 409', async () => {
 const { json: c } = await api('POST', '/api/clients', { first_name: 'Conflict', last_name: `Asmt-${Date.now()}` });
 created.clients.push(c.id);
 const a0 = await api('POST', `/api/clients/${c.id}/assessments`, { title: `Conflict Test ${Date.now()}` });
 assert.equal(a0.status, 201);
 assert.match(a0.json.updated_at, TS_RE);
 created.assessments.push(a0.json.id);
 // list items carry updated_at too
 const list = await api('GET', `/api/clients/${c.id}/assessments`);
 assert.equal(list.json.find((a) => a.id === a0.json.id).updated_at, a0.json.updated_at);
 await sleep(1100);
 const ok = await api('PUT', `/api/assessments/${a0.json.id}`, { title: `Conflict Test Edited ${Date.now()}`, status: 'in_progress', base_updated_at: a0.json.updated_at });
 assert.equal(ok.status, 200);
 assert.notEqual(ok.json.updated_at, a0.json.updated_at);
 const stale = await api('PUT', `/api/assessments/${a0.json.id}`, { title: 'Conflict Test Stale', base_updated_at: a0.json.updated_at });
 assert.equal(stale.status, 409);
 assert.equal(stale.json.entity, 'assessment');
 assert.equal(stale.json.current.updated_at, ok.json.updated_at);
 const nobase = await api('PUT', `/api/assessments/${a0.json.id}`, { title: 'Conflict Test Final' });
 assert.equal(nobase.status, 200);
});

test('target behavior PUT: create returns updated_at; correct base works; stale base -> 409; no base -> 200', async () => {
 const { json: c } = await api('POST', '/api/clients', { first_name: 'Conflict', last_name: `Beh-${Date.now()}` });
 created.clients.push(c.id);
 const a0 = await api('POST', `/api/clients/${c.id}/assessments`, { title: `Behavior Test ${Date.now()}` });
 created.assessments.push(a0.json.id);
 const b0 = await api('POST', `/api/assessments/${a0.json.id}/target-behaviors`, { name: 'Conflict Behavior', operational_definition: 'Test definition', baseline_measurement_type: 'frequency' });
 assert.equal(b0.status, 201);
 assert.match(b0.json.updated_at, TS_RE);
 created.behaviors.push(b0.json.id);
 await sleep(1100);
 const ok = await api('PUT', `/api/target-behaviors/${b0.json.id}`, { name: 'Conflict Behavior Edited', operational_definition: 'Test definition', base_updated_at: b0.json.updated_at });
 assert.equal(ok.status, 200);
 assert.notEqual(ok.json.updated_at, b0.json.updated_at);
 const stale = await api('PUT', `/api/target-behaviors/${b0.json.id}`, { name: 'Stale', operational_definition: 'Test definition', base_updated_at: b0.json.updated_at });
 assert.equal(stale.status, 409);
 assert.equal(stale.json.entity, 'target_behavior');
 assert.equal(stale.json.current.updated_at, ok.json.updated_at);
 const nobase = await api('PUT', `/api/target-behaviors/${b0.json.id}`, { name: 'Conflict Behavior Final', operational_definition: 'Test definition' });
 assert.equal(nobase.status, 200);
});

// Sanity: data-point creation is append-only and stays unversioned (no 409 path).
test('data-point creation is unaffected by conflict detection', async () => {
 const { json: c } = await api('POST', '/api/clients', { first_name: 'Conflict', last_name: `DP-${Date.now()}` });
 created.clients.push(c.id);
 const a0 = await api('POST', `/api/clients/${c.id}/assessments`, { title: `DP Test ${Date.now()}` });
 created.assessments.push(a0.json.id);
 const b0 = await api('POST', `/api/assessments/${a0.json.id}/target-behaviors`, { name: 'DP Behavior', operational_definition: 'Test definition' });
 created.behaviors.push(b0.json.id);
 const dp = await api('POST', `/api/assessments/${a0.json.id}/data-points`, {
  target_behavior_id: b0.json.id, recorded_at: '2026-08-08T12:00:00Z',
  setting: 'classroom', antecedent: 'demand_task', consequence: 'escape_removed_demand',
  measurement_type: 'frequency', value: 3,
 });
 assert.equal(dp.status, 201);
 created.dataPoints.push(dp.json.id);
 // no updated_at on data points — creation is versionless by design
 assert.equal(dp.json.updated_at, undefined);
});
