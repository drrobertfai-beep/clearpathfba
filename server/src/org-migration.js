// ClearPathFBA — organization scoping migration (pass 1 of 3).
//
// Adds the `organizations` table and an `org_id` on `users` and `clients`, then
// backfills every existing row. Nothing else carries org_id: assessments,
// target behaviors, data points, function hypotheses, sign-offs and progress
// reports all reach their organization through `clients.org_id` (see org.js).
//
// Two kinds of work happen here:
//
//  1. ALWAYS-RUN backfill (idempotent, cheap, safe on every boot)
//       - ensure the default organization and the demo organization exist
//       - any user/client with a NULL org_id joins the default organization
//       - the platform-admin flag is set for the owner's account
//     These statements are written so re-running them is a no-op.
//
//  2. ONE-TIME data move (guarded by the schema_migrations marker)
//       - the demo workspace (the demo user + every client flagged
//         dbhds_flags.demo === true) moves to the demo organization
//     Guarded because it is *not* idempotent in intent: without the marker, a
//     clinician who later flagged a real client `demo: true` would have that
//     record yanked into the sample-data organization on the next boot.
//
// Both backends run this: db.js calls runOrgMigration() as part of `db.ready`
// (SQLite: right after the schema is created; Postgres: inside the pooled
// boot path), so `await db.ready` means "schema + organization backfill done".
// It can also be run on demand against any database:
//   DATABASE_URL=postgres://… node server/scripts/migrate-organizations.mjs
//
// The module takes the data layer as a parameter instead of importing db.js so
// db.js can call it without a circular import.

/** Marker row recorded in schema_migrations once the one-time move has run. */
export const ORG_MIGRATION_ID = '001_organizations';

export const DEFAULT_ORG = { name: 'ClearPathFBA', slug: 'default' };
export const DEMO_ORG = { name: 'ClearPathFBA Demo (Sample Data)', slug: 'demo' };

/** The demo workspace account (created by server/scripts/seed-demo.mjs). */
export const DEMO_USERNAME = 'demo@clearpathfba.com';

/**
 * Accounts that may cross organization boundaries. This is deliberately a
 * separate, explicit flag (`users.is_platform_admin`) rather than a role, so
 * who can see every organization is visible in the users table and in the
 * audit trail instead of hiding inside `role = 'admin'`.
 */
export const PLATFORM_ADMIN_ACCOUNTS = ['hello@clearpathfba.com'];

const isUnique = (err) => String(err && err.message).includes('UNIQUE');

/**
 * Look up an organization by slug, creating it when missing. Idempotent: a
 * concurrent creator that wins the unique race is treated as success.
 * @returns {Promise<object>} the organization row
 */
export async function ensureOrg(database, { name, slug }) {
  const existing = await database.prepare('SELECT * FROM organizations WHERE slug=?').get(slug);
  if (existing) return existing;
  try {
    await database.prepare("INSERT INTO organizations (name, slug, status) VALUES (?, ?, 'active')").run(name, slug);
  } catch (err) {
    if (!isUnique(err)) throw err;
  }
  return await database.prepare('SELECT * FROM organizations WHERE slug=?').get(slug);
}

/**
 * Idempotent backfill that runs on every boot: the two well-known
 * organizations, org_id on every legacy user/client row, and the
 * platform-admin flag on the owner's account.
 */
export async function backfillOrganizations(database) {
  const defaultOrg = await ensureOrg(database, DEFAULT_ORG);
  await ensureOrg(database, DEMO_ORG);
  // Legacy rows (and rows written by any code path that has not learned about
  // organizations yet) join the default organization rather than becoming
  // invisible: an org-less row would fail closed in org.js.
  await database.prepare('UPDATE users SET org_id=? WHERE org_id IS NULL').run(defaultOrg.id);
  await database.prepare('UPDATE clients SET org_id=? WHERE org_id IS NULL').run(defaultOrg.id);
  // Never cleared automatically — revoking platform-admin access is a manual,
  // auditable UPDATE so an accidental migration run cannot silently widen it.
  for (const account of PLATFORM_ADMIN_ACCOUNTS) {
    await database.prepare('UPDATE users SET is_platform_admin=1 WHERE lower(email)=? OR lower(username)=?')
      .run(account, account);
  }
  return defaultOrg;
}

/**
 * Move the demo workspace into its own organization: the demo user plus every
 * client whose dbhds_flags carry `demo: true` (the marker the demo seed
 * writes). Everything else — including any real client record — stays in the
 * organization it is already in.
 *
 * Exported (not just used by the one-time step) so the test suite can exercise
 * it directly against a fixture.
 * @returns {Promise<{org: object, clientIds: number[]}>}
 */
export async function relocateDemoWorkspace(database) {
  const org = await ensureOrg(database, DEMO_ORG);
  const clients = await database.prepare('SELECT id, dbhds_flags FROM clients').all();
  const clientIds = [];
  for (const client of clients) {
    let flags = {};
    try { flags = JSON.parse(client.dbhds_flags || '{}'); } catch { flags = {}; }
    // JSON is parsed in JS rather than with json_extract / ->> so the SQL is
    // identical on SQLite and Postgres, and a malformed flags blob on a legacy
    // row can never abort the migration.
    if (flags && flags.demo === true) clientIds.push(client.id);
  }
  for (const id of clientIds) {
    await database.prepare('UPDATE clients SET org_id=? WHERE id=?').run(org.id, id);
  }
  await database.prepare('UPDATE users SET org_id=? WHERE lower(username)=? OR lower(email)=?')
    .run(org.id, DEMO_USERNAME, DEMO_USERNAME);
  return { org, clientIds };
}

/**
 * Run the whole organization migration. Safe to call on every boot.
 * @param {{prepare: Function}} database data layer (db.js surface, or a
 *   pool-backed adapter with the same prepare().get/all/run shape)
 * @returns {Promise<{defaultOrg: object, demoOrg: object, movedClientIds: number[], alreadyApplied: boolean}>}
 */
export async function runOrgMigration(database) {
  const defaultOrg = await backfillOrganizations(database);
  const demoOrg = await ensureOrg(database, DEMO_ORG);
  const applied = await database.prepare('SELECT id FROM schema_migrations WHERE id=?').get(ORG_MIGRATION_ID);
  if (applied) return { defaultOrg, demoOrg, movedClientIds: [], alreadyApplied: true };
  const { clientIds } = await relocateDemoWorkspace(database);
  try {
    await database.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(ORG_MIGRATION_ID);
  } catch (err) {
    // Two instances booting at once: the other one recorded the marker.
    if (!isUnique(err)) throw err;
  }
  return { defaultOrg, demoOrg, movedClientIds: clientIds, alreadyApplied: false };
}
