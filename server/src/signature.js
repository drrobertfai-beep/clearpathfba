// ClearPathFBA — formal cryptographic e-signature layer (Ed25519).
// Replaces the "typed-name only" sign-off record with a verifiable digital
// signature over the exact document payload the export builders produce.
//
// Design:
//  * One organization signing key, lazily generated on first use and persisted:
//      - private key: PEM file at data/keys/signing.pem (mode 0600; data/ is
//        gitignored, so the key never leaves this machine via git)
//      - public key + fingerprint: signing_keys table
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
const KEY_FILE = process.env.SIGNING_KEY_FILE || path.join(KEYS_DIR, 'signing.pem');

// In-process cache so repeated calls reuse the loaded key without re-reading.
let cached = null;
// In-flight dedupe for the Postgres path (two concurrent first-time calls
// must not both try to INSERT the key row).
let keyPromise = null;

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
 * 'signed'). Everything else — client, assessment, behaviors, data, hypotheses,
 * strategies — is signed content.
 */
export function digestPayload(payload) {
 const clone = { ...payload };
 delete clone.generated_at;
 delete clone.signatures;
 delete clone.sign_offs;
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

/**
 * Shared body of ensureSigningKey(), parameterized by the row-reader so it can
 * run against either backend. All db access goes through `dbRow` (a function
 * returning the first signing_keys row — a value in SQLite mode, a promise in
 * Postgres mode).
 */
function keyRecordFrom(privatePem) {
 const privateKey = crypto.createPrivateKey(privatePem);
 const publicKeyPem = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
 const fingerprint = fingerprintForPublicKey(publicKeyPem);
 return { privateKey, publicKeyPem, fingerprint };
}

/** Ensure the org signing key exists and is loaded. Idempotent. */
export function ensureSigningKey() {
 if (cached) return cached;
 if (db.mode === 'sqlite') return ensureSqlite();
 if (!keyPromise) {
  keyPromise = ensurePostgres().then((k) => { cached = k; return k; }).catch((err) => { keyPromise = null; throw err; });
 }
 return keyPromise;
}

function ensureSqlite() {
 const fileExists = fs.existsSync(KEY_FILE);
 const row = db.prepare('SELECT * FROM signing_keys ORDER BY id LIMIT 1').get();
 let privatePem = null;
 if (fileExists) {
  try {
   privatePem = fs.readFileSync(KEY_FILE, 'utf8');
   crypto.createPrivateKey(privatePem); // validates the PEM
  } catch {
   privatePem = null;
  }
 }
 if (privatePem && row) {
  const rec = keyRecordFrom(privatePem);
  if (row.fingerprint !== rec.fingerprint || row.public_key_pem !== rec.publicKeyPem) {
   db.prepare('UPDATE signing_keys SET fingerprint = ?, public_key_pem = ?, created_at = COALESCE(created_at, CURRENT_TIMESTAMP) WHERE id = ?')
    .run(rec.fingerprint, rec.publicKeyPem, row.id);
  }
  cached = { ...rec, created_at: row.created_at };
  return cached;
 }
 if (privatePem && !row) {
  // Recover the public key from the private key and record it.
  const rec = keyRecordFrom(privatePem);
  const info = db.prepare('INSERT INTO signing_keys (fingerprint, public_key_pem) VALUES (?, ?)').run(rec.fingerprint, rec.publicKeyPem);
  const created = db.prepare('SELECT * FROM signing_keys WHERE id = ?').get(info.lastInsertRowid);
  cached = { ...rec, created_at: created.created_at };
  return cached;
 }
 // Fresh generation (or corrupt state: regenerate both stores).
 const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
 const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
 privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
 const fingerprint = fingerprintForPublicKey(publicKeyPem);
 fs.mkdirSync(KEYS_DIR, { recursive: true });
 fs.writeFileSync(KEY_FILE, privatePem, { mode: 0o600 });
 if (row) db.prepare('DELETE FROM signing_keys WHERE id = ?').run(row.id);
 const info = db.prepare('INSERT INTO signing_keys (fingerprint, public_key_pem) VALUES (?, ?)').run(fingerprint, publicKeyPem);
 const created = db.prepare('SELECT * FROM signing_keys WHERE id = ?').get(info.lastInsertRowid);
 cached = { privateKey, publicKeyPem, fingerprint, created_at: created.created_at };
 return cached;
}

async function ensurePostgres() {
 const fileExists = fs.existsSync(KEY_FILE);
 const row = await db.prepare('SELECT * FROM signing_keys ORDER BY id LIMIT 1').get();
 let privatePem = null;
 if (fileExists) {
  try {
   privatePem = fs.readFileSync(KEY_FILE, 'utf8');
   crypto.createPrivateKey(privatePem); // validates the PEM
  } catch {
   privatePem = null;
  }
 }
 if (privatePem && row) {
  const rec = keyRecordFrom(privatePem);
  if (row.fingerprint !== rec.fingerprint || row.public_key_pem !== rec.publicKeyPem) {
   await db.prepare('UPDATE signing_keys SET fingerprint = ?, public_key_pem = ?, created_at = COALESCE(created_at, CURRENT_TIMESTAMP) WHERE id = ?')
    .run(rec.fingerprint, rec.publicKeyPem, row.id);
  }
  cached = { ...rec, created_at: row.created_at };
  return cached;
 }
 if (privatePem && !row) {
  // Recover the public key from the private key and record it.
  const rec = keyRecordFrom(privatePem);
  const info = await db.prepare('INSERT INTO signing_keys (fingerprint, public_key_pem) VALUES (?, ?)').run(rec.fingerprint, rec.publicKeyPem);
  const created = await db.prepare('SELECT * FROM signing_keys WHERE id = ?').get(info.lastInsertRowid);
  cached = { ...rec, created_at: created.created_at };
  return cached;
 }
 // Fresh generation (or corrupt state: regenerate both stores).
 const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
 const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
 privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
 const fingerprint = fingerprintForPublicKey(publicKeyPem);
 fs.mkdirSync(KEYS_DIR, { recursive: true });
 fs.writeFileSync(KEY_FILE, privatePem, { mode: 0o600 });
 if (row) await db.prepare('DELETE FROM signing_keys WHERE id = ?').run(row.id);
 const info = await db.prepare('INSERT INTO signing_keys (fingerprint, public_key_pem) VALUES (?, ?)').run(fingerprint, publicKeyPem);
 const created = await db.prepare('SELECT * FROM signing_keys WHERE id = ?').get(info.lastInsertRowid);
 cached = { privateKey, publicKeyPem, fingerprint, created_at: created.created_at };
 return cached;
}

/** Public key info only — never the private key. */
export function keyInfo() {
 const k = ensureSigningKey();
 if (k && typeof k.then === 'function') return k.then((kk) => ({ fingerprint: kk.fingerprint, public_key_pem: kk.publicKeyPem, created_at: kk.created_at }));
 return { fingerprint: k.fingerprint, public_key_pem: k.publicKeyPem, created_at: k.created_at };
}

/**
 * Sign one document payload. Returns the digest + base64 signature +
 * fingerprint needed to persist on the sign_offs row.
 * Value in SQLite mode, promise in Postgres mode.
 */
export function signDocument(payload, documentType) {
 const key = ensureSigningKey();
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
