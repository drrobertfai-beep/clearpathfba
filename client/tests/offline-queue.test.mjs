// Unit tests for the offline queue's pure logic (operation records, ordering,
// dedupe, legacy migration mapping). No browser needed: these functions don't
// touch IndexedDB/localStorage. Run with:  node tests/offline-queue.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOperation, legacyToOperation, operationToView, sortOps, dedupeOperations, buildEditOperation,
} from '../src/offline.js';

const payload = {
  assessment_id: 7,
  target_behavior_id: 12,
  recorded_at: '2026-08-08T10:00:00',
  measurement_type: 'frequency',
  value: 3,
  setting: 'classroom',
  antecedent: 'demand',
  consequence: 'escape',
  notes: 'E2E marker',
};

test('buildOperation creates a full forward-compatible operation record', () => {
  const op = buildOperation(payload);
  assert.ok(op.id && typeof op.id === 'string' && op.id.length > 0, 'has client uuid');
  assert.equal(op.kind, 'data-point');
  assert.equal(op.method, 'POST');
  assert.equal(op.endpoint, '/api/assessments/7/data-points');
  assert.equal(op.assessment_id, 7);
  assert.deepEqual(op.body, {
    target_behavior_id: 12,
    recorded_at: '2026-08-08T10:00:00',
    measurement_type: 'frequency',
    value: 3,
    setting: 'classroom',
    antecedent: 'demand',
    consequence: 'escape',
    notes: 'E2E marker',
  });
  assert.equal(op.attempts, 0);
  assert.equal(op.last_error, null);
  assert.ok(!Number.isNaN(Date.parse(op.queued_at)), 'queued_at is an ISO timestamp');
  // distinct ids
  assert.notEqual(buildOperation(payload).id, buildOperation(payload).id);
});

test('buildOperation defaults queued_at and blanks missing ABC fields', () => {
  const op = buildOperation({ ...payload, queued_at: '2026-01-01T00:00:00Z', setting: undefined, notes: undefined });
  assert.equal(op.queued_at, '2026-01-01T00:00:00Z');
  assert.equal(op.body.setting, '');
  assert.equal(op.body.notes, '');
});

test('legacyToOperation preserves clientUuid and queued_at through migration', () => {
  const legacy = {
    clientUuid: 'abc-123',
    queued_at: '2026-07-01T09:30:00.000Z',
    assessment_id: 3,
    target_behavior_id: 5,
    recorded_at: '2026-07-01T09:30:00',
    measurement_type: 'duration',
    value: 42,
    setting: '',
    antecedent: 'attention',
    consequence: '',
    notes: 'old point',
  };
  const op = legacyToOperation(legacy);
  assert.equal(op.id, 'abc-123');
  assert.equal(op.queued_at, '2026-07-01T09:30:00.000Z');
  assert.equal(op.kind, 'data-point');
  assert.equal(op.method, 'POST');
  assert.equal(op.endpoint, '/api/assessments/3/data-points');
  assert.equal(op.assessment_id, 3);
  assert.equal(op.body.target_behavior_id, 5);
  assert.equal(op.body.antecedent, 'attention');
  assert.equal(op.body.notes, 'old point');
  assert.equal(op.attempts, 0);
  assert.equal(op.last_error, null);
});

test('operationToView restores the App.jsx-facing shape (clientUuid + body fields)', () => {
  const op = buildOperation(payload);
  const view = operationToView(op);
  assert.equal(view.clientUuid, op.id);
  assert.equal(view.assessment_id, 7);
  assert.equal(view.target_behavior_id, 12);
  assert.equal(view.recorded_at, '2026-08-08T10:00:00');
  assert.equal(view.measurement_type, 'frequency');
  assert.equal(view.value, 3);
  assert.equal(view.setting, 'classroom');
  assert.equal(view.antecedent, 'demand');
  assert.equal(view.consequence, 'escape');
  assert.equal(view.notes, 'E2E marker');
  assert.equal(view.queued_at, op.queued_at);
  // operation fields stay available for future conflict resolution
  assert.equal(view.kind, 'data-point');
  assert.equal(view.endpoint, '/api/assessments/7/data-points');
  assert.equal(view.attempts, 0);
});

test('legacy → operation → view round-trip keeps every UI field intact', () => {
  const legacy = {
    clientUuid: 'rt-1', queued_at: '2026-06-01T00:00:00.000Z', assessment_id: 2,
    target_behavior_id: 9, recorded_at: '2026-06-01T08:00:00', measurement_type: 'latency',
    value: 12.5, setting: 'home', antecedent: 'transition', consequence: 'tangible', notes: 'rt',
  };
  const view = operationToView(legacyToOperation(legacy));
  assert.equal(view.clientUuid, 'rt-1');
  assert.equal(view.queued_at, '2026-06-01T00:00:00.000Z');
  assert.equal(view.assessment_id, 2);
  assert.equal(view.target_behavior_id, 9);
  assert.equal(view.recorded_at, '2026-06-01T08:00:00');
  assert.equal(view.measurement_type, 'latency');
  assert.equal(view.value, 12.5);
  assert.equal(view.setting, 'home');
  assert.equal(view.antecedent, 'transition');
  assert.equal(view.consequence, 'tangible');
  assert.equal(view.notes, 'rt');
});

test('sortOps orders FIFO by queued_at with id tiebreak', () => {
  const ops = [
    { id: 'b', queued_at: '2026-08-08T12:00:00Z', kind: 'data-point' },
    { id: 'a', queued_at: '2026-08-08T10:00:00Z', kind: 'data-point' },
    { id: 'c', queued_at: '2026-08-08T11:00:00Z', kind: 'data-point' },
  ];
  const sorted = sortOps(ops).map((o) => o.id);
  assert.deepEqual(sorted, ['a', 'c', 'b']);
  // input array untouched
  assert.equal(ops[0].id, 'b');
  // same-timestamp tiebreak
  const tied = sortOps([
    { id: 'z', queued_at: '2026-08-08T10:00:00Z' },
    { id: 'a', queued_at: '2026-08-08T10:00:00Z' },
  ]).map((o) => o.id);
  assert.deepEqual(tied, ['a', 'z']);
});

test('dedupeOperations skips existing ids, malformed entries, and intra-list dupes', () => {
  const legacy = [
    { clientUuid: 'dup-1', assessment_id: 1, target_behavior_id: 1, recorded_at: 'x', measurement_type: 'frequency', value: 1, queued_at: '2026-01-01T00:00:00Z' },
    { clientUuid: 'dup-1', assessment_id: 1, target_behavior_id: 1, recorded_at: 'x', measurement_type: 'frequency', value: 1, queued_at: '2026-01-01T00:00:00Z' }, // dupe inside list
    { clientUuid: 'already-there', assessment_id: 2, target_behavior_id: 2, recorded_at: 'y', measurement_type: 'frequency', value: 2, queued_at: '2026-01-02T00:00:00Z' },
    null, // malformed
    { clientUuid: '', assessment_id: 3, target_behavior_id: 3, recorded_at: 'z', measurement_type: 'frequency', value: 3, queued_at: '2026-01-03T00:00:00Z' }, // no id
    { clientUuid: 'fresh-1', assessment_id: 4, target_behavior_id: 4, recorded_at: 'w', measurement_type: 'frequency', value: 4, queued_at: '2026-01-04T00:00:00Z' },
  ];
  const ops = dedupeOperations(legacy, ['already-there', 'unrelated-existing']);
  assert.deepEqual(ops.map((o) => o.id), ['dup-1', 'fresh-1']);
  assert.equal(ops[0].assessment_id, 1);
  assert.equal(ops[0].kind, 'data-point');
  assert.equal(ops[0].method, 'POST');
  assert.equal(ops[1].endpoint, '/api/assessments/4/data-points');
  assert.deepEqual(dedupeOperations([], []), []);
  assert.deepEqual(dedupeOperations(undefined, []), []);
});

test('edit operation carries optimistic concurrency base and starts pending', () => {
  const op = buildEditOperation({kind:'client', endpoint:'/api/clients/9', body:{first_name:'Mine'}, record:{id:9,updated_at:'2026-08-08 10:00:00'}, queued_at:'2026-08-08T11:00:00Z'});
  assert.equal(op.status, 'pending');
  assert.equal(op.body.base_updated_at, '2026-08-08 10:00:00');
  assert.equal(op.server_record, null);
});
