// ClearPathFBA — e-signature layer tests (node --test).
// Isolated from the dev database: a temp sqlite file + temp keys dir are
// created before the modules are imported, so tests never touch dev data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATABASE_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'cpf-sig-db-')), 'test.sqlite');
process.env.SIGNING_KEYS_DIR = mkdtempSync(path.join(tmpdir(), 'cpf-sig-keys-'));
process.env.SIGNING_KEY_FILE = path.join(process.env.SIGNING_KEYS_DIR, 'signing.pem');

const { ensureSigningKey, keyInfo, signDocument, verifyDocument, digestFor, canonicalStringify, fingerprintForPublicKey, SIGNATURE_ALGO } = await import('../src/signature.js');
const db = (await import('../src/db.js')).default;

// A representative report-style payload (like buildReport produces), with the
// volatile fields the digest layer is expected to normalize away.
function samplePayload() {
 return {
  client: { id: 1, first_name: 'Alex', last_name: 'Sample', date_of_birth: '2015-03-02' },
  assessment: { id: 9, title: 'FBA — sample', status: 'completed' },
  behaviors: [
   { id: 1, name: 'Screaming', operational_definition: 'Vocalizations above conversational level', safety_classification: 'none' },
   { id: 2, name: 'Aggression', operational_definition: 'Hitting others with open hand', safety_classification: 'aggression', is_safety_concern: true },
  ],
  data_summary: { total_points: 4, per_behavior: [{ target_behavior_id: 1, count: 3 }, { target_behavior_id: 2, count: 1 }] },
  abc: [{ target_behavior_id: 1, top_antecedents: [{ code: 'demand_task', count: 3 }], top_consequences: [{ code: 'escape_removed_demand', count: 3 }] }],
  hypotheses: [{ target_behavior_id: 1, function: 'escape', confidence: 0.75 }],
  signatures: [{ role: 'BCBA / Behavior Analyst', role_code: 'bcba' }],
  sign_offs: [{ id: 5, signatory_role: 'bcba', status: 'signed', signature: 'Sam Rivera, BCBA', signed_at: '2026-08-08T12:00:00.000Z' }],
  generated_at: new Date().toISOString(), // volatile — must not affect the digest
  is_preliminary: false,
 };
}

test('canonical stringify is key-sorted and deterministic', () => {
 const a = { b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } };
 const b = { a: { c: [3, { e: 2, f: 1 }], d: 2 }, b: 1 };
 assert.equal(canonicalStringify(a), canonicalStringify(b));
 assert.equal(canonicalStringify(a), JSON.stringify({ a: { c: [3, { e: 2, f: 1 }], d: 2 }, b: 1 }));
});

test('digest excludes volatile fields (generated_at, signatures, sign_offs)', () => {
 const p1 = samplePayload();
 const p2 = samplePayload();
 // Different generated_at and a now-signed sign_offs row must not change the digest.
 p2.generated_at = new Date(Date.now() + 60000).toISOString();
 p2.sign_offs[0].status = 'pending';
 p2.signatures = [{ role: 'BCBA / Behavior Analyst', role_code: 'bcba', fields: ['Signature'] }];
 assert.equal(digestFor(p1, 'fba_report'), digestFor(p2, 'fba_report'));
 // …but clinical content changes must.
 p2.behaviors[0].name = 'Renamed behavior';
 assert.notEqual(digestFor(p1, 'fba_report'), digestFor(p2, 'fba_report'));
 // Document type participates in the digest.
 assert.notEqual(digestFor(p1, 'fba_report'), digestFor(p1, 'bip'));
});

test('roundtrip: sign then verify is valid, key is Ed25519', () => {
 const key = ensureSigningKey();
 assert.equal(key.publicKeyPem.includes('BEGIN PUBLIC KEY'), true);
 const signed = signDocument(samplePayload(), 'fba_report');
 assert.equal(signed.digest.length, 64); // SHA-256 hex
 assert.equal(typeof signed.signature, 'string');
 assert.ok(signed.signature.length > 0);
 const v = verifyDocument(samplePayload(), 'fba_report', { digest: signed.digest, signature: signed.signature, fingerprint: signed.fingerprint });
 assert.equal(v.valid, true);
 assert.equal(v.tampered, false);
 assert.equal(v.digest_matches, true);
 assert.equal(signed.fingerprint, keyInfo().fingerprint);
 assert.equal(signed.fingerprint.length, 16);
});

test('tamper detection: content change -> invalid + tampered', () => {
 const signed = signDocument(samplePayload(), 'fba_report');
 const tampered = samplePayload();
 tampered.assessment.title = 'FBA — EDITED AFTER SIGNING';
 const v = verifyDocument(tampered, 'fba_report', { digest: signed.digest, signature: signed.signature, fingerprint: signed.fingerprint });
 assert.equal(v.valid, false);
 assert.equal(v.tampered, true);
 assert.equal(v.digest_matches, false);
});

test('tamper detection: stored digest mutated -> invalid + tampered', () => {
 const signed = signDocument(samplePayload(), 'fba_report');
 const badDigest = 'f'.repeat(64);
 const v = verifyDocument(samplePayload(), 'fba_report', { digest: badDigest, signature: signed.signature, fingerprint: signed.fingerprint });
 assert.equal(v.valid, false);
 assert.equal(v.tampered, true);
 assert.equal(v.sig_valid, false);
});

test('tamper detection: signature bytes mutated -> invalid', () => {
 const signed = signDocument(samplePayload(), 'fba_report');
 const corrupted = signed.signature.slice(0, -4) + 'AAAA';
 const v = verifyDocument(samplePayload(), 'fba_report', { digest: signed.digest, signature: corrupted, fingerprint: signed.fingerprint });
 assert.equal(v.valid, false);
 // Content is unchanged, so this is a corrupted signature record, not a
 // modified document: digest_matches stays true.
 assert.equal(v.digest_matches, true);
 assert.equal(v.sig_valid, false);
});

test('key idempotency: second call reuses the same key', () => {
 const first = ensureSigningKey();
 const second = ensureSigningKey();
 assert.equal(first.fingerprint, second.fingerprint);
 assert.equal(first.publicKeyPem, second.publicKeyPem);
 // The recorded public key in the DB matches and stays unique.
 const rows = db.prepare('SELECT * FROM signing_keys').all();
 assert.equal(rows.length, 1);
 assert.equal(rows[0].fingerprint, first.fingerprint);
 // Fingerprint is SHA-256 of the DER public key, first 16 hex chars.
 assert.equal(fingerprintForPublicKey(first.publicKeyPem), first.fingerprint);
 assert.match(first.fingerprint, /^[0-9a-f]{16}$/);
});

test('key file is persisted with 0600 perms and private key never exposed', () => {
 const info = keyInfo();
 assert.ok(!Object.keys(info).some((k) => k.toLowerCase().includes('private')));
 const pem = readFileSync(process.env.SIGNING_KEY_FILE, 'utf8');
 assert.match(pem, /^-----BEGIN PRIVATE KEY-----/);
 const mode = statSync(process.env.SIGNING_KEY_FILE).mode & 0o777;
 assert.equal(mode, 0o600);
 assert.equal(SIGNATURE_ALGO, 'Ed25519');
});
