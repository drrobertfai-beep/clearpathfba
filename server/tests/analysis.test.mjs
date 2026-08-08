// Quick unit tests for the analysis engine (run: node --input-type=module tests/analysis.test.mjs)
import assert from 'node:assert';
import { analyzeBehavior, functionForPoint, describeStats, countAbc, topN } from '../src/analysis.js';

const P = (o) => ({ measurement_type: 'frequency', value: 1, setting: 'classroom', ...o });
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('ok -', name); };

// 1. consequence preferred over antecedent when both present
t('consequence wins over antecedent', () => {
  assert.strictEqual(functionForPoint(P({ antecedent: 'demand_task', consequence: 'attention_given' })), 'attention');
  assert.strictEqual(functionForPoint(P({ antecedent: 'demand_task', consequence: 'escape_removed_demand' })), 'escape');
  assert.strictEqual(functionForPoint(P({ antecedent: 'attention_diverted' })), 'attention');
  assert.strictEqual(functionForPoint(P({ antecedent: 'denied_access' })), 'tangible');
  assert.strictEqual(functionForPoint(P({ antecedent: 'unstructured_time' })), 'automatic');
  assert.strictEqual(functionForPoint(P({ consequence: 'sensory_stimulation' })), 'automatic');
  assert.strictEqual(functionForPoint(P({ antecedent: 'peer_interaction', consequence: 'redirected' })), null);
});

// 2. clear escape pattern -> escape, confidence = support/total
t('escape pattern', () => {
  const pts = [
    ...Array.from({ length: 6 }, () => P({ antecedent: 'demand_task', consequence: 'escape_removed_demand' })),
    ...Array.from({ length: 2 }, () => P({ antecedent: 'demand_task', consequence: 'attention_given' })),
  ];
  const r = analyzeBehavior(1, pts);
  assert.strictEqual(r.function, 'escape');
  assert.strictEqual(r.confidence, 0.75);
  assert.strictEqual(r.stats.frequency.total, 8);
});

// 3. tie 2/2/2 -> multiple
t('near-equal support -> multiple', () => {
  const pts = [
    ...Array.from({ length: 2 }, () => P({ antecedent: 'transition', consequence: 'escape_removed_demand' })),
    ...Array.from({ length: 2 }, () => P({ antecedent: 'attention_diverted', consequence: 'attention_given' })),
    ...Array.from({ length: 2 }, () => P({ antecedent: 'denied_access', consequence: 'access_preferred_item' })),
  ];
  const r = analyzeBehavior(1, pts);
  assert.strictEqual(r.function, 'multiple');
  assert.strictEqual(r.confidence, Math.round(2 / 6 * 100) / 100);
});

// 4. boundary: diff exactly 0.10 -> multiple; 0.11 -> single
t('0.10 boundary', () => {
  const mk = (e, a) => [...Array.from({ length: e }, () => P({ consequence: 'escape_removed_demand' })), ...Array.from({ length: a }, () => P({ consequence: 'attention_given' }))];
  const mk3 = (e, a, n) => [...mk(e, a), ...Array.from({ length: n }, () => P({}))];
  // 11 pts: 6 escape / 5 attention -> 0.545 / 0.455 -> diff .09 -> multiple
  assert.strictEqual(analyzeBehavior(1, mk(6, 5)).function, 'multiple');
  // 10 pts: 6 escape / 4 attention -> 0.6 / 0.4 -> diff .2 -> escape
  assert.strictEqual(analyzeBehavior(1, mk(6, 4)).function, 'escape');
  // 10 pts: 5 escape / 4 attention / 1 neutral -> 0.5 / 0.4 -> diff exactly .10 -> multiple
  assert.strictEqual(analyzeBehavior(1, mk3(5, 4, 1)).function, 'multiple');
  // 10 pts: 5 escape / 3 attention / 2 neutral -> 0.5 / 0.3 -> diff .2 -> escape
  assert.strictEqual(analyzeBehavior(1, mk3(5, 3, 2)).function, 'escape');
});

// 5. fewer than 3 points -> undetermined
t('insufficient data -> undetermined', () => {
  const r = analyzeBehavior(1, [P({ antecedent: 'demand_task', consequence: 'escape_removed_demand' }), P({ antecedent: 'denied_access', consequence: 'access_preferred_item' })]);
  assert.strictEqual(r.function, 'undetermined');
  assert.strictEqual(r.confidence, 0);
  assert.ok(r.notes.some((n) => n.includes('Insufficient data')));
});

// 6. no ABC pattern -> undetermined
t('no pattern -> undetermined', () => {
  const r = analyzeBehavior(1, [P({ antecedent: 'peer_interaction', consequence: 'redirected' }), P({}), P({}), P({})]);
  assert.strictEqual(r.function, 'undetermined');
  assert.ok(r.notes.some((n) => n.includes('No antecedents')));
});

// 7. stats: frequency total/mean/min/max; duration mean/min/max; mixed types
t('descriptive stats', () => {
  const pts = [
    P({ measurement_type: 'frequency', value: 2 }),
    P({ measurement_type: 'frequency', value: 4 }),
    P({ measurement_type: 'frequency', value: 6 }),
    P({ measurement_type: 'duration', value: 10 }),
    P({ measurement_type: 'duration', value: 20 }),
  ];
  const s = describeStats(pts);
  assert.deepStrictEqual(s.frequency, { count: 3, total: 12, mean: 4, min: 2, max: 6 });
  assert.deepStrictEqual(s.duration, { count: 2, mean: 15, min: 10, max: 20 });
});

// 8. countAbc + topN
t('ABC counts and topN', () => {
  const pts = [P({ antecedent: 'demand_task', consequence: 'escape_removed_demand' }), P({ antecedent: 'demand_task', consequence: 'attention_given' }), P({ consequence: 'attention_given' })];
  const { antecedent_counts, consequence_counts } = countAbc(pts);
  assert.deepStrictEqual(antecedent_counts, { demand_task: 2 });
  assert.deepStrictEqual(consequence_counts, { escape_removed_demand: 1, attention_given: 2 });
  assert.deepStrictEqual(topN(consequence_counts, 3), [{ code: 'attention_given', count: 2 }, { code: 'escape_removed_demand', count: 1 }]);
});

// 9. data completeness
t('data completeness', () => {
  const r = analyzeBehavior(1, [P({ setting: 'classroom', antecedent: 'demand_task', consequence: 'escape_removed_demand' }), P({ setting: 'classroom', antecedent: 'demand_task' }), P({ setting: 'classroom', antecedent: 'demand_task', consequence: 'escape_removed_demand' })]);
  assert.strictEqual(r.data_completeness, Math.round(2 / 3 * 100) / 100);
  assert.ok(r.notes.some((n) => n.includes('Data completeness')));
});

console.log(`\nAll ${passed} tests passed.`);
