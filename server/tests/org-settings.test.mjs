// ClearPathFBA — organization settings screen tests (pass 2, last slice).
//
// Proves the settings API: an organization's admin reads and edits their own
// organization's letterhead and sees only their own members; the platform admin
// may pick which organization to edit; any other organization id answers 404
// (never 403) and changes nothing; every real write lands in the audit log,
// attributed to the organization it changed; and a no-op save writes nothing.
//
// Isolated from the dev database: a temp sqlite file (and a temp signing-key
// directory) is created before the server modules are imported. The same file
// runs against Postgres when DATABASE_URL is set; the rows it creates are
// removed in after().
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(tmpdir(), 'cpf-org-settings-'));
process.env.DATABASE_PATH = path.join(tmp, 'test.sqlite');
process.env.SIGNING_KEYS_DIR = path.join(tmp, 'keys');
process.env.VERCEL = '1'; // index.js exports app/bootstrap without listening.

const { app, bootstrap } = await import('../src/index.js');
const db = (await import('../src/db.js')).default;
const { hashPassword } = await import('../src/auth.js');
const { ensureOrg, backfillOrganizations, PLATFORM_ADMIN_ACCOUNTS } = await import('../src/org-migration.js');
const { validateOrgSettings, normalizePhone, normalizeNpi, changedOrgFields } = await import('../src/org-settings.js');
const { buildLetterhead } = await import('../src/letterhead.js');

let server;
let baseUrl;
const fx = {};
const created = { users: [], orgs: [], auditFloor: 0 };

async function mkUser(username, orgId, role = 'bcba', email = null) {
 const r = await db.prepare(
  'INSERT INTO users (username,password_hash,role,display_name,email,org_id,active,must_change_password) VALUES (?,?,?,?,?,?,1,0)',
 ).run(username, hashPassword('OrgSettings2026!'), role, `Test ${username}`, email, orgId);
 created.users.push(r.lastInsertRowid);
 return await db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
}

async function login(username, password = 'OrgSettings2026!') {
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

before(async () => {
 await bootstrap();
 created.auditFloor = (await db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM audit_log').get()).id;
 await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
 baseUrl = `http://127.0.0.1:${server.address().port}`;

 fx.orgA = await ensureOrg(db, { name: 'Settings Practice A', slug: 'settings-a' });
 fx.orgB = await ensureOrg(db, { name: 'Settings Practice B', slug: 'settings-b' });
 created.orgs.push(fx.orgA.id, fx.orgB.id);

 fx.adminA = await mkUser('settings.admin.a@test', fx.orgA.id, 'admin');
 fx.clinicianA = await mkUser('settings.bcba.a@test', fx.orgA.id, 'bcba');
 fx.adminB = await mkUser('settings.admin.b@test', fx.orgB.id, 'admin');
 // The owner's account: the migration sets is_platform_admin from the address.
 fx.owner = await mkUser(PLATFORM_ADMIN_ACCOUNTS[0], fx.orgA.id, 'admin', PLATFORM_ADMIN_ACCOUNTS[0]);
 await backfillOrganizations(db);

 fx.tokenAdminA = await login('settings.admin.a@test');
 fx.tokenClinicianA = await login('settings.bcba.a@test');
 fx.tokenAdminB = await login('settings.admin.b@test');
 fx.tokenOwner = await login(PLATFORM_ADMIN_ACCOUNTS[0]);
});

after(async () => {
 for (const id of created.users) { try { await db.prepare('DELETE FROM users WHERE id=?').run(id); } catch { /* gone */ } }
 for (const id of created.orgs) { try { await db.prepare('DELETE FROM organizations WHERE id=?').run(id); } catch { /* gone */ } }
 if (created.auditFloor) { try { await db.prepare('DELETE FROM audit_log WHERE id > ?').run(created.auditFloor); } catch { /* gone */ } }
 server?.close();
});

// ---------------------------------------------------------------------------
// 1. validation is pure and mirrors the CLI's normalization
// ---------------------------------------------------------------------------
test('validation: phone/fax normalized for print, NPI kept as 10 digits, name required', () => {
 assert.equal(normalizePhone('(757) 544 9140'), '757-544-9140');
 assert.equal(normalizePhone('17575449140'), '757-544-9140');
 assert.equal(normalizePhone('555-1234'), null);
 assert.equal(normalizeNpi('1396347340'), '1396347340');
 assert.equal(normalizeNpi('139-634-734'), null);

 const ok = validateOrgSettings({
  name: '  Pederec Inc  ', address_line: '2002 Orange Rd', address_line2: 'Suite 106',
  city: 'Culpeper', state: 'VA', postal_code: '22701',
  phone: '7575449140', fax: '757-935-0240', npi: '139-634-7340',
 });
 assert.equal(ok.error, undefined);
 assert.equal(ok.values.name, 'Pederec Inc', 'whitespace trimmed');
 assert.equal(ok.values.phone, '757-544-9140', 'phone printed in US form');
 assert.equal(ok.values.npi, '1396347340', 'NPI digits only');

 assert.match(validateOrgSettings({ name: '' }).error, /name is required/i);
 assert.match(validateOrgSettings({ name: 'X', phone: '555-1234' }).error, /10-digit US number/i);
 assert.match(validateOrgSettings({ name: 'X', npi: '123' }).error, /exactly 10 digits/i);
 assert.match(validateOrgSettings({ name: 'X'.repeat(201) }).error, /200 characters or fewer/i);

 // A blank field clears it; unchanged fields are not reported as changed.
 const before = { name: 'A', city: 'Culpeper', phone: '757-544-9140' };
 const changed = changedOrgFields(before, { ...before, city: '' });
 assert.deepEqual(changed, { city: { before: 'Culpeper', after: '' } });
});

// ---------------------------------------------------------------------------
// 2. an organization admin reads their own organization and its people
// ---------------------------------------------------------------------------
test('org admin: GET returns own organization, its letterhead and only its members', async () => {
 const r = await api(fx.tokenAdminA, 'GET', '/api/organization');
 assert.equal(r.status, 200);
 assert.equal(r.json.organization.id, Number(fx.orgA.id));
 assert.equal(r.json.organization.slug, 'settings-a');
 assert.equal(r.json.can_edit, true);
 const usernames = r.json.users.map((u) => u.username);
 assert.ok(usernames.includes('settings.admin.a@test'), 'own admin listed');
 assert.ok(usernames.includes('settings.bcba.a@test'), 'own clinician listed');
 assert.ok(!usernames.includes('settings.admin.b@test'), 'another organization\'s admin is never listed');
 assert.deepEqual(r.json.organizations.map((o) => o.id), [Number(fx.orgA.id)], 'no organization picker for an org admin');
});

test('non-admin clinician: may read their own organization but not edit it, and sees no member list', async () => {
 const r = await api(fx.tokenClinicianA, 'GET', '/api/organization');
 assert.equal(r.status, 200);
 assert.equal(r.json.organization.id, Number(fx.orgA.id));
 assert.equal(r.json.can_edit, false);
 assert.deepEqual(r.json.users, [], 'the member list is the admin\'s');

 const w = await api(fx.tokenClinicianA, 'PUT', `/api/organization/${fx.orgA.id}`, { name: 'Hijacked Practice' });
 assert.equal(w.status, 403, 'a clinician cannot edit organization settings');
 assert.equal((await row('organizations', fx.orgA.id)).name, 'Settings Practice A', 'nothing changed');
});

// ---------------------------------------------------------------------------
// 3. no cross-organization reads or writes — 404, never 403
// ---------------------------------------------------------------------------
test('org admin A cannot read or write organization B: 404 and no change', async () => {
 const read = await api(fx.tokenAdminA, 'GET', `/api/organization?org_id=${fx.orgB.id}`);
 assert.equal(read.status, 404, 'another organization is indistinguishable from a missing one');

 const write = await api(fx.tokenAdminA, 'PUT', `/api/organization/${fx.orgB.id}`, { name: 'Taken Over' });
 assert.equal(write.status, 404);
 assert.equal((await row('organizations', fx.orgB.id)).name, 'Settings Practice B', 'nothing changed');
 assert.equal((await row('organizations', fx.orgB.id)).phone, null, 'no field was written');

 const missing = await api(fx.tokenAdminA, 'PUT', '/api/organization/999999', { name: 'Ghost' });
 assert.equal(missing.status, 404);
});

// ---------------------------------------------------------------------------
// 4. an admin edits their own organization: stored, audited, on the letterhead
// ---------------------------------------------------------------------------
test('org admin saves their own letterhead: fields stored, audit entry written, letterhead rendered', async () => {
 const body = {
  name: 'Settings Practice A', address_line: '2002 Orange Rd', address_line2: 'Suite 106',
  city: 'Culpeper', state: 'VA', postal_code: '22701',
  phone: '(757) 544 9140', fax: '757-935-0240', npi: '139-634-7340', credential_line: 'LBA #1234',
 };
 const r = await api(fx.tokenAdminA, 'PUT', `/api/organization/${fx.orgA.id}`, body);
 assert.equal(r.status, 200, JSON.stringify(r.json));
 assert.deepEqual([...r.json.changed].sort(), ['address_line', 'address_line2', 'city', 'credential_line', 'fax', 'npi', 'phone', 'postal_code', 'state'].sort());
 assert.equal(r.json.organization.phone, '757-544-9140', 'phone normalized for print');
 assert.equal(r.json.organization.npi, '1396347340');

 const stored = await row('organizations', fx.orgA.id);
 assert.equal(stored.address_line, '2002 Orange Rd');
 assert.equal(stored.city, 'Culpeper');
 assert.equal(stored.fax, '757-935-0240');
 assert.equal(stored.credential_line, 'LBA #1234');

 // The letterhead the documents print is built from the stored row.
 const lines = buildLetterhead(stored).lines;
 assert.ok(lines.includes('2002 Orange Rd, Suite 106'), `street line: ${JSON.stringify(lines)}`);
 assert.ok(lines.includes('Culpeper, VA 22701'), `city line: ${JSON.stringify(lines)}`);
 assert.ok(lines.some((l) => l.includes('Phone 757-544-9140') && l.includes('NPI 1396347340')), `contact line: ${JSON.stringify(lines)}`);
 assert.deepEqual(r.json.organization.letterhead.lines, lines, 'the response carries the same letterhead');

 const audit = await db.prepare(
  "SELECT * FROM audit_log WHERE action='organization_settings_updated' AND org_id=? ORDER BY id DESC LIMIT 1",
 ).get(fx.orgA.id);
 assert.ok(audit, 'the write is in the audit log');
 assert.equal(audit.actor, 'settings.admin.a@test');
 const details = JSON.parse(audit.details);
 assert.equal(details.organization_id, Number(fx.orgA.id));
 assert.equal(details.changed.city.after, 'Culpeper');
});

test('saving again with no change writes nothing (no UPDATE, no audit row)', async () => {
 const before = (await db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM audit_log').get()).id;
 const current = await row('organizations', fx.orgA.id);
 const r = await api(fx.tokenAdminA, 'PUT', `/api/organization/${fx.orgA.id}`, {
  name: current.name, address_line: current.address_line, address_line2: current.address_line2,
  city: current.city, state: current.state, postal_code: current.postal_code,
  phone: current.phone, fax: current.fax, npi: current.npi, credential_line: current.credential_line,
 });
 assert.equal(r.status, 200);
 assert.deepEqual(r.json.changed, [], 'nothing changed');
 const after = (await db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM audit_log').get()).id;
 assert.equal(after, before, 'no audit row for a no-op save');
});

test('a rejected save leaves the stored organization untouched', async () => {
 const before = await row('organizations', fx.orgA.id);
 const bad = await api(fx.tokenAdminA, 'PUT', `/api/organization/${fx.orgA.id}`, { name: 'Renamed', phone: '555-1234' });
 assert.equal(bad.status, 400);
 assert.match(bad.json.error, /10-digit US number/i);
 const after = await row('organizations', fx.orgA.id);
 assert.deepEqual(after, before, 'nothing was written');
});

test('clearing a field removes it from the letterhead', async () => {
 const current = await row('organizations', fx.orgA.id);
 const r = await api(fx.tokenAdminA, 'PUT', `/api/organization/${fx.orgA.id}`, {
  name: current.name, address_line: current.address_line, address_line2: '',
  city: current.city, state: current.state, postal_code: current.postal_code,
  phone: current.phone, fax: '', npi: current.npi, credential_line: '',
 });
 assert.equal(r.status, 200);
 assert.deepEqual([...r.json.changed].sort(), ['address_line2', 'credential_line', 'fax']);
 assert.ok(!r.json.organization.letterhead.lines.some((l) => l.includes('Suite 106')), 'cleared suite is gone');
 assert.ok(r.json.organization.letterhead.lines.some((l) => l.includes('Phone 757-544-9140')), 'the rest of the letterhead is intact');
});

// ---------------------------------------------------------------------------
// 5. the platform admin may pick which organization to edit
// ---------------------------------------------------------------------------
test('platform admin: sees every organization, reads and edits another one, audited to that organization', async () => {
 const list = await api(fx.tokenOwner, 'GET', '/api/organization');
 assert.equal(list.status, 200);
 assert.equal(list.json.organization.id, Number(fx.orgA.id), 'own organization by default');
 const pickable = list.json.organizations.map((o) => o.id);
 assert.ok(pickable.includes(Number(fx.orgA.id)) && pickable.includes(Number(fx.orgB.id)), 'both organizations are offered');

 const other = await api(fx.tokenOwner, 'GET', `/api/organization?org_id=${fx.orgB.id}`);
 assert.equal(other.status, 200);
 assert.equal(other.json.organization.slug, 'settings-b');
 assert.ok(other.json.users.some((u) => u.username === 'settings.admin.b@test'), 'organization B members listed');
 assert.ok(!other.json.users.some((u) => u.username === 'settings.bcba.a@test'), 'organization A members are not');

 const write = await api(fx.tokenOwner, 'PUT', `/api/organization/${fx.orgB.id}`, {
  name: 'Settings Practice B', city: 'Richmond', state: 'VA', phone: '804-555-0142',
 });
 assert.equal(write.status, 200, JSON.stringify(write.json));
 assert.equal((await row('organizations', fx.orgB.id)).city, 'Richmond');

 const audit = await db.prepare(
  "SELECT * FROM audit_log WHERE action='organization_settings_updated' AND org_id=? ORDER BY id DESC LIMIT 1",
 ).get(fx.orgB.id);
 assert.ok(audit, 'the platform admin\'s write is attributed to organization B');
 assert.equal(audit.actor, PLATFORM_ADMIN_ACCOUNTS[0]);

 // Organization B's own admin sees that change (it is their organization).
 const seenByB = await api(fx.tokenAdminB, 'GET', '/api/organization');
 assert.equal(seenByB.json.organization.city, 'Richmond');
});

test('unauthenticated callers cannot reach organization settings', async () => {
 const res = await fetch(`${baseUrl}/api/organization`);
 assert.equal(res.status, 401);
});
