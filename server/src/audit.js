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

/**
 * Append one audit entry.
 * @param {object} entry { assessment_id, actor, action, details }
 *   - assessment_id may be null for system-level events (currently always set).
 *   - actor defaults to 'BCBA' (auth is stubbed to the BCBA role for the MVP).
 *   - details is an object, JSON-stringified for storage.
 */
export function logAudit(dbInstance, { assessment_id, actor = 'BCBA', action, details = {} }) {
 const stmt = dbInstance.prepare('INSERT INTO audit_log (assessment_id, actor, action, details) VALUES (?, ?, ?, ?)');
 return stmt.run(assessment_id ?? null, String(actor), String(action), JSON.stringify(details));
}

/**
 * Public-shaped sign_offs rows for one assessment + document type.
 * Used by report.js / documents.js so every printable document payload carries
 * its sign-off records (name + date once signed) for filled signature lines.
 */
export function signOffsFor(assessmentId, documentType) {
 return db.prepare('SELECT * FROM sign_offs WHERE assessment_id=? AND document_type=? ORDER BY id')
  .all(assessmentId, documentType)
  .map((s) => ({
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
