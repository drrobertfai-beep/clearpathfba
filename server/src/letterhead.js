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
// Contact lines are optional and nullable (organizations.address_line / phone /
// credential_line). They render only when the owner has supplied them, so a
// fresh organization prints as a deliberate name-only letterhead instead of an
// empty block with stray separators. Nothing is ever invented here.
import db from './db.js';

/** Product name, used only when a client somehow has no organization. */
export const PRODUCT_NAME = 'ClearPathFBA';

const clean = (v) => (v == null ? '' : String(v).trim());

/**
 * Shape one letterhead from an organizations row (or null).
 * Pure: no db access, so renderers and tests can use it directly.
 * @param {object|null} org organizations row with name/address_line/phone/credential_line
 * @returns {{org_id: number|null, name: string, address_line: string, phone: string,
 *   credential_line: string, lines: string[], is_fallback: boolean}}
 */
export function buildLetterhead(org) {
 const name = clean(org && org.name);
 const address_line = clean(org && org.address_line);
 const phone = clean(org && org.phone);
 const credential_line = clean(org && org.credential_line);
 // Only supplied lines, in a fixed order; blanks are dropped rather than
 // printed as empty rows.
 const lines = [address_line, phone, credential_line].filter(Boolean);
 if (!name) {
  // Fallback: a client with no organization still gets a letterhead line.
  return { org_id: null, name: PRODUCT_NAME, address_line, phone, credential_line, lines, is_fallback: true };
 }
 return { org_id: org.id == null ? null : Number(org.id), name, address_line, phone, credential_line, lines, is_fallback: false };
}

/** Letterhead for an organization id (null/unknown id → product-name fallback). */
export async function letterheadForOrgId(orgId) {
 const id = Number(orgId);
 if (!Number.isInteger(id) || id < 1) return buildLetterhead(null);
 const org = await db.prepare('SELECT id, name, address_line, phone, credential_line FROM organizations WHERE id=?').get(id);
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
