#!/usr/bin/env node
/**
 * ClearPathFBA — demo / sample-data seed.
 *
 * Creates a self-contained demo workspace so a pilot clinician's first login is
 * not an empty app:
 *   * one demo user            — demo@clearpathfba.com / DemoPilot2026!
 *   * three sample clients     — "Sample Client A/B/C" (obviously fictional)
 *   * target behaviors with operational definitions + safety classifications
 *   * an ABC/baseline data set that produces real rule-based function
 *     hypotheses (escape / attention / automatic) with confidence + evidence
 *   * sign-offs on the FBA report (one cryptographically signed) and a pending
 *     BIP signatory
 *   * a generated monthly progress report with a real trend direction
 *
 * IDEMPOTENT: every row is looked up by its natural key before it is inserted,
 * and existing rows are never rewritten (rewriting data points or hypotheses
 * would change the signed-document digest and invalidate the demo signature).
 * Running the script twice leaves the demo data byte-identical.
 *
 * DUAL BACKEND: uses the same data layer as the server (server/src/db.js) —
 * SQLite when DATABASE_URL is unset, PostgreSQL when it is set — so the exact
 * same code path seeds dev and production. Every db call is awaited.
 *
 * Usage (from the repository root, so the SQLite file resolves to data/):
 *   npm run seed:demo
 *   DATABASE_URL=postgres://… npm run seed:demo     # e.g. the pilot database
 */
import { pathToFileURL } from 'node:url';
import db from '../src/db.js';
import { hashPassword, verifyPassword } from '../src/auth.js';
import { DEMO_ORG as DEMO_ORG_ROW, DEMO_USERNAME, ensureOrg } from '../src/org-migration.js';
import { analyzeAssessment } from '../src/analysis.js';
import { buildReport } from '../src/report.js';
import { signDocument, verifyDocument } from '../src/signature.js';
import { buildProgressReport } from '../src/reporting.js';
import { logAudit } from '../src/audit.js';

// --- Demo identity ---------------------------------------------------------
// The demo workspace lives in its OWN organization (see server/src/org.js):
// a demo login must never see a real clinician's clients, and a real
// organization must never see the sample data. The organization name/slug and
// the demo username are defined once, in org-migration.js, so the seed and the
// migration that moves existing demo rows cannot drift apart.
const DEMO_ORG = DEMO_ORG_ROW.name;
const DEMO_PASSWORD = 'DemoPilot2026!';
const DEMO_DISPLAY_NAME = 'Demo Clinician, BCBA (Sample Data)';
const DEMO_ASSESSOR = 'Demo Clinician, BCBA (sample data)';
const DEMO_SIGNATORY = 'Demo Clinician, BCBA';
const NOTE_MARKER = 'SAMPLE DATA';

// --- Periods: the two most recently completed calendar months ---------------
// Data lives in the past so no observation is dated in the future, and both
// progress-report periods are complete (the monthly report compares them).
const monthKey = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const addMonths = (d, n) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
const NOW = new Date();
const LAST_MONTH = monthKey(addMonths(NOW, -1)); // most recently completed month
const PREV_MONTH = monthKey(addMonths(NOW, -2)); // the month before that
/** 'YYYY-MM-DDTHH:MM:00' — the shape the app's datetime-local input produces. */
const stamp = (month, day, hour = 9, minute = 0) =>
  `${month}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;

// --- ABC context presets ---------------------------------------------------
// Antecedent/consequence codes are the controlled vocabulary from
// server/src/vocab.js — they are what the rule-based engine reads.
const ABC = {
  demandEscape: { setting: 'classroom', antecedent: 'demand_task', consequence: 'escape_removed_demand' },
  reprimandEscape: { setting: 'group_instruction', antecedent: 'reprimand_correction', consequence: 'ignored_no_consequence' },
  transitionEscape: { setting: 'transition', antecedent: 'transition', consequence: 'escape_removed_demand' },
  attentionSeek: { setting: 'playground', antecedent: 'attention_diverted', consequence: 'attention_given' },
  peerAttention: { setting: 'group_instruction', antecedent: 'attention_diverted', consequence: 'peer_attention' },
  tangibleSeek: { setting: 'community', antecedent: 'denied_access', consequence: 'access_preferred_item' },
  automatic: { setting: 'therapy_1on1', antecedent: 'sensory_stimulation', consequence: 'sensory_stimulation' },
};

/**
 * Sample workspace. Points are [period, day-of-month, ABC preset, value] and
 * inherit the behavior's measurement type. The mixes are hand-tuned so the
 * analysis engine returns a dominant function with a believable confidence
 * (not a 100% straight line) and the two months differ enough to produce an
 * "improved" and a "stable" trend.
 */
const DEMO_CLIENTS = [
  {
    first_name: 'Sample',
    last_name: 'Client A',
    date_of_birth: '2015-01-01',
    gender: 'Prefer not to say',
    consent_status: 'obtained',
    notes: `${NOTE_MARKER} — fictional client created by the ClearPathFBA demo seed for “${DEMO_ORG}”. Not a real person. Sample referral: teacher reports frequent aggression during academic demands, with escalation at transitions.`,
    assessment: {
      title: 'Initial FBA — Sample Client A',
      status: 'completed',
      assessor: DEMO_ASSESSOR,
      notes: `${NOTE_MARKER}: baseline/ABC data collected across two months in classroom, group instruction, and transition settings. Assessment marked completed so the FBA Report prints as a final document.`,
      behaviors: [
        {
          name: 'Aggression toward peers',
          operational_definition:
            'Any instance of hitting, kicking, biting, or forcefully pushing a peer with an open hand or closed fist, from the moment contact is initiated until the peer is released (sample definition).',
          safety_classification: 'aggression',
          baseline_measurement_type: 'frequency',
          reviewed: true,
          points: [
            [PREV_MONTH, 3, 'demandEscape', 4], [PREV_MONTH, 5, 'demandEscape', 5],
            [PREV_MONTH, 8, 'reprimandEscape', 4], [PREV_MONTH, 10, 'demandEscape', 3],
            [PREV_MONTH, 12, 'reprimandEscape', 5], [PREV_MONTH, 16, 'demandEscape', 4],
            [PREV_MONTH, 18, 'reprimandEscape', 3], [PREV_MONTH, 22, 'transitionEscape', 4],
            [PREV_MONTH, 25, 'attentionSeek', 5], [PREV_MONTH, 27, 'tangibleSeek', 4],
            [LAST_MONTH, 2, 'demandEscape', 2], [LAST_MONTH, 4, 'demandEscape', 1],
            [LAST_MONTH, 7, 'reprimandEscape', 2], [LAST_MONTH, 9, 'demandEscape', 2],
            [LAST_MONTH, 13, 'reprimandEscape', 1], [LAST_MONTH, 15, 'transitionEscape', 2],
            [LAST_MONTH, 19, 'demandEscape', 1], [LAST_MONTH, 21, 'reprimandEscape', 2],
            [LAST_MONTH, 24, 'transitionEscape', 2], [LAST_MONTH, 28, 'attentionSeek', 1],
          ],
        },
        {
          name: 'Elopement from assigned area',
          operational_definition:
            'Leaving the assigned area without adult permission and moving more than 5 feet beyond the marked boundary, lasting longer than 3 seconds (sample definition).',
          safety_classification: 'elopement',
          baseline_measurement_type: 'frequency',
          reviewed: false,
          points: [
            [PREV_MONTH, 3, 'attentionSeek', 2], [PREV_MONTH, 6, 'attentionSeek', 2],
            [PREV_MONTH, 9, 'peerAttention', 3], [PREV_MONTH, 12, 'attentionSeek', 2],
            [PREV_MONTH, 17, 'attentionSeek', 2], [PREV_MONTH, 20, 'demandEscape', 3],
            [PREV_MONTH, 24, 'attentionSeek', 2], [PREV_MONTH, 27, 'attentionSeek', 2],
            [LAST_MONTH, 2, 'attentionSeek', 2], [LAST_MONTH, 5, 'attentionSeek', 3],
            [LAST_MONTH, 8, 'peerAttention', 2], [LAST_MONTH, 11, 'attentionSeek', 2],
            [LAST_MONTH, 16, 'attentionSeek', 3], [LAST_MONTH, 19, 'demandEscape', 2],
            [LAST_MONTH, 23, 'attentionSeek', 2], [LAST_MONTH, 26, 'attentionSeek', 2],
          ],
        },
      ],
    },
  },
  {
    first_name: 'Sample',
    last_name: 'Client B',
    date_of_birth: '2012-06-15',
    gender: 'Prefer not to say',
    consent_status: 'obtained',
    notes: `${NOTE_MARKER} — fictional client created by the ClearPathFBA demo seed for “${DEMO_ORG}”. Not a real person. Sample referral: property destruction during independent work and loud vocalizations maintained by adult attention.`,
    assessment: {
      title: 'Initial FBA — Sample Client B',
      status: 'in_progress',
      assessor: DEMO_ASSESSOR,
      notes: `${NOTE_MARKER}: data collection ongoing — this assessment is intentionally left “In progress” so the FBA Report prints as PRELIMINARY.`,
      behaviors: [
        {
          name: 'Property destruction',
          operational_definition:
            'Throwing, tearing, or breaking classroom materials (paper, folders, small furniture) such that the item is unusable or must be replaced (sample definition).',
          safety_classification: 'property_damage',
          baseline_measurement_type: 'frequency',
          reviewed: false,
          points: [
            [LAST_MONTH, 4, 'demandEscape', 3], [LAST_MONTH, 8, 'demandEscape', 4],
            [LAST_MONTH, 12, 'reprimandEscape', 2], [LAST_MONTH, 17, 'demandEscape', 3],
            [LAST_MONTH, 21, 'transitionEscape', 4], [LAST_MONTH, 26, 'tangibleSeek', 2],
          ],
        },
        {
          name: 'Vocal disruption',
          operational_definition:
            'Vocalizations above conversational volume (screaming, loud repetitive protesting) lasting more than 5 consecutive seconds during instruction (sample definition).',
          safety_classification: 'none',
          baseline_measurement_type: 'duration',
          reviewed: false,
          points: [
            [LAST_MONTH, 4, 'attentionSeek', 2.5], [LAST_MONTH, 8, 'attentionSeek', 3],
            [LAST_MONTH, 12, 'peerAttention', 1.5], [LAST_MONTH, 17, 'attentionSeek', 4],
            [LAST_MONTH, 21, 'attentionSeek', 2], [LAST_MONTH, 26, 'attentionSeek', 3.5],
          ],
        },
      ],
    },
  },
  {
    first_name: 'Sample',
    last_name: 'Client C',
    date_of_birth: '2018-03-10',
    gender: 'Prefer not to say',
    consent_status: 'in_progress',
    notes: `${NOTE_MARKER} — fictional client created by the ClearPathFBA demo seed for “${DEMO_ORG}”. Not a real person. Sample referral: self-injury during 1:1 therapy; consent paperwork is intentionally left “In progress” to show that state.`,
    assessment: {
      title: 'Initial FBA — Sample Client C',
      status: 'in_progress',
      assessor: DEMO_ASSESSOR,
      notes: `${NOTE_MARKER}: short baseline — 5 observations, enough for a rule-based hypothesis but still preliminary.`,
      behaviors: [
        {
          name: 'Self-injurious behavior',
          operational_definition:
            'Any instance of head-directed contact with an open hand or a hard surface, or biting of the hand or forearm, that leaves a red mark (sample definition).',
          safety_classification: 'self_injury',
          baseline_measurement_type: 'frequency',
          reviewed: false,
          points: [
            [LAST_MONTH, 5, 'automatic', 3], [LAST_MONTH, 9, 'automatic', 2],
            [LAST_MONTH, 14, 'automatic', 4], [LAST_MONTH, 20, 'automatic', 2],
            [LAST_MONTH, 25, 'attentionSeek', 3],
          ],
        },
      ],
    },
  },
];

const created = { users: 0, clients: 0, assessments: 0, behaviors: 0, data_points: 0, hypotheses: 0, sign_offs: 0, signatures: 0, progress_reports: 0 };
const out = (...a) => console.log(...a);

// --- Lookup-or-insert helpers ---------------------------------------------
/** Ensure the demo user exists with the documented password + no forced reset. */
async function ensureDemoUser() {
  const org = await ensureOrg(db, DEMO_ORG_ROW);
  const existing = await db.prepare('SELECT * FROM users WHERE username=?').get(DEMO_USERNAME);
  if (!existing) {
    await db.prepare(
      'INSERT INTO users(username,password_hash,role,display_name,email,active,must_change_password,org_id) VALUES (?,?,?,?,?,1,0,?)'
    ).run(DEMO_USERNAME, hashPassword(DEMO_PASSWORD), 'bcba', DEMO_DISPLAY_NAME, DEMO_USERNAME, org.id);
    created.users += 1;
    out(`  + user            ${DEMO_USERNAME} (bcba, must_change_password=0, org=${DEMO_ORG})`);
    return org;
  }
  // Keep the documented demo credentials true: no forced reset, active, bcba.
  // Only rewrite the password when the stored one no longer matches the docs.
  const patch = {};
  if (!verifyPassword(DEMO_PASSWORD, existing.password_hash)) patch.password_hash = hashPassword(DEMO_PASSWORD);
  if (existing.must_change_password) patch.must_change_password = 0;
  if (existing.active !== 1) patch.active = 1;
  if (existing.role !== 'bcba') patch.role = 'bcba';
  if (existing.display_name !== DEMO_DISPLAY_NAME) patch.display_name = DEMO_DISPLAY_NAME;
  if (existing.email !== DEMO_USERNAME) patch.email = DEMO_USERNAME;
  // Re-running the seed keeps the demo account inside the demo organization
  // (covers a row created before organizations existed).
  if (Number(existing.org_id) !== Number(org.id)) patch.org_id = org.id;
  const keys = Object.keys(patch);
  if (!keys.length) {
    out(`  = user            ${DEMO_USERNAME} (already seeded)`);
    return org;
  }
  await db.prepare(`UPDATE users SET ${keys.map((k) => `${k}=?`).join(',')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(...keys.map((k) => patch[k]), existing.id);
  out(`  ~ user            ${DEMO_USERNAME} (updated: ${keys.join(', ')})`);
  return org;
}

async function ensureClient(spec, org) {
  const existing = await db.prepare(
    "SELECT * FROM clients WHERE first_name=? AND last_name=? AND notes LIKE ? AND deleted_at IS NULL"
  ).get(spec.first_name, spec.last_name, `${NOTE_MARKER}%`);
  if (existing) {
    // Keep sample data in the sample-data organization on every run.
    if (Number(existing.org_id) !== Number(org.id)) {
      await db.prepare('UPDATE clients SET org_id=? WHERE id=?').run(org.id, existing.id);
      out(`  ~ client          ${spec.first_name} ${spec.last_name} (#${existing.id}) → org=${DEMO_ORG}`);
    } else {
      out(`  = client          ${spec.first_name} ${spec.last_name} (#${existing.id})`);
    }
    return existing;
  }
  const info = await db.prepare(
    'INSERT INTO clients (org_id,first_name,last_name,date_of_birth,gender,consent_status,dbhds_flags,notes) VALUES (?,?,?,?,?,?,?,?)'
  ).run(
    org.id, spec.first_name, spec.last_name, spec.date_of_birth, spec.gender, spec.consent_status,
    JSON.stringify({ demo: true, organization: DEMO_ORG, seed: 'server/scripts/seed-demo.mjs' }),
    spec.notes,
  );
  const client = await db.prepare('SELECT * FROM clients WHERE id=?').get(info.lastInsertRowid);
  created.clients += 1;
  await logAudit(db, { assessment_id: null, actor: DEMO_USERNAME, action: 'client_created', details: {
    label: `Client created: ${client.first_name} ${client.last_name} (sample data)`, entity: 'client', id: client.id,
  } });
  out(`  + client          ${client.first_name} ${client.last_name} (#${client.id})`);
  return client;
}

async function ensureAssessment(client, spec) {
  const existing = await db.prepare('SELECT * FROM assessments WHERE client_id=? AND title=? AND deleted_at IS NULL')
    .get(client.id, spec.title);
  if (existing) {
    out(`  = assessment      ${spec.title} (#${existing.id})`);
    return existing;
  }
  // assessment_date: first day of the earlier seeded month, so the assessment
  // predates all of its own observations.
  const info = await db.prepare(
    'INSERT INTO assessments (client_id,title,status,assessment_date,assessor,notes) VALUES (?,?,?,?,?,?)'
  ).run(client.id, spec.title, spec.status, `${PREV_MONTH}-01`, spec.assessor, spec.notes);
  const a = await db.prepare('SELECT * FROM assessments WHERE id=?').get(info.lastInsertRowid);
  created.assessments += 1;
  await logAudit(db, { assessment_id: a.id, actor: DEMO_USERNAME, action: 'assessment_created', details: {
    label: `Assessment created: ${a.title} (sample data)`, entity: 'assessment', id: a.id,
  } });
  out(`  + assessment      ${a.title} (#${a.id})`);
  return a;
}

async function ensureBehavior(assessment, spec) {
  const existing = await db.prepare('SELECT * FROM target_behaviors WHERE assessment_id=? AND name=?')
    .get(assessment.id, spec.name);
  if (existing) {
    out(`  = behavior        ${spec.name} (#${existing.id})`);
    return existing;
  }
  const sc = spec.safety_classification || 'none';
  const info = await db.prepare(
    'INSERT INTO target_behaviors (assessment_id,name,operational_definition,safety_classification,is_safety_concern,baseline_measurement_type) VALUES (?,?,?,?,?,?)'
  ).run(assessment.id, spec.name, spec.operational_definition, sc, sc !== 'none' ? 1 : 0, spec.baseline_measurement_type || null);
  const b = await db.prepare('SELECT * FROM target_behaviors WHERE id=?').get(info.lastInsertRowid);
  created.behaviors += 1;
  await logAudit(db, { assessment_id: assessment.id, actor: DEMO_USERNAME, action: 'behavior_created', details: {
    label: `Target behavior created: ${b.name} (sample data)`, entity: 'target_behavior', id: b.id,
  } });
  out(`  + behavior        ${b.name} (#${b.id}, safety=${sc})`);
  return b;
}

async function ensureDataPoints(assessment, behavior, spec) {
  const count = (await db.prepare('SELECT COUNT(*) AS n FROM data_points WHERE assessment_id=? AND target_behavior_id=?')
    .get(assessment.id, behavior.id)).n;
  if (count > 0) {
    out(`  = data points     ${behavior.name}: ${count} already present`);
    return;
  }
  const ins = db.prepare(
    'INSERT INTO data_points (assessment_id,target_behavior_id,recorded_at,setting,antecedent,behavior,consequence,measurement_type,value,notes) VALUES (?,?,?,?,?,?,?,?,?,?)'
  );
  for (const [period, day, abcKey, value] of spec.points) {
    const abc = ABC[abcKey];
    await ins.run(
      assessment.id, behavior.id, stamp(period, day), abc.setting, abc.antecedent, behavior.name, abc.consequence,
      spec.baseline_measurement_type || 'frequency', value, null,
    );
    created.data_points += 1;
  }
  out(`  + data points     ${behavior.name}: ${spec.points.length} recorded`);
}

/** Run the real analysis engine and store its output (never overwrites a row). */
async function ensureHypotheses(assessment, behaviorRows, behaviorSpecs) {
  const existing = await db.prepare('SELECT COUNT(*) AS n FROM function_hypotheses WHERE assessment_id=?').get(assessment.id);
  if (existing.n > 0) {
    out(`  = hypotheses      ${existing.n} already present`);
    return;
  }
  const points = await db.prepare('SELECT * FROM data_points WHERE assessment_id=?').all(assessment.id);
  const results = analyzeAssessment(behaviorRows, points);
  for (const r of results) {
    const spec = behaviorSpecs.find((s) => s.name === (behaviorRows.find((b) => b.id === r.target_behavior_id) || {}).name);
    const status = spec && spec.reviewed ? 'reviewed' : 'draft';
    await db.prepare(
      'INSERT INTO function_hypotheses (assessment_id,target_behavior_id,function,confidence,evidence,status) VALUES (?,?,?,?,?,?)'
    ).run(assessment.id, r.target_behavior_id, r.function, r.confidence, JSON.stringify(r.evidence), status);
    created.hypotheses += 1;
    out(`  + hypothesis      ${spec ? spec.name : 'behavior #' + r.target_behavior_id}: ${r.function} @ ${Math.round(r.confidence * 100)}% (${status})`);
  }
}

async function ensureProgressReport(assessment, type, period) {
  const existing = await db.prepare('SELECT id FROM progress_reports WHERE assessment_id=? AND period_type=? AND period=?')
    .get(assessment.id, type, period);
  if (existing) {
    out(`  = progress report ${period} (#${existing.id})`);
    return;
  }
  const payload = await buildProgressReport(assessment.id, type, period);
  if (!payload) throw new Error(`Could not build the ${type} progress report for ${period}.`);
  const info = await db.prepare(
    'INSERT INTO progress_reports (assessment_id,period_type,period,period_label,start_date,end_date,payload) VALUES (?,?,?,?,?,?,?)'
  ).run(assessment.id, type, period, payload.period_label, payload.date_range.start, payload.date_range.end, JSON.stringify(payload));
  created.progress_reports += 1;
  const trends = (payload.trends.per_behavior || []).map((t) => `${t.behavior_name}: ${t.direction}`).join(', ');
  await logAudit(db, { assessment_id: assessment.id, actor: DEMO_USERNAME, action: 'progress_report_created', details: {
    label: `Progress report generated: ${payload.period_label} (sample data)`, entity: 'progress_report',
    id: Number(info.lastInsertRowid), period_type: type, period,
  } });
  out(`  + progress report ${payload.period_label} (#${info.lastInsertRowid}) — ${trends}`);
}

async function ensureSignOff(assessment, documentType, role, name, sign) {
  const existing = await db.prepare('SELECT * FROM sign_offs WHERE assessment_id=? AND document_type=? AND signatory_role=?')
    .get(assessment.id, documentType, role);
  if (existing) {
    out(`  = sign-off        ${documentType}/${role} (${existing.status})`);
    // Re-verify a previously recorded signature: because the seed never
    // rewrites signed content, a second run must leave it valid.
    if (existing.status === 'signed' && existing.signature_digest) {
      const v = await verifyDocument(await buildReport(assessment.id), documentType, {
        digest: existing.signature_digest, signature: existing.signature, fingerprint: existing.signature_key_fingerprint,
      });
      out(`  ✓ verify          ${documentType} signature after re-run: valid=${v.valid} tampered=${v.tampered}`);
      if (!v.valid || v.tampered) throw new Error(`Seed self-check failed: re-running the seed invalidated the ${documentType} signature.`);
    }
    return existing;
  }
  const info = await db.prepare(
    'INSERT INTO sign_offs (assessment_id,document_type,signatory_role,signatory_name) VALUES (?,?,?,?)'
  ).run(assessment.id, documentType, role, name);
  created.sign_offs += 1;
  const row = await db.prepare('SELECT * FROM sign_offs WHERE id=?').get(info.lastInsertRowid);
  if (!sign) {
    out(`  + sign-off        ${documentType}/${role} → ${name} (pending)`);
    return row;
  }
  // Sign exactly what the export builders produce, via the app's own Ed25519
  // signer — the same digest path the /sign endpoint uses.
  const payload = await buildReport(assessment.id);
  const { digest, signature, fingerprint } = await signDocument(payload, documentType);
  const signedAt = new Date().toISOString();
  await db.prepare(
    "UPDATE sign_offs SET status='signed', signature=?, signature_algo=?, signature_digest=?, signature_key_fingerprint=?, signature_typed=?, signed_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?"
  ).run(signature, 'Ed25519', digest, fingerprint, name, signedAt, row.id);
  created.signatures += 1;
  const signed = await db.prepare('SELECT * FROM sign_offs WHERE id=?').get(row.id);
  out(`  + sign-off        ${documentType}/${role} → ${name} (SIGNED, Ed25519 ${String(fingerprint).slice(0, 8)}…)`);
  // Self-check: the stored signature must verify against the current document.
  const v = await verifyDocument(payload, documentType, { digest: signed.signature_digest, signature: signed.signature, fingerprint: signed.signature_key_fingerprint });
  out(`  ✓ verify          ${documentType} signature: valid=${v.valid} tampered=${v.tampered}`);
  if (!v.valid || v.tampered) throw new Error(`Seed self-check failed: the ${documentType} signature does not verify.`);
  return signed;
}

// --- Summary (deterministic, so two runs can be diffed) --------------------
async function summary() {
  const row = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM clients WHERE notes LIKE '${NOTE_MARKER}%' AND deleted_at IS NULL) AS clients,
      (SELECT COUNT(*) FROM assessments WHERE client_id IN (SELECT id FROM clients WHERE notes LIKE '${NOTE_MARKER}%') AND deleted_at IS NULL) AS assessments,
      (SELECT COUNT(*) FROM target_behaviors WHERE assessment_id IN (SELECT id FROM assessments WHERE client_id IN (SELECT id FROM clients WHERE notes LIKE '${NOTE_MARKER}%'))) AS target_behaviors,
      (SELECT COUNT(*) FROM data_points WHERE assessment_id IN (SELECT id FROM assessments WHERE client_id IN (SELECT id FROM clients WHERE notes LIKE '${NOTE_MARKER}%'))) AS data_points,
      (SELECT COUNT(*) FROM function_hypotheses WHERE assessment_id IN (SELECT id FROM assessments WHERE client_id IN (SELECT id FROM clients WHERE notes LIKE '${NOTE_MARKER}%'))) AS function_hypotheses,
      (SELECT COUNT(*) FROM sign_offs WHERE assessment_id IN (SELECT id FROM assessments WHERE client_id IN (SELECT id FROM clients WHERE notes LIKE '${NOTE_MARKER}%'))) AS sign_offs,
      (SELECT COUNT(*) FROM sign_offs WHERE status='signed' AND assessment_id IN (SELECT id FROM assessments WHERE client_id IN (SELECT id FROM clients WHERE notes LIKE '${NOTE_MARKER}%'))) AS signed_documents,
      (SELECT COUNT(*) FROM progress_reports WHERE assessment_id IN (SELECT id FROM assessments WHERE client_id IN (SELECT id FROM clients WHERE notes LIKE '${NOTE_MARKER}%'))) AS progress_reports,
      (SELECT COUNT(*) FROM users WHERE username='${DEMO_USERNAME}') AS demo_users,
      (SELECT COUNT(*) FROM users) AS users_total,
      (SELECT COUNT(*) FROM clients) AS clients_total
  `).get();
  return row;
}

// --- Main ------------------------------------------------------------------
async function main() {
  await db.ready;
  out('');
  const target = db.mode === 'postgres'
    ? 'PostgreSQL (DATABASE_URL)'
    : `SQLite (${process.env.DATABASE_PATH || 'data/clearpathfba.sqlite'})`;
  out(`ClearPathFBA demo seed — target: ${target}`);
  if (db.mode === 'postgres') out('  NOTE: this writes sample data to the database DATABASE_URL points at.');
  out(`  demo organization: ${DEMO_ORG}`);
  out(`  data periods:      ${PREV_MONTH} (baseline) and ${LAST_MONTH} (current)`);
  out('');

  const org = await ensureDemoUser();

  for (const spec of DEMO_CLIENTS) {
    const client = await ensureClient(spec, org);
    const assessment = await ensureAssessment(client, spec.assessment);
    const behaviors = [];
    for (const bSpec of spec.assessment.behaviors) {
      const behavior = await ensureBehavior(assessment, bSpec);
      behaviors.push(behavior);
      await ensureDataPoints(assessment, behavior, bSpec);
    }
    await ensureHypotheses(assessment, behaviors, spec.assessment.behaviors);
    if (spec.last_name === 'Client A') {
      // The headline demo assessment: a completed monthly progress report, a
      // signed FBA report, an awaiting guardian, and a pending BIP signatory.
      await ensureProgressReport(assessment, 'month', LAST_MONTH);
      await ensureSignOff(assessment, 'fba_report', 'bcba', DEMO_SIGNATORY, true);
      await ensureSignOff(assessment, 'fba_report', 'guardian', 'Sample Guardian A (sample data)', false);
      await ensureSignOff(assessment, 'bip', 'bcba', DEMO_SIGNATORY, false);
    }
    out('');
  }

  const counts = await summary();
  out('Created this run: ' + JSON.stringify(created));
  out('SEED SUMMARY (json):');
  out(JSON.stringify(counts, null, 1));
  out('');
  out('Demo sign-in:');
  out(`  username: ${DEMO_USERNAME}`);
  out(`  password: ${DEMO_PASSWORD}`);
  out('  (role bcba, must_change_password=0 — no forced password reset)');
  out('');
}

export { main as seedDemo };

// Run only when executed directly (`npm run seed:demo`), so tests can import
// seedDemo() and drive it against an isolated database.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('');
      console.error('Demo seed failed:', err && err.message ? err.message : err);
      if (err && err.stack) console.error(err.stack);
      process.exit(1);
    });
}
