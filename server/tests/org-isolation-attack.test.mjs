// ClearPathFBA — organization scoping pass 3: adversarial isolation testing.
//
// Pass 1 proved the happy path (own records only, 404 for another practice's
// ids). Pass 2 scoped the audit feed, exports, FHIR, billing, signing keys and
// the org settings screen. This file is the attacker's side: it builds a
// second practice with its own admin in a scratch database, then tries every
// route that touches clinical data as that admin.
//
// What the attacker tries:
//   * every id-taking route with the victim practice's ids (read, write, delete,
//     documents, PDF/Word downloads, exports, FHIR, sign-off verify/sign/revoke,
//     progress reports, per-assessment audit log, CSV import)
//   * id substitution: another practice's client_id / assessment_id /
//     target_behavior_id / user id / org id inside request bodies and query
//     strings, to try to attach or steal a record
//   * id enumeration: sweeping every id in every table to see whether one
//     practice's ids are distinguishable from missing ones
//   * the admin surfaces: audit feed, user list and user edits, organization
//     settings, billing
//   * the public verification link (unauthenticated by design)
//   * offline sync: the base_updated_at conflict path (409 vs 404 is itself an
//     existence oracle)
//   * privilege escalation: an organization admin promoting itself to platform
//     admin or moving itself into another practice
//
// Every response is also scanned for the victim's sentinel strings, so a leak
// in a 200 body fails the test even when the status code looks right.
//
// Scratch database: temp sqlite file + temp signing-key directory, created
// before the server modules are imported, so this never touches dev data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(tmpdir(), 'cpf-attack-'));
process.env.DATABASE_PATH = path.join(tmp, 'attack.sqlite');
process.env.SIGNING_KEYS_DIR = path.join(tmp, 'keys');
process.env.VERCEL = '1'; // import the app without listening; bind an ephemeral port.

const { app, bootstrap } = await import('../src/index.js');
const db = (await import('../src/db.js')).default;
const { hashPassword } = await import('../src/auth.js');
const { ensureOrg } = await import('../src/org-migration.js');

// Sentinels: strings that only exist in the victim practice's data. Any
// response containing one of these has leaked another practice's record.
const VICTIM = {
  orgName: 'Victim Practice LLC',
  clientFirst: 'Zebulon',
  clientLast: 'Quillon',
  assessmentTitle: 'VICTIM-ASSESSMENT-7Q',
  behaviorName: 'VICTIM-BEHAVIOR-7Q',
  signatory: 'VICTIM-SIGNER-7Q',
  reportPeriod: '2026-10',
};
const SENTINELS = [
  VICTIM.orgName, VICTIM.clientFirst, VICTIM.clientLast,
  VICTIM.assessmentTitle, VICTIM.behaviorName, VICTIM.signatory,
];
const leaks = (text) => SENTINELS.filter((s) => String(text || '').includes(s));

let server;
let baseUrl;
const fx = {};
const created = { clients: [], assessments: [], behaviors: [], dataPoints: [], auditFloor: 0, users: [] };

// --- fixture helpers -------------------------------------------------------
const row = async (table, id) => await db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);

async function mkUser(username, orgId, role = 'bcba', email = null) {
  const r = await db.prepare(
    'INSERT INTO users (username,password_hash,role,display_name,email,org_id,active,must_change_password) VALUES (?,?,?,?,?,?,1,0)',
  ).run(username, hashPassword('AttackTest2026!'), role, `Test ${username}`, email, orgId);
  created.users.push(r.lastInsertRowid);
  return await row('users', r.lastInsertRowid);
}

async function mkClient(orgId, first, last) {
  const r = await db.prepare(
    "INSERT INTO clients (org_id,first_name,last_name,consent_status,dbhds_flags) VALUES (?,?,?,'obtained','{}')",
  ).run(orgId, first, last);
  created.clients.push(r.lastInsertRowid);
  return await row('clients', r.lastInsertRowid);
}

async function mkAssessment(clientId, title) {
  const r = await db.prepare("INSERT INTO assessments (client_id,title,status) VALUES (?,?,'in_progress')")
    .run(clientId, title);
  created.assessments.push(r.lastInsertRowid);
  return await row('assessments', r.lastInsertRowid);
}

async function mkBehavior(assessmentId, name) {
  const r = await db.prepare(
    "INSERT INTO target_behaviors (assessment_id,name,operational_definition,safety_classification) VALUES (?,?,?,'none')",
  ).run(assessmentId, name, `Any instance of ${name} (attack-test fixture).`);
  created.behaviors.push(r.lastInsertRowid);
  return await row('target_behaviors', r.lastInsertRowid);
}

async function mkDataPoint(assessmentId, behaviorId, value = 3) {
  const r = await db.prepare(
    'INSERT INTO data_points (assessment_id,target_behavior_id,recorded_at,setting,antecedent,consequence,measurement_type,value) VALUES (?,?,?,?,?,?,?,?)',
  ).run(assessmentId, behaviorId, '2026-10-05T09:00:00', 'classroom', 'demand_task', 'escape_removed_demand', 'frequency', value);
  created.dataPoints.push(r.lastInsertRowid);
  return await row('data_points', r.lastInsertRowid);
}

async function login(username, password = 'AttackTest2026!') {
  const r = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await r.json();
  assert.equal(r.status, 200, `login failed for ${username}: ${JSON.stringify(body)}`);
  return body.token;
}

/** Authenticated request; returns status + raw text + parsed json. */
async function api(token, method, p, body, headers = {}) {
  const res = await fetch(baseUrl + p, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { json = text; } }
  return { status: res.status, json, text };
}

/** A clinical-data snapshot, so "changed nothing" can be asserted exactly. */
async function clinicalSnapshot() {
  const out = {};
  for (const table of ['clients', 'assessments', 'target_behaviors', 'data_points', 'function_hypotheses', 'sign_offs', 'progress_reports']) {
    out[table] = await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  }
  return JSON.parse(JSON.stringify(out));
}

// --- fixture ---------------------------------------------------------------
before(async () => {
  await bootstrap();
  created.auditFloor = (await db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM audit_log').get()).id;
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // The practice under attack (stands in for the owner's real organization).
  fx.victimOrg = await ensureOrg(db, { name: VICTIM.orgName, slug: 'attack-victim' });
  // The attacker's practice: a real second organization with its own admin.
  fx.attackerOrg = await ensureOrg(db, { name: 'Attacker Practice', slug: 'attack-attacker' });

  fx.victimClinician = await mkUser('victim.clinician@attack.test', fx.victimOrg.id, 'bcba');
  fx.attackerAdmin = await mkUser('attacker.admin@attack.test', fx.attackerOrg.id, 'admin');
  fx.attackerClinician = await mkUser('attacker.clinician@attack.test', fx.attackerOrg.id, 'bcba');

  // --- the victim practice's clinical record ---
  fx.victimClient = await mkClient(fx.victimOrg.id, VICTIM.clientFirst, VICTIM.clientLast);
  fx.victimAssessment = await mkAssessment(fx.victimClient.id, VICTIM.assessmentTitle);
  fx.victimBehavior = await mkBehavior(fx.victimAssessment.id, VICTIM.behaviorName);
  fx.victimDataPoint = await mkDataPoint(fx.victimAssessment.id, fx.victimBehavior.id, 4);
  const hyp = await db.prepare(
    "INSERT INTO function_hypotheses (assessment_id,target_behavior_id,function,confidence,evidence) VALUES (?,?,'escape',0.7,'{}')",
  ).run(fx.victimAssessment.id, fx.victimBehavior.id);
  fx.victimHypothesisId = hyp.lastInsertRowid;
  const pr = await db.prepare(
    "INSERT INTO progress_reports (assessment_id,period_type,period,period_label,start_date,end_date,payload) VALUES (?,'month',?,'October 2026','2026-10-01','2026-11-01',?)",
  ).run(fx.victimAssessment.id, VICTIM.reportPeriod, JSON.stringify({
    client: { first_name: VICTIM.clientFirst, last_name: VICTIM.clientLast },
    assessment: { title: VICTIM.assessmentTitle },
    period_label: 'October 2026',
  }));
  fx.victimProgressReportId = pr.lastInsertRowid;
  const sub = await db.prepare(
    "INSERT INTO subscriptions (user_id,customer_id,subscription_id,plan_key,plan_label,quantity,status) VALUES (?,?,?,?,?,1,'active')",
  ).run(fx.victimClinician.id, 'cus_victim', 'sub_victim', 'solo', 'Solo');
  fx.victimSubscriptionId = sub.lastInsertRowid;

  // A signed document in the victim practice (signed through the API so the
  // real per-org key path is exercised).
  fx.victimToken = await login('victim.clinician@attack.test');
  const so = await api(fx.victimToken, 'POST', `/api/assessments/${fx.victimAssessment.id}/sign-offs`, {
    document_type: 'fba_report', signatory_role: 'bcba', signatory_name: VICTIM.signatory,
  });
  assert.equal(so.status, 201, JSON.stringify(so.json));
  fx.victimSignOffId = so.json.id;
  const signed = await api(fx.victimToken, 'POST', `/api/sign-offs/${fx.victimSignOffId}/sign`, { signature: VICTIM.signatory });
  assert.equal(signed.status, 200, JSON.stringify(signed.json));

  // --- the attacker's own (legitimate) workspace ---
  fx.attackerClient = await mkClient(fx.attackerOrg.id, 'Attacker', 'Own');
  fx.attackerAssessment = await mkAssessment(fx.attackerClient.id, 'Attacker own assessment');
  fx.attackerBehavior = await mkBehavior(fx.attackerAssessment.id, 'Attacker own behavior');
  fx.attackerDataPoint = await mkDataPoint(fx.attackerAssessment.id, fx.attackerBehavior.id, 2);

  fx.tokenAdmin = await login('attacker.admin@attack.test');
  fx.tokenClinician = await login('attacker.clinician@attack.test');
});

after(async () => {
  for (const id of created.dataPoints) { try { await db.prepare('DELETE FROM data_points WHERE id=?').run(id); } catch { /* gone */ } }
  for (const id of created.behaviors) { try { await db.prepare('DELETE FROM target_behaviors WHERE id=?').run(id); } catch { /* gone */ } }
  for (const id of created.assessments) { try { await db.prepare('DELETE FROM assessments WHERE id=?').run(id); } catch { /* gone */ } }
  for (const id of created.clients) { try { await db.prepare('DELETE FROM clients WHERE id=?').run(id); } catch { /* gone */ } }
  for (const id of created.users) { try { await db.prepare('DELETE FROM users WHERE id=?').run(id); } catch { /* gone */ } }
  try { await db.prepare('DELETE FROM subscriptions WHERE id=?').run(fx.victimSubscriptionId); } catch { /* gone */ }
  if (created.auditFloor) { try { await db.prepare('DELETE FROM audit_log WHERE id > ?').run(created.auditFloor); } catch { /* gone */ } }
  server?.close();
});

// ---------------------------------------------------------------------------
// 0. the attacker's own workspace works (so the 404s below are not an outage)
// ---------------------------------------------------------------------------
test('baseline: the attacker admin can use its own practice normally', async () => {
  const t = fx.tokenAdmin;
  assert.equal((await api(t, 'GET', '/api/clients')).status, 200);
  assert.equal((await api(t, 'GET', `/api/clients/${fx.attackerClient.id}`)).status, 200);
  assert.equal((await api(t, 'GET', `/api/assessments/${fx.attackerAssessment.id}`)).status, 200);
  assert.equal((await api(t, 'GET', `/api/assessments/${fx.attackerAssessment.id}/report`)).status, 200);
  assert.equal((await api(t, 'GET', `/api/assessments/${fx.attackerAssessment.id}/report.pdf`)).status, 200);
  assert.equal((await api(t, 'GET', `/api/assessments/${fx.attackerAssessment.id}/export.fhir`)).status, 200);
  assert.equal((await api(t, 'GET', `/api/organization`)).status, 200);
  assert.equal((await api(t, 'GET', '/api/admin/users')).status, 200);
  assert.equal((await api(t, 'GET', '/api/admin/audit-log')).status, 200);
});

// ---------------------------------------------------------------------------
// 1. every id-taking route, with the victim practice's ids
// ---------------------------------------------------------------------------
test('attack 1: every route that takes another practice\'s id answers 404 and leaks nothing', async () => {
  const t = fx.tokenAdmin;
  const a = fx.victimAssessment.id;
  const c = fx.victimClient.id;

  const getRoutes = [
    `/api/clients/${c}`,
    `/api/clients/${c}/assessments`,
    `/api/clients/${c}/export.fhir`,
    `/api/clients/${c}/export.fhir?deidentified=true`,
    `/api/assessments/${a}`,
    `/api/assessments/${a}/target-behaviors`,
    `/api/assessments/${a}/data-points`,
    `/api/assessments/${a}/data-points/summary`,
    `/api/assessments/${a}/function-hypotheses`,
    `/api/assessments/${a}/sign-offs`,
    `/api/assessments/${a}/sign-offs?document_type=fba_report`,
    `/api/assessments/${a}/progress-reports`,
    `/api/assessments/${a}/audit-log`,
    `/api/assessments/${a}/report`,
    `/api/assessments/${a}/report?deidentified=true`,
    `/api/assessments/${a}/report.pdf`,
    `/api/assessments/${a}/report.docx`,
    `/api/assessments/${a}/bip`,
    `/api/assessments/${a}/bip.pdf`,
    `/api/assessments/${a}/bip.docx`,
    `/api/assessments/${a}/crisis-plan`,
    `/api/assessments/${a}/crisis-plan.pdf`,
    `/api/assessments/${a}/crisis-plan.docx`,
    `/api/assessments/${a}/data-sheet`,
    `/api/assessments/${a}/data-sheet.pdf`,
    `/api/assessments/${a}/data-sheet.docx`,
    `/api/assessments/${a}/export.csv`,
    `/api/assessments/${a}/export.csv?deidentified=true`,
    `/api/assessments/${a}/export.json`,
    `/api/assessments/${a}/export.json?deidentified=true`,
    `/api/assessments/${a}/export.fhir`,
    `/api/assessments/${a}/export.fhir?deidentified=true`,
    `/api/progress-reports/${fx.victimProgressReportId}`,
    `/api/progress-reports/${fx.victimProgressReportId}.pdf`,
    `/api/progress-reports/${fx.victimProgressReportId}.docx`,
    `/api/progress-reports/${fx.victimProgressReportId}?deidentified=true`,
    `/api/sign-offs/${fx.victimSignOffId}/verify`,
  ];
  for (const p of getRoutes) {
    const res = await api(t, 'GET', p);
    assert.equal(res.status, 404, `GET ${p} must be 404 for another practice, got ${res.status}: ${String(res.text).slice(0, 200)}`);
    assert.deepEqual(leaks(res.text), [], `GET ${p} leaked another practice's data`);
  }

  const writeRoutes = [
    ['PUT', `/api/clients/${c}`, { first_name: 'Hijacked', last_name: 'ByAttacker', consent_status: 'obtained' }],
    ['DELETE', `/api/clients/${c}`, undefined],
    ['POST', `/api/clients/${c}/assessments`, { title: 'Injected assessment' }],
    ['PUT', `/api/assessments/${a}`, { title: 'Hijacked assessment', status: 'completed' }],
    ['DELETE', `/api/assessments/${a}`, undefined],
    ['POST', `/api/assessments/${a}/target-behaviors`, { name: 'Injected', operational_definition: 'Injected definition.' }],
    ['PUT', `/api/target-behaviors/${fx.victimBehavior.id}`, { name: 'Hijacked', operational_definition: 'Hijacked definition.' }],
    ['DELETE', `/api/target-behaviors/${fx.victimBehavior.id}`, undefined],
    ['POST', `/api/assessments/${a}/data-points`, { target_behavior_id: fx.victimBehavior.id, recorded_at: '2026-10-06T09:00:00', measurement_type: 'frequency', value: 9 }],
    ['PUT', `/api/data-points/${fx.victimDataPoint.id}`, { target_behavior_id: fx.victimBehavior.id, recorded_at: '2026-10-06T09:00:00', measurement_type: 'frequency', value: 99 }],
    ['DELETE', `/api/data-points/${fx.victimDataPoint.id}`, undefined],
    ['POST', `/api/assessments/${a}/function-hypotheses/generate`, undefined],
    ['PUT', `/api/function-hypotheses/${fx.victimHypothesisId}`, { function: 'attention', status: 'reviewed' }],
    ['POST', `/api/assessments/${a}/sign-offs`, { document_type: 'bip', signatory_role: 'bcba', signatory_name: 'Injected Signer' }],
    ['POST', `/api/sign-offs/${fx.victimSignOffId}/sign`, { signature: 'Injected Signature' }],
    ['DELETE', `/api/sign-offs/${fx.victimSignOffId}`, undefined],
    ['POST', `/api/assessments/${a}/progress-reports`, { period_type: 'month', period: VICTIM.reportPeriod }],
  ];
  for (const [method, p, body] of writeRoutes) {
    const res = await api(t, method, p, body);
    assert.equal(res.status, 404, `${method} ${p} must be 404 for another practice, got ${res.status}: ${String(res.text).slice(0, 200)}`);
    assert.deepEqual(leaks(res.text), [], `${method} ${p} leaked another practice's data`);
  }

  // CSV import is a raw text body, so it bypasses the JSON helper.
  const importRes = await fetch(`${baseUrl}/api/assessments/${a}/import/csv`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv', Authorization: `Bearer ${t}` },
    body: `recorded_at,behavior_name,measurement_type,value\n2026-10-07T09:00:00,${VICTIM.behaviorName},frequency,9\n`,
  });
  assert.equal(importRes.status, 404, 'CSV import against another practice must be 404');

  // The victim practice can still reach all of it: the 404s were scoping, not an outage.
  const v = fx.victimToken;
  assert.equal((await api(v, 'GET', `/api/clients/${c}`)).status, 200);
  assert.equal((await api(v, 'GET', `/api/assessments/${a}/report`)).status, 200);
  assert.equal((await api(v, 'GET', `/api/assessments/${a}/report.pdf`)).status, 200);
  assert.equal((await api(v, 'GET', `/api/progress-reports/${fx.victimProgressReportId}`)).status, 200);
  assert.equal((await api(v, 'GET', `/api/sign-offs/${fx.victimSignOffId}/verify`)).status, 200);
});

test('attack 1b: the victim practice\'s records are byte-for-byte unchanged after the attack', async () => {
  // Snapshot was taken before attack 1 ran? No: take one now and re-run the
  // whole write matrix, then compare. This proves nothing was mutated even
  // where the status code could have hidden a partial write.
  const before = await clinicalSnapshot();
  const t = fx.tokenAdmin;
  const a = fx.victimAssessment.id;
  await api(t, 'PUT', `/api/clients/${fx.victimClient.id}`, { first_name: 'Hijacked', last_name: 'X', consent_status: 'obtained' });
  await api(t, 'DELETE', `/api/clients/${fx.victimClient.id}`);
  await api(t, 'PUT', `/api/assessments/${a}`, { title: 'Hijacked', status: 'completed' });
  await api(t, 'DELETE', `/api/assessments/${a}`);
  await api(t, 'POST', `/api/assessments/${a}/target-behaviors`, { name: 'Injected', operational_definition: 'Injected.' });
  await api(t, 'PUT', `/api/target-behaviors/${fx.victimBehavior.id}`, { name: 'Hijacked', operational_definition: 'Hijacked.' });
  await api(t, 'POST', `/api/assessments/${a}/data-points`, { target_behavior_id: fx.victimBehavior.id, recorded_at: '2026-10-08T09:00:00', measurement_type: 'frequency', value: 9 });
  await api(t, 'PUT', `/api/data-points/${fx.victimDataPoint.id}`, { target_behavior_id: fx.victimBehavior.id, recorded_at: '2026-10-08T09:00:00', measurement_type: 'frequency', value: 99 });
  await api(t, 'POST', `/api/sign-offs/${fx.victimSignOffId}/sign`, { signature: 'Injected' });
  await api(t, 'DELETE', `/api/sign-offs/${fx.victimSignOffId}`);
  await api(t, 'POST', `/api/assessments/${a}/progress-reports`, { period_type: 'month', period: VICTIM.reportPeriod });

  const after = await clinicalSnapshot();
  assert.deepEqual(after, before, 'no clinical row changed or was created');

  const so = await row('sign_offs', fx.victimSignOffId);
  assert.equal(so.status, 'signed', 'the victim signature still stands');
  assert.equal(so.signature_typed, VICTIM.signatory, 'the typed signature is intact');
  const client = await row('clients', fx.victimClient.id);
  assert.equal(client.deleted_at, null, 'the victim client is not soft-deleted');
  assert.equal(client.first_name, VICTIM.clientFirst);
});

// ---------------------------------------------------------------------------
// 2. id substitution in request bodies and query strings
// ---------------------------------------------------------------------------
test('attack 2: ids in bodies and query strings cannot attach a record to another practice', async () => {
  const t = fx.tokenAdmin;

  // A client created with another practice's org_id joins the caller's own.
  const made = await api(t, 'POST', '/api/clients', {
    first_name: 'BodyOrg', last_name: 'Injected', consent_status: 'obtained', org_id: fx.victimOrg.id,
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  created.clients.push(made.json.id);
  assert.equal(Number(made.json.org_id), Number(fx.attackerOrg.id), 'org_id comes from the session, not the body');
  assert.equal(Number((await row('clients', made.json.id)).org_id), Number(fx.attackerOrg.id));

  // ...and the victim practice does not see it.
  const victimList = await api(fx.victimToken, 'GET', '/api/clients');
  assert.ok(!victimList.json.map((c) => c.id).includes(made.json.id), 'injected client did not land in the victim practice');

  // An assessment cannot be created under another practice's client, whatever
  // client_id the body carries.
  const a1 = await api(t, 'POST', `/api/clients/${fx.victimClient.id}/assessments`, { title: 'Injected', client_id: fx.attackerClient.id });
  assert.equal(a1.status, 404);
  const a2 = await api(t, 'POST', `/api/clients/${fx.attackerClient.id}/assessments`, { title: 'Injected', client_id: fx.victimClient.id });
  assert.equal(a2.status, 201);
  created.assessments.push(a2.json.id);
  assert.equal(Number(a2.json.client_id), Number(fx.attackerClient.id), 'client_id in the body is ignored');

  // A data point cannot be recorded against another practice's target behavior,
  // even inside the attacker's own assessment.
  const dpBefore = (await db.prepare('SELECT COUNT(*) AS n FROM data_points WHERE assessment_id=?').get(fx.attackerAssessment.id)).n;
  const badDp = await api(t, 'POST', `/api/assessments/${fx.attackerAssessment.id}/data-points`, {
    target_behavior_id: fx.victimBehavior.id, recorded_at: '2026-10-09T09:00:00', measurement_type: 'frequency', value: 5,
  });
  assert.equal(badDp.status, 400, 'a foreign target_behavior_id is refused');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM data_points WHERE assessment_id=?').get(fx.attackerAssessment.id)).n, dpBefore, 'nothing was inserted');

  // ...and an existing data point cannot be re-pointed at a foreign behavior.
  const badPut = await api(t, 'PUT', `/api/data-points/${fx.attackerDataPoint.id}`, {
    target_behavior_id: fx.victimBehavior.id, recorded_at: '2026-10-09T09:00:00', measurement_type: 'frequency', value: 5,
  });
  assert.equal(badPut.status, 400, 're-pointing a data point at a foreign behavior is refused');
  assert.equal(Number((await row('data_points', fx.attackerDataPoint.id)).target_behavior_id), Number(fx.attackerBehavior.id), 'the data point still belongs to its own behavior');

  // The attacker's own assessment with another practice's assessment_id in the
  // body stays its own.
  const asmtPut = await api(t, 'PUT', `/api/assessments/${fx.attackerAssessment.id}`, {
    title: 'Own assessment renamed', status: 'in_progress', client_id: fx.victimClient.id,
  });
  assert.equal(asmtPut.status, 200);
  assert.equal(Number((await row('assessments', fx.attackerAssessment.id)).client_id), Number(fx.attackerClient.id), 'client_id in the body is ignored on update');

  // Client list query strings cannot widen the scope.
  for (const q of [`?org_id=${fx.victimOrg.id}`, `?org_id=${fx.victimOrg.id}&limit=1000`, '?org_id=*']) {
    const res = await api(t, 'GET', `/api/clients${q}`);
    assert.equal(res.status, 200);
    assert.deepEqual(leaks(res.text), [], `GET /api/clients${q} leaked another practice's data`);
    for (const c of res.json) assert.equal(Number(c.org_id), Number(fx.attackerOrg.id), 'every listed client is in the attacker practice');
  }
});

// ---------------------------------------------------------------------------
// 3. id enumeration
// ---------------------------------------------------------------------------
test('attack 3: sweeping every id never returns another practice\'s row', async () => {
  const t = fx.tokenAdmin;
  const ownOrg = Number(fx.attackerOrg.id);
  const maxId = async (table) => (await db.prepare(`SELECT COALESCE(MAX(id),0) AS id FROM ${table}`).get()).id;
  const clientMax = await maxId('clients');
  const assessmentMax = await maxId('assessments');
  const behaviorMax = await maxId('target_behaviors');
  const dataPointMax = await maxId('data_points');
  const signOffMax = await maxId('sign_offs');
  const progressMax = await maxId('progress_reports');

  // clients: a 200 must be one of the attacker's own clients.
  for (let id = 1; id <= clientMax + 2; id++) {
    const res = await api(t, 'GET', `/api/clients/${id}`);
    if (res.status === 200) {
      assert.equal(Number(res.json.org_id), ownOrg, `GET /api/clients/${id} returned another practice's client`);
    } else {
      assert.equal(res.status, 404, `GET /api/clients/${id} answered ${res.status}, which distinguishes existing from missing ids`);
    }
    assert.deepEqual(leaks(res.text), [], `GET /api/clients/${id} leaked`);
  }

  // assessments and every assessment-scoped route.
  const assessmentRoutes = [
    '', '/target-behaviors', '/data-points', '/data-points/summary', '/function-hypotheses',
    '/sign-offs', '/progress-reports', '/audit-log', '/report', '/report.pdf', '/report.docx',
    '/bip', '/crisis-plan', '/data-sheet', '/export.csv', '/export.json', '/export.fhir',
  ];
  for (let id = 1; id <= assessmentMax + 2; id++) {
    const owner = await db.prepare('SELECT c.org_id FROM assessments a JOIN clients c ON c.id=a.client_id WHERE a.id=?').get(id);
    for (const suffix of assessmentRoutes) {
      const res = await api(t, 'GET', `/api/assessments/${id}${suffix}`);
      if (owner && Number(owner.org_id) === ownOrg) continue; // own rows are allowed any answer
      assert.equal(res.status, 404, `GET /api/assessments/${id}${suffix} answered ${res.status} for another practice's assessment`);
      assert.deepEqual(leaks(res.text), [], `GET /api/assessments/${id}${suffix} leaked`);
    }
  }

  // behaviors (write path) and data points (write path).
  for (let id = 1; id <= behaviorMax + 2; id++) {
    const res = await api(t, 'PUT', `/api/target-behaviors/${id}`, { name: 'Probe', operational_definition: 'Probe definition.' });
    const owner = await db.prepare('SELECT c.org_id FROM target_behaviors tb JOIN assessments a ON a.id=tb.assessment_id JOIN clients c ON c.id=a.client_id WHERE tb.id=?').get(id);
    if (owner && Number(owner.org_id) === ownOrg) continue;
    assert.equal(res.status, 404, `PUT /api/target-behaviors/${id} answered ${res.status}`);
  }
  for (let id = 1; id <= dataPointMax + 2; id++) {
    const dp = await db.prepare('SELECT * FROM data_points WHERE id=?').get(id);
    const owner = dp ? await db.prepare('SELECT c.org_id FROM assessments a JOIN clients c ON c.id=a.client_id WHERE a.id=?').get(dp.assessment_id) : null;
    const res = await api(t, 'DELETE', `/api/data-points/${id}`);
    if (owner && Number(owner.org_id) === ownOrg) continue;
    assert.equal(res.status, 404, `DELETE /api/data-points/${id} answered ${res.status}`);
  }
  for (let id = 1; id <= signOffMax + 2; id++) {
    const res = await api(t, 'GET', `/api/sign-offs/${id}/verify`);
    const owner = await db.prepare('SELECT c.org_id FROM sign_offs s JOIN assessments a ON a.id=s.assessment_id JOIN clients c ON c.id=a.client_id WHERE s.id=?').get(id);
    if (owner && Number(owner.org_id) === ownOrg) continue;
    assert.equal(res.status, 404, `GET /api/sign-offs/${id}/verify answered ${res.status}`);
    assert.deepEqual(leaks(res.text), [], `GET /api/sign-offs/${id}/verify leaked`);
  }
  for (let id = 1; id <= progressMax + 2; id++) {
    const res = await api(t, 'GET', `/api/progress-reports/${id}`);
    const owner = await db.prepare('SELECT c.org_id FROM progress_reports p JOIN assessments a ON a.id=p.assessment_id JOIN clients c ON c.id=a.client_id WHERE p.id=?').get(id);
    if (owner && Number(owner.org_id) === ownOrg) continue;
    assert.equal(res.status, 404, `GET /api/progress-reports/${id} answered ${res.status}`);
    assert.deepEqual(leaks(res.text), [], `GET /api/progress-reports/${id} leaked`);
  }

  // Denied is not enough: a foreign id and a missing id must be
  // indistinguishable, so the body has to match too (no "exists but forbidden"
  // wording, no id echoed back).
  const MISSING = 987654;
  const probes = [
    ['GET', (id) => `/api/clients/${id}`, undefined],
    ['GET', (id) => `/api/assessments/${id}`, undefined],
    ['GET', (id) => `/api/assessments/${id}/report`, undefined],
    ['GET', (id) => `/api/assessments/${id}/export.fhir`, undefined],
    ['GET', (id) => `/api/progress-reports/${id}`, undefined],
    ['GET', (id) => `/api/sign-offs/${id}/verify`, undefined],
    ['PUT', (id) => `/api/target-behaviors/${id}`, { name: 'Probe', operational_definition: 'Probe definition.' }],
    ['DELETE', (id) => `/api/data-points/${id}`, undefined],
  ];
  for (const [method, fn, body] of probes) {
    const foreign = await api(t, method, fn(fx.victimClient.id), body);
    const missing = await api(t, method, fn(MISSING), body);
    assert.equal(foreign.status, missing.status, `${method} ${fn(':id')}: status differs between another practice's id and a missing id`);
    assert.equal(foreign.text, missing.text, `${method} ${fn(':id')}: body differs between another practice's id and a missing id (an existence oracle)`);
  }
});

test('attack 3b: each practice prints its own letterhead on its own documents', async () => {
  const victimReport = await api(fx.victimToken, 'GET', `/api/assessments/${fx.victimAssessment.id}/report`);
  assert.equal(victimReport.status, 200);
  assert.equal(victimReport.json.letterhead?.name, VICTIM.orgName, "the victim's document carries the victim practice's letterhead");

  const attackerReport = await api(fx.tokenAdmin, 'GET', `/api/assessments/${fx.attackerAssessment.id}/report`);
  assert.equal(attackerReport.status, 200);
  assert.equal(attackerReport.json.letterhead?.name, 'Attacker Practice', 'the attacker\'s document carries its own letterhead');
  assert.deepEqual(leaks(JSON.stringify(attackerReport.json)), [], 'no other practice\'s letterhead appears on the attacker\'s document');

  // De-identification keeps the letterhead (it is not PHI) and drops the client.
  const deid = await api(fx.victimToken, 'GET', `/api/assessments/${fx.victimAssessment.id}/report?deidentified=true`);
  assert.equal(deid.status, 200);
  assert.equal(deid.json.letterhead?.name, VICTIM.orgName);
  assert.ok(!JSON.stringify(deid.json).includes(VICTIM.clientLast), 'the de-identified document drops the client name');
});

// ---------------------------------------------------------------------------
// 4. admin surfaces: audit feed, users, organization settings, billing
// ---------------------------------------------------------------------------
test('attack 4: the audit feed, user list, org settings and billing show only the attacker practice', async () => {
  const t = fx.tokenAdmin;

  const feed = await api(t, 'GET', '/api/admin/audit-log?limit=500');
  assert.equal(feed.status, 200);
  assert.deepEqual(leaks(feed.text), [], 'the audit feed leaked another practice\'s activity');
  for (const r of feed.json) assert.equal(Number(r.org_id), Number(fx.attackerOrg.id), `audit row ${r.id} (${r.action}) belongs to another practice`);
  // A query string naming the victim organization is ignored.
  const feedQ = await api(t, 'GET', `/api/admin/audit-log?limit=500&org_id=${fx.victimOrg.id}`);
  assert.deepEqual(leaks(feedQ.text), [], 'an org_id query string widened the audit feed');

  const users = await api(t, 'GET', '/api/admin/users');
  assert.equal(users.status, 200);
  assert.deepEqual(leaks(users.text), [], 'the user list leaked another practice\'s accounts');
  const usernames = users.json.map((u) => u.username);
  assert.ok(usernames.includes('attacker.clinician@attack.test'));
  assert.ok(!usernames.includes('victim.clinician@attack.test'), 'the victim practice\'s account is not listed');

  // Editing another practice's account: 404, and the account is unchanged.
  const before = await row('users', fx.victimClinician.id);
  const edit = await api(t, 'PUT', `/api/admin/users/${fx.victimClinician.id}`, { display_name: 'Hijacked', role: 'admin' });
  assert.equal(edit.status, 404);
  const afterEdit = await row('users', fx.victimClinician.id);
  assert.equal(afterEdit.display_name, before.display_name);
  assert.equal(afterEdit.role, before.role);

  // Creating a user with another practice's org_id puts it in the caller's own.
  const madeUser = await api(t, 'POST', '/api/admin/users', {
    username: 'injected.user@attack.test', password: 'AttackTest2026!', role: 'staff', org_id: fx.victimOrg.id,
  });
  assert.equal(madeUser.status, 201, JSON.stringify(madeUser.json));
  created.users.push(madeUser.json.id);
  assert.equal(Number(madeUser.json.org_id), Number(fx.attackerOrg.id), 'a new account joins the caller\'s practice, not the body\'s');

  // Organization settings: the victim organization is not readable or editable.
  const orgPeek = await api(t, 'GET', `/api/organization?org_id=${fx.victimOrg.id}`);
  assert.equal(orgPeek.status, 404);
  assert.deepEqual(leaks(orgPeek.text), [], 'the org settings endpoint leaked another practice');

  const victimOrgBefore = await row('organizations', fx.victimOrg.id);
  const orgWrite = await api(t, 'PUT', `/api/organization/${fx.victimOrg.id}`, {
    name: 'Hijacked Practice', address_line: '1 Hijack St', city: 'Nowhere', state: 'VA', postal_code: '00000',
  });
  assert.equal(orgWrite.status, 404);
  const victimOrgAfter = await row('organizations', fx.victimOrg.id);
  assert.equal(victimOrgAfter.name, victimOrgBefore.name, 'another practice\'s letterhead is untouched');
  assert.equal(victimOrgAfter.address_line, victimOrgBefore.address_line);

  // Own settings still work, and the org picker offers exactly one practice.
  const own = await api(t, 'GET', '/api/organization');
  assert.equal(own.status, 200);
  assert.equal(Number(own.json.organization.id), Number(fx.attackerOrg.id));
  assert.equal(own.json.organizations.length, 1, 'a non-platform admin is offered exactly its own practice');
  assert.deepEqual(leaks(own.text), []);

  // Billing is the caller's own account only.
  const billing = await api(t, 'GET', '/api/billing/status');
  assert.equal(billing.status, 200);
  assert.ok(billing.json === null || billing.json.subscription_id !== 'sub_victim', 'never another practice\'s subscription');
  assert.deepEqual(leaks(billing.text), []);
});

// ---------------------------------------------------------------------------
// 5. privilege escalation
// ---------------------------------------------------------------------------
test('attack 5: an organization admin cannot promote itself to platform admin or move practice', async () => {
  const t = fx.tokenAdmin;
  const before = await row('users', fx.attackerAdmin.id);

  const res = await api(t, 'PUT', `/api/admin/users/${fx.attackerAdmin.id}`, {
    display_name: before.display_name, role: 'admin',
    is_platform_admin: 1, org_id: fx.victimOrg.id,
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const after = await row('users', fx.attackerAdmin.id);
  assert.equal(Number(after.is_platform_admin), Number(before.is_platform_admin), 'is_platform_admin cannot be set through the user editor');
  assert.equal(Number(after.org_id), Number(fx.attackerOrg.id), 'org_id cannot be set through the user editor');

  // ...and the session reflects it: still confined to its own practice.
  const me = await api(t, 'GET', '/api/auth/me');
  assert.equal(Number(me.json.is_platform_admin), 0);
  assert.equal(Number(me.json.org_id), Number(fx.attackerOrg.id));
  assert.equal((await api(t, 'GET', `/api/clients/${fx.victimClient.id}`)).status, 404, 'still cannot cross practices');

  // The admin response body does not carry secrets either.
  const meText = JSON.stringify(me.json);
  for (const secret of ['password_hash', 'mfa_secret', 'scrypt$']) {
    assert.ok(!meText.includes(secret), `/api/auth/me must not expose ${secret}`);
  }
});

// ---------------------------------------------------------------------------
// 6. offline sync conflict path (409 is an existence oracle)
// ---------------------------------------------------------------------------
test('attack 6: the offline conflict path cannot be used to detect or edit another practice\'s records', async () => {
  const t = fx.tokenAdmin;
  const victimClient = await row('clients', fx.victimClient.id);

  // A stale base_updated_at against another practice's record: 404, never 409.
  for (const [method, p, body] of [
    ['PUT', `/api/clients/${fx.victimClient.id}`, { first_name: 'Sync', last_name: 'Hijack', consent_status: 'obtained', base_updated_at: '2020-01-01T00:00:00Z' }],
    ['PUT', `/api/assessments/${fx.victimAssessment.id}`, { title: 'Sync hijack', status: 'draft', base_updated_at: '2020-01-01T00:00:00Z' }],
    ['PUT', `/api/target-behaviors/${fx.victimBehavior.id}`, { name: 'Sync hijack', operational_definition: 'Sync hijack.', base_updated_at: '2020-01-01T00:00:00Z' }],
  ]) {
    const res = await api(t, method, p, body);
    assert.equal(res.status, 404, `${method} ${p} with a stale base must be 404, not a conflict answer`);
    assert.deepEqual(leaks(res.text), [], `${method} ${p} leaked`);
  }
  assert.equal((await row('clients', fx.victimClient.id)).first_name, victimClient.first_name, 'nothing was written');

  // The conflict path itself still works, on the attacker's own record.
  const stale = await api(t, 'PUT', `/api/clients/${fx.attackerClient.id}`, {
    first_name: 'Offline', last_name: 'Edit', consent_status: 'obtained', base_updated_at: '2020-01-01T00:00:00Z',
  });
  assert.equal(stale.status, 409, 'a stale base on an own record still conflicts');
  assert.equal(stale.json.conflict, true);
  assert.equal(Number(stale.json.current.id), Number(fx.attackerClient.id));

  // A queued offline write replayed against a foreign record id fails closed.
  const replay = await api(t, 'POST', `/api/assessments/${fx.victimAssessment.id}/data-points`, {
    target_behavior_id: fx.victimBehavior.id, recorded_at: '2026-10-10T09:00:00', measurement_type: 'frequency', value: 7,
    client_uuid: 'offline-replay-1', base_updated_at: '2026-10-01T00:00:00Z',
  });
  assert.equal(replay.status, 404, 'a replayed offline write against another practice is 404');
});

// ---------------------------------------------------------------------------
// 7. verification links
// ---------------------------------------------------------------------------
test('attack 7: the public verification link discloses no clinical data and stays unauthenticated by design', async () => {
  // Unauthenticated, by design (a document recipient has no account).
  const pub = await fetch(`${baseUrl}/api/verify/sign-off/${fx.victimSignOffId}`);
  const body = await pub.json();
  assert.equal(pub.status, 200);
  assert.equal(body.valid, true);
  // The payload is minimal: no client, no assessment, no organization, and no
  // signatory name (a guardian's name is the client's family — not something an
  // unauthenticated visitor may enumerate).
  assert.deepEqual(Object.keys(body).sort(),
    ['algorithm', 'document_type', 'key_fingerprint', 'signed_at', 'tampered', 'valid']);
  assert.ok(!('signatory_name' in body), 'the public payload carries no signatory name');
  assert.ok(!JSON.stringify(body).includes(VICTIM.signatory), 'the signatory name is not disclosed publicly');
  assert.deepEqual(leaks(JSON.stringify(body)), [], 'the public verification link leaked clinical data');
  // No field names a client, an assessment, an organization or a person.
  for (const key of Object.keys(body)) {
    assert.ok(!/client|assessment|org|signatory|name/i.test(key), `the public payload exposes ${key}`);
  }
  // ...and no value is one of the victim's record ids.
  const values = Object.values(body);
  assert.ok(!values.includes(Number(fx.victimAssessment.id)), 'no assessment id in the public payload');
  assert.ok(!values.includes(Number(fx.victimClient.id)), 'no client id in the public payload');

  // Unknown ids are 404 and say nothing else.
  const missing = await fetch(`${baseUrl}/api/verify/sign-off/999999`);
  assert.equal(missing.status, 404);

  // The authenticated verification route is scoped: another practice's admin
  // cannot use it to learn anything about the victim's document.
  const authed = await api(fx.tokenAdmin, 'GET', `/api/sign-offs/${fx.victimSignOffId}/verify`);
  assert.equal(authed.status, 404);
  assert.deepEqual(leaks(authed.text), []);
});

// ---------------------------------------------------------------------------
// 8. fail closed
// ---------------------------------------------------------------------------
test('attack 8: an account with no organization sees nothing at all', async () => {
  const orphan = await mkUser('orphan@attack.test', null, 'bcba');
  const token = await login('orphan@attack.test');
  assert.equal((await row('users', orphan.id)).org_id, null);

  const list = await api(token, 'GET', '/api/clients');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json, [], 'an account with no organization lists nothing');
  assert.equal((await api(token, 'GET', `/api/clients/${fx.attackerClient.id}`)).status, 404);
  assert.equal((await api(token, 'GET', `/api/clients/${fx.victimClient.id}`)).status, 404);
  assert.equal((await api(token, 'GET', `/api/assessments/${fx.victimAssessment.id}/report`)).status, 404);
  assert.equal((await api(token, 'GET', '/api/organization')).status, 404, 'no organization to show');
  assert.deepEqual((await api(token, 'GET', '/api/admin/audit-log')).status, 403, 'no admin feed without an organization');
  // ...and it cannot create a record into anyone's practice.
  const made = await api(token, 'POST', '/api/clients', { first_name: 'Orphan', last_name: 'Write', consent_status: 'obtained' });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  created.clients.push(made.json.id);
  const stored = await row('clients', made.json.id);
  assert.ok(stored.org_id != null, 'an org-less account writes into the default organization, never the victim\'s');
  assert.notEqual(Number(stored.org_id), Number(fx.victimOrg.id));
});
