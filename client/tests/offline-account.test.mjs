// Account scoping of the offline queue (residual item 3 of the organization
// isolation attack report): queued operations are stamped with the account that
// created them, only that account's operations are shown and replayed, and
// sign-out purges the account's queue + cached client data.
//
// Runs in Node with a localStorage stub and a stubbed fetch; IndexedDB writes
// are best-effort in the module and are simply absent here. Run with:
//   node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
  key: (i) => Array.from(store.keys())[i] ?? null,
  get length() { return store.size; },
};

const posted = [];
globalThis.fetch = async (url, opts) => {
  posted.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization });
  return { ok: true, status: 200, json: async () => ({}) };
};

const {
  buildOperation, enqueuePoint, getQueue, getState, flushQueue, purgeAccount,
  currentAccountId, cacheBehaviors, getCachedBehaviors,
} = await import('../src/offline.js');

function signInAs(id) {
  store.set('clearpath_user', JSON.stringify({ id, username: `user${id}` }));
  store.set('clearpath_token', `tok-${id}`);
}
function signOutLocally() {
  store.delete('clearpath_user');
  store.delete('clearpath_token');
}
const point = (n) => ({
  assessment_id: 7, target_behavior_id: 12, recorded_at: `2026-08-08T10:00:0${n}`,
  measurement_type: 'frequency', value: n, notes: `PHI-${n}`,
});

test('a queued operation is stamped with the signed-in account', () => {
  signInAs(1);
  assert.equal(currentAccountId(), '1');
  const op = buildOperation(point(1));
  assert.equal(op.account_id, '1');
  // explicit account wins over the ambient one
  assert.equal(buildOperation({ ...point(2), account_id: 9 }).account_id, '9');
});

test("another account's queue is invisible and is never replayed", async () => {
  signInAs(1);
  enqueuePoint(point(1));
  enqueuePoint(point(2));
  assert.equal(getQueue().length, 2);

  signInAs(2);
  assert.equal(getQueue().length, 0, "account 2 must not see account 1's unsynced PHI");
  assert.deepEqual(getState().pending, 0);
  assert.deepEqual(getState().conflicted, 0);

  enqueuePoint(point(3));
  posted.length = 0;
  const r = await flushQueue();
  assert.equal(r.synced, 1);
  assert.equal(posted.length, 1, "only account 2's operation is posted");
  assert.equal(posted[0].body.notes, 'PHI-3');
  assert.equal(posted[0].auth, 'Bearer tok-2');
  assert.equal(getQueue().length, 0);

  // Back as account 1: its two operations are still there and now replay.
  signInAs(1);
  assert.equal(getQueue().length, 2);
  posted.length = 0;
  const r1 = await flushQueue();
  assert.equal(r1.synced, 2);
  assert.deepEqual(posted.map((p) => p.body.notes).sort(), ['PHI-1', 'PHI-2']);
  assert.equal(posted[0].auth, 'Bearer tok-1');
});

test('nothing is replayed when no account is signed in', async () => {
  signInAs(1);
  enqueuePoint(point(4));
  signOutLocally();
  posted.length = 0;
  const r = await flushQueue();
  assert.equal(r.synced, 0);
  assert.equal(posted.length, 0);
  assert.equal(getQueue().length, 0);
});

test('purgeAccount removes that account queue and cached client data only', async () => {
  signInAs(1);
  cacheBehaviors(7, [{ id: 12, name: 'Aggression' }]);
  assert.equal(getCachedBehaviors(7).length, 1);
  enqueuePoint(point(5));

  signInAs(2);
  enqueuePoint(point(6));

  await purgeAccount(1);
  // account 2's queued record survives
  assert.equal(getQueue().length, 1);
  assert.equal(getQueue()[0].notes, 'PHI-6');
  // account 1's cached client data is gone
  assert.equal([...store.keys()].some((k) => k.startsWith('clearpath_behaviors_1_')), false);

  signInAs(1);
  assert.equal(getQueue().length, 0);
  assert.equal(getCachedBehaviors(7), null);
});

test('cached client data is scoped per account', () => {
  signInAs(1);
  cacheBehaviors(8, [{ id: 1, name: 'Account one behavior' }]);
  signInAs(2);
  assert.equal(getCachedBehaviors(8), null);
  cacheBehaviors(8, [{ id: 2, name: 'Account two behavior' }]);
  assert.equal(getCachedBehaviors(8)[0].name, 'Account two behavior');
  signInAs(1);
  assert.equal(getCachedBehaviors(8)[0].name, 'Account one behavior');
});
