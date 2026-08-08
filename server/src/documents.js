// ClearPathFBA — server-side assembly of printable support documents:
//   BIP (Behavior Intervention Plan)          GET /api/assessments/:id/bip
//   Crisis Procedure                          GET /api/assessments/:id/crisis-plan
//   Blank observation data sheet(s)           GET /api/assessments/:id/data-sheet
// Mirrors report.js: pure assembly on top of db.js, one builder per document,
// returns null when the assessment does not exist, and produces plain JSON
// payloads that the client renders with the same @media print CSS as the FBA
// report. Strategy text below is static clinical scaffolding for the MVP —
// per-assessment editable strategy fields are a later phase.
import db from './db.js';
import { LABELS } from './vocab.js';
import { signOffsFor } from './audit.js';

const consentLabels = { not_started: 'Not started', in_progress: 'In progress', obtained: 'Obtained', declined: 'Declined' };
const statusLabels = { draft: 'Draft', in_progress: 'In progress', completed: 'Completed' };
const safetyLabels = { none: 'None', self_injury: 'Self-injury', aggression: 'Aggression', elopement: 'Elopement', property_damage: 'Property damage', other: 'Other' };
const hypStatusLabels = { draft: 'Draft', reviewed: 'Reviewed' };
const measurementLabels = LABELS.measurementTypes;
const lab = (map, code) => (map && map[code]) || code;

/** Shared label appended to every auto-suggested strategy: it is a scaffold, not a finalized plan. */
export const SUGGESTED_NOTE = 'Suggested — clinician to review and finalize.';

// ---------------------------------------------------------------------------
// Static function-based strategy maps (MVP).
// These are the clinical starting points a BCBA expects from a function-based
// BIP. They are keyed by the hypothesized function code (escape / attention /
// tangible / automatic / multiple / undetermined) and are intentionally
// generic — the printed plan flags every item with SUGGESTED_NOTE so the
// reviewing clinician owns the final wording. A later phase will persist
// clinician-edited strategies per assessment.
// ---------------------------------------------------------------------------

/** Antecedent (prevention) strategies per hypothesized function. */
const ANTECEDENT_STRATEGIES = {
 escape: [
  'Modify or differentiate task demands to match the individual\'s current skill level.',
  'Offer choices before presenting demands (order of tasks, materials, seating).',
  'Intersperse mastered tasks among more difficult demands to build momentum.',
  'Pre-teach routines and transitions with visual supports and advance warnings.',
 ],
 attention: [
  'Use planned ignoring for minor, non-dangerous attention-seeking behavior (only once the replacement skill is being taught).',
  'Provide non-contingent attention on a fixed schedule (e.g., brief positive contact every few minutes).',
  'Teach delay-of-reinforcement: require a brief wait for attention, then deliver it promptly when the individual requests appropriately.',
 ],
 tangible: [
  'Provide scheduled, non-contingent access to preferred items and activities so access is not dependent on the behavior.',
  'Teach waiting and turn-taking explicitly, using timers and visual supports to make waiting concrete.',
  'Keep preferred items out of sight when they are not available, and pre-schedule when they will be available.',
 ],
 automatic: [
  'Provide a matched sensory replacement that produces similar stimulation in an appropriate way.',
  'Enrich the environment with engaging, sensory-appropriate materials and activities.',
  'Schedule regular sensory breaks to prevent build-up of the need the behavior currently meets.',
 ],
 multiple: [
  'Combine prevention strategies for the candidate functions (see the hypothesis detail) and prioritize the strongest contributors.',
  'Use broad prevention measures (choice, non-contingent reinforcement, demand support) while further assessment refines the function.',
 ],
 undetermined: [
  'Continue structured ABC data collection before finalizing prevention strategies.',
  'Until a function is identified, use generally supportive prevention (clear expectations, predictable routine, engagement, choice) and avoid strategies that could inadvertently reinforce an unknown function.',
 ],
};

/** Replacement (FCT-style) skill suggestion per hypothesized function. */
const REPLACEMENT_SKILLS = {
 escape: 'Teach a functionally equivalent request for a break or help (e.g., “break please”, “help please”, or a picture/sign/device equivalent).',
 attention: 'Teach an appropriate attention-seeking response (e.g., tap shoulder, say the person\'s name, raise a hand, or use a communication device).',
 tangible: 'Teach requesting the item/activity, and tolerating waiting for scheduled access.',
 automatic: 'Teach the individual to request, or move to, a matched sensory activity or break.',
 multiple: 'Teach the primary replacement for the strongest candidate function, then layer additional requests (break, help, attention, item) as data direct.',
 undetermined: 'Defer final replacement-skill selection until the function is identified; meanwhile teach a general “request break / request help” response.',
};

/** Least-to-most prompting note attached to every replacement skill. */
const PROMPTING_NOTE = 'Prompt the replacement skill using a least-to-most hierarchy (independent → gestural → verbal → model → partial physical → full physical), fading support as the individual becomes more independent.';

/** Consequence strategies per hypothesized function. */
const CONSEQUENCE_STRATEGIES = {
 escape: [
  'Keep the demand present — the behavior should not result in escape from the task.',
  'Redirect to the replacement response (e.g., request a break), then honor the request.',
  'Block reinforcement: ensure the behavior does not remove the demand.',
 ],
 attention: [
  'Provide minimal attention during the behavior; avoid lengthy reprimands or discussion.',
  'Deliver a brief, neutral redirect to the replacement response.',
  'Reinforce the replacement response with prompt, contingent attention.',
 ],
 tangible: [
  'Do not provide access to the preferred item following the behavior.',
  'Redirect to the replacement request; when the individual requests appropriately, honor it or provide the scheduled alternative.',
  'Teach and reinforce waiting when the item is unavailable.',
 ],
 automatic: [
  'Interrupt the behavior neutrally and redirect to the matched replacement activity.',
  'Block access to the sensory product of the behavior where possible.',
  'Reinforce engagement with the matched replacement activity.',
 ],
 multiple: [
  'Apply consequence strategies for the strongest candidate function, and ensure the behavior is not reinforced by any candidate function.',
 ],
 undetermined: [
  'Use neutral, minimal responses and avoid reinforcing the behavior; continue structured data collection.',
 ],
};

/** Additional safety step prepended to consequence strategies for safety-flagged behaviors. */
const SAFETY_CONSEQUENCE_STEP = 'Protect the individual and others (block/redirect); call for staff support per the Crisis Procedure.';

// ---------------------------------------------------------------------------
// Crisis procedure static content.
// ---------------------------------------------------------------------------

/** Generic response steps for any crisis situation (static for the MVP; editable later). */
export const CRISIS_RESPONSE_STEPS = [
 'Remain calm and speak in a neutral, quiet tone.',
 'Ensure the physical safety of the individual and others; move bystanders away if needed.',
 'Remove or reduce the triggering situation if it can be done safely.',
 'Use the least-restrictive intervention that is likely to be effective.',
 'Call for staff support if the situation does not resolve safely and quickly.',
];

/** Behavior-classification-specific crisis guidance keyed by safety_classification. */
export const CRISIS_BEHAVIOR_GUIDANCE = {
 self_injury: 'Protect the individual\'s head and body; block attempts to cause injury. Use only trained, approved protective responses — never restraint unless authorized and trained.',
 aggression: 'Create space between the individual and others; position yourself to the side rather than face-on; protect your face and body.',
 elopement: 'Secure exits and alert other staff immediately; maintain line of sight at all times until the individual is safe.',
 property_damage: 'Remove valuable or dangerous items from reach; redirect the individual to a safe alternative activity.',
 other: 'Follow the individualized safety plan for this behavior; use blocking and protective responses as trained.',
};

/** Debrief steps for after a crisis event (static; the blanks are filled by the team). */
export const CRISIS_DEBRIEF_STEPS = [
 'Debrief after any significant incident, ideally within 24 hours.',
 'Participants: staff involved in the incident, the BCBA/analyst, and the supervisor as appropriate.',
 'Review: what triggered the behavior, what was tried, what worked, what should change in the plan.',
];

// ---------------------------------------------------------------------------
// Shared assembly helpers.
// ---------------------------------------------------------------------------

/** Load assessment + client + behaviors + hypotheses; null when assessment missing. */
function loadContext(assessmentId) {
 const a = db.prepare('SELECT * FROM assessments WHERE id=? AND deleted_at IS NULL').get(assessmentId);
 if (!a) return null;
 const client = db.prepare('SELECT * FROM clients WHERE id=? AND deleted_at IS NULL').get(a.client_id);
 const behaviors = db.prepare('SELECT * FROM target_behaviors WHERE assessment_id=? ORDER BY id').all(assessmentId);
 const hypRows = db.prepare('SELECT * FROM function_hypotheses WHERE assessment_id=? ORDER BY target_behavior_id').all(assessmentId);
 return { a, client, behaviors, hypRows };
}

/** Document header shared by all three documents (mirrors report.js shape). */
function buildHeader(a, client) {
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
  generated_at: new Date().toISOString(),
  is_preliminary: a.status !== 'completed',
 };
}

/** Behaviors with their stored hypothesis attached (or explicit missing-hypothesis note). */
function buildBehaviors(behaviors, hypRows) {
 const hypByBehavior = new Map(hypRows.map((h) => [h.target_behavior_id, h]));
 return behaviors.map((b) => {
  const h = hypByBehavior.get(b.id);
  const base = {
   id: b.id, name: b.name, operational_definition: b.operational_definition,
   safety_classification: b.safety_classification,
   safety_classification_label: lab(safetyLabels, b.safety_classification),
   is_safety_concern: !!b.is_safety_concern,
   baseline_measurement_type: b.baseline_measurement_type,
   baseline_measurement_type_label: b.baseline_measurement_type ? lab(measurementLabels, b.baseline_measurement_type) : null,
  };
  if (!h) return { ...base, hypothesized_function: null, hypothesis_status_note: 'No hypothesis yet — run “Generate analysis” once baseline data is collected.' };
  return {
   ...base,
   hypothesized_function: {
    function: h.function,
    function_label: lab(LABELS.functions, h.function),
    confidence: h.confidence,
    status: h.status,
    status_label: lab(hypStatusLabels, h.status),
   },
   hypothesis_status_note: null,
  };
 });
}

/** Wrap a list of strategy strings with the shared suggested-review label. */
const withSuggested = (list) => list.map((text) => ({ text, note: SUGGESTED_NOTE }));

// ---------------------------------------------------------------------------
// 1) BIP
// ---------------------------------------------------------------------------

/**
 * Assemble the Behavior Intervention Plan payload for one assessment.
 * Function-based antecedent/consequence strategies come from the static maps
 * above keyed by the stored function hypothesis; replacement skills carry a
 * prompting-hierarchy note and blank mastery-criteria fields for the BCBA to
 * complete on the printed document.
 */
export function buildBip(assessmentId) {
 const ctx = loadContext(assessmentId);
 if (!ctx) return null;
 const { a, client, behaviors, hypRows } = ctx;
 const hypByBehavior = new Map(hypRows.map((h) => [h.target_behavior_id, h]));

 const behaviorSections = behaviors.map((b) => {
  const h = hypByBehavior.get(b.id);
  const fn = h ? h.function : 'undetermined';
  const antecedent = ANTECEDENT_STRATEGIES[fn] || ANTECEDENT_STRATEGIES.undetermined;
  const consequence = CONSEQUENCE_STRATEGIES[fn] || CONSEQUENCE_STRATEGIES.undetermined;
  const list = b.is_safety_concern ? [SAFETY_CONSEQUENCE_STEP, ...consequence] : consequence;
  return {
   id: b.id, name: b.name, operational_definition: b.operational_definition,
   safety_classification: b.safety_classification,
   safety_classification_label: lab(safetyLabels, b.safety_classification),
   is_safety_concern: !!b.is_safety_concern,
   baseline_measurement_type: b.baseline_measurement_type,
   baseline_measurement_type_label: b.baseline_measurement_type ? lab(measurementLabels, b.baseline_measurement_type) : null,
   hypothesized_function: h ? {
    function: h.function,
    function_label: lab(LABELS.functions, h.function),
    confidence: h.confidence,
    status: h.status,
    status_label: lab(hypStatusLabels, h.status),
   } : null,
   hypothesis_status_note: h ? null : 'No hypothesis yet — run “Generate analysis” once baseline data is collected.',
   antecedent_strategies: withSuggested(antecedent),
   replacement_skills: {
    description: (REPLACEMENT_SKILLS[fn] || REPLACEMENT_SKILLS.undetermined) + (h ? '' : ' (Confirm once the function hypothesis is established.)'),
    prompting_note: PROMPTING_NOTE,
    // Blank fields for the BCBA to complete on the printed document.
    mastery_criteria: '',
    review_interval: '',
   },
   consequence_strategies: withSuggested(list),
   data_collection_plan: {
    measurement_type: b.baseline_measurement_type || null,
    measurement_type_label: b.baseline_measurement_type ? lab(measurementLabels, b.baseline_measurement_type) : null,
    data_sheet_reference: b.baseline_measurement_type
     ? `Blank observation data sheet for “${b.name}” — printable from the Data Sheet document (20 rows, ${lab(measurementLabels, b.baseline_measurement_type)} measurement).`
     : `Set a baseline measurement type for “${b.name}” (frequency, duration, or latency) and use the printable Data Sheet document for observations.`,
   },
  };
 });

 return {
  ...buildHeader(a, client),
  behaviors: behaviorSections,
  data_points_count: db.prepare('SELECT COUNT(*) AS c FROM data_points WHERE assessment_id=?').get(assessmentId).c,
  // role_code links each printed signature line to the matching sign_offs row
  // (bcba / guardian / supervisor / other) so a signed record fills the line.
  signatures: [
   { role: 'BCBA / Behavior Analyst', role_code: 'bcba', fields: ['Signature', 'Printed name & credentials', 'Date'] },
   { role: 'Parent / Guardian', role_code: 'guardian', fields: ['Signature', 'Printed name', 'Date'] },
  ],
  sign_offs: signOffsFor(assessmentId, 'bip'),
 };
}

// ---------------------------------------------------------------------------
// 2) Crisis Procedure
// ---------------------------------------------------------------------------

/**
 * Assemble the Crisis Procedure payload for one assessment.
 * Trigger behaviors are those flagged is_safety_concern (safety_classification
 * != none). When none exist the payload carries an explicit empty-state note
 * instead of fabricated content.
 */
export function buildCrisisPlan(assessmentId) {
 const ctx = loadContext(assessmentId);
 if (!ctx) return null;
 const { a, client, behaviors, hypRows } = ctx;
 const hypByBehavior = new Map(hypRows.map((h) => [h.target_behavior_id, h]));
 const triggers = behaviors.filter((b) => b.is_safety_concern && b.safety_classification !== 'none');

 return {
  ...buildHeader(a, client),
  has_triggers: triggers.length > 0,
  empty_state_note: triggers.length
   ? null
   : 'No target behaviors on this assessment are flagged as safety concerns (safety classification is “None” for all behaviors), so no behavior-specific crisis procedures are listed. Mark a behavior with a safety classification in the assessment to generate its crisis guidance.',
  trigger_behaviors: triggers.map((b) => {
   const h = hypByBehavior.get(b.id);
   return {
    id: b.id, name: b.name, operational_definition: b.operational_definition,
    safety_classification: b.safety_classification,
    safety_classification_label: lab(safetyLabels, b.safety_classification),
    hypothesized_function: h ? {
     function: h.function,
     function_label: lab(LABELS.functions, h.function),
     confidence: h.confidence,
     status: h.status,
     status_label: lab(hypStatusLabels, h.status),
    } : null,
    hypothesis_status_note: h ? null : 'No hypothesis yet — run “Generate analysis” once baseline data is collected.',
    guidance: CRISIS_BEHAVIOR_GUIDANCE[b.safety_classification] || CRISIS_BEHAVIOR_GUIDANCE.other,
   };
  }),
  response_steps: CRISIS_RESPONSE_STEPS,
  // Blank rows for the team to assign crisis roles.
  roles: Array.from({ length: 5 }, () => ({ role: '', name: '', duty: '' })),
  debrief: {
   steps: CRISIS_DEBRIEF_STEPS,
   blanks: { debrief_date: '', participants: '', review_notes: '' },
  },
  emergency_contacts: { contact_1: '', contact_2: '', local_emergency_number: '' },
  signatures: [
   { role: 'BCBA / Behavior Analyst', role_code: 'bcba', fields: ['Signature', 'Printed name & credentials', 'Date'] },
   { role: 'Program / Site Supervisor', role_code: 'supervisor', fields: ['Signature', 'Printed name', 'Date'] },
  ],
  sign_offs: signOffsFor(assessmentId, 'crisis_plan'),
 };
}

// ---------------------------------------------------------------------------
// 3) Blank data sheet(s)
// ---------------------------------------------------------------------------

/** Column label for the value cell, derived from the measurement type. */
function valueColumnLabel(measurementType) {
 if (measurementType === 'duration') return 'Duration (minutes)';
 if (measurementType === 'latency') return 'Latency (seconds)';
 return 'Frequency (count)';
}

const DATA_SHEET_ROWS = 20;

/**
 * Assemble one blank printable observation sheet per target behavior.
 * Rows are empty strings — the sheet is a paper-ready capture form, one per
 * behavior, with the value column labeled by that behavior's measurement type.
 */
export function buildDataSheet(assessmentId) {
 const ctx = loadContext(assessmentId);
 if (!ctx) return null;
 const { a, client, behaviors } = ctx;

 return {
  ...buildHeader(a, client),
  observation_instructions: 'Record one row per observation. For each observed instance, note the date/time, the setting, the antecedent (what happened just before), the consequence (what happened just after), and the measurement value in the labeled column.',
  rows_per_sheet: DATA_SHEET_ROWS,
  sheets: behaviors.map((b) => ({
   behavior_id: b.id,
   behavior_name: b.name,
   operational_definition: b.operational_definition,
   measurement_type: b.baseline_measurement_type || 'frequency',
   measurement_type_label: b.baseline_measurement_type ? lab(measurementLabels, b.baseline_measurement_type) : 'Frequency',
   value_column_label: valueColumnLabel(b.baseline_measurement_type || 'frequency'),
   rows: Array.from({ length: DATA_SHEET_ROWS }, () => ({ date_time: '', setting: '', antecedent: '', consequence: '', value: '' })),
  })),
 };
}
