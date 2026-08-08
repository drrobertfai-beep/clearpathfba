// ClearPathFBA — dual-mode data layer.
//
// Two backends behind one surface:
//   * SQLite (better-sqlite3, synchronous) — local dev / tests. Selected when
//     DATABASE_URL is NOT set. Byte-for-byte the historical schema + guarded
//     ALTER migrations; `prepare().get()/all()/run()` return plain values.
//   * PostgreSQL (pg, asynchronous) — production/serverless. Selected when
//     DATABASE_URL IS set. Same schema (same table/column names, same
//     unique/foreign-key intent) with Postgres types: TEXT, INTEGER, DOUBLE
//     PRECISION (SQLite REAL is an 8-byte double), TIMESTAMPTZ for datetime
//     columns, JSONB where SQLite stored JSON TEXT.
//
// The exported `db` object exposes the same surface in both modes:
//   prepare(sql).get(...) / .all(...) / .run(...)
//   transaction(fn) → async fn
//   exec(sql)
// plus mode helpers:
//   db.mode            'sqlite' | 'postgres'
//   db.ready           promise that resolves once schema is created/migrated
//   db.currentTimestamp SQL literal for "now" in the active dialect
//   db.nowPlus(minutes) SQL expression for now() + N minutes in the active dialect
//   db.orderCi(col)     case-insensitive ORDER BY expression in the active dialect
//
// Call sites should `await` every db call: awaiting a synchronous value is a
// no-op, so one code path works unchanged in both modes. In Postgres mode the
// adapter rewrites `?` placeholders to `$n`, maps rows back to the shapes the
// app already expects (COUNT(*) → Number, timestamps → 'YYYY-MM-DD HH:MM:SS'
// UTC strings like SQLite's CURRENT_TIMESTAMP, JSONB → JSON text, booleans →
// 1/0), appends RETURNING id to plain INSERTs so run().lastInsertRowid works,
// and normalizes unique-violation errors to include 'UNIQUE' (SQLite wording)
// so existing catch handlers keep working.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
// better-sqlite3 is a native module; load it lazily (only in SQLite mode) so
// serverless/Postgres installs that cannot build it still boot cleanly.
const require = createRequire(import.meta.url);
const PG_URL = process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Schema (shared intent; dialect-specific DDL below).
// ---------------------------------------------------------------------------
const migrations = {
 assessments: [
  ['assessor', 'TEXT'],
  ['deleted_at', 'TEXT'],
 ],
 users: [
  ['must_change_password', 'INTEGER NOT NULL DEFAULT 0'],
  ['mfa_secret', 'TEXT'],
  ['mfa_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['email', 'TEXT'],
 ],
 target_behaviors: [
  ['safety_classification', "TEXT NOT NULL DEFAULT 'none'"],
  ['is_safety_concern', 'INTEGER NOT NULL DEFAULT 0'],
  ['baseline_measurement_type', 'TEXT'],
 ],
 sign_offs: [
  ['signature_algo', 'TEXT'],
  ['signature_digest', 'TEXT'],
  ['signature_key_fingerprint', 'TEXT'],
  ['signature_typed', 'TEXT'],
 ],
};

const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS clients (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 first_name TEXT NOT NULL, last_name TEXT NOT NULL, date_of_birth TEXT,
 gender TEXT, consent_status TEXT NOT NULL DEFAULT 'not_started' CHECK (consent_status IN ('not_started','in_progress','obtained','declined')),
 dbhds_flags TEXT NOT NULL DEFAULT '{}', notes TEXT, deleted_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS assessments (
 id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL REFERENCES clients(id), title TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_progress','completed')), assessment_date TEXT,
 assessor TEXT, notes TEXT, deleted_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS target_behaviors (
 id INTEGER PRIMARY KEY AUTOINCREMENT, assessment_id INTEGER NOT NULL REFERENCES assessments(id), name TEXT NOT NULL,
 operational_definition TEXT NOT NULL,
 safety_classification TEXT NOT NULL DEFAULT 'none' CHECK (safety_classification IN ('none','self_injury','aggression','elopement','property_damage','other')),
 is_safety_concern INTEGER NOT NULL DEFAULT 0,
 baseline_measurement_type TEXT CHECK (baseline_measurement_type IN ('frequency','duration','latency')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS data_points (
 id INTEGER PRIMARY KEY AUTOINCREMENT, assessment_id INTEGER NOT NULL REFERENCES assessments(id), target_behavior_id INTEGER REFERENCES target_behaviors(id),
 recorded_at TEXT NOT NULL, setting TEXT, antecedent TEXT, behavior TEXT, consequence TEXT,
 measurement_type TEXT NOT NULL CHECK (measurement_type IN ('frequency','duration','latency')), value REAL NOT NULL,
 notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS function_hypotheses (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 assessment_id INTEGER NOT NULL REFERENCES assessments(id),
 target_behavior_id INTEGER NOT NULL REFERENCES target_behaviors(id),
 function TEXT NOT NULL CHECK (function IN ('escape','attention','tangible','automatic','multiple','undetermined')),
 confidence REAL NOT NULL DEFAULT 0,
 evidence TEXT,
 status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reviewed')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(assessment_id, target_behavior_id)
);
CREATE TABLE IF NOT EXISTS sign_offs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 assessment_id INTEGER NOT NULL REFERENCES assessments(id),
 document_type TEXT NOT NULL CHECK (document_type IN ('fba_report','bip','crisis_plan')),
 signatory_role TEXT NOT NULL CHECK (signatory_role IN ('bcba','guardian','supervisor','other')),
 signatory_name TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','signed')),
 signature TEXT,
 signed_at TEXT,
 signature_algo TEXT,
 signature_digest TEXT,
 signature_key_fingerprint TEXT,
 signature_typed TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(assessment_id, document_type, signatory_role)
);
CREATE TABLE IF NOT EXISTS signing_keys (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 fingerprint TEXT UNIQUE NOT NULL,
 public_key_pem TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 assessment_id INTEGER,
 actor TEXT,
 action TEXT,
 details TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_assessments_client ON assessments(client_id);
CREATE INDEX IF NOT EXISTS idx_data_points_assessment ON data_points(assessment_id);
CREATE INDEX IF NOT EXISTS idx_target_behaviors_assessment ON target_behaviors(assessment_id);
CREATE INDEX IF NOT EXISTS idx_sign_offs_assessment ON sign_offs(assessment_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_assessment ON audit_log(assessment_id);
CREATE TABLE IF NOT EXISTS progress_reports (
 id INTEGER PRIMARY KEY AUTOINCREMENT, assessment_id INTEGER NOT NULL REFERENCES assessments(id),
 period_type TEXT NOT NULL CHECK (period_type IN ('month','quarter')), period TEXT NOT NULL, period_label TEXT NOT NULL,
 start_date TEXT NOT NULL, end_date TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_progress_reports_assessment ON progress_reports(assessment_id);
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK (role IN ('admin','bcba','specialist','staff','supervisor','guardian')), display_name TEXT, email TEXT UNIQUE,
 active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT UNIQUE NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_security (
 username TEXT PRIMARY KEY, failed_count INTEGER NOT NULL DEFAULT 0, locked_until TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS mfa_backup_codes (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), code_hash TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_mfa_backup_user ON mfa_backup_codes(user_id);
    `;

// Postgres mirror of SQLITE_DDL. Type mapping notes:
//  * SERIAL (int4) ids — pg returns int4 as JS numbers, so `b.id === 5` checks
//    in the app keep working (int8/BIGSERIAL would come back as strings).
//  * DOUBLE PRECISION for the two REAL columns: SQLite REAL is an 8-byte IEEE
//    double, which is exactly Postgres DOUBLE PRECISION.
//  * TIMESTAMPTZ for datetime columns (created_at/updated_at/deleted_at/
//    recorded_at/signed_at/used_at/locked_until/expires_at).
//  * Date-only TEXT columns (date_of_birth, assessment_date, progress report
//    start_date/end_date) stay TEXT so values round-trip verbatim.
//  * JSONB for columns that stored JSON text in SQLite (dbhds_flags, evidence,
//    details, payload) — the adapter re-serializes them to JSON text on read,
//    so the app's JSON.parse(...) call sites are unchanged.
//  * now()/CURRENT_TIMESTAMP for timestamps; sessions expire via
//    now() + interval '7 days' (auth.js), lockouts via now() + interval
//    '15 minutes' (index.js).
const PG_DDL = `
CREATE TABLE IF NOT EXISTS clients (
 id SERIAL PRIMARY KEY,
 first_name TEXT NOT NULL, last_name TEXT NOT NULL, date_of_birth TEXT,
 gender TEXT, consent_status TEXT NOT NULL DEFAULT 'not_started' CHECK (consent_status IN ('not_started','in_progress','obtained','declined')),
 dbhds_flags JSONB NOT NULL DEFAULT '{}', notes TEXT, deleted_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS assessments (
 id SERIAL PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id), title TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_progress','completed')), assessment_date TEXT,
 assessor TEXT, notes TEXT, deleted_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS target_behaviors (
 id SERIAL PRIMARY KEY, assessment_id INTEGER NOT NULL REFERENCES assessments(id), name TEXT NOT NULL,
 operational_definition TEXT NOT NULL,
 safety_classification TEXT NOT NULL DEFAULT 'none' CHECK (safety_classification IN ('none','self_injury','aggression','elopement','property_damage','other')),
 is_safety_concern INTEGER NOT NULL DEFAULT 0,
 baseline_measurement_type TEXT CHECK (baseline_measurement_type IN ('frequency','duration','latency')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS data_points (
 id SERIAL PRIMARY KEY, assessment_id INTEGER NOT NULL REFERENCES assessments(id), target_behavior_id INTEGER REFERENCES target_behaviors(id),
 recorded_at TIMESTAMPTZ NOT NULL, setting TEXT, antecedent TEXT, behavior TEXT, consequence TEXT,
 measurement_type TEXT NOT NULL CHECK (measurement_type IN ('frequency','duration','latency')), value DOUBLE PRECISION NOT NULL,
 notes TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS function_hypotheses (
 id SERIAL PRIMARY KEY,
 assessment_id INTEGER NOT NULL REFERENCES assessments(id),
 target_behavior_id INTEGER NOT NULL REFERENCES target_behaviors(id),
 function TEXT NOT NULL CHECK (function IN ('escape','attention','tangible','automatic','multiple','undetermined')),
 confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
 evidence JSONB,
 status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reviewed')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(assessment_id, target_behavior_id)
);
CREATE TABLE IF NOT EXISTS sign_offs (
 id SERIAL PRIMARY KEY,
 assessment_id INTEGER NOT NULL REFERENCES assessments(id),
 document_type TEXT NOT NULL CHECK (document_type IN ('fba_report','bip','crisis_plan')),
 signatory_role TEXT NOT NULL CHECK (signatory_role IN ('bcba','guardian','supervisor','other')),
 signatory_name TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','signed')),
 signature TEXT,
 signed_at TIMESTAMPTZ,
 signature_algo TEXT,
 signature_digest TEXT,
 signature_key_fingerprint TEXT,
 signature_typed TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(assessment_id, document_type, signatory_role)
);
CREATE TABLE IF NOT EXISTS signing_keys (
 id SERIAL PRIMARY KEY,
 fingerprint TEXT UNIQUE NOT NULL,
 public_key_pem TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_log (
 id SERIAL PRIMARY KEY,
 assessment_id INTEGER,
 actor TEXT,
 action TEXT,
 details JSONB,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assessments_client ON assessments(client_id);
CREATE INDEX IF NOT EXISTS idx_data_points_assessment ON data_points(assessment_id);
CREATE INDEX IF NOT EXISTS idx_target_behaviors_assessment ON target_behaviors(assessment_id);
CREATE INDEX IF NOT EXISTS idx_sign_offs_assessment ON sign_offs(assessment_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_assessment ON audit_log(assessment_id);
CREATE TABLE IF NOT EXISTS progress_reports (
 id SERIAL PRIMARY KEY, assessment_id INTEGER NOT NULL REFERENCES assessments(id),
 period_type TEXT NOT NULL CHECK (period_type IN ('month','quarter')), period TEXT NOT NULL, period_label TEXT NOT NULL,
 start_date TEXT NOT NULL, end_date TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_progress_reports_assessment ON progress_reports(assessment_id);
CREATE TABLE IF NOT EXISTS users (
 id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK (role IN ('admin','bcba','specialist','staff','supervisor','guardian')), display_name TEXT, email TEXT UNIQUE,
 active INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
 id SERIAL PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS login_security (
 username TEXT PRIMARY KEY, failed_count INTEGER NOT NULL DEFAULT 0, locked_until TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mfa_backup_codes (
 id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), code_hash TEXT NOT NULL, used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mfa_backup_user ON mfa_backup_codes(user_id);
`;

// ---------------------------------------------------------------------------
// SQLite mode (default; synchronous, unchanged behavior).
// ---------------------------------------------------------------------------
function sqliteDb() {
 const Database = require('better-sqlite3');
 const file = process.env.DATABASE_PATH || path.resolve('data/clearpathfba.sqlite');
 fs.mkdirSync(path.dirname(file), { recursive: true });
 const raw = new Database(file);
 raw.pragma('foreign_keys = ON');
 raw.exec(SQLITE_DDL);
 // Defensive migration: a DB file may already exist with an older schema.
 for (const [table, cols] of Object.entries(migrations)) {
  const existing = new Set(raw.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
  for (const [name, def] of cols) {
   if (!existing.has(name)) raw.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
  }
 }
 return {
  mode: 'sqlite',
  ready: Promise.resolve(),
  currentTimestamp: 'CURRENT_TIMESTAMP',
  nowPlus: (minutes) => `datetime('now','+${minutes} minutes')`,
  orderCi: (col) => `${col} COLLATE NOCASE`,
  prepare(sql) {
   const st = raw.prepare(sql);
   return {
    get: (...args) => st.get(...args),
    all: (...args) => st.all(...args),
    run: (...args) => st.run(...args),
   };
  },
  // Async-compatible transaction wrapper: `await fn(...)` runs the whole body
  // between BEGIN and COMMIT even when fn is async (the SQLite statements
  // inside still execute synchronously, so the transaction is atomic).
  transaction(fn) {
   return async (...args) => {
    raw.exec('BEGIN');
    try {
     const result = await fn(...args);
     raw.exec('COMMIT');
     return result;
    } catch (err) {
     try { raw.exec('ROLLBACK'); } catch { /* connection-level failure */ }
     throw err;
    }
   };
  },
  exec(sql) { return raw.exec(sql); },
 };
}

// ---------------------------------------------------------------------------
// PostgreSQL mode (async; selected by DATABASE_URL).
// ---------------------------------------------------------------------------
// Postgres field type OIDs we coerce so rows look exactly like SQLite rows.
const OID_BOOL = 16, OID_INT8 = 20, OID_DATE = 1082, OID_TIMESTAMP = 1114, OID_TIMESTAMPTZ = 1184, OID_JSONB = 3802;
const fmtTs = (d) => d.toISOString().slice(0, 19).replace('T', ' '); // 'YYYY-MM-DD HH:MM:SS' (UTC, like SQLite CURRENT_TIMESTAMP)
const fmtDate = (d) => d.toISOString().slice(0, 10);
function pgValue(oid, v) {
 if (v === null || v === undefined) return v;
 switch (oid) {
  case OID_BOOL: return v ? 1 : 0;
  case OID_INT8: return typeof v === 'bigint' ? Number(v) : Number(v);
  case OID_TIMESTAMP: case OID_TIMESTAMPTZ: return fmtTs(v);
  case OID_DATE: return fmtDate(v);
  case OID_JSONB: return JSON.stringify(v);
  default: return v;
 }
}
function mapRows(fields, rows) {
 if (!rows || !rows.length) return rows || [];
 return rows.map((row) => {
  const out = {};
  for (let i = 0; i < fields.length; i++) out[fields[i].name] = pgValue(fields[i].dataTypeID, row[fields[i].name]);
  return out;
 });
}
// better-sqlite3 uses `?`; Postgres uses $1..$n.
function pgText(sql) {
 let n = 0;
 return sql.replace(/\?/g, () => `$${++n}`);
}
// Keep the SQLite-style 'UNIQUE constraint failed' wording so existing
// catch handlers (`String(e.message).includes('UNIQUE')`) keep working.
function pgError(err) {
 if (err && err.code === '23505') {
  const detail = err.constraint || err.detail || 'constraint';
  err.message = `UNIQUE constraint failed: ${detail}`;
 }
 return err;
}
function postgresDb() {
 const ssl = process.env.PGSSLMODE
  ? (process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: process.env.PGSSLMODE === 'verify-full' || process.env.PGSSLMODE === 'verify-ca' })
  : (/neon\.tech/i.test(PG_URL) ? { rejectUnauthorized: false } : undefined);
 const ready = (async () => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: PG_URL, ssl, max: 10, idleTimeoutMillis: 30000 });
  await pool.query(PG_DDL);
  // Guarded migrations (PG: ADD COLUMN IF NOT EXISTS is idempotent).
  for (const [table, cols] of Object.entries(migrations)) {
   for (const [name, def] of cols) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} ${def}`);
   }
  }
  return pool;
 })();
 return {
  mode: 'postgres',
  ready,
  currentTimestamp: 'now()',
  nowPlus: (minutes) => `now() + interval '${minutes} minutes'`,
  orderCi: (col) => `LOWER(${col})`,
  prepare(sql) {
   const isInsert = /^\s*INSERT\b/i.test(sql) && !/\bRETURNING\b/i.test(sql);
   const text = pgText(sql.replace(/;+\s*$/, ''));
   const exec = async (method, params) => {
    const pool = await ready;
    try {
     if (method === 'get') {
      const r = await pool.query({ text, values: params });
      return r.rows.length ? mapRows(r.fields, [r.rows[0]])[0] : undefined;
     }
     if (method === 'all') {
      const r = await pool.query({ text, values: params });
      return mapRows(r.fields, r.rows);
     }
     // run: plain INSERTs get RETURNING id so lastInsertRowid matches SQLite.
     const r = await pool.query({ text: isInsert ? `${text} RETURNING id` : text, values: params });
     return { changes: r.rowCount, lastInsertRowid: r.rows && r.rows.length ? mapRows(r.fields, r.rows)[0].id : undefined };
    } catch (err) { throw pgError(err); }
   };
   return {
    get: (...params) => exec('get', params),
    all: (...params) => exec('all', params),
    run: (...params) => exec('run', params),
   };
  },
  transaction(fn) {
   return async (...args) => {
    const pool = await ready;
    const client = await pool.connect();
    try {
     await client.query('BEGIN');
     const result = await fn(...args);
     await client.query('COMMIT');
     return result;
    } catch (err) {
     try { await client.query('ROLLBACK'); } catch { /* connection-level failure */ }
     throw pgError(err);
    } finally {
     client.release();
    }
   };
  },
  exec(sql) { return (async () => { const pool = await ready; return pool.query(sql); })(); },
 };
}

export default PG_URL ? postgresDb() : sqliteDb();
