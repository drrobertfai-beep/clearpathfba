import test from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';

test('login_security INSERT works through the adapter without an id column', async () => {
 await db.ready;
 const username = `db-regression-${Date.now()}-${Math.random()}`;
 try {
  const result = await db.prepare(
   'INSERT INTO login_security (username, failed_count, locked_until) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET failed_count=login_security.failed_count+1, updated_at=CURRENT_TIMESTAMP',
  ).run(username, 1, null);
  assert.equal(result.changes, 1);
  if (db.mode === 'postgres') assert.equal(result.lastInsertRowid, undefined);
  else assert.equal(typeof result.lastInsertRowid, 'number');
 } finally {
  await db.prepare('DELETE FROM login_security WHERE username=?').run(username);
 }
});
