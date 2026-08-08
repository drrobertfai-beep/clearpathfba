// ClearPathFBA — HL7 FHIR R4 export mapping.
//
// Pure mapping functions (no db calls) that translate ClearPathFBA rows into
// minimal-but-valid FHIR R4 JSON resources, then wrap them in a Bundle. The API
// routes in index.js fetch the rows and call these; the unit tests call them
// directly with fixture rows.
//
// Choices (kept deliberately simple and defensible for EHR sharing):
//   * Patient  — one per client. identifier = the ClearPathFBA client id,
//     name/birthDate/gender mapped from the profile, managingOrganization is a
//     placeholder pointing at the app itself. The clients table has no
//     phone/email/address columns today, so telecom/address are emitted only
//     when the row happens to carry those fields (future-proof, never wrong).
//   * Observation — one per data point. code = the target behavior (custom
//     CodeSystem + display text), subject = the Patient, effectiveDateTime =
//     recorded_at, valueQuantity keyed off measurement_type (frequency uses the
//     UCUM count unit '{count}'; duration/latency use UCUM seconds 's'). ABC
//     context (setting/antecedent/consequence) rides along as components with
//     valueCodeableConcept, using the app's controlled-vocabulary codes.
//   * QuestionnaireResponse — one per assessment, summarizing title/status/
//     date, the target behaviors with their operational definitions, and a
//     data-point count per behavior.
//
// De-identification mirrors server/src/deidentify.js: the client name becomes
// "Client #<id>", birthDate/gender/telecom/address/notes are dropped, the
// assessor becomes the role label "BCBA", and assessment notes are removed.
// Clinical content (behavior names, definitions, data) is kept. The Bundle
// carries a DEID meta.tag so receiving systems can see it without parsing
// every resource.

import { LABELS } from './vocab.js';

export const FHIR_VERSION = '4.0.1';
export const FHIR_BASE = 'https://clearpathfba.com/fhir';
// System URLs for our custom identifiers/code systems. These are placeholder
// namespaces owned by the app; they do not need to resolve.
export const SYS_CLIENT_ID = 'https://clearpathfba.com/fhir/sid/client-id';
export const SYS_TARGET_BEHAVIOR = 'https://clearpathfba.com/fhir/CodeSystem/target-behavior';
export const SYS_ABC = 'https://clearpathfba.com/fhir/CodeSystem/abc';
export const SYS_UCUM = 'http://unitsofmeasure.org';
export const SYS_QUESTIONNAIRE = 'http://clearpathfba.com/fhir/Questionnaire/fba-assessment';
export const PROFILE_PATIENT = 'http://hl7.org/fhir/StructureDefinition/Patient';
export const PROFILE_OBSERVATION = 'http://hl7.org/fhir/StructureDefinition/Observation';
export const PROFILE_QUESTIONNAIRE_RESPONSE = 'http://hl7.org/fhir/StructureDefinition/QuestionnaireResponse';
// De-identification tag (v3 ActCode) mirroring the deidentified flag.
const CODE_DEID = { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'DEID', display: 'De-identified' };

// 'YYYY-MM-DD HH:MM:SS' (UTC, SQLite CURRENT_TIMESTAMP / pg adapter) or an
// ISO-8601 string -> FHIR dateTime. FHIR requires a timezone on dateTime;
// the stored timestamps are UTC, so emit 'Z'.
export function toFhirDateTime(value) {
 if (value == null || value === '') return undefined;
 const s = String(value).trim();
 if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; // date only
 // Already carries a timezone -> valid FHIR dateTime, pass through.
 if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return s;
 // 'YYYY-MM-DD HH:MM:SS' / 'YYYY-MM-DDTHH:MM[:SS]' (UTC) -> add Z.
 const dt = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
 if (dt) return `${dt[1]}T${dt[2]}${dt[2].length === 5 ? ':00' : ''}Z`;
 return s; // anything else passes through
}

// The profile's free-text gender picker -> FHIR administrative gender.
export function mapGender(gender) {
 const v = String(gender ?? '').trim().toLowerCase();
 if (!v) return undefined;
 if (v === 'female' || v === 'f') return 'female';
 if (v === 'male' || v === 'm') return 'male';
 if (v === 'non-binary') return 'other';
 return 'unknown'; // covers 'Prefer not to say' and any free text
}

function patientName(clientRow, opts) {
 if (opts?.deidentified) {
  return [{ use: 'official', family: `#${clientRow.id}`, given: ['Client'] }];
 }
 const family = String(clientRow.last_name ?? '');
 const given = [String(clientRow.first_name ?? '')];
 return [{ use: 'official', family, given }].filter((n) => n.family || n.given[0]);
}

/**
 * Map a clients row to a FHIR R4 Patient resource.
 * @param {object} clientRow row from the clients table
 * @param {{deidentified?: boolean}} [opts]
 * @returns Patient resource (resourceType 'Patient')
 */
export function mapClientToPatient(clientRow, opts = {}) {
 const resource = {
  resourceType: 'Patient',
  id: String(clientRow.id),
  meta: { profile: [PROFILE_PATIENT] },
  identifier: [{ system: SYS_CLIENT_ID, value: String(clientRow.id) }],
  managingOrganization: { reference: 'Organization/clearpathfba', display: 'ClearPathFBA' },
 };
 const name = patientName(clientRow, opts);
 if (name.length) resource.name = name;
 if (!opts.deidentified) {
  if (clientRow.date_of_birth) resource.birthDate = toFhirDateTime(clientRow.date_of_birth);
  const gender = mapGender(clientRow.gender);
  if (gender) resource.gender = gender;
 }
 // Telecom/address: the schema has no such columns today; emit only if a row
 // (or a future migration) provides them.
 const telecom = [];
 if (clientRow.phone) telecom.push({ system: 'phone', value: String(clientRow.phone) });
 if (clientRow.email) telecom.push({ system: 'email', value: String(clientRow.email) });
 if (telecom.length) resource.telecom = telecom;
 if (clientRow.address) resource.address = [{ text: String(clientRow.address) }];
 return resource;
}

// Unit mapping per measurement_type. Frequency is a count (UCUM '{count}');
// duration and latency are recorded in seconds.
const MEASURE_UNITS = {
 frequency: { unit: 'occurrences', system: SYS_UCUM, code: '{count}' },
 duration: { unit: 'seconds', system: SYS_UCUM, code: 's' },
 latency: { unit: 'seconds', system: SYS_UCUM, code: 's' },
};

/**
 * Map one data point to a FHIR R4 Observation. Subject is set from clientRow.
 * @param {object} point row from the data_points table
 * @param {object} clientRow clients row (for the Patient reference)
 * @param {Map<number, object>} behaviorsById target_behaviors rows keyed by id
 * @param {{deidentified?: boolean}} [opts]
 * @returns Observation resource
 */
export function mapDataPointToObservation(point, clientRow, behaviorsById = new Map(), opts = {}) {
 const behavior = behaviorsById.get(point.target_behavior_id);
 const display = behavior?.name || `Target behavior #${point.target_behavior_id}`;
 const code = behavior ? String(behavior.id) : String(point.target_behavior_id);
 const unit = MEASURE_UNITS[point.measurement_type] || MEASURE_UNITS.frequency;
 const obs = {
  resourceType: 'Observation',
  id: `observation-${point.id}`,
  meta: { profile: [PROFILE_OBSERVATION] },
  status: 'final',
  code: {
   coding: [{ system: SYS_TARGET_BEHAVIOR, code, display }],
   text: display,
  },
  subject: { reference: `Patient/${clientRow.id}` },
  effectiveDateTime: toFhirDateTime(point.recorded_at),
  valueQuantity: { value: Number(point.value), unit: unit.unit, system: unit.system, code: unit.code },
 };
 // ABC context as Observation components (controlled-vocabulary codes).
 // component.code identifies the kind (setting/antecedent/consequence);
 // valueCodeableConcept carries the recorded vocabulary value.
 const component = [];
 for (const [field, kind] of [['setting', 'settings'], ['antecedent', 'antecedents'], ['consequence', 'consequences']]) {
  if (point[field]) {
   const label = LABELS[kind]?.[point[field]] || point[field];
   component.push({
    code: { coding: [{ system: SYS_ABC, code: field }], text: field },
    valueCodeableConcept: { coding: [{ system: SYS_ABC, code: point[field], display: label }], text: label },
   });
  }
 }
 if (component.length) obs.component = component;
 return obs;
}

function qrItem(linkId, text, valueString) {
 const item = { linkId, text };
 if (valueString != null && valueString !== '') item.answer = [{ valueString: String(valueString) }];
 return item;
}

/**
 * Map an assessment (plus its behaviors and data points) to FHIR resources:
 * one Observation per data point plus one QuestionnaireResponse summary.
 * @param {object} assessmentRow assessments row
 * @param {object} clientRow clients row
 * @param {object[]} targetBehaviors target_behaviors rows for the assessment
 * @param {object[]} dataPoints data_points rows for the assessment
 * @param {{deidentified?: boolean}} [opts]
 * @returns {object[]} FHIR resources (Observations + QuestionnaireResponse)
 */
export function mapAssessmentToResources(assessmentRow, clientRow, targetBehaviors = [], dataPoints = [], opts = {}) {
 const behaviorsById = new Map(targetBehaviors.map((b) => [b.id, b]));
 const resources = dataPoints.map((p) => mapDataPointToObservation(p, clientRow, behaviorsById, opts));

 // Per-behavior data point counts for the summary.
 const counts = new Map();
 for (const p of dataPoints) counts.set(p.target_behavior_id, (counts.get(p.target_behavior_id) || 0) + 1);

 const item = [
  qrItem('assessment-title', 'Assessment title', assessmentRow.title),
  qrItem('assessment-status', 'Assessment status', assessmentRow.status),
 ];
 if (assessmentRow.assessment_date) item.push(qrItem('assessment-date', 'Assessment date', assessmentRow.assessment_date));
 if (!opts.deidentified && assessmentRow.notes) item.push(qrItem('assessment-notes', 'Assessment notes', assessmentRow.notes));

 if (targetBehaviors.length) {
  item.push({
   linkId: 'target-behaviors',
   text: 'Target behaviors',
   item: targetBehaviors.map((b) => ({
    linkId: `target-behavior-${b.id}`,
    text: b.name,
    item: [
     qrItem('operational-definition', 'Operational definition', b.operational_definition),
     qrItem('safety-classification', 'Safety classification', b.safety_classification),
     qrItem('baseline-measurement-type', 'Baseline measurement type', b.baseline_measurement_type),
    ].filter((x) => x.answer || x.text === 'Operational definition'),
   })),
  });
 }
 if (dataPoints.length) {
  item.push({
   linkId: 'data-summary',
   text: 'Data summary',
   item: [
    qrItem('total-data-points', 'Total data points', String(dataPoints.length)),
    ...[...counts.entries()].map(([tbId, n]) => {
     const b = behaviorsById.get(tbId);
     return qrItem(`behavior-${tbId}-points`, `${b?.name || `Behavior #${tbId}`} — data points`, String(n));
    }),
   ],
  });
 }

 resources.push({
  resourceType: 'QuestionnaireResponse',
  id: `questionnaire-response-${assessmentRow.id}`,
  meta: { profile: [PROFILE_QUESTIONNAIRE_RESPONSE] },
  questionnaire: `${SYS_QUESTIONNAIRE}|1`,
  status: assessmentRow.status === 'completed' ? 'completed' : 'in-progress',
  subject: { reference: `Patient/${clientRow.id}` },
  authored: toFhirDateTime(assessmentRow.updated_at || assessmentRow.created_at),
  author: { display: opts.deidentified ? 'BCBA' : (assessmentRow.assessor || 'BCBA') },
  item,
 });
 return resources;
}

/**
 * Wrap FHIR resources in a Bundle of type 'collection' with the Patient first.
 * @param {object[]} resources FHIR resources (first should be the Patient)
 * @param {{id?: string, timestamp?: string, deidentified?: boolean}} [meta]
 * @returns Bundle resource
 */
export function bundleResources(resources = [], meta = {}) {
 const timestamp = meta.timestamp || new Date().toISOString();
 const bundleMeta = { lastUpdated: timestamp };
 if (meta.deidentified) bundleMeta.tag = [CODE_DEID];
 return {
  resourceType: 'Bundle',
  id: meta.id || `clearpathfba-${meta.deidentified ? 'deid-' : ''}export-${Date.now().toString(36)}`,
  meta: bundleMeta,
  type: 'collection',
  timestamp,
  entry: resources.map((r) => ({ fullUrl: `${FHIR_BASE}/${r.resourceType}/${r.id}`, resource: r })),
 };
}
