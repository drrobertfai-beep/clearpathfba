// ClearPathFBA — audit trail + sign-off shared helpers.
// logAudit() appends one row to audit_log. The trail is append-only: no update
// or delete path exists, so it is a reliable record of sign-off and generation
// actions. Details is stored as JSON; callers should include a human-readable
// `label` so any client (UI, CSV export, future email) can render the event
// without re-implementing wording.
import db from './db.js';

export const DOCUMENT_TYPE_LABELS = {
 fba_report: 'FBA Report',
 bip: 'BIP',
 crisis_plan: 'Crisis Plan',
 data_sheet: 'Data Sheet',
};

export const SIGNATORY_ROLE_LABELS = {
 bcba: 'BCBA',
 guardian: 'Guardian',
 supervisor: 'Supervisor',
 other: 'Other',
};

export const SIGN_OFF_STATUS_LABELS = { pending: 'Pending', signed: 'Signed' };

// Organization scoping (pass 2). Every audit entry records the organization it
// belongs to, so the admin audit feed can be read per organization instead of
// globally. The organization is derived — never supplied by the client — from
// the most authoritative thing the entry names, in this order:
//
//   1. the assessment the entry is about (assessment → client → org)
//   2. the record it names in `details.entity` / `details.id`
//   3. the account named by `actor` (login, MFA, password, billing events)
//
// Anything that matches none of these stays NULL: a Stripe webhook, for
// instance, arrives without a signed-in user. NULL-org rows are visible to a
// platform admin only — never to an organization's own admin.
const ASSESSMENT_ORG_SQL = `SELECT c.org_id FROM assessments a JOIN clients c ON c.id = a.client_id WHERE a.id = ?`;

/** How a named entity reaches its organization (one row, one org_id). */
const ENTITY_ORG_SQL = {
 client: 'SELECT org_id FROM clients WHERE id = ?',
 user: 'SELECT org_id FROM users WHERE id = ?',
 assessment: ASSESSMENT_ORG_SQL,
 target_behavior: `SELECT c.org_id FROM target_behaviors tb
   JOIN assessments a ON a.id = tb.assessment_id JOIN clients c ON c.id = a.client_id WHERE tb.id = ?`,
 data_point: `SELECT c.org_id FROM data_points dp
   JOIN assessments a ON a.id = dp.assessment_id JOIN clients c ON c.id = a.client_id WHERE dp.id = ?`,
 sign_off: `SELECT c.org_id FROM sign_offs s
   JOIN assessments a ON a.id = s.assessment_id JOIN clients c ON c.id = a.client_id WHERE s.id = ?`,
 progress_report: `SELECT c.org_id FROM progress_reports pr
   JOIN assessments a ON a.id = pr.assessment_id JOIN clients c ON c.id = a.client_id WHERE pr.id = ?`,
};

const ACTOR_ORG_SQL = 'SELECT org_id FROM users WHERE lower(username) = lower(?) OR lower(email) = lower(?) LIMIT 1';

/**
 * Resolve the organization an audit entry belongs to, or null when it cannot be
 * attributed. Exported so the boot migration can attribute rows written before
 * audit_log carried an org_id, using exactly the same rules.
 *
 * Never throws: a lookup that fails leaves the entry unattributed (visible to
 * platform admins only), which is the safe direction. It also cannot be used to
 * *widen* visibility — an entry attributed to another organization simply
 * disappears from the writer's own feed.
 *
 * @param {{prepare: Function}} dbInstance data layer
 * @param {{assessment_id?: number|null, actor?: string, details?: object|string}} entry
 * @returns {Promise<number|null>}
 */
export async function resolveAuditOrg(dbInstance, { assessment_id = null, actor = null, details = {} } = {}) {
 const orgIdOf = async (sql, ...params) => {
  try {
   const row = await dbInstance.prepare(sql).get(...params);
   const orgId = row ? Number(row.org_id) : NaN;
   return Number.isInteger(orgId) && orgId > 0 ? orgId : null;
  } catch {
   return null;
  }
 };
 if (assessment_id) {
  const fromAssessment = await orgIdOf(ASSESSMENT_ORG_SQL, assessment_id);
  if (fromAssessment) return fromAssessment;
 }
 let parsed = details;
 if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { parsed = {}; } }
 const entity = parsed && parsed.entity;
 const entityId = parsed && parsed.id;
 if (entity && entityId && ENTITY_ORG_SQL[entity]) {
  const fromEntity = await orgIdOf(ENTITY_ORG_SQL[entity], entityId);
  if (fromEntity) return fromEntity;
 }
 // Server-side jobs (the letterhead CLI, for one) name the organization they
 // changed directly in details.organization_id. Nothing client-supplied reaches
 // this field: it is written by our own code, and honouring it only makes an
 // entry visible to that one organization.
 const declaredOrg = parsed && parsed.organization_id;
 if (declaredOrg) {
  const declared = Number(declaredOrg);
  if (Number.isInteger(declared) && declared > 0) return declared;
 }
 if (actor) {
  const name = String(actor);
  return await orgIdOf(ACTOR_ORG_SQL, name, name);
 }
 return null;
}

/**
 * Append one audit entry.
 * @param {object} entry { assessment_id, actor, action, details, org_id }
 *   - assessment_id may be null for system-level events (client-level events,
 *     sign-in events, billing events).
 *   - actor defaults to 'BCBA' (auth is stubbed to the BCBA role for the MVP).
 *   - details is an object, JSON-stringified for storage.
 *   - org_id is derived with resolveAuditOrg unless a caller supplies it.
 */
export async function logAudit(dbInstance, { assessment_id, actor = 'BCBA', action, details = {}, org_id = null }) {
 const orgId = org_id ?? await resolveAuditOrg(dbInstance, { assessment_id, actor, details });
 const stmt = dbInstance.prepare('INSERT INTO audit_log (org_id, assessment_id, actor, action, details) VALUES (?, ?, ?, ?, ?)');
 return stmt.run(orgId ?? null, assessment_id ?? null, String(actor), String(action), JSON.stringify(details));
}

/**
 * Public-shaped sign_offs rows for one assessment + document type.
 * Used by report.js / documents.js so every printable document payload carries
 * its sign-off records (name + date once signed) for filled signature lines.
 */
export async function signOffsFor(assessmentId, documentType) {
 const rows = await db.prepare('SELECT * FROM sign_offs WHERE assessment_id=? AND document_type=? ORDER BY id')
  .all(assessmentId, documentType);
 return rows.map((s) => ({
  id: s.id,
  document_type: s.document_type,
  document_type_label: DOCUMENT_TYPE_LABELS[s.document_type] || s.document_type,
  signatory_role: s.signatory_role,
  signatory_role_label: SIGNATORY_ROLE_LABELS[s.signatory_role] || s.signatory_role,
  signatory_name: s.signatory_name,
  status: s.status,
  status_label: SIGN_OFF_STATUS_LABELS[s.status] || s.status,
  signature: s.signature,
  signature_typed: s.signature_typed,
  signed_at: s.signed_at,
  // Cryptographic e-signature metadata (set once signed). The digest is a
  // SHA-256 hash of the signed document — safe to expose to document viewers.
  signature_algo: s.signature_algo,
  signature_digest: s.signature_digest,
  signature_key_fingerprint: s.signature_key_fingerprint,
 }));
}
