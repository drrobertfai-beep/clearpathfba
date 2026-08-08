// ClearPathFBA — boot retry/backoff unit tests (node --test).
// The serverless cold-start fix retries the bootstrap with a delay between
// attempts so a suspended Neon compute has time to wake. These tests inject a
// fake failing bootstrap + fake sleep to verify the loop behavior in isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBootWithRetry } from '../src/boot-retry.js';

const failing = (msg, code) => {
 const e = new Error(msg);
 if (code) e.code = code;
 throw e;
};

test('succeeds on the first attempt when bootstrap is healthy', async () => {
 let calls = 0;
 const boot = createBootWithRetry({
  retries: 8, delayMs: 1000,
  bootstrapFn: async () => { calls += 1; return 'ok'; },
 });
 assert.equal(await boot(), 'ok');
 assert.equal(calls, 1);
});

test('retries a failing bootstrap and succeeds once the DB wakes', async () => {
 let calls = 0;
 const failures = 3;
 const attempts = [];
 const boot = createBootWithRetry({
  retries: 8, delayMs: 2,
  bootstrapFn: async () => {
   calls += 1;
   attempts.push(calls);
   if (calls <= failures) failing('Client network socket disconnected before secure TLS connection was established', 'ECONNRESET');
   return 'recovered';
  },
  onFail: (attempt, total, err) => {
   assert.equal(total, 8);
   assert.equal(err.code, 'ECONNRESET');
  },
 });
 assert.equal(await boot(), 'recovered');
 assert.equal(calls, failures + 1);
 assert.deepEqual(attempts, [1, 2, 3, 4]);
});

test('throws the last error when all retries are exhausted', async () => {
 let calls = 0;
 const boot = createBootWithRetry({
  retries: 3, delayMs: 1,
  bootstrapFn: async () => { calls += 1; failing('boom'); },
 });
 await assert.rejects(boot, /boom/);
 assert.equal(calls, 3);
});

test('waits the delay between attempts, but not after the final one', async () => {
 const sleeps = [];
 const boot = createBootWithRetry({
  retries: 3, delayMs: 5,
  sleep: async (ms) => { sleeps.push(ms); },
  bootstrapFn: async () => { failing('x'); },
 });
 await assert.rejects(boot);
 assert.deepEqual(sleeps, [5, 5]); // after attempts 1 and 2 only
});

test('reports each failure through onFail with 1-based attempt numbering', async () => {
 const seen = [];
 const boot = createBootWithRetry({
  retries: 4, delayMs: 1,
  onFail: (attempt, total) => seen.push(`${attempt}/${total}`),
  bootstrapFn: async () => { failing('nope'); },
 });
 await assert.rejects(boot);
 assert.deepEqual(seen, ['1/4', '2/4', '3/4', '4/4']);
});
