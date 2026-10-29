#!/usr/bin/env node
/**
 * ClearPathFBA — run the organization-scoping migration on demand.
 *
 * The migration itself runs automatically at boot (`await db.ready` in db.js),
 * so this script is for running it deliberately — e.g. against the production
 * Postgres database during a deploy window — and for printing the resulting
 * state so the result can be reviewed.
 *
 * Usage (from the repository root):
 *   DATABASE_URL=postgres://… node server/scripts/migrate-organizations.mjs
 *   node server/scripts/migrate-organizations.mjs        # local SQLite
 *
 * Safe to run any number of times: the org backfill is idempotent and the
 * one-time demo-workspace move is guarded by a schema_migrations marker.
 */
import db from '../src/db.js';

async function main() {
  const target = db.mode === 'postgres'
    ? 'PostgreSQL (DATABASE_URL)'
    : `SQLite (${process.env.DATABASE_PATH || 'data/clearpathfba.sqlite'})`;
  console.log(`ClearPathFBA organization migration — target: ${target}`);
  if (db.mode === 'postgres') console.log('  NOTE: this writes to the database DATABASE_URL points at.');

  await db.ready; // schema + organization backfill (db.js runs the migration here)

  const orgs = await db.prepare('SELECT id, name, slug, status, created_at FROM organizations ORDER BY id').all();
  console.log('\nOrganizations:');
  for (const o of orgs) {
    const clients = (await db.prepare('SELECT COUNT(*) AS n FROM clients WHERE org_id=?').get(o.id)).n;
    const users = (await db.prepare('SELECT COUNT(*) AS n FROM users WHERE org_id=?').get(o.id)).n;
    console.log(`  #${o.id} ${o.slug.padEnd(10)} ${o.name} — ${users} user(s), ${clients} client(s)`);
  }

  const marker = await db.prepare('SELECT id, applied_at FROM schema_migrations WHERE id=?').get('001_organizations');
  console.log(`\nOne-time demo-workspace move: ${marker ? `applied ${marker.applied_at}` : 'NOT applied'}`);

  const orphanClients = (await db.prepare('SELECT COUNT(*) AS n FROM clients WHERE org_id IS NULL').get()).n;
  const orphanUsers = (await db.prepare('SELECT COUNT(*) AS n FROM users WHERE org_id IS NULL').get()).n;
  const admins = await db.prepare('SELECT username, email FROM users WHERE is_platform_admin=1 ORDER BY id').all();
  console.log(`Clients without an organization: ${orphanClients}`);
  console.log(`Users without an organization:   ${orphanUsers}`);
  console.log(`Platform admins: ${admins.length ? admins.map((a) => a.email || a.username).join(', ') : '(none)'}`);

  if (orphanClients || orphanUsers) {
    console.error('\nFAILED: some rows still have no organization — they would be invisible to every non-platform admin.');
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((err) => {
    console.error('\nOrganization migration failed:', err && err.message ? err.message : err);
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
