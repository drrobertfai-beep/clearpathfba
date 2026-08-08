// ClearPathFBA — de-identification transform for document exports.
// Produces a PHI-stripped copy of any document payload (FBA report, BIP, crisis
// plan, data sheet, progress report) for supervision/research use.
//
// Rules (see business plan, privacy slice):
//  * client name        -> "Client #<id>" (no real name anywhere)
//  * date of birth      -> null (age-range label is a UI concern; we drop the date)
//  * gender             -> removed (null)
//  * assessment notes   -> removed (free text can contain PHI)
//  * assessor name      -> "BCBA" (role only)
//  * signatory names    -> removed (role labels only; signature/signed_at dropped,
//                           status forced back to 'pending' so printed lines stay blank)
//  * flags              -> deidentified: true + deidentified_header banner string
// Clinical content is KEPT: behavior names, operational definitions, data,
// hypotheses, strategies, recommendations.
//
// Implementation note: payloads are plain JSON (no Dates/Buffers), so a
// JSON round-trip is a safe, dependency-free deep clone.

export const DEIDENTIFIED_HEADER = 'DE-IDENTIFIED — FOR SUPERVISION/RESEARCH ONLY, NOT A TREATMENT RECORD';

export function deidentify(payload) {
 if (!payload || typeof payload !== 'object') return payload;
 const p = JSON.parse(JSON.stringify(payload));

 // Client: name -> "Client #<id>", DOB/gender -> removed, notes -> removed.
 if (p.client && typeof p.client === 'object') {
  const id = p.client.id;
  p.client = {
   ...p.client,
   first_name: 'Client',
   last_name: `#${id}`,
   date_of_birth: null,
   gender: null,
  };
  delete p.client.notes;
 }

 // Assessment: assessor -> role label, notes (free text) -> removed.
 if (p.assessment && typeof p.assessment === 'object') {
  p.assessment = { ...p.assessment, assessor: 'BCBA', notes: null };
 }

 // Sign-offs: drop names/signatures; keep role labels only.
 if (Array.isArray(p.sign_offs)) {
  p.sign_offs = p.sign_offs.map((s) => ({
   ...s,
   signatory_name: null,
   signature: null,
   signed_at: null,
   status: 'pending',
   status_label: 'Pending',
  }));
 }

 // Prominent flag + banner string consumed by renderers and docx export.
 p.deidentified = true;
 p.deidentified_header = DEIDENTIFIED_HEADER;
 return p;
}
