// ClearPathFBA — formal cryptographic e-signature layer (Ed25519).
// Replaces the "typed-name only" sign-off record with a verifiable digital
// signature over the exact document payload the export builders produce.
//
// Design:
//  * One signing key PER ORGANIZATION, lazily generated on first use and
//    persisted in `signing_keys`:
//      - private key: `signing_keys.private_key_pem`, mirrored to a PEM file
//        under data/keys/ (mode 0600; data/ is gitignored) for local dev
//      - public key + fingerprint: the same row
//    The organization is the one the *client* belongs to (orgIdForAssessment in
//    org.js) — never the caller's own, so a platform admin signing another
//    practice's document still signs with that practice's key.
//  * A row with org_id NULL is the single pre-scoping ("legacy") key that
//    signed every document before pass 2. Nothing ever deletes it or rewrites
//    its fingerprint, and verification looks a key up by the fingerprint
//    recorded on the sign_off row (never by organization), so documents signed
//    under the old key keep verifying as valid — including through the
//    unauthenticated verification endpoint.
//  * A signature covers the SHA-256 digest of the canonical (deterministic,
//    key-sorted) JSON of the document payload, suffixed with the document_type.
//    Volatile/derived fields (generated_at, the signature scaffold, and the
//    sign_offs records themselves) are excluded so the digest is stable for
//    unchanged clinical content: signing then verifying the same assessment
//    yields valid:true, and any edit to the assessment flips it to
//    valid:false / tampered:true.
//  * The private key is never exposed: keyInfo()/signOffOut() only ever return
//    the public fingerprint.
//
// Backend note: the exported functions return plain values in SQLite mode
// (synchronous db) and Promises in Postgres mode (async db). Call sites use
// `await`, which works for both. ensureSigningKey()/keyInfo() are also used
// synchronously by server/tests/signature.test.mjs, so their SQLite-mode
// return values stay synchronous.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import db from './db.js';

export const SIGNATURE_ALGO = 'Ed25519';

const KEYS_DIR = process.env.SIGNING_KEYS_DIR || path.resolve('data', 'keys');
// The pre-scoping key file. Kept under its historical name and path so an
// existing deployment finds it; it belongs to the legacy (org_id NULL) key.
const LEGACY_KEY_FILE = process.env.SIGNING_KEY_FILE || path.join(KEYS_DIR, 'signing.pem');

// In-process caches so repeated calls reuse a loaded key without re-reading.
// Keyed per organization ('legacy' for the pre-scoping key).
const keyCache = new Map();
// In-flight dedupe for the Postgres path (two concurrent first-time calls for
// the same organization must not both try to INSERT its key row).
const keyInFlight = new Map();

/** '3' / 3 -> 3; null / '' / anything invalid -> null (the legacy key). */
function normalizeOrgId(orgId) {
 if (orgId === null || orgId === undefined || orgId === '') return null;
 const n = Number(orgId);
 return Number.isInteger(n) && n > 0 ? n : null;
}

const cacheKeyFor = (orgId) => (orgId == null ? 'legacy' : `org:${orgId}`);

/** PEM file for one organization's key (the legacy file for org_id NULL). */
const pemFileFor = (orgId) => (orgId == null ? LEGACY_KEY_FILE : path.join(KEYS_DIR, `org-${orgId}.pem`));

/** The newest key row for an organization (org_id NULL = the legacy key). */
const keyRowSql = (orgId) => (orgId == null
 ? 'SELECT * FROM signing_keys WHERE org_id IS NULL ORDER BY id DESC LIMIT 1'
 : 'SELECT * FROM signing_keys WHERE org_id = ? ORDER BY id DESC LIMIT 1');
const keyRowParams = (orgId) => (orgId == null ? [] : [orgId]);

function readPrivatePem(file) {
 try {
  if (!fs.existsSync(file)) return null;
  const pem = fs.readFileSync(file, 'utf8');
  crypto.createPrivateKey(pem); // validates the PEM
  return pem;
 } catch {
  return null;
 }
}

/**
 * Mirror the private key to its PEM file (mode 0600) for local dev. Best
 * effort: the database copy is authoritative, and a serverless instance's disk
 * may be read-only or gone on the next request.
 */
function writePrivatePem(file, pem) {
 try {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, pem, { mode: 0o600 });
  return true;
 } catch {
  return false;
 }
}

function newKeyMaterial() {
 const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
 const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
 const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
 return { privateKey, publicKeyPem, privatePem, fingerprint: fingerprintForPublicKey(publicKeyPem) };
}

/** The private key stored on a row, if it is readable and matches the row's
 *  recorded public key. A row that fails this is still kept: verification only
 *  needs its public key. */
function recoverStoredKey(row) {
 if (!row || !row.private_key_pem) return null;
 try {
  const rec = keyRecordFrom(row.private_key_pem);
  if (rec.fingerprint !== row.fingerprint) return null;
  return { ...rec, privatePem: row.private_key_pem, created_at: row.created_at };
 } catch {
  return null;
 }
}

/**
 * Decide what to do with the stored row plus whatever private material is on
 * disk, without touching the database — the two backends only differ in how
 * they execute the returned plan:
 *   { record, insert: false }            private material matches the stored row
 *   { record, backfillRowId }            key recovered from the PEM file: keep
 *                                        the row, store the material on it
 *   { record, insert: true }             no usable material: a new key row
 * The stored fingerprint of an existing row is NEVER rewritten and no row is
 * ever deleted: verification looks a key up by the fingerprint recorded on the
 * sign_off row, so an old signature must always find the public key it was
 * made with.
 */
function planKey(row, filePem) {
 const stored = recoverStoredKey(row);
 if (stored) return { record: stored, insert: false };
 if (filePem) {
  const rec = keyRecordFrom(filePem);
  if (!row) return { record: { ...rec, privatePem: filePem }, insert: true };
  if (rec.fingerprint === row.fingerprint) {
   // Adopt the key: the file is the key this row records, so persist the
   // private material where a diskless instance can still find it.
   return { record: { ...rec, privatePem: filePem, created_at: row.created_at }, backfillRowId: row.id, insert: false };
  }
 }
 return { record: newKeyMaterial(), insert: true };
}

/** Shared body of ensureSigningKey(), parameterized by the row-reader so it can
 *  run against either backend. */
function keyRecordFrom(privatePem) {
 const privateKey = crypto.createPrivateKey(privatePem);
 const publicKeyPem = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
 const fingerprint = fingerprintForPublicKey(publicKeyPem);
 return { privateKey, publicKeyPem, fingerprint };
}

/** SHA-256 of the SPKI DER public key, first 16 hex chars. */
export function fingerprintForPublicKey(publicKeyPem) {
 const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
 return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}

/**
 * Deterministic JSON: keys sorted recursively. Arrays keep order (data points
 * are ordered content), object keys are sorted so identical documents produce
 * identical bytes regardless of insertion order.
 */
export function canonicalStringify(value) {
 const sort = (v) => {
  if (Array.isArray(v)) return v.map(sort);
  if (v && typeof v === 'object') {
   const out = {};
   for (const k of Object.keys(v).sort()) out[k] = sort(v[k]);
   return out;
  }
  return v;
 };
 return JSON.stringify(sort(value));
}

/**
 * Fields that must not influence the digest: generated_at is a per-call
 * timestamp, and signatures/sign_offs are workflow records about the document
 * (the sign_offs array would otherwise change the instant this row flips to
 * 'signed'). `letterhead` is excluded for the same reason plus one more: it is
 * the *provider's* identity (resolved from organizations at render time), not
 * clinical content, and it can legitimately change when an organization renames
 * itself — a rename must not turn every previously signed record into
 * "tampered". Everything else — client, assessment, behaviors, data, hypotheses,
 * strategies — is signed content.
 */
export function digestPayload(payload) {
 const clone = { ...payload };
 delete clone.generated_at;
 delete clone.signatures;
 delete clone.sign_offs;
 delete clone.letterhead;
 return clone;
}

/**
 * SHA-256 digest over canonical JSON of the (normalized) document payload,
 * suffixed with the document_type. Hex string.
 */
export function digestFor(payload, documentType) {
 const canonical = canonicalStringify(digestPayload(payload));
 return crypto.createHash('sha256').update(canonical).update(String(documentType)).digest('hex');
}

/** Sign the 32-byte digest with the org Ed25519 key. Returns base64. */
export function signDigest(digestHex, privateKey) {
 const sig = crypto.sign(null, Buffer.from(digestHex, 'hex'), privateKey);
 return sig.toString('base64');
}

/** Verify a base64 Ed25519 signature over the digest with the public PEM. */
export function verifyDigest(digestHex, signatureB64, publicKeyPem) {
 if (!digestHex || !signatureB64 || !publicKeyPem) return false;
 try {
  return crypto.verify(
   null,
   Buffer.from(String(digestHex), 'hex'),
   crypto.createPublicKey(publicKeyPem),
   Buffer.from(String(signatureB64), 'base64'),
  );
 } catch {
  return false;
 }
}

/** Ensure an organization's signing key exists and is loaded. Idempotent.
 *  `orgId` null/undefined addresses the pre-scoping legacy key. */
export function ensureSigningKey(orgId) {
 const id = normalizeOrgId(orgId);
 const ck = cacheKeyFor(id);
 if (keyCache.has(ck)) return keyCache.get(ck);
 if (db.mode === 'sqlite') {
  const key = ensureSqlite(id);
  keyCache.set(ck, key);
  return key;
 }
 if (!keyInFlight.has(ck)) {
  keyInFlight.set(ck, ensurePostgres(id)
   .then((key) => { keyCache.set(ck, key); keyInFlight.delete(ck); return key; })
   .catch((err) => { keyInFlight.delete(ck); throw err; }));
 }
 return keyInFlight.get(ck);
}

function ensureSqlite(orgId) {
 const row = db.prepare(keyRowSql(orgId)).get(...keyRowParams(orgId));
 const plan = planKey(row, readPrivatePem(pemFileFor(orgId)));
 if (plan.backfillRowId != null) {
  db.prepare('UPDATE signing_keys SET private_key_pem = ? WHERE id = ?').run(plan.record.privatePem, plan.backfillRowId);
 }
 if (!plan.insert) return plan.record;
 return insertSqlite(orgId, plan.record);
}

function insertSqlite(orgId, record) {
 writePrivatePem(pemFileFor(orgId), record.privatePem);
 const info = db.prepare('INSERT INTO signing_keys (org_id, fingerprint, public_key_pem, private_key_pem) VALUES (?, ?, ?, ?)')
  .run(orgId, record.fingerprint, record.publicKeyPem, record.privatePem);
 const created = db.prepare('SELECT * FROM signing_keys WHERE id = ?').get(info.lastInsertRowid);
 return { ...record, created_at: created.created_at };
}

async function ensurePostgres(orgId) {
 const row = await db.prepare(keyRowSql(orgId)).get(...keyRowParams(orgId));
 const plan = planKey(row, readPrivatePem(pemFileFor(orgId)));
 if (plan.backfillRowId != null) {
  await db.prepare('UPDATE signing_keys SET private_key_pem = ? WHERE id = ?').run(plan.record.privatePem, plan.backfillRowId);
 }
 if (!plan.insert) return plan.record;
 return await insertPostgres(orgId, plan.record);
}

async function insertPostgres(orgId, record) {
 writePrivatePem(pemFileFor(orgId), record.privatePem);
 const info = await db.prepare('INSERT INTO signing_keys (org_id, fingerprint, public_key_pem, private_key_pem) VALUES (?, ?, ?, ?)')
  .run(orgId, record.fingerprint, record.publicKeyPem, record.privatePem);
 const created = await db.prepare('SELECT * FROM signing_keys WHERE id = ?').get(info.lastInsertRowid);
 return { ...record, created_at: created.created_at };
}

/** Public key info only — never the private key. */
export function keyInfo(orgId) {
 const k = ensureSigningKey(orgId);
 if (k && typeof k.then === 'function') return k.then((kk) => ({ fingerprint: kk.fingerprint, public_key_pem: kk.publicKeyPem, created_at: kk.created_at }));
 return { fingerprint: k.fingerprint, public_key_pem: k.publicKeyPem, created_at: k.created_at };
}

/**
 * Sign one document payload with the key of the organization the document
 * belongs to (`orgId`, resolved from the client — see orgIdForAssessment in
 * org.js). Returns the digest + base64 signature + fingerprint needed to
 * persist on the sign_offs row.
 * Value in SQLite mode, promise in Postgres mode.
 */
export function signDocument(payload, documentType, orgId) {
 const key = ensureSigningKey(orgId);
 if (key && typeof key.then === 'function') return key.then((k) => finishSign(payload, documentType, k));
 return finishSign(payload, documentType, key);
}
function finishSign(payload, documentType, key) {
 const digest = digestFor(payload, documentType);
 const signature = signDigest(digest, key.privateKey);
 return { digest, signature, fingerprint: key.fingerprint };
}

/**
 * Verify a stored signature against BOTH the recorded digest (cryptographic
 * check) and the current state of the document (content check).
 * stored = { digest, signature, fingerprint } as persisted on sign_offs.
 * Returns { valid, tampered, sig_valid, digest_matches }.
 *  - valid          = signature verifies AND document content is unchanged.
 *  - tampered       = the current document content no longer matches what was
 *                     signed (or the stored digest/signature were altered).
 *  - digest_matches = recomputed digest equals the stored digest.
 * Value in SQLite mode, promise in Postgres mode.
 */
export function verifyDocument(payload, documentType, stored) {
 const storedDigest = stored && stored.digest ? String(stored.digest) : null;
 const digestMatches = !!storedDigest && digestFor(payload, documentType) === storedDigest;
 const row = stored && stored.fingerprint
  ? db.prepare('SELECT public_key_pem FROM signing_keys WHERE fingerprint = ?').get(String(stored.fingerprint))
  : null;
 if (row && typeof row.then === 'function') return row.then((r) => finishVerify(storedDigest, digestMatches, stored, r));
 return finishVerify(storedDigest, digestMatches, stored, row);
}
function finishVerify(storedDigest, digestMatches, stored, keyRow) {
 const sigValid = !!storedDigest && !!keyRow && verifyDigest(storedDigest, stored.signature, keyRow.public_key_pem);
 return { valid: sigValid && digestMatches, tampered: !digestMatches, sig_valid: sigValid, digest_matches: digestMatches };
}
