// ClearPathFBA — FHIR R4 export mapping tests (node --test).
// fhir.js is pure (no db), so these tests run with plain fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
 mapClientToPatient, mapAssessmentToResources, bundleResources, toFhirDateTime, mapGender,
 SYS_CLIENT_ID, SYS_TARGET_BEHAVIOR, SYS_UCUM, FHIR_BASE, PROFILE_PATIENT,
} from '../src/fhir.js';

const client = {
 id: 12, first_name: 'Alex', last_name: 'Sample', date_of_birth: '2015-03-02',
 gender: 'Male', consent_status: 'obtained', notes: 'Likes dinosaurs.',
};
const behaviors = [
 { id: 1, assessment_id: 9, name: 'Screaming', operational_definition: 'Vocalizations above conversational level', safety_classification: 'none', baseline_measurement_type: 'frequency' },
 { id: 2, assessment_id: 9, name: 'Elopement', operational_definition: 'Leaving the assigned area without permission', safety_classification: 'elopement', baseline_measurement_type: 'latency' },
];
const points = [
 { id: 101, assessment_id: 9, target_behavior_id: 1, recorded_at: '2026-01-05 09:15:00', setting: 'classroom', antecedent: 'demand_task', consequence: 'escape_removed_demand', measurement_type: 'frequency', value: 3, notes: null },
 { id: 102, assessment_id: 9, target_behavior_id: 1, recorded_at: '2026-01-05 10:00:00', setting: 'classroom', antecedent: 'attention_diverted', consequence: 'attention_given', measurement_type: 'duration', value: 45.5, notes: 'block 2' },
 { id: 103, assessment_id: 9, target_behavior_id: 2, recorded_at: '2026-01-06 08:30:00', setting: 'transition', antecedent: 'transition', consequence: null, measurement_type: 'latency', value: 120, notes: null },
];
const assessment = {
 id: 9, client_id: 12, title: 'Initial FBA — Spring 2026', status: 'completed',
 assessment_date: '2026-01-10', assessor: 'Sam Rivera, BCBA', notes: 'Referral from school.',
 created_at: '2026-01-04 08:00:00', updated_at: '2026-01-11 16:30:00',
};

test('mapClientToPatient maps identity fields', () => {
 const p = mapClientToPatient(client);
 assert.equal(p.resourceType, 'Patient');
 assert.equal(p.id, '12');
 assert.deepEqual(p.identifier, [{ system: SYS_CLIENT_ID, value: '12' }]);
 assert.equal(p.name[0].family, 'Sample');
 assert.deepEqual(p.name[0].given, ['Alex']);
 assert.equal(p.birthDate, '2015-03-02');
 assert.equal(p.gender, 'male');
 assert.equal(p.managingOrganization.reference, 'Organization/clearpathfba');
 assert.deepEqual(p.meta.profile, [PROFILE_PATIENT]);
});

test('mapClientToPatient handles missing optional fields and unknown gender', () => {
 const p = mapClientToPatient({ id: 3, first_name: 'Jo', last_name: '' });
 assert.equal(p.name[0].family, '');
 assert.equal(p.birthDate, undefined);
 assert.equal(p.gender, undefined);
 assert.equal(p.telecom, undefined);
 assert.equal(mapGender('Prefer not to say'), 'unknown');
 assert.equal(mapGender('Non-binary'), 'other');
});

test('mapGender is case-insensitive', () => {
 assert.equal(mapGender('female'), 'female');
 assert.equal(mapGender('F'), 'female');
 assert.equal(mapGender('male'), 'male');
 assert.equal(mapGender(''), undefined);
 assert.equal(mapGender(undefined), undefined);
});

test('toFhirDateTime normalizes app timestamps to UTC dateTime', () => {
 assert.equal(toFhirDateTime('2026-01-05 09:15:00'), '2026-01-05T09:15:00Z');
 assert.equal(toFhirDateTime('2026-01-05 09:15'), '2026-01-05T09:15:00Z');
 assert.equal(toFhirDateTime('2015-03-02'), '2015-03-02');
 assert.equal(toFhirDateTime('2026-01-05T09:15:00.000Z'), '2026-01-05T09:15:00.000Z');
 assert.equal(toFhirDateTime(null), undefined);
});

test('one Observation per data point with code/subject/effectiveDateTime', () => {
 const resources = mapAssessmentToResources(assessment, client, behaviors, points);
 const observations = resources.filter((r) => r.resourceType === 'Observation');
 assert.equal(observations.length, 3);
 const first = observations.find((o) => o.id === 'observation-101');
 assert.equal(first.status, 'final');
 assert.deepEqual(first.subject, { reference: 'Patient/12' });
 assert.equal(first.effectiveDateTime, '2026-01-05T09:15:00Z');
 assert.equal(first.code.coding[0].system, SYS_TARGET_BEHAVIOR);
 assert.equal(first.code.coding[0].code, '1');
 assert.equal(first.code.coding[0].display, 'Screaming');
 assert.equal(first.code.text, 'Screaming');
});

test('valueQuantity follows measurement type (frequency count, duration/latency seconds)', () => {
 const resources = mapAssessmentToResources(assessment, client, behaviors, points);
 const byId = Object.fromEntries(resources.filter((r) => r.resourceType === 'Observation').map((o) => [o.id, o]));
 assert.deepEqual(byId['observation-101'].valueQuantity, { value: 3, unit: 'occurrences', system: SYS_UCUM, code: '{count}' });
 assert.deepEqual(byId['observation-102'].valueQuantity, { value: 45.5, unit: 'seconds', system: SYS_UCUM, code: 's' });
 assert.deepEqual(byId['observation-103'].valueQuantity, { value: 120, unit: 'seconds', system: SYS_UCUM, code: 's' });
});

test('ABC context is attached as Observation components', () => {
 const resources = mapAssessmentToResources(assessment, client, behaviors, points);
 const obs = resources.find((r) => r.id === 'observation-101');
 assert.equal(obs.component.length, 3);
 const setting = obs.component.find((c) => c.code.coding[0].code === 'setting');
 assert.equal(setting.valueCodeableConcept.coding[0].code, 'classroom');
 assert.equal(setting.valueCodeableConcept.text, 'Classroom');
 // Data point with no consequence gets only two components.
 const obs103 = resources.find((r) => r.id === 'observation-103');
 assert.equal(obs103.component.length, 2);
});

test('QuestionnaireResponse summarizes the assessment', () => {
 const resources = mapAssessmentToResources(assessment, client, behaviors, points);
 const qr = resources.find((r) => r.resourceType === 'QuestionnaireResponse');
 assert.ok(qr);
 assert.equal(qr.id, 'questionnaire-response-9');
 assert.equal(qr.status, 'completed'); // assessment status completed
 assert.deepEqual(qr.subject, { reference: 'Patient/12' });
 assert.equal(qr.author.display, 'Sam Rivera, BCBA');
 const titles = qr.item.map((i) => i.text);
 assert.ok(titles.includes('Assessment title'));
 assert.ok(titles.includes('Target behaviors'));
 assert.ok(titles.includes('Data summary'));
 const tbItem = qr.item.find((i) => i.linkId === 'target-behaviors');
 assert.equal(tbItem.item.length, 2);
 assert.equal(tbItem.item[0].text, 'Screaming');
 assert.equal(tbItem.item[0].item[0].answer[0].valueString, 'Vocalizations above conversational level');
 const summary = qr.item.find((i) => i.linkId === 'data-summary');
 assert.equal(summary.item.find((i) => i.linkId === 'total-data-points').answer[0].valueString, '3');
});

test('draft assessment QuestionnaireResponse status is in-progress', () => {
 const resources = mapAssessmentToResources({ ...assessment, status: 'draft' }, client, behaviors, points);
 const qr = resources.find((r) => r.resourceType === 'QuestionnaireResponse');
 assert.equal(qr.status, 'in-progress');
});

test('bundleResources builds a collection Bundle with Patient first', () => {
 const patient = mapClientToPatient(client);
 const resources = [patient, ...mapAssessmentToResources(assessment, client, behaviors, points)];
 const bundle = bundleResources(resources, { id: 'bundle-1', timestamp: '2026-01-11T16:30:00Z' });
 assert.equal(bundle.resourceType, 'Bundle');
 assert.equal(bundle.type, 'collection');
 assert.equal(bundle.id, 'bundle-1');
 assert.equal(bundle.timestamp, '2026-01-11T16:30:00Z');
 assert.equal(bundle.entry.length, 5); // Patient + 3 Observations + QuestionnaireResponse
 assert.equal(bundle.entry[0].resource.resourceType, 'Patient');
 assert.equal(bundle.entry[0].fullUrl, `${FHIR_BASE}/Patient/12`);
 assert.equal(bundle.entry[0].resource.id, patient.id);
 assert.ok(bundle.entry.every((e) => e.fullUrl && e.resource));
});

test('bundleResources with no Patient first requirement still includes all resources', () => {
 const bundle = bundleResources([mapClientToPatient(client)]);
 assert.equal(bundle.entry.length, 1);
 assert.equal(bundle.entry[0].resource.resourceType, 'Patient');
 assert.equal(bundle.meta.tag, undefined); // no DEID tag when not deidentified
});

test('de-identified bundle omits PII (name/DOB/gender/assessor/notes)', () => {
 const patient = mapClientToPatient(client, { deidentified: true });
 const resources = [patient, ...mapAssessmentToResources(assessment, client, behaviors, points, { deidentified: true })];
 const bundle = bundleResources(resources, { deidentified: true });
 const text = JSON.stringify(bundle);
 // No real name, DOB, gender, assessor, or notes anywhere in the bundle.
 assert.ok(!text.includes('Alex'));
 assert.ok(!text.includes('Sample'));
 assert.ok(!text.includes('birthDate'));
 assert.ok(!text.includes('2015-03-02'));
 assert.ok(!text.includes('Sam Rivera'));
 assert.ok(!text.includes('Referral from school'));
 // De-identified patient keeps the Client #N name pattern and the id.
 const p = bundle.entry[0].resource;
 assert.equal(p.name[0].given[0], 'Client');
 assert.equal(p.name[0].family, '#12');
 assert.equal(p.gender, undefined);
 // Bundle is tagged DEID; clinical content is preserved.
 assert.equal(bundle.meta.tag[0].code, 'DEID');
 assert.ok(text.includes('Screaming'));
 assert.ok(text.includes('observation-101'));
 const qr = bundle.entry.find((e) => e.resource.resourceType === 'QuestionnaireResponse').resource;
 assert.equal(qr.author.display, 'BCBA');
});

test('assessment resources skip notes when de-identified', () => {
 const resources = mapAssessmentToResources(assessment, client, behaviors, points, { deidentified: true });
 const qr = resources.find((r) => r.resourceType === 'QuestionnaireResponse');
 assert.ok(!qr.item.some((i) => i.linkId === 'assessment-notes'));
});
