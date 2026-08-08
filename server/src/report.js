// ClearPathFBA — server-side FBA report assembly (GET /api/assessments/:id/report).
// Builds one structured JSON payload from an assessment's clients, behaviors,
// data points and stored function hypotheses. Pure assembly on top of db.js;
// reuses analysis.js helpers (describeStats, countAbc, topN) so report numbers
// always match what the analysis engine would compute.
import db from './db.js';
import { LABELS } from './vocab.js';
import { describeStats, countAbc, topN } from './analysis.js';
import { signOffsFor } from './audit.js';

const consentLabels = { not_started: 'Not started', in_progress: 'In progress', obtained: 'Obtained', declined: 'Declined' };
const statusLabels = { draft: 'Draft', in_progress: 'In progress', completed: 'Completed' };
const safetyLabels = { none: 'None', self_injury: 'Self-injury', aggression: 'Aggression', elopement: 'Elopement', property_damage: 'Property damage', other: 'Other' };
const hypStatusLabels = { draft: 'Draft', reviewed: 'Reviewed' };

const lab = (map, code) => (map && map[code]) || code;
const parseEvidence = (row) => { try { return JSON.parse(row && row.evidence || '{}'); } catch { return {}; } };
const pct = (n) => Math.round(n * 100);

/** Plain-language interpretation of one hypothesis, derived from its stored evidence JSON. */
function deriveInterpretation(ev, fn, confidence) {
 const total = ev.point_count || 0;
 const support = ev.function_support || {};
 const c = pct(confidence);
 if (total < 3) {
  return `Only ${total} data point${total === 1 ? ' was' : 's were'} recorded for this behavior — fewer than the 3 recommended for a reliable function hypothesis. Continue baseline data collection before drawing conclusions.`;
 }
 if (fn === 'undetermined') {
  return 'No consistent antecedent–consequence pattern was detected in the recorded observations, so no function hypothesis could be formed at this time.';
 }
 if (fn === 'multiple') {
  const ranked = Object.entries(support).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const top = ranked[0] ? ranked[0][1] : 0;
  const ties = ranked.filter(([, n]) => top > 0 && n >= top - Math.ceil(top * 0.1)).map(([f]) => lab(LABELS.functions, f));
  const names = ties.length ? ties.join(' vs ') : 'multiple functions';
  return `Data suggest this behavior may be maintained by more than one function (${names}), with no single function clearly dominating. Confidence: ${c}% based on ${total} recorded observations. Clinical judgment is recommended.`;
 }
 const supportCount = support[fn] || 0;
 const rankedSupport = Object.entries(support).sort((a, b) => b[1] - a[1]);
 const topEntry = rankedSupport[0];
 const topFn = topEntry && topEntry[1] > 0 ? topEntry[0] : null;
 const fnName = lab(LABELS.functions, fn).toLowerCase();
 if (supportCount > 0 && topFn === fn) {
  return `Data suggest this behavior may be maintained by ${fnName}. Confidence: ${c}% based on ${supportCount} of ${total} recorded observations.`;
 }
 // Clinician-set function that the stored rule-based evidence does not put first (an override):
 const overrideNote = topFn
  ? ` Note: the rule-based ABC analysis most strongly supported ${lab(LABELS.functions, topFn).toLowerCase()} (${topEntry[1]} of ${total} observations); the hypothesis above reflects clinician review.`
  : '';
 return `Data suggest this behavior may be maintained by ${fnName}. Confidence: ${c}% (clinician-set) based on ${total} recorded observations.${overrideNote}`;
}

/**
 * Assemble the full report payload for one assessment.
 * @returns {object|null} null when the assessment does not exist.
 */
export function buildReport(assessmentId) {
 const a = db.prepare('SELECT * FROM assessments WHERE id=? AND deleted_at IS NULL').get(assessmentId);
 if (!a) return null;
 const client = db.prepare('SELECT * FROM clients WHERE id=? AND deleted_at IS NULL').get(a.client_id);
 const behaviors = db.prepare('SELECT * FROM target_behaviors WHERE assessment_id=? ORDER BY id').all(assessmentId);
 const points = db.prepare('SELECT * FROM data_points WHERE assessment_id=? ORDER BY recorded_at, id').all(assessmentId);
 const hypRows = db.prepare('SELECT * FROM function_hypotheses WHERE assessment_id=? ORDER BY target_behavior_id').all(assessmentId);

 const byBehavior = new Map(behaviors.map((b) => [b.id, []]));
 for (const p of points) if (byBehavior.has(p.target_behavior_id)) byBehavior.get(p.target_behavior_id).push(p);

 // --- data summary ---
 const total_points = points.length;
 const per_behavior = behaviors.map((b) => ({
  target_behavior_id: b.id, target_behavior_name: b.name, count: byBehavior.get(b.id).length,
 }));
 const mt = {};
 for (const p of points) mt[p.measurement_type] = (mt[p.measurement_type] || 0) + 1;
 const per_measurement_type = Object.entries(mt)
  .map(([measurement_type, count]) => ({ measurement_type, label: lab(LABELS.measurementTypes, measurement_type), count }))
  .sort((x, y) => y.count - x.count);
 const per_behavior_stats = behaviors.map((b) => ({
  target_behavior_id: b.id, target_behavior_name: b.name, stats: describeStats(byBehavior.get(b.id)),
 }));

 // --- ABC analysis (fresh from data points) ---
 const abc = behaviors.map((b) => {
  const pts = byBehavior.get(b.id);
  const { antecedent_counts, consequence_counts } = countAbc(pts);
  return {
   target_behavior_id: b.id, target_behavior_name: b.name,
   top_antecedents: topN(antecedent_counts, 3).map((x) => ({ ...x, label: lab(LABELS.antecedents, x.code) })),
   top_consequences: topN(consequence_counts, 3).map((x) => ({ ...x, label: lab(LABELS.consequences, x.code) })),
  };
 });

 // --- hypotheses (from stored rows + evidence JSON) ---
 const hypotheses = hypRows.map((h) => {
  const ev = parseEvidence(h);
  return {
   target_behavior_id: h.target_behavior_id,
   target_behavior_name: (behaviors.find((b) => b.id === h.target_behavior_id) || {}).name || 'Unknown behavior',
   function: h.function, function_label: lab(LABELS.functions, h.function),
   confidence: h.confidence, status: h.status, status_label: lab(hypStatusLabels, h.status),
   rationale: ev.rationale || null,
   interpretation: deriveInterpretation(ev, h.function, h.confidence),
   top_antecedents: topN(ev.antecedent_counts, 3).map((x) => ({ ...x, label: lab(LABELS.antecedents, x.code) })),
   top_consequences: topN(ev.consequence_counts, 3).map((x) => ({ ...x, label: lab(LABELS.consequences, x.code) })),
   data_completeness: typeof ev.data_completeness === 'number' ? ev.data_completeness : 0,
   stats: ev.stats || {},
   notes: Array.isArray(ev.notes) ? ev.notes : [],
   point_count: ev.point_count || 0,
  };
 });

 // --- data quality ---
 let complete = 0;
 for (const p of points) if (p.setting && p.antecedent && p.consequence) complete += 1;
 const data_completeness = total_points ? Math.round((complete / total_points) * 100) / 100 : 0;
 const dqNotes = [];
 if (!total_points) {
  dqNotes.push('No data points have been recorded for this assessment. The sections below are empty; record ABC baseline data before finalizing the report.');
 } else {
  if (data_completeness < 1) dqNotes.push(`${complete} of ${total_points} data points (${pct(complete / total_points)}%) include full ABC context (setting, antecedent, consequence); missing context may limit pattern detection.`);
  for (const b of behaviors) {
   const n = byBehavior.get(b.id).length;
   if (n > 0 && n < 3) dqNotes.push(`Only ${n} data point${n === 1 ? '' : 's'} recorded for “${b.name}”; at least 3 are recommended for a reliable function hypothesis.`);
  }
  const noHyp = behaviors.filter((b) => !hypRows.some((h) => h.target_behavior_id === b.id));
  if (noHyp.length) dqNotes.push(`No function hypothesis recorded for: ${noHyp.map((b) => b.name).join(', ')}. Run “Generate analysis” once baseline data is collected.`);
  const draftHyps = hypRows.filter((h) => h.status !== 'reviewed');
  if (draftHyps.length) dqNotes.push(`${draftHyps.length} function hypothes${draftHyps.length === 1 ? 'is' : 'es'} ${draftHyps.length === 1 ? 'has' : 'have'} not yet been reviewed by a BCBA.`);
 }

 // --- charts: frequency per day per behavior (sum of frequency-type values per date) ---
 const freqBy = {}; // behaviorId -> { date -> sum }
 const dateSet = new Set();
 for (const p of points) {
  if (p.measurement_type !== 'frequency') continue;
  const d = String(p.recorded_at).slice(0, 10);
  if (!freqBy[p.target_behavior_id]) freqBy[p.target_behavior_id] = {};
  freqBy[p.target_behavior_id][d] = (freqBy[p.target_behavior_id][d] || 0) + p.value;
  dateSet.add(d);
 }
 const dates = [...dateSet].sort();
 const chartSeries = behaviors.map((b) => ({
  target_behavior_id: b.id, target_behavior_name: b.name, values: dates.map((d) => freqBy[b.id] && freqBy[b.id][d] || 0),
 }));

 return {
  client: client ? {
   id: client.id, first_name: client.first_name, last_name: client.last_name,
   date_of_birth: client.date_of_birth, gender: client.gender,
   consent_status: client.consent_status, consent_status_label: lab(consentLabels, client.consent_status),
  } : null,
  assessment: {
   id: a.id, title: a.title, assessment_date: a.assessment_date, assessor: a.assessor,
   status: a.status, status_label: lab(statusLabels, a.status), notes: a.notes,
  },
  behaviors: behaviors.map((b) => ({
   id: b.id, name: b.name, operational_definition: b.operational_definition,
   safety_classification: b.safety_classification, safety_classification_label: lab(safetyLabels, b.safety_classification),
   is_safety_concern: !!b.is_safety_concern,
   baseline_measurement_type: b.baseline_measurement_type,
   baseline_measurement_type_label: b.baseline_measurement_type ? lab(LABELS.measurementTypes, b.baseline_measurement_type) : null,
  })),
  data_summary: {
   total_points,
   observation_start: total_points ? points[0].recorded_at : null,
   observation_end: total_points ? points[points.length - 1].recorded_at : null,
   per_behavior, per_measurement_type, per_behavior_stats,
  },
  abc,
  hypotheses,
  data_quality: { data_completeness, notes: dqNotes },
  charts: { frequency_per_day: { dates, series: chartSeries } },
  // Signature scaffolding + in-app sign-off records. role_code links the printed
  // line to the sign_offs row (bcba / guardian / supervisor / other).
  signatures: [
   { role: 'BCBA / Behavior Analyst', role_code: 'bcba', fields: ['Signature', 'Printed name & credentials', 'Date'] },
   { role: 'Parent / Guardian', role_code: 'guardian', fields: ['Signature', 'Printed name', 'Date'] },
  ],
  sign_offs: signOffsFor(assessmentId, 'fba_report'),
  generated_at: new Date().toISOString(),
  is_preliminary: a.status !== 'completed',
 };
}
