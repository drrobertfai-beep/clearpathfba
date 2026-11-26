// ClearPathFBA — organization settings (pass 2).
//
// The settings screen edits exactly the letterhead fields `npm run
// org:letterhead` sets, so a practice can maintain the identity printed on every
// document without SQL or a shell. The rules mirror the CLI's on purpose:
//
//  - a phone/fax is stored in the printed US form (757-544-9140)
//  - an NPI is kept as 10 digits
//  - a blank field is a cleared field (the letterhead simply omits it)
//  - nothing is invented: an invalid value is rejected, never corrected
//
// Pure and side-effect free, so the API and the tests share one definition.

/** Editable columns, in the order the settings screen shows them. */
export const ORG_SETTINGS_FIELDS = [
 'name', 'address_line', 'address_line2', 'city', 'state', 'postal_code',
 'phone', 'fax', 'npi', 'credential_line',
];

export const ORG_SETTINGS_LABELS = {
 name: 'Organization name',
 address_line: 'Street address',
 address_line2: 'Suite / address line 2',
 city: 'City',
 state: 'State',
 postal_code: 'ZIP',
 phone: 'Phone',
 fax: 'Fax',
 npi: 'NPI',
 credential_line: 'Credential line',
};

const MAX_LENGTH = {
 name: 200,
 address_line: 200,
 address_line2: 200,
 city: 100,
 state: 50,
 postal_code: 20,
 phone: 30,
 fax: 30,
 npi: 30,
 credential_line: 200,
};

const text = (value) => (value == null ? '' : String(value).trim());

/** "757-544-9140" / "(757) 544 9140" / "17575449140" → 757-544-9140, or null. */
export function normalizePhone(value) {
 const digits = String(value).replace(/\D/g, '');
 const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
 if (national.length !== 10) return null;
 return `${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`;
}

/** An NPI is a 10-digit identifier (it has a checksum; we keep it verbatim). */
export function normalizeNpi(value) {
 const digits = String(value).replace(/\D/g, '');
 return digits.length === 10 ? digits : null;
}

/**
 * Validate a settings submission.
 * @param {object} body request body (unknown keys are ignored)
 * @returns {{error: string}|{values: object}} every editable field, trimmed
 */
export function validateOrgSettings(body = {}) {
 const source = body && typeof body === 'object' ? body : {};
 const values = {};
 for (const field of ORG_SETTINGS_FIELDS) {
  const value = text(source[field]);
  const max = MAX_LENGTH[field];
  if (value.length > max) {
   return { error: `${ORG_SETTINGS_LABELS[field]} must be ${max} characters or fewer.` };
  }
  values[field] = value;
 }
 if (!values.name) return { error: 'Organization name is required.' };

 for (const field of ['phone', 'fax']) {
  if (!values[field]) continue;
  const normalized = normalizePhone(values[field]);
  if (!normalized) {
   return { error: `${ORG_SETTINGS_LABELS[field]} must be a 10-digit US number, for example 757-544-9140.` };
  }
  values[field] = normalized;
 }
 if (values.npi) {
  const normalized = normalizeNpi(values.npi);
  if (!normalized) return { error: 'NPI must be exactly 10 digits.' };
  values.npi = normalized;
 }
 return { values };
}

/**
 * The fields whose stored value differs from the submission, as
 * {field: {before, after}} — what the audit entry records. A no-op save yields
 * an empty object (and writes nothing, exactly like the CLI).
 */
export function changedOrgFields(before, values) {
 const changed = {};
 for (const field of ORG_SETTINGS_FIELDS) {
  const was = before && before[field] != null ? String(before[field]) : '';
  const now = values[field] == null ? '' : String(values[field]);
  if (was !== now) changed[field] = { before: was, after: now };
 }
 return changed;
}
