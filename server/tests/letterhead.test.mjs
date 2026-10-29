// ClearPathFBA — document letterhead tests.
//
// Every generated document (FBA report, BIP, crisis plan, data sheet, progress
// report) carries the letterhead of THE ORGANIZATION THAT OWNS THE CLIENT —
// resolved from `clients.org_id`, never from the account viewing it. This test
// proves that resolution end to end, through the HTTP surface the app uses:
//
//   1. two organizations, each with its own client: every one of the five
//      documents carries that client's organization name
//   2. the platform admin (who belongs to organization A) opening organization
//      B's documents sees "organization B", not their own organization
//   3. de-identified documents keep the organization letterhead (an
//      organization name is not PHI)
//   4. optional contact lines render only when supplied, and a client with no
//      organization falls back to the product name instead of an empty line
//   5. the rendered artifacts themselves carry the name: the PDF bytes and the
//      Word document's XML are opened and searched, not just the JSON payload
//   6. the letterhead is outside the signature digest, so adding it (or an
//      organization renaming itself) does not turn a signed record "tampered"
//
// Isolated like org-scoping.test.mjs: a temp sqlite file and temp signing-key
// directory are created before the server modules load.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const tmp = mkdtempSync(path.join(tmpdir(), 'cpf-letterhead-'));
process.env.DATABASE_PATH = path.join(tmp, 'test.sqlite');
process.env.SIGNING_KEYS_DIR = path.join(tmp, 'keys');
process.env.VERCEL = '1'; // index.js exports app/bootstrap without listening.

const { app, bootstrap } = await import('../src/index.js');
const db = (await import('../src/db.js')).default;
const { hashPassword } = await import('../src/auth.js');
const { ensureOrg, backfillOrganizations, PLATFORM_ADMIN_ACCOUNTS } = await import('../src/org-migration.js');
const { buildLetterhead, letterheadForClient, ensureLetterhead, PRODUCT_NAME } = await import('../src/letterhead.js');
const { buildReport } = await import('../src/report.js');
const { digestFor } = await import('../src/signature.js');

let server;
let baseUrl;
const fx = {};
const created = { clients: [], assessments: [], behaviors: [], dataPoints: [], progressReports: [] };

// --- fixture helpers -------------------------------------------------------
async function mkUser(username, orgId, role = 'bcba', email = null) {
 const r = await db.prepare(
  'INSERT INTO users (username,password_hash,role,display_name,email,org_id,active,must_change_password) VALUES (?,?,?,?,?,?,1,0)',
 ).run(username, hashPassword('Letterhead2026!'), role, `Test ${username}`, email, orgId);
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
 const r = await db.prepare("INSERT INTO assessments (client_id,title,status,assessment_date) VALUES (?,?,'completed','2026-10-15')")
  .run(clientId, title);
 const a = await db.prepare('SELECT * FROM assessments WHERE id=?').get(r.lastInsertRowid);
 created.assessments.push(a.id);
 return a;
}

async function mkBehavior(assessmentId, name) {
 const r = await db.prepare(
  "INSERT INTO target_behaviors (assessment_id,name,operational_definition,safety_classification,is_safety_concern,baseline_measurement_type) VALUES (?,?,?,'aggression',1,'frequency')",
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

async function login(username, password = 'Letterhead2026!') {
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

async function fetchBinary(token, p) {
 const res = await fetch(baseUrl + p, { headers: { Authorization: `Bearer ${token}` } });
 const buf = Buffer.from(await res.arrayBuffer());
 return { status: res.status, buf, contentType: res.headers.get('content-type') };
}

/**
 * Text of every FlateDecode stream in a PDFKit buffer, decoded back to readable
 * text. PDFKit emits text as hex strings inside TJ arrays (kerning splits a run
 * into several), so adjacent runs are concatenated without a separator.
 */
function pdfText(buf) {
 const streams = [];
 const marker = Buffer.from('stream');
 let idx = 0;
 while ((idx = buf.indexOf(marker, idx)) !== -1) {
  let start = idx + marker.length;
  if (buf[start] === 0x0d) start += 1;
  if (buf[start] === 0x0a) start += 1;
  const end = buf.indexOf(Buffer.from('endstream'), start);
  if (end === -1) break;
  try { streams.push(zlib.inflateSync(buf.slice(start, end)).toString('latin1')); } catch { /* not deflated */ }
  idx = end + 'endstream'.length;
 }
 const content = streams.join('\n');
 const parts = [];
 for (const m of content.matchAll(/<([0-9A-Fa-f]+)>/g)) parts.push(Buffer.from(m[1], 'hex').toString('latin1'));
 for (const m of content.matchAll(/\(((?:\\.|[^\\()])*)\)/g)) parts.push(m[1].replace(/\\([()\\])/g, '$1'));
 return parts.join('');
}

/** Read one entry out of a ZIP (docx) via its central directory. */
function zipEntry(buf, name) {
 const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
 if (eocd === -1) return null;
 const count = buf.readUInt16LE(eocd + 10);
 let off = buf.readUInt32LE(eocd + 16);
 for (let i = 0; i < count; i += 1) {
  if (buf.readUInt32LE(off) !== 0x02014b50) return null;
  const method = buf.readUInt16LE(off + 10);
  const compSize = buf.readUInt32LE(off + 20);
  const nameLen = buf.readUInt16LE(off + 28);
  const extraLen = buf.readUInt16LE(off + 30);
  const commentLen = buf.readUInt16LE(off + 32);
  const localOff = buf.readUInt32LE(off + 42);
  const entryName = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
  if (entryName === name) {
   const lNameLen = buf.readUInt16LE(localOff + 26);
   const lExtraLen = buf.readUInt16LE(localOff + 28);
   const dataStart = localOff + 30 + lNameLen + lExtraLen;
   const data = buf.slice(dataStart, dataStart + compSize);
   return method === 0 ? data.toString('utf8') : zlib.inflateRawSync(data).toString('utf8');
  }
  off += 46 + nameLen + extraLen + commentLen;
 }
 return null;
}

const docxText = (buf) => zipEntry(buf, 'word/document.xml') || '';

// The five documents, addressed the way the client view addresses them.
const FIVE = [
 { key: 'fba_report', path: (id) => `/api/assessments/${id}/report` },
 { key: 'bip', path: (id) => `/api/assessments/${id}/bip` },
 { key: 'crisis_plan', path: (id) => `/api/assessments/${id}/crisis-plan` },
 { key: 'data_sheet', path: (id) => `/api/assessments/${id}/data-sheet` },
 { key: 'progress_report', path: null }, // created per assessment below
];

async function progressReportFor(token, assessmentId) {
 const made = await api(token, 'POST', `/api/assessments/${assessmentId}/progress-reports`, { period_type: 'month', period: '2026-10' });
 assert.equal(made.status, 201, `progress report creation failed: ${JSON.stringify(made.json)}`);
 created.progressReports.push(made.json.id);
 return made.json;
}

/** Every one of the five documents for one assessment, as the given caller. */
async function allDocuments(token, assessmentId) {
 const docs = {};
 for (const d of FIVE) {
  if (d.key === 'progress_report') {
   const made = await progressReportFor(token, assessmentId);
   const got = await api(token, 'GET', `/api/progress-reports/${made.id}`);
   assert.equal(got.status, 200);
   docs[d.key] = got.json;
  } else {
   const got = await api(token, 'GET', d.path(assessmentId));
   assert.equal(got.status, 200, `${d.key} returned ${got.status}: ${JSON.stringify(got.json)}`);
   docs[d.key] = got.json;
  }
 }
 return docs;
}

// --- fixture ---------------------------------------------------------------
before(async () => {
 await bootstrap();
 await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
 baseUrl = `http://127.0.0.1:${server.address().port}`;

 // Organization A: the owner's practice, with every optional contact line set.
 fx.orgA = await ensureOrg(db, { name: 'Pederec Inc', slug: 'letterhead-org-a' });
 await db.prepare('UPDATE organizations SET address_line=?, phone=?, credential_line=? WHERE id=?')
  .run('123 Example Street, Suite 200, Richmond, VA 23219', '(804) 555-0100', 'Virginia DBHDS-licensed provider', fx.orgA.id);

 // Organization B: no contact lines at all — a name-only letterhead.
 fx.orgB = await ensureOrg(db, { name: 'Bright Path ABA', slug: 'letterhead-org-b' });

 fx.userA = await mkUser('clinician.a@letterhead.test', fx.orgA.id, 'bcba');
 fx.userB = await mkUser('clinician.b@letterhead.test', fx.orgB.id, 'bcba');
 // The platform admin belongs to organization A; the migration marks the
 // configured owner address as a platform admin.
 fx.owner = await mkUser(PLATFORM_ADMIN_ACCOUNTS[0], fx.orgA.id, 'admin', PLATFORM_ADMIN_ACCOUNTS[0]);
 await backfillOrganizations(db);

 fx.clientA = await mkClient(fx.orgA.id, 'Client', 'Alpha');
 fx.assessA = await mkAssessment(fx.clientA.id, 'Letterhead A assessment');
 fx.behaviorA = await mkBehavior(fx.assessA.id, 'Aggression (A)');
 await mkDataPoint(fx.assessA.id, fx.behaviorA.id);

 fx.clientB = await mkClient(fx.orgB.id, 'Client', 'Bravo');
 fx.assessB = await mkAssessment(fx.clientB.id, 'Letterhead B assessment');
 fx.behaviorB = await mkBehavior(fx.assessB.id, 'Elopement (B)');
 await mkDataPoint(fx.assessB.id, fx.behaviorB.id);

 fx.tokenA = await login('clinician.a@letterhead.test');
 fx.tokenB = await login('clinician.b@letterhead.test');
 fx.tokenOwner = await login(PLATFORM_ADMIN_ACCOUNTS[0]);
});

after(async () => {
 // Child rows first; matters when this runs against a shared Postgres database.
 for (const id of created.progressReports) { try { await db.prepare('DELETE FROM progress_reports WHERE id=?').run(id); } catch { /* gone */ } }
 for (const id of created.dataPoints) { try { await db.prepare('DELETE FROM data_points WHERE id=?').run(id); } catch { /* gone */ } }
 for (const id of created.behaviors) { try { await db.prepare('DELETE FROM target_behaviors WHERE id=?').run(id); } catch { /* gone */ } }
 for (const id of created.assessments) { try { await db.prepare('DELETE FROM assessments WHERE id=?').run(id); } catch { /* gone */ } }
 for (const id of created.clients) { try { await db.prepare('DELETE FROM clients WHERE id=?').run(id); } catch { /* gone */ } }
 for (const org of [fx.orgB, fx.orgA]) { try { await db.prepare('DELETE FROM organizations WHERE id=?').run(org.id); } catch { /* gone */ } }
 server?.close();
});

// ---------------------------------------------------------------------------
// 1. the letterhead resolves from the client's organization
// ---------------------------------------------------------------------------
test('all five documents carry their own organization name (two orgs, isolated)', async () => {
 const docsA = await allDocuments(fx.tokenA, fx.assessA.id);
 for (const d of FIVE) {
  const lh = docsA[d.key].letterhead;
  assert.ok(lh, `${d.key} carries a letterhead`);
  assert.equal(lh.name, 'Pederec Inc', `${d.key} shows organization A's name`);
  assert.equal(lh.org_id, Number(fx.orgA.id), `${d.key} letterhead is organization A`);
  assert.equal(lh.is_fallback, false);
 }

 const docsB = await allDocuments(fx.tokenB, fx.assessB.id);
 for (const d of FIVE) {
  const lh = docsB[d.key].letterhead;
  assert.ok(lh, `${d.key} carries a letterhead`);
  assert.equal(lh.name, 'Bright Path ABA', `${d.key} shows organization B's name`);
  assert.equal(lh.org_id, Number(fx.orgB.id), `${d.key} letterhead is organization B`);
 }
});

test('optional contact lines render only when supplied', async () => {
 const reportA = (await api(fx.tokenA, 'GET', `/api/assessments/${fx.assessA.id}/report`)).json;
 assert.deepEqual(reportA.letterhead.lines, [
  '123 Example Street, Suite 200, Richmond, VA 23219',
  '(804) 555-0100',
  'Virginia DBHDS-licensed provider',
 ]);

 const reportB = (await api(fx.tokenB, 'GET', `/api/assessments/${fx.assessB.id}/report`)).json;
 assert.equal(reportB.letterhead.name, 'Bright Path ABA');
 // Name only: no blank rows, no stray separators.
 assert.deepEqual(reportB.letterhead.lines, []);
 assert.equal(reportB.letterhead.address_line, '');
 assert.equal(reportB.letterhead.phone, '');
 assert.equal(reportB.letterhead.credential_line, '');
});

// ---------------------------------------------------------------------------
// 2. the platform admin sees the OTHER organization's name, not their own
// ---------------------------------------------------------------------------
test('platform admin viewing another organization\'s document sees that organization\'s letterhead', async () => {
 // Sanity: this account really is the cross-org one, and it belongs to org A.
 const me = (await api(fx.tokenOwner, 'GET', '/api/auth/me')).json;
 assert.equal(me.is_platform_admin, 1, 'owner account is a platform admin');
 assert.equal(Number(me.org_id), Number(fx.orgA.id), 'owner account belongs to organization A');

 // Own organization's documents: own name.
 const own = await allDocuments(fx.tokenOwner, fx.assessA.id);
 for (const d of FIVE) assert.equal(own[d.key].letterhead.name, 'Pederec Inc', `${d.key} (own org)`);

 // Another organization's documents: THAT organization's name, not "Pederec Inc".
 for (const d of FIVE) {
  let doc;
  if (d.key === 'progress_report') {
   const made = await progressReportFor(fx.tokenOwner, fx.assessB.id);
   doc = (await api(fx.tokenOwner, 'GET', `/api/progress-reports/${made.id}`)).json;
  } else {
   const got = await api(fx.tokenOwner, 'GET', d.path(fx.assessB.id));
   assert.equal(got.status, 200, `${d.key} for org B by the platform admin: ${got.status}`);
   doc = got.json;
  }
  assert.equal(doc.letterhead.name, 'Bright Path ABA', `${d.key}: platform admin sees org B's name`);
  assert.notEqual(doc.letterhead.name, 'Pederec Inc', `${d.key}: never the viewer's own organization`);
 }

 // The clinician in organization A cannot reach organization B at all (404).
 const blocked = await api(fx.tokenA, 'GET', `/api/assessments/${fx.assessB.id}/report`);
 assert.equal(blocked.status, 404, 'org A clinician still cannot open org B\'s report');
});

// ---------------------------------------------------------------------------
// 3. de-identified documents keep the letterhead
// ---------------------------------------------------------------------------
test('de-identified documents still carry the organization name', async () => {
 for (const d of FIVE) {
  let doc;
  if (d.key === 'progress_report') {
   const made = await progressReportFor(fx.tokenA, fx.assessA.id);
   doc = (await api(fx.tokenA, 'GET', `/api/progress-reports/${made.id}?deidentified=true`)).json;
  } else {
   const got = await api(fx.tokenA, 'GET', `${d.path(fx.assessA.id)}?deidentified=true`);
   assert.equal(got.status, 200, `${d.key} de-identified: ${got.status}`);
   doc = got.json;
  }
  assert.equal(doc.deidentified, true, `${d.key} is flagged de-identified`);
  // PHI really is stripped ...
  assert.equal(doc.client.first_name, 'Client');
  assert.equal(doc.client.last_name, `#${fx.clientA.id}`);
  // ... and the organization letterhead survives (an org name is not PHI).
  assert.equal(doc.letterhead.name, 'Pederec Inc', `${d.key} keeps the org letterhead when de-identified`);
  assert.deepEqual(doc.letterhead.lines, [
   '123 Example Street, Suite 200, Richmond, VA 23219',
   '(804) 555-0100',
   'Virginia DBHDS-licensed provider',
  ]);
 }
});

// ---------------------------------------------------------------------------
// 4. fallback when a client has no organization
// ---------------------------------------------------------------------------
test('a client with no organization falls back to the product name, never an empty line', async () => {
 const noOrg = await letterheadForClient({ id: 999999, org_id: null });
 assert.equal(noOrg.name, PRODUCT_NAME);
 assert.equal(noOrg.is_fallback, true);
 assert.equal(noOrg.org_id, null);
 assert.deepEqual(noOrg.lines, []);

 const missingOrg = await letterheadForClient({ id: 999999, org_id: 987654 });
 assert.equal(missingOrg.name, PRODUCT_NAME, 'a dangling org id falls back too');
 assert.equal(missingOrg.is_fallback, true);

 // buildLetterhead never emits an empty name, and drops blank contact rows.
 assert.equal(buildLetterhead(null).name, PRODUCT_NAME);
 assert.deepEqual(buildLetterhead({ name: 'X', address_line: '  ', phone: null, credential_line: 'Lic. 1' }).lines, ['Lic. 1']);

 // Stored payloads with no letterhead (progress reports generated before this
 // feature) are resolved at render time from the client's organization.
 const patched = await ensureLetterhead({ client: { id: fx.clientA.id }, period_label: 'October 2026' });
 assert.equal(patched.letterhead.name, 'Pederec Inc');
 assert.equal(patched.period_label, 'October 2026', 'payload is otherwise untouched');
 // A payload that already has one keeps it verbatim (generated = frozen).
 const kept = await ensureLetterhead({ client: { id: fx.clientA.id }, letterhead: { name: 'Old Name', lines: [] } });
 assert.equal(kept.letterhead.name, 'Old Name');
});

// ---------------------------------------------------------------------------
// 5. the rendered artifacts carry the name (PDF bytes and DOCX XML)
// ---------------------------------------------------------------------------
test('server-generated PDF and Word files carry the organization letterhead', async () => {
 const pdf = await fetchBinary(fx.tokenA, `/api/assessments/${fx.assessA.id}/report.pdf`);
 assert.equal(pdf.status, 200);
 assert.match(pdf.contentType || '', /application\/pdf/);
 const pdfBody = pdfText(pdf.buf);
 assert.ok(pdf.buf.subarray(0, 5).toString() === '%PDF-', 'a real PDF is returned');
 assert.ok(pdfBody.includes('Pederec Inc'), 'the PDF text contains the organization name');
 assert.ok(pdfBody.includes('Virginia DBHDS-licensed provider'), 'the PDF text contains the credential line');
 assert.ok(!pdfBody.includes('Bright Path ABA'), 'the PDF does not leak the other organization');

 const docx = await fetchBinary(fx.tokenA, `/api/assessments/${fx.assessA.id}/report.docx`);
 assert.equal(docx.status, 200);
 const docxBody = docxText(docx.buf);
 assert.ok(docxBody.length > 0, 'word/document.xml was read out of the .docx zip');
 assert.ok(docxBody.includes('Pederec Inc'), 'the Word document contains the organization name');
 assert.ok(docxBody.includes('Virginia DBHDS-licensed provider'), 'the Word document contains the credential line');

 // De-identified exports keep the letterhead in both file formats.
 const pdfDeid = await fetchBinary(fx.tokenA, `/api/assessments/${fx.assessA.id}/report.pdf?deidentified=true`);
 assert.ok(pdfText(pdfDeid.buf).includes('Pederec Inc'), 'de-identified PDF keeps the org letterhead');
 assert.ok(pdfText(pdfDeid.buf).includes('DE-IDENTIFIED'), 'de-identified PDF is still banner-flagged');
 const docxDeid = await fetchBinary(fx.tokenA, `/api/assessments/${fx.assessA.id}/report.docx?deidentified=true`);
 assert.ok(docxText(docxDeid.buf).includes('Pederec Inc'), 'de-identified Word file keeps the org letterhead');

 // Every other document type, through both file formats.
 for (const slug of ['bip', 'crisis-plan', 'data-sheet']) {
  const p = await fetchBinary(fx.tokenA, `/api/assessments/${fx.assessA.id}/${slug}.pdf`);
  assert.equal(p.status, 200, `${slug}.pdf status`);
  assert.ok(pdfText(p.buf).includes('Pederec Inc'), `${slug}.pdf carries the letterhead`);
  const w = await fetchBinary(fx.tokenA, `/api/assessments/${fx.assessA.id}/${slug}.docx`);
  assert.equal(w.status, 200, `${slug}.docx status`);
  assert.ok(docxText(w.buf).includes('Pederec Inc'), `${slug}.docx carries the letterhead`);
 }
});

// ---------------------------------------------------------------------------
// 6. the letterhead stays out of the signature digest
// ---------------------------------------------------------------------------
test('adding the letterhead does not change the signature digest of a document', async () => {
 const payload = await buildReport(fx.assessA.id);
 assert.equal(payload.letterhead.name, 'Pederec Inc');
 const withLetterhead = digestFor(payload, 'fba_report');
 const without = digestFor({ ...payload, letterhead: undefined }, 'fba_report');
 assert.equal(withLetterhead, without, 'the digest is over clinical content, not the provider letterhead');
 // An organization renaming itself must not flip a signed record to "tampered".
 const renamed = digestFor({ ...payload, letterhead: { ...payload.letterhead, name: 'Pederec Inc (renamed)' } }, 'fba_report');
 assert.equal(renamed, without);
});
