// ClearPathFBA — document letterhead.
//
// Every generated document (FBA report, BIP, crisis plan, data sheet, progress
// report) is printed on the letterhead of THE ORGANIZATION THAT OWNS THE
// CLIENT — resolved from `clients.org_id`, never from the account viewing it.
// That distinction is the whole point: a platform admin opening another
// organization's report must see that organization's name, because the
// document belongs to the client's provider, not to whoever is looking.
//
// The organization name is not PHI, so the letterhead survives
// de-identification (see deidentify.js, which never touches `letterhead`).
//
// Every contact field is optional and nullable (organizations.address_line,
// address_line2, city, state, postal_code, phone, fax, npi, credential_line).
// They render only when the owner has supplied them, so a fresh organization
// prints as a deliberate name-only letterhead instead of an empty block with
// stray separators. Nothing is ever invented here.
//
// The rendered shape is a small set of lines, in a fixed order:
//
//   Pederec Inc
//   2002 Orange Rd, Suite 106          <- street + suite
//   Culpeper, VA 22701                 <- city, state ZIP
//   Phone 757-544-9140 · Fax 757-935-0240 · NPI 1396347340
//   <credential_line>                  <- e.g. LBA/BCBA number, when supplied
//
// `lines` is the single source of truth for all four render paths (on-screen
// view + print CSS, server PDF, Word), so they cannot drift apart.
import db from './db.js';

/** Product name, used only when a client somehow has no organization. */
export const PRODUCT_NAME = 'ClearPathFBA';

/** Separator between the contact items on the letterhead's contact line. */
export const CONTACT_SEPARATOR = ' · ';

const clean = (v) => (v == null ? '' : String(v).trim());

/** Street line: "2002 Orange Rd, Suite 106" (either part alone works). */
export function streetLine(org) {
 const street = clean(org && org.address_line);
 const suite = clean(org && org.address_line2);
 return [street, suite].filter(Boolean).join(', ');
}

/** City line: "Culpeper, VA 22701" — every part optional, blanks dropped. */
export function cityLine(org) {
 const city = clean(org && org.city);
 const state = clean(org && org.state);
 const zip = clean(org && org.postal_code);
 const cityState = [city, state].filter(Boolean).join(', ');
 return [cityState, zip].filter(Boolean).join(' ');
}

/** Contact line: "Phone … · Fax … · NPI …" — only the items supplied. */
export function contactLine(org) {
 const parts = [];
 const phone = clean(org && org.phone);
 const fax = clean(org && org.fax);
 const npi = clean(org && org.npi);
 if (phone) parts.push(`Phone ${phone}`);
 if (fax) parts.push(`Fax ${fax}`);
 if (npi) parts.push(`NPI ${npi}`);
 return parts.join(CONTACT_SEPARATOR);
}

/**
 * Shape one letterhead from an organizations row (or null).
 * Pure: no db access, so renderers and tests can use it directly.
 * @param {object|null} org organizations row with name + optional contact fields
 * @returns {{org_id: number|null, name: string, address_line: string,
 *   address_line2: string, city: string, state: string, postal_code: string,
 *   phone: string, fax: string, npi: string, credential_line: string,
 *   lines: string[], is_fallback: boolean}}
 */
export function buildLetterhead(org) {
 const name = clean(org && org.name);
 const credential_line = clean(org && org.credential_line);
 // Only supplied lines, in a fixed order; blanks are dropped rather than
 // printed as empty rows (and no dangling separators when a part is missing).
 const lines = [streetLine(org), cityLine(org), contactLine(org), credential_line].filter(Boolean);
 const fields = {
  address_line: clean(org && org.address_line),
  address_line2: clean(org && org.address_line2),
  city: clean(org && org.city),
  state: clean(org && org.state),
  postal_code: clean(org && org.postal_code),
  phone: clean(org && org.phone),
  fax: clean(org && org.fax),
  npi: clean(org && org.npi),
  credential_line,
 };
 if (!name) {
  // Fallback: a client with no organization still gets a letterhead line.
  return { org_id: null, name: PRODUCT_NAME, ...fields, lines, is_fallback: true };
 }
 return { org_id: org.id == null ? null : Number(org.id), name, ...fields, lines, is_fallback: false };
}

/** Columns that make up a letterhead, in print order (shared with the CLI). */
export const LETTERHEAD_COLUMNS = [
 'address_line', 'address_line2', 'city', 'state', 'postal_code',
 'phone', 'fax', 'npi', 'credential_line',
];

/** Letterhead for an organization id (null/unknown id → product-name fallback). */
export async function letterheadForOrgId(orgId) {
 const id = Number(orgId);
 if (!Number.isInteger(id) || id < 1) return buildLetterhead(null);
 const org = await db.prepare(`SELECT id, name, ${LETTERHEAD_COLUMNS.join(', ')} FROM organizations WHERE id=?`).get(id);
 return buildLetterhead(org || null);
}

/**
 * Letterhead for the organization that owns this client.
 * @param {object|null} client clients row (only id / org_id are needed)
 */
export async function letterheadForClient(client) {
 if (!client) return buildLetterhead(null);
 const orgId = client.org_id;
 if (orgId == null) return buildLetterhead(null);
 return letterheadForOrgId(orgId);
}

/**
 * Guarantee a stored payload carries a letterhead.
 *
 * Progress-report payloads are assembled once and stored as JSON, so a report
 * generated before letterheads existed has none. Those are resolved from the
 * client at render time; a payload that already has one keeps it verbatim, so a
 * document that was generated (and possibly signed) keeps the letterhead it was
 * generated with.
 */
export async function ensureLetterhead(payload) {
 if (!payload || typeof payload !== 'object') return payload;
 if (payload.letterhead && payload.letterhead.name) return payload;
 const client = payload.client && typeof payload.client === 'object' ? payload.client : null;
 let orgId = client ? client.org_id : null;
 if (orgId == null && client && client.id != null) {
  const row = await db.prepare('SELECT org_id FROM clients WHERE id=?').get(client.id);
  orgId = row ? row.org_id : null;
 }
 return { ...payload, letterhead: await letterheadForOrgId(orgId) };
}
