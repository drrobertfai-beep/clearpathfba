import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
const file = process.env.DATABASE_PATH || path.resolve('data/clearpathfba.sqlite');
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new Database(file);
db.pragma('foreign_keys = ON');
db.exec(`
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
-- In-app signature RECORD (typed name + role + date) per document per role.
-- This is a tracking record for ClearPathFBA's own workflow, NOT a legally-binding
-- cryptographic e-signature — formal e-signature integration is a later phase.
-- UNIQUE(assessment_id, document_type, signatory_role): each role signs each
-- document once. The API returns 409 Conflict on a duplicate (no upsert), so the
-- audit trail keeps exactly one create event per row.
CREATE TABLE IF NOT EXISTS sign_offs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 assessment_id INTEGER NOT NULL REFERENCES assessments(id),
 document_type TEXT NOT NULL CHECK (document_type IN ('fba_report','bip','crisis_plan')),
 signatory_role TEXT NOT NULL CHECK (signatory_role IN ('bcba','guardian','supervisor','other')),
 signatory_name TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','signed')),
 signature TEXT,
 signed_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(assessment_id, document_type, signatory_role)
);
-- Append-only audit trail for sign-off and generation actions. Rows are never
-- updated or deleted; details holds a JSON object (with a human-readable label).
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
 role TEXT NOT NULL CHECK (role IN ('admin','bcba','specialist','staff','supervisor','guardian')), display_name TEXT,
 active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
 id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT UNIQUE NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_security (
 username TEXT PRIMARY KEY, failed_count INTEGER NOT NULL DEFAULT 0, locked_until TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
    `);
// Defensive migration: a DB file may already exist with an older schema.
// Add any missing columns via ALTER TABLE (SQLite cannot add CHECKs this way,
// so app-layer validation is the guard for older DBs).
const migrations = {
 assessments: [
  ['assessor', 'TEXT'],
  ['deleted_at', 'TEXT'],
 ],
 users: [
  ['must_change_password', 'INTEGER NOT NULL DEFAULT 0'],
 ],
 target_behaviors: [
  ['safety_classification', "TEXT NOT NULL DEFAULT 'none'"],
  ['is_safety_concern', 'INTEGER NOT NULL DEFAULT 0'],
  ['baseline_measurement_type', 'TEXT'],
 ],
};
for (const [table, cols] of Object.entries(migrations)) {
 const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
 for (const [name, def] of cols) {
  if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
 }
}
export default db;
