// ClearPathFBA — organization scoping tests (pass 1 of 3).
//
// Proves that a signed-in clinician can only reach their own organization's
// clinical records, and that the platform admin (the explicit
// `users.is_platform_admin` flag) is the only account that can cross
// organizations.
//
// Isolated from the dev database: a temp sqlite file (and a temp signing-key
// directory) is created before the server modules are imported, so this test
// never touches dev data. The same file runs against Postgres when
// DATABASE_URL is set (DATABASE_PATH is ignored in that mode; the rows it
// creates are removed in after()).
//
// The four required scenarios from the brief:
//   1. two-organization fixture (org A clinician, org B clinician, a client each)
//   2. org A listing clients returns only A's; GET/UPDATE/DELETE of B's client
//      id by A returns 404 and changes nothing — same for an assessment id and
//      a data point write
//   3. the platform admin account sees both organizations
//   4. the demo account sees only Sample Client A/B/C and never a real client
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(tmpdir(), 'cpf-org-'));
process.env.DATABASE_PATH = path.join(tmp, 'test.sqlite');
// A private signing-key directory: the demo seed signs a document, and the
// test must not read or create the repository's real signing key.
process.env.SIGNING_KEYS_DIR = path.join(tmp, 'keys');
process.env.VERCEL = '1'; // index.js exports app/bootstrap without listening; we bind an ephemeral port.

const { app, bootstrap } = await import('../src/index.js');
const db = (await import('../src/db.js')).default;
const { hashPassword } = await import('../src/auth.js');
const {
  runOrgMigration, relocateDemoWorkspace, ensureOrg, backfillOrganizations,
  DEFAULT_ORG, DEMO_ORG, DEMO_USERNAME, ORG_MIGRATION_ID, PLATFORM_ADMIN_ACCOUNTS,
} = await import('../src/org-migration.js');
const { seedDemo } = await import('../scripts/seed-demo.mjs');

let server;
let baseUrl;
const fx = {}; // fixture: orgs, users, tokens, records
const created = { clients: [], assessments: [], behaviors: [], dataPoints: [] };

// --- fixture helpers -------------------------------------------------------
async function mkOrg(slug, name) {
  return await ensureOrg(db, { name, slug });
}

async function mkUser(username, orgId, role = 'bcba', email = null) {
  const r = await db.prepare(
    'INSERT INTO users (username,password_hash,role,display_name,email,org_id,active,must_change_password) VALUES (?,?,?,?,?,?,1,0)',
  ).run(username, hashPassword('OrgTest2026!'), role, `Test ${username}`, email, orgId);
  return await db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
}

async function mkClient(orgId, first, last) {
  const r = await db.prepare(
    "INSERT INTO clients (org_id,first_name,last_name,consent_status,dbhds_flags) VALUES (?,?,?,'obtained','{}')",
  ).run(orgId, first, last);
  const client = await db.prepare('SELECT * FROM clients WHERE id=?').get(r.lastInsertRowid);
  created.clients.push(client.id);
  return client;
}

async function mkAssessment(clientId, title) {
  const r = await db.prepare("INSERT INTO assessments (client_id,title,status) VALUES (?,?,'in_progress')")
    .run(clientId, title);
  const a = await db.prepare('SELECT * FROM assessments WHERE id=?').get(r.lastInsertRowid);
  created.assessments.push(a.id);
  return a;
}

async function mkBehavior(assessmentId, name) {
  const r = await db.prepare(
    "INSERT INTO target_behaviors (assessment_id,name,operational_definition,safety_classification) VALUES (?,?,?,'none')",
  ).run(assessmentId, name, `Any instance of ${name} (test fixture definition).`);
  const b = await db.prepare('SELECT * FROM target_behaviors WHERE id=?').get(r.lastInsertRowid);
  created.behaviors.push(b.id);
  return b;
}

async function mkDataPoint(assessmentId, behaviorId) {
  const r = await db.prepare(
    'INSERT INTO data_points (assessment_id,target_behavior_id,recorded_at,setting,antecedent,consequence,measurement_type,value) VALUES (?,?,?,?,?,?,?,?)',
  ).run(assessmentId, behaviorId, '2026-10-01T09:00:00', 'classroom', 'demand_task', 'escape_removed_demand', 'frequency', 3);
  const dp = await db.prepare('SELECT * FROM data_points WHERE id=?').get(r.lastInsertRowid);
  created.dataPoints.push(dp.id);
  return dp;
}

async function login(username, password = 'OrgTest2026!') {
  const r = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await r.json();
  assert.equal(r.status, 200, `login failed for ${username}: ${JSON.stringify(body)}`);
  assert.ok(body.token, 'login must return a token');
  return body.token;
}

async function api(token, method, p, body) {
  const res = await fetch(baseUrl + p, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { json = text; } }
  return { status: res.status, json };
}

const row = async (table, id) => await db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);

// --- fixture ---------------------------------------------------------------
before(async () => {
  await bootstrap(); // schema + organization migration + seed accounts
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  fx.orgA = await mkOrg('org-a', 'Organization A');
  fx.orgB = await mkOrg('org-b', 'Organization B');

  fx.userA = await mkUser('clinician.a@org-a.test', fx.orgA.id, 'bcba');
  fx.userB = await mkUser('clinician.b@org-b.test', fx.orgB.id, 'bcba');
  // An organization's own admin: role 'admin', but NOT a platform admin.
  fx.adminA = await mkUser('admin.a@org-a.test', fx.orgA.id, 'admin');
  // The owner's account. The migration sets is_platform_admin from the address.
  fx.owner = await mkUser(PLATFORM_ADMIN_ACCOUNTS[0], fx.orgA.id, 'admin', PLATFORM_ADMIN_ACCOUNTS[0]);
  await backfillOrganizations(db);
  fx.owner = await row('users', fx.owner.id);

  fx.clientA = await mkClient(fx.orgA.id, 'Client', 'Alpha');
  fx.assessA = await mkAssessment(fx.clientA.id, 'Org A assessment');
  fx.behaviorA = await mkBehavior(fx.assessA.id, 'Aggression (A)');
  fx.dataPointA = await mkDataPoint(fx.assessA.id, fx.behaviorA.id);

  fx.clientB = await mkClient(fx.orgB.id, 'Client', 'Bravo');
  fx.assessB = await mkAssessment(fx.clientB.id, 'Org B assessment');
  fx.behaviorB = await mkBehavior(fx.assessB.id, 'Elopement (B)');
  fx.dataPointB = await mkDataPoint(fx.assessB.id, fx.behaviorB.id);

  fx.tokenA = await login('clinician.a@org-a.test');
  fx.tokenB = await login('clinician.b@org-b.test');
  fx.tokenAdminA = await login('admin.a@org-a.test');
  fx.tokenOwner = await login(PLATFORM_ADMIN_ACCOUNTS[0]);
});

after(async () => {
  // Remove rows this test created (matters for a shared Postgres database; the
  // temp sqlite file is discarded either way). Child rows first.
  for (const id of created.dataPoints) { try { await db.prepare('DELETE FROM data_points WHERE id=?').run(id); } catch { /* gone */ } }
  for (const id of created.behaviors) { try { await db.prepare('DELETE FROM target_behaviors WHERE id=?').run(id); } catch { /* gone */ } }
  for (const id of created.assessments) { try { await db.prepare('DELETE FROM assessments WHERE id=?').run(id); } catch { /* gone */ } }
  for (const id of created.clients) { try { await db.prepare('DELETE FROM clients WHERE id=?').run(id); } catch { /* gone */ } }
  server?.close();
});

// ---------------------------------------------------------------------------
// 0. schema + migration
// ---------------------------------------------------------------------------
test('schema: organizations table, org_id on users and clients, platform-admin flag', async () => {
  const org = await row('organizations', fx.orgA.id);
  assert.equal(org.slug, 'org-a');
  assert.equal(org.name, 'Organization A');
  assert.equal(org.status, 'active');
  assert.ok(org.created_at, 'organizations.created_at is set');

  // org_id lives on clients (the single source of truth) and on users — and
  // nowhere else, so no child table can drift out of its client's org.
  for (const table of ['clients', 'users']) {
    const cols = db.mode === 'postgres'
      ? (await db.prepare("SELECT column_name AS name FROM information_schema.columns WHERE table_name=?").all(table)).map((r) => r.name)
      : (await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all()).map((r) => r.name);
    assert.ok(cols.includes('org_id'), `${table}.org_id exists`);
  }
  for (const table of ['assessments', 'target_behaviors', 'data_points', 'function_hypotheses', 'sign_offs', 'progress_reports']) {
    const cols = db.mode === 'postgres'
      ? (await db.prepare("SELECT column_name AS name FROM information_schema.columns WHERE table_name=?").all(table)).map((r) => r.name)
      : (await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all()).map((r) => r.name);
    assert.ok(!cols.includes('org_id'), `${table} must NOT carry a denormalized org_id`);
  }

  const owner = await row('users', fx.owner.id);
  assert.equal(owner.is_platform_admin, 1, 'the owner account is a platform admin');
  const clinician = await row('users', fx.userA.id);
  assert.equal(clinician.is_platform_admin, 0, 'a clinician is not a platform admin');
  const orgAdmin = await row('users', fx.adminA.id);
  assert.equal(orgAdmin.role, 'admin');
  assert.equal(orgAdmin.is_platform_admin, 0, 'role=admin alone does not grant cross-org access');
});

test('migration: default + demo organizations exist and the one-time move is recorded', async () => {
  const def = await db.prepare('SELECT * FROM organizations WHERE slug=?').get(DEFAULT_ORG.slug);
  const demo = await db.prepare('SELECT * FROM organizations WHERE slug=?').get(DEMO_ORG.slug);
  assert.ok(def, 'default organization exists');
  assert.equal(def.name, DEFAULT_ORG.name);
  assert.ok(demo, 'demo organization exists');
  assert.equal(demo.name, DEMO_ORG.name);
  const marker = await db.prepare('SELECT * FROM schema_migrations WHERE id=?').get(ORG_MIGRATION_ID);
  assert.ok(marker, 'the one-time demo move is recorded');
});

test('migration is idempotent: re-running changes nothing and duplicates no organization', async () => {
  const snapshot = async () => ({
    orgs: (await db.prepare('SELECT id, slug, name FROM organizations ORDER BY id').all()).map((o) => `${o.id}:${o.slug}`),
    perOrg: (await db.prepare('SELECT org_id, COUNT(*) AS n FROM clients GROUP BY org_id ORDER BY org_id').all())
      .map((r) => `${r.org_id}=${r.n}`),
    markers: (await db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE id=?').get(ORG_MIGRATION_ID)).n,
    orphans: (await db.prepare('SELECT COUNT(*) AS n FROM clients WHERE org_id IS NULL').get()).n
      + (await db.prepare('SELECT COUNT(*) AS n FROM users WHERE org_id IS NULL').get()).n,
  });
  const beforeRun = await snapshot();
  await runOrgMigration(db);
  await runOrgMigration(db);
  assert.deepEqual(await snapshot(), beforeRun);
  assert.equal(beforeRun.markers, 1, 'exactly one marker row');
  assert.equal(beforeRun.orphans, 0, 'no row is left without an organization');
});

test('relocateDemoWorkspace moves only the demo-flagged clients', async () => {
  const demoOrg = await db.prepare('SELECT * FROM organizations WHERE slug=?').get(DEMO_ORG.slug);
  const real = await mkClient(fx.orgA.id, 'Relocate', 'Real');
  const flagged = await mkClient(fx.orgA.id, 'Relocate', 'Flagged');
  await db.prepare('UPDATE clients SET dbhds_flags=? WHERE id=?').run(JSON.stringify({ demo: true }), flagged.id);

  await relocateDemoWorkspace(db);

  assert.equal((await row('clients', real.id)).org_id, fx.orgA.id, 'an unflagged client does not move');
  assert.equal((await row('clients', flagged.id)).org_id, demoOrg.id, 'a demo-flagged client moves to the demo org');
  // Put the flagged fixture client back so later assertions on org A stay exact.
  await db.prepare('UPDATE clients SET org_id=?, dbhds_flags=? WHERE id=?').run(fx.orgA.id, '{}', flagged.id);
});

// ---------------------------------------------------------------------------
// 1 + 2. cross-organization isolation between two clinicians
// ---------------------------------------------------------------------------
test('org A clinician lists only org A clients; org B lists only org B clients', async () => {
  const a = await api(fx.tokenA, 'GET', '/api/clients');
  assert.equal(a.status, 200);
  const idsA = a.json.map((c) => c.id);
  assert.ok(idsA.includes(fx.clientA.id), "org A's own client is listed");
  assert.ok(!idsA.includes(fx.clientB.id), "org B's client is NOT listed for org A");

  const b = await api(fx.tokenB, 'GET', '/api/clients');
  const idsB = b.json.map((c) => c.id);
  assert.ok(idsB.includes(fx.clientB.id));
  assert.ok(!idsB.includes(fx.clientA.id));

  // The response never carries another organization's rows, whatever the order.
  assert.deepEqual(idsA.filter((id) => idsB.includes(id)), []);
});

test("cross-org client id: GET, PUT and DELETE return 404 and change nothing", async () => {
  const before = await row('clients', fx.clientB.id);

  const get = await api(fx.tokenA, 'GET', `/api/clients/${fx.clientB.id}`);
  assert.equal(get.status, 404, 'GET another org\'s client is 404 (never 403 — no id leak)');

  const put = await api(fx.tokenA, 'PUT', `/api/clients/${fx.clientB.id}`, {
    first_name: 'Hijacked', last_name: 'ByOrgA', consent_status: 'obtained',
  });
  assert.equal(put.status, 404);

  const del = await api(fx.tokenA, 'DELETE', `/api/clients/${fx.clientB.id}`);
  assert.equal(del.status, 404);

  const after = await row('clients', fx.clientB.id);
  assert.equal(after.first_name, before.first_name, 'name unchanged');
  assert.equal(after.last_name, before.last_name, 'name unchanged');
  assert.equal(after.updated_at, before.updated_at, 'row untouched');
  assert.equal(after.deleted_at, null, 'not soft-deleted');

  // ...and org B still sees its own client, so the 404s were not a global outage.
  const own = await api(fx.tokenB, 'GET', `/api/clients/${fx.clientB.id}`);
  assert.equal(own.status, 200);
});

test("cross-org assessment id: read, write, delete and every document route return 404", async () => {
  const before = await row('assessments', fx.assessB.id);
  const t = fx.tokenA;

  const checks = [
    ['GET', `/api/assessments/${fx.assessB.id}`],
    ['GET', `/api/assessments/${fx.assessB.id}/target-behaviors`],
    ['GET', `/api/assessments/${fx.assessB.id}/data-points`],
    ['GET', `/api/assessments/${fx.assessB.id}/data-points/summary`],
    ['GET', `/api/assessments/${fx.assessB.id}/function-hypotheses`],
    ['GET', `/api/assessments/${fx.assessB.id}/sign-offs`],
    ['GET', `/api/assessments/${fx.assessB.id}/progress-reports`],
    ['GET', `/api/assessments/${fx.assessB.id}/audit-log`],
    ['GET', `/api/assessments/${fx.assessB.id}/report`],
    ['GET', `/api/assessments/${fx.assessB.id}/bip`],
    ['GET', `/api/assessments/${fx.assessB.id}/crisis-plan`],
    ['GET', `/api/assessments/${fx.assessB.id}/data-sheet`],
    ['GET', `/api/assessments/${fx.assessB.id}/report.docx`],
    ['GET', `/api/assessments/${fx.assessB.id}/bip.docx`],
    ['GET', `/api/assessments/${fx.assessB.id}/crisis-plan.docx`],
    ['GET', `/api/assessments/${fx.assessB.id}/data-sheet.docx`],
    ['GET', `/api/assessments/${fx.assessB.id}/report.pdf`],
    ['GET', `/api/assessments/${fx.assessB.id}/bip.pdf`],
    ['GET', `/api/assessments/${fx.assessB.id}/crisis-plan.pdf`],
    ['GET', `/api/assessments/${fx.assessB.id}/data-sheet.pdf`],
    ['GET', `/api/assessments/${fx.assessB.id}/export.csv`],
    ['GET', `/api/assessments/${fx.assessB.id}/export.json`],
    ['GET', `/api/assessments/${fx.assessB.id}/export.fhir`],
    ['GET', `/api/clients/${fx.clientB.id}/assessments`],
    ['GET', `/api/clients/${fx.clientB.id}/export.fhir`],
  ];
  for (const [method, p] of checks) {
    const res = await api(t, method, p);
    assert.equal(res.status, 404, `${method} ${p} must be 404`);
  }

  const put = await api(t, 'PUT', `/api/assessments/${fx.assessB.id}`, { title: 'Hijacked assessment', status: 'completed' });
  assert.equal(put.status, 404);
  const del = await api(t, 'DELETE', `/api/assessments/${fx.assessB.id}`);
  assert.equal(del.status, 404);
  const post = await api(t, 'POST', `/api/clients/${fx.clientB.id}/assessments`, { title: 'Injected' });
  assert.equal(post.status, 404);
  const behaviors = await api(t, 'POST', `/api/assessments/${fx.assessB.id}/target-behaviors`, { name: 'Injected', operational_definition: 'x' });
  assert.equal(behaviors.status, 404);
  const signOff = await api(t, 'POST', `/api/assessments/${fx.assessB.id}/sign-offs`, { document_type: 'fba_report', signatory_role: 'bcba', signatory_name: 'Injected' });
  assert.equal(signOff.status, 404);
  const progress = await api(t, 'POST', `/api/assessments/${fx.assessB.id}/progress-reports`, { period_type: 'month', period: '2026-10' });
  assert.equal(progress.status, 404);
  const generate = await api(t, 'POST', `/api/assessments/${fx.assessB.id}/function-hypotheses/generate`);
  assert.equal(generate.status, 404);

  const after = await row('assessments', fx.assessB.id);
  assert.equal(after.title, before.title, 'title unchanged');
  assert.equal(after.status, before.status, 'status unchanged');
  assert.equal(after.updated_at, before.updated_at, 'row untouched');
  assert.equal(after.deleted_at, null, 'not soft-deleted');

  // Nothing was created underneath the other organization's assessment.
  const behaviorsB = await db.prepare('SELECT COUNT(*) AS n FROM target_behaviors WHERE assessment_id=?').get(fx.assessB.id);
  assert.equal(behaviorsB.n, 1, 'no target behavior was injected');
  const signOffsB = await db.prepare('SELECT COUNT(*) AS n FROM sign_offs WHERE assessment_id=?').get(fx.assessB.id);
  assert.equal(signOffsB.n, 0, 'no sign-off was injected');
});

test("cross-org data point write: POST, PUT and DELETE return 404 and change nothing", async () => {
  const before = await row('data_points', fx.dataPointB.id);
  const countBefore = (await db.prepare('SELECT COUNT(*) AS n FROM data_points WHERE assessment_id=?').get(fx.assessB.id)).n;

  const post = await api(fx.tokenA, 'POST', `/api/assessments/${fx.assessB.id}/data-points`, {
    target_behavior_id: fx.behaviorB.id, recorded_at: '2026-10-02T09:00:00', measurement_type: 'frequency', value: 9,
  });
  assert.equal(post.status, 404);

  const put = await api(fx.tokenA, 'PUT', `/api/data-points/${fx.dataPointB.id}`, {
    target_behavior_id: fx.behaviorB.id, recorded_at: '2026-10-02T09:00:00', measurement_type: 'frequency', value: 99,
  });
  assert.equal(put.status, 404);

  const del = await api(fx.tokenA, 'DELETE', `/api/data-points/${fx.dataPointB.id}`);
  assert.equal(del.status, 404);

  // CSV import is a raw text body (express.text), so it bypasses api().
  const importRes = await fetch(`${baseUrl}/api/assessments/${fx.assessB.id}/import/csv`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv', Authorization: `Bearer ${fx.tokenA}` },
    body: 'recorded_at,behavior_name,measurement_type,value\n2026-10-02T09:00:00,Elopement (B),frequency,9\n',
  });
  assert.equal(importRes.status, 404, 'POST import/csv against another org is 404');


  const after = await row('data_points', fx.dataPointB.id);
  assert.equal(after.value, before.value, 'value unchanged');
  const countAfter = (await db.prepare('SELECT COUNT(*) AS n FROM data_points WHERE assessment_id=?').get(fx.assessB.id)).n;
  assert.equal(countAfter, countBefore, 'no data point was inserted');
});

test('cross-org behavior, hypothesis, sign-off and progress-report ids return 404', async () => {
  // Fixture rows owned by org B.
  const hyp = await db.prepare(
    "INSERT INTO function_hypotheses (assessment_id,target_behavior_id,function,confidence,evidence) VALUES (?,?,'escape',0.6,'{}')",
  ).run(fx.assessB.id, fx.behaviorB.id);
  const signOff = await db.prepare(
    "INSERT INTO sign_offs (assessment_id,document_type,signatory_role,signatory_name) VALUES (?,'fba_report','bcba','Org B BCBA')",
  ).run(fx.assessB.id);
  const progress = await db.prepare(
    "INSERT INTO progress_reports (assessment_id,period_type,period,period_label,start_date,end_date,payload) VALUES (?,'month','2026-10','October 2026','2026-10-01','2026-11-01','{}')",
  ).run(fx.assessB.id);

  const t = fx.tokenA;
  assert.equal((await api(t, 'PUT', `/api/target-behaviors/${fx.behaviorB.id}`, { name: 'Hijacked', operational_definition: 'x' })).status, 404);
  assert.equal((await api(t, 'DELETE', `/api/target-behaviors/${fx.behaviorB.id}`)).status, 404);
  assert.equal((await api(t, 'PUT', `/api/function-hypotheses/${hyp.lastInsertRowid}`, { function: 'attention' })).status, 404);
  assert.equal((await api(t, 'GET', `/api/sign-offs/${signOff.lastInsertRowid}/verify`)).status, 404);
  assert.equal((await api(t, 'POST', `/api/sign-offs/${signOff.lastInsertRowid}/sign`, { signature: 'Injected' })).status, 404);
  assert.equal((await api(t, 'DELETE', `/api/sign-offs/${signOff.lastInsertRowid}`)).status, 404);
  assert.equal((await api(t, 'GET', `/api/progress-reports/${progress.lastInsertRowid}`)).status, 404);
  assert.equal((await api(t, 'GET', `/api/progress-reports/${progress.lastInsertRowid}.pdf`)).status, 404);
  assert.equal((await api(t, 'GET', `/api/progress-reports/${progress.lastInsertRowid}.docx`)).status, 404);

  const behaviorAfter = await row('target_behaviors', fx.behaviorB.id);
  assert.equal(behaviorAfter.name, 'Elopement (B)', 'behavior name unchanged');
  const hypAfter = await row('function_hypotheses', hyp.lastInsertRowid);
  assert.equal(hypAfter.function, 'escape', 'hypothesis unchanged');
  const signAfter = await row('sign_offs', signOff.lastInsertRowid);
  assert.equal(signAfter.status, 'pending', 'sign-off not signed');
  assert.equal(signAfter.signature, null, 'no signature written');

  // The owning organization can still reach them.
  assert.equal((await api(fx.tokenB, 'GET', `/api/progress-reports/${progress.lastInsertRowid}`)).status, 200);
  assert.equal((await api(fx.tokenB, 'GET', `/api/assessments/${fx.assessB.id}/sign-offs`)).status, 200);

  await db.prepare('DELETE FROM progress_reports WHERE id=?').run(progress.lastInsertRowid);
  await db.prepare('DELETE FROM sign_offs WHERE id=?').run(signOff.lastInsertRowid);
  await db.prepare('DELETE FROM function_hypotheses WHERE id=?').run(hyp.lastInsertRowid);
});

test('the owning organization still has full access to its own records', async () => {
  const a = await api(fx.tokenA, 'GET', `/api/clients/${fx.clientA.id}`);
  assert.equal(a.status, 200);
  assert.equal(a.json.id, fx.clientA.id);
  assert.equal((await api(fx.tokenA, 'GET', `/api/assessments/${fx.assessA.id}`)).status, 200);
  assert.equal((await api(fx.tokenA, 'GET', `/api/assessments/${fx.assessA.id}/report`)).status, 200);
  assert.equal((await api(fx.tokenA, 'GET', `/api/assessments/${fx.assessA.id}/data-points`)).status, 200);
  const dp = await api(fx.tokenA, 'POST', `/api/assessments/${fx.assessA.id}/data-points`, {
    target_behavior_id: fx.behaviorA.id, recorded_at: '2026-10-03T09:00:00', measurement_type: 'frequency', value: 4,
  });
  assert.equal(dp.status, 201);
  created.dataPoints.push(dp.json.id);
});

// ---------------------------------------------------------------------------
// 3. platform admin
// ---------------------------------------------------------------------------
test('the platform admin account sees every organization', async () => {
  const list = await api(fx.tokenOwner, 'GET', '/api/clients');
  assert.equal(list.status, 200);
  const ids = list.json.map((c) => c.id);
  assert.ok(ids.includes(fx.clientA.id), 'sees org A client');
  assert.ok(ids.includes(fx.clientB.id), 'sees org B client');

  assert.equal((await api(fx.tokenOwner, 'GET', `/api/clients/${fx.clientA.id}`)).status, 200);
  assert.equal((await api(fx.tokenOwner, 'GET', `/api/clients/${fx.clientB.id}`)).status, 200);
  assert.equal((await api(fx.tokenOwner, 'GET', `/api/assessments/${fx.assessB.id}`)).status, 200);
  assert.equal((await api(fx.tokenOwner, 'GET', `/api/assessments/${fx.assessB.id}/report`)).status, 200);

  const me = await api(fx.tokenOwner, 'GET', '/api/auth/me');
  assert.equal(me.json.is_platform_admin, 1);
});

test("an organization's own admin is confined to that organization", async () => {
  const list = await api(fx.tokenAdminA, 'GET', '/api/clients');
  const ids = list.json.map((c) => c.id);
  assert.ok(ids.includes(fx.clientA.id));
  assert.ok(!ids.includes(fx.clientB.id), 'org admin does not see org B');
  assert.equal((await api(fx.tokenAdminA, 'GET', `/api/clients/${fx.clientB.id}`)).status, 404);
  assert.equal((await api(fx.tokenAdminA, 'GET', `/api/assessments/${fx.assessB.id}/report`)).status, 404);

  // User management: the org admin sees only its own organization's accounts,
  // and cannot edit another organization's user.
  const users = await api(fx.tokenAdminA, 'GET', '/api/admin/users');
  assert.equal(users.status, 200);
  const usernames = users.json.map((u) => u.username);
  assert.ok(usernames.includes('clinician.a@org-a.test'));
  assert.ok(!usernames.includes('clinician.b@org-b.test'), 'org B user is not listed');
  const edit = await api(fx.tokenAdminA, 'PUT', `/api/admin/users/${fx.userB.id}`, { display_name: 'Hijacked' });
  assert.equal(edit.status, 404);
  assert.equal((await row('users', fx.userB.id)).display_name, 'Test clinician.b@org-b.test');

  // The platform admin does see both organizations' users.
  const allUsers = await api(fx.tokenOwner, 'GET', '/api/admin/users');
  assert.ok(allUsers.json.map((u) => u.username).includes('clinician.b@org-b.test'));
});

// ---------------------------------------------------------------------------
// 4. the session is the only source of organization scope
// ---------------------------------------------------------------------------
test('the session carries the organization; request parameters cannot override it', async () => {
  const me = await api(fx.tokenA, 'GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.org_id, fx.orgA.id);
  assert.equal(me.json.org_slug, 'org-a');
  assert.equal(me.json.org_name, 'Organization A');
  assert.equal(me.json.is_platform_admin, 0);

  // A query string naming another organization is ignored.
  const viaQuery = await api(fx.tokenA, 'GET', `/api/clients?org_id=${fx.orgB.id}`);
  const ids = viaQuery.json.map((c) => c.id);
  assert.ok(!ids.includes(fx.clientB.id), 'query string cannot widen the scope');

  // A body naming another organization is ignored: the record joins the
  // caller's organization.
  const created2 = await api(fx.tokenA, 'POST', '/api/clients', {
    first_name: 'Scoped', last_name: 'ByBody', consent_status: 'obtained', org_id: fx.orgB.id,
  });
  assert.equal(created2.status, 201);
  created.clients.push(created2.json.id);
  assert.equal(created2.json.org_id, fx.orgA.id, 'org_id comes from the session, not the body');
  const stored = await row('clients', created2.json.id);
  assert.equal(stored.org_id, fx.orgA.id);

  // ...and it does not appear in org B's list.
  const listB = await api(fx.tokenB, 'GET', '/api/clients');
  assert.ok(!listB.json.map((c) => c.id).includes(created2.json.id));
});

// ---------------------------------------------------------------------------
// 5. the demo workspace
// ---------------------------------------------------------------------------
test('the demo account sees only the sample clients and never a real client', async () => {
  // A real-looking record in the default organization, like production's
  // client id 4: the demo login must not list it.
  const real = await mkClient(fx.orgA.id, 'Real', 'Record');
  const realAssessment = await mkAssessment(real.id, 'Real assessment');
  assert.ok(real.id > 0);

  // Seed the demo workspace exactly as `npm run seed:demo` does.
  const log = console.log;
  console.log = () => {};
  try { await seedDemo(); } finally { console.log = log; }

  const demoOrg = await db.prepare('SELECT * FROM organizations WHERE slug=?').get(DEMO_ORG.slug);
  const demoUser = await db.prepare('SELECT * FROM users WHERE username=?').get(DEMO_USERNAME);
  assert.ok(demoUser, 'demo user exists');
  assert.equal(demoUser.org_id, demoOrg.id, 'demo user is in the demo organization');

  const demoToken = await login(DEMO_USERNAME, 'DemoPilot2026!');
  const list = await api(demoToken, 'GET', '/api/clients');
  assert.equal(list.status, 200);
  const names = list.json.map((c) => `${c.first_name} ${c.last_name}`).sort();
  assert.deepEqual(names, ['Sample Client A', 'Sample Client B', 'Sample Client C']);
  const ids = list.json.map((c) => c.id);
  assert.ok(!ids.includes(real.id), 'the demo login does NOT see the real client');
  assert.ok(!ids.includes(fx.clientA.id), 'the demo login does NOT see org A clients');

  // Direct access to the real record is refused, and so is its assessment.
  assert.equal((await api(demoToken, 'GET', `/api/clients/${real.id}`)).status, 404);
  assert.equal((await api(demoToken, 'GET', `/api/assessments/${realAssessment.id}`)).status, 404);
  assert.equal((await api(demoToken, 'GET', `/api/assessments/${realAssessment.id}/report`)).status, 404);
  assert.equal((await api(demoToken, 'DELETE', `/api/clients/${real.id}`)).status, 404);
  assert.equal((await row('clients', real.id)).deleted_at, null, 'the real client is untouched');

  // The sample data itself is fully usable by the demo account.
  const sampleA = list.json.find((c) => c.last_name === 'Client A');
  const assessments = await api(demoToken, 'GET', `/api/clients/${sampleA.id}/assessments`);
  assert.equal(assessments.status, 200);
  assert.ok(assessments.json.length >= 1);
  assert.equal((await api(demoToken, 'GET', `/api/assessments/${assessments.json[0].id}/report`)).status, 200);

  // Re-running the seed is still idempotent and keeps the data in the demo org.
  console.log = () => {};
  try { await seedDemo(); } finally { console.log = log; }
  const again = await api(demoToken, 'GET', '/api/clients');
  assert.deepEqual(again.json.map((c) => c.id).sort(), ids.slice().sort(), 'second seed run adds nothing');
  for (const c of again.json) assert.equal(c.org_id ?? (await row('clients', c.id)).org_id, demoOrg.id);
});

test('the demo organization is separate from the default organization', async () => {
  const demoOrg = await db.prepare('SELECT * FROM organizations WHERE slug=?').get(DEMO_ORG.slug);
  const defOrg = await db.prepare('SELECT * FROM organizations WHERE slug=?').get(DEFAULT_ORG.slug);
  assert.notEqual(demoOrg.id, defOrg.id);
  const demoClients = await db.prepare('SELECT COUNT(*) AS n FROM clients WHERE org_id=?').get(demoOrg.id);
  assert.equal(demoClients.n, 3, 'exactly the three sample clients live in the demo organization');
  const realInDemo = await db.prepare(
    'SELECT COUNT(*) AS n FROM clients WHERE org_id=? AND (notes IS NULL OR notes NOT LIKE ?)',
  ).get(demoOrg.id, 'SAMPLE DATA%');
  assert.equal(realInDemo.n, 0, 'no non-sample client was moved into the demo organization');
});
