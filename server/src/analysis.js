// ClearPathFBA — rule-based function hypothesis analysis engine.
// Pure, exported functions (no DB, no Express) so the logic is unit-testable.
//
// RULES (documented here; this is the clinical heuristic behind the MVP):
//  1. Each data point is classified as supporting AT MOST ONE candidate function:
//       escape    : antecedent demand_task|transition|reprimand_correction
//                    AND/OR consequence escape_removed_demand|ignored_no_consequence
//       attention : consequence attention_given|peer_attention OR antecedent attention_diverted
//       tangible  : consequence access_preferred_item OR antecedent denied_access
//       automatic : consequence sensory_stimulation OR antecedent sensory_stimulation|unstructured_time
//     When BOTH antecedent and consequence match, the consequence evidence wins
//     (the observed outcome is weighted over the setting context).
//  2. confidence = supporting points / total points for that behavior.
//  3. Fewer than 3 points -> function 'undetermined', confidence 0, note "insufficient data".
//  4. If the top support share and the second share are within 0.10 -> 'multiple'.
//  5. No point matching the rule set -> 'undetermined', note "no ABC pattern detected".
// Data quality: data_completeness = share of points where setting+antecedent+consequence
// are all populated; a note is added when incomplete.

import { LABELS } from './vocab.js';

export const FUNCTIONS = ['escape','attention','tangible','automatic','multiple','undetermined'];

const ANTECEDENT_FUNCTION = {
 demand_task: 'escape', transition: 'escape', reprimand_correction: 'escape',
 attention_diverted: 'attention',
 denied_access: 'tangible',
 sensory_stimulation: 'automatic', unstructured_time: 'automatic',
};
const CONSEQUENCE_FUNCTION = {
 escape_removed_demand: 'escape', ignored_no_consequence: 'escape',
 attention_given: 'attention', peer_attention: 'attention',
 access_preferred_item: 'tangible',
 sensory_stimulation: 'automatic',
};

const r2 = (n) => Math.round(n * 100) / 100;
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

/** Which single candidate function a point supports (null = none). Consequence wins over antecedent. */
export function functionForPoint(p) {
 if (!p) return null;
 const con = p.consequence ? CONSEQUENCE_FUNCTION[p.consequence] : null;
 if (con) return con;
 const ant = p.antecedent ? ANTECEDENT_FUNCTION[p.antecedent] : null;
 return ant || null;
}

/** Descriptive stats per measurement type: frequency -> total/mean/min/max; duration/latency -> mean/min/max. */
export function describeStats(points) {
 const byType = {};
 for (const p of points) {
  (byType[p.measurement_type] || (byType[p.measurement_type] = [])).push(p.value);
 }
 const stats = {};
 for (const [type, vals] of Object.entries(byType)) {
  const sorted = [...vals].sort((a, b) => a - b);
  const sum = vals.reduce((a, b) => a + b, 0);
  const base = { count: vals.length, mean: r2(sum / vals.length), min: sorted[0], max: sorted[sorted.length - 1] };
  stats[type] = type === 'frequency' ? { ...base, total: r2(sum) } : base;
 }
 return stats;
}

/** Frequency of each antecedent and each consequence across the points. */
export function countAbc(points) {
 const antecedent_counts = {}, consequence_counts = {};
 for (const p of points) {
  if (p.antecedent) antecedent_counts[p.antecedent] = (antecedent_counts[p.antecedent] || 0) + 1;
  if (p.consequence) consequence_counts[p.consequence] = (consequence_counts[p.consequence] || 0) + 1;
 }
 return { antecedent_counts, consequence_counts };
}

/** Top n codes by count, as [{code,count}], descending. */
export function topN(counts, n = 3) {
 return Object.entries(counts || {})
  .filter(([, c]) => c > 0)
  .sort((a, b) => b[1] - a[1])
  .slice(0, n)
  .map(([code, count]) => ({ code, count }));
}

function buildRationale({ ranked, topFn, topShare, secondShare, total, support, antecedent_counts, consequence_counts }) {
 const label = LABELS.functions[topFn] || topFn;
 const topCon = topN(consequence_counts, 1)[0];
 const topAnt = topN(antecedent_counts, 1)[0];
 let txt;
 if (total < 3) {
  txt = `Too few data points (${total}) for a rule-based function hypothesis.`;
 } else if (topShare === 0) {
  txt = 'No recorded antecedent or consequence matched the rule set (escape / attention / tangible / automatic), so no function pattern could be detected.';
 } else if (topShare - secondShare <= 0.10) {
  const tied = ranked.filter(([, s]) => topShare - s <= 0.10).map(([f]) => LABELS.functions[f] || f).join(' vs ');
  txt = `No single function dominates: ${tied} are within 10 percentage points (${pct(topShare, 1)}% vs ${pct(secondShare, 1)}%). Manual review recommended.`;
 } else {
  const topCount = Math.round(topShare * total);
  txt = `${label} pattern in ${topCount} of ${total} points (${pct(topCount, total)}%)`;
  const seq = [];
  if (topCon && topAnt && ANTECEDENT_FUNCTION[topAnt.code] === topFn) seq.push(`${LABELS.antecedents[topAnt.code] || topAnt.code} → ${LABELS.consequences[topCon.code] || topCon.code}`);
  else if (topCon) seq.push(LABELS.consequences[topCon.code] || topCon.code);
  else if (topAnt && ANTECEDENT_FUNCTION[topAnt.code] === topFn) seq.push(`seen after ${LABELS.antecedents[topAnt.code] || topAnt.code}`);
  if (seq.length) txt += ` — most often ${seq.join(' ')}`;
  txt += '.';
 }
 const supp = Object.entries(support).filter(([, c]) => c > 0).map(([f, c]) => `${LABELS.functions[f] || f} ${c}`).join(', ');
 if (supp) txt += ` Support counts: ${supp}.`;
 return txt;
}

/** Full rule-based analysis for one target behavior. */
export function analyzeBehavior(target_behavior_id, points = []) {
 const total = points.length;
 const support = { escape: 0, attention: 0, tangible: 0, automatic: 0 };
 let complete = 0;
 for (const p of points) {
  const f = functionForPoint(p);
  if (f) support[f] += 1;
  if (p.setting && p.antecedent && p.consequence) complete += 1;
 }
 const data_completeness = total ? r2(complete / total) : 0;
 const { antecedent_counts, consequence_counts } = countAbc(points);
 const stats = describeStats(points);
 const notes = [];
 let fn = 'undetermined';
 let confidence = 0;

 const ranked = Object.entries(support).map(([f, c]) => [f, total ? c / total : 0]).sort((a, b) => b[1] - a[1]);
 const [topFn, topShare] = ranked[0];
 const [, secondShare] = ranked[1] || [null, 0];

 if (total < 3) {
  notes.push(`Insufficient data: only ${total} data point${total === 1 ? '' : 's'} recorded; at least 3 are needed for a reliable hypothesis.`);
 } else if (topShare === 0) {
  notes.push('No antecedents or consequences matching the rule set were recorded, so no function pattern could be detected.');
 } else if (topShare - secondShare <= 0.10) {
  fn = 'multiple';
  confidence = r2(topShare);
  const tied = ranked.filter(([, s]) => topShare - s <= 0.10).map(([f]) => LABELS.functions[f] || f).join(' vs ');
  notes.push(`Ambiguous pattern: ${tied} are nearly equally supported (within 10 percentage points). Manual review recommended.`);
 } else {
  fn = topFn;
  confidence = r2(topShare);
 }
 if (data_completeness < 1 && total > 0) {
  notes.push(`Data completeness: ${complete} of ${total} point${total === 1 ? '' : 's'} (${pct(complete, total)}%) have full ABC context; missing context may bias the hypothesis.`);
 }

 const rationale = buildRationale({ ranked, topFn, topShare, secondShare, total, support, antecedent_counts, consequence_counts });
 const evidence = { antecedent_counts, consequence_counts, function_support: support, rationale, data_completeness, stats, notes, point_count: total };
 return {
  target_behavior_id, function: fn, confidence,
  top_antecedents: topN(antecedent_counts, 3), top_consequences: topN(consequence_counts, 3),
  stats, data_completeness, notes, evidence,
 };
}

/** Run the engine across all behaviors of an assessment (behaviors: [{id}], points: data_point rows). */
export function analyzeAssessment(behaviors, points) {
 const byBehavior = new Map();
 for (const p of points) {
  if (!byBehavior.has(p.target_behavior_id)) byBehavior.set(p.target_behavior_id, []);
  byBehavior.get(p.target_behavior_id).push(p);
 }
 return behaviors.map((b) => analyzeBehavior(b.id, byBehavior.get(b.id) || []));
}
