// ClearPathFBA — organization scoping (pass 1 of 3).
//
// ONE rule: a request may only reach clinical records that belong to the
// caller's organization. This module is the single place that rule is
// implemented, so routes stay readable and there is exactly one thing to audit.
//
// How a record reaches its organization:
//   clients.org_id              ← the only place org_id is stored
//   assessments                 → client_id → clients.org_id
//   target_behaviors            → assessment_id → assessments → clients
//   data_points                 → assessment_id → assessments → clients
//   function_hypotheses         → assessment_id → assessments → clients
//   sign_offs                   → assessment_id → assessments → clients
//   progress_reports            → assessment_id → assessments → clients
// Deliberately NOT denormalized: one source of truth means a client can never
// end up with records in two organizations.
//
// Callers use a resolver and answer 404 when it returns null. Never 403: a
// "forbidden" response would confirm that another organization's id exists,
// which is exactly the id-enumeration leak this is meant to prevent.
//
// The scope comes from req.user, which auth.js resolves from the session token
// on every request (users.org_id joined from the session row). It is never
// read from a query string, body or header.
import db from './db.js';

/** The demo/sample-data organization created by the migration and the seed. */
export const DEMO_ORG_SLUG = 'demo';
/** The organization every pre-existing record joined during the migration. */
export const DEFAULT_ORG_SLUG = 'default';

/**
 * True when the account may cross organization boundaries. This is the
 * explicit `users.is_platform_admin` flag — NOT `role === 'admin'`, so an
 * organization's own admin stays inside that organization.
 */
export function isPlatformAdmin(user) {
 return Boolean(user && (user.is_platform_admin === 1 || user.is_platform_admin === true));
}

/**
 * SQL predicate confining `column` to the caller's organization.
 * @param {object} user req.user (session-derived)
 * @param {string} column qualified column name, e.g. 'c.org_id'
 * @returns {{sql: string, params: any[]}} safe to splice into a WHERE clause
 */
export function orgPredicate(user, column = 'org_id') {
 if (isPlatformAdmin(user)) return { sql: '1=1', params: [] };
 const orgId = Number(user && user.org_id);
 // Fail closed: an account with no organization sees nothing rather than
 // everything. (The boot migration gives every legacy account an org.)
 if (!Number.isInteger(orgId) || orgId < 1) return { sql: '1=0', params: [] };
 return { sql: `${column} = ?`, params: [orgId] };
}

/**
 * The organization a record created by this caller belongs to. Always the
 * caller's own organization — a client-supplied org_id is never honoured.
 */
export async function orgIdForWrite(user) {
 const orgId = Number(user && user.org_id);
 if (Number.isInteger(orgId) && orgId > 0) return orgId;
 const fallback = await db.prepare('SELECT id FROM organizations WHERE slug=?').get(DEFAULT_ORG_SLUG);
 if (!fallback) throw new Error('No organization is configured for this account.');
 return fallback.id;
}

// --- Client ----------------------------------------------------------------
const CLIENT_COLUMNS = 'id, org_id, first_name, last_name, date_of_birth, gender, consent_status, dbhds_flags, notes, created_at, updated_at';

/** Clients visible to the caller, in the app's usual name order. */
export async function listClientsInOrg(user) {
 const scope = orgPredicate(user, 'org_id');
 return await db.prepare(
  `SELECT ${CLIENT_COLUMNS} FROM clients WHERE deleted_at IS NULL AND ${scope.sql}
   ORDER BY ${db.orderCi('last_name')}, ${db.orderCi('first_name')}`,
 ).all(...scope.params);
}

/** One client, only if it belongs to the caller's organization. */
export async function findClientInOrg(id, user) {
 const scope = orgPredicate(user, 'org_id');
 return await db.prepare(`SELECT ${CLIENT_COLUMNS} FROM clients WHERE id=? AND deleted_at IS NULL AND ${scope.sql}`)
  .get(id, ...scope.params);
}

// --- Assessment ------------------------------------------------------------
/** One assessment, resolved through its client's organization. */
export async function findAssessmentInOrg(id, user) {
 const scope = orgPredicate(user, 'c.org_id');
 return await db.prepare(
  `SELECT a.* FROM assessments a JOIN clients c ON c.id = a.client_id
   WHERE a.id=? AND a.deleted_at IS NULL AND ${scope.sql}`,
 ).get(id, ...scope.params);
}

// --- Rows that hang off an assessment --------------------------------------
/** One target behavior, resolved through assessment → client → organization. */
export async function findTargetBehaviorInOrg(id, user) {
 const scope = orgPredicate(user, 'c.org_id');
 return await db.prepare(
  `SELECT tb.* FROM target_behaviors tb
   JOIN assessments a ON a.id = tb.assessment_id
   JOIN clients c ON c.id = a.client_id
   WHERE tb.id=? AND ${scope.sql}`,
 ).get(id, ...scope.params);
}

/** One data point, resolved through assessment → client → organization. */
export async function findDataPointInOrg(id, user) {
 const scope = orgPredicate(user, 'c.org_id');
 return await db.prepare(
  `SELECT dp.* FROM data_points dp
   JOIN assessments a ON a.id = dp.assessment_id
   JOIN clients c ON c.id = a.client_id
   WHERE dp.id=? AND ${scope.sql}`,
 ).get(id, ...scope.params);
}

/** One function hypothesis, resolved through assessment → client → org. */
export async function findHypothesisInOrg(id, user) {
 const scope = orgPredicate(user, 'c.org_id');
 return await db.prepare(
  `SELECT fh.* FROM function_hypotheses fh
   JOIN assessments a ON a.id = fh.assessment_id
   JOIN clients c ON c.id = a.client_id
   WHERE fh.id=? AND ${scope.sql}`,
 ).get(id, ...scope.params);
}

/** One sign-off record, resolved through assessment → client → org. */
export async function findSignOffInOrg(id, user) {
 const scope = orgPredicate(user, 'c.org_id');
 return await db.prepare(
  `SELECT s.* FROM sign_offs s
   JOIN assessments a ON a.id = s.assessment_id
   JOIN clients c ON c.id = a.client_id
   WHERE s.id=? AND ${scope.sql}`,
 ).get(id, ...scope.params);
}

/** One progress report, resolved through assessment → client → org. */
export async function findProgressReportInOrg(id, user) {
 const scope = orgPredicate(user, 'c.org_id');
 return await db.prepare(
  `SELECT pr.* FROM progress_reports pr
   JOIN assessments a ON a.id = pr.assessment_id
   JOIN clients c ON c.id = a.client_id
   WHERE pr.id=? AND ${scope.sql}`,
 ).get(id, ...scope.params);
}

// --- Users -----------------------------------------------------------------
/** Users the caller may administer: their own organization, or all for a
 *  platform admin. User *management* (invitations, seat changes) is pass 2;
 *  this exists so the existing admin endpoints cannot be used to read or edit
 *  another organization's accounts. */
export async function listUsersInOrg(user) {
 const scope = orgPredicate(user, 'org_id');
 return await db.prepare(
  `SELECT id, username, email, role, display_name, active, org_id, is_platform_admin, created_at, updated_at
   FROM users WHERE ${scope.sql} ORDER BY username`,
 ).all(...scope.params);
}

/** One user, only if they belong to the caller's organization. */
export async function findUserInOrg(id, user) {
 const scope = orgPredicate(user, 'org_id');
 return await db.prepare(`SELECT * FROM users WHERE id=? AND ${scope.sql}`).get(id, ...scope.params);
}
