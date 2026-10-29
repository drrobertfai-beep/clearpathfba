#!/usr/bin/env node
/**
 * ClearPathFBA — set an organization's letterhead (the provider identity printed
 * on every generated document) without hand-written SQL.
 *
 * Usage (from the repository root):
 *   npm run org:letterhead -- --slug default --show
 *   npm run org:letterhead -- --slug default \
 *     --name "Pederec Inc" \
 *     --address-line "2002 Orange Rd" --address-line-2 "Suite 106" \
 *     --city Culpeper --state VA --postal-code 22701 \
 *     --phone 757-544-9140 --fax 757-935-0240 --npi 1396347340
 *   npm run org:letterhead -- --slug default --set city=Culpeper --set state=VA --dry-run
 *
 * Against production:
 *   DATABASE_URL=postgres://… npm run org:letterhead -- --slug default --phone 757-544-9140
 *
 * Rules this script keeps on purpose:
 *  - It never invents a value: a field is written only when it is passed, and
 *    nothing is defaulted or backfilled. Fields left out keep their current
 *    value, so re-running the same command is a no-op.
 *  - It refuses to write to an organization it cannot find (exit 1, nothing
 *    written) — a typo in --slug must not silently create a second practice.
 *  - It normalizes phone/fax to the printed US form (757-544-9140) and keeps the
 *    NPI as digits, then prints the letterhead exactly as the documents will
 *    render it.
 *  - Every write is recorded in the append-only audit log.
 *
 * Idempotent: run it as often as you like. If nothing changed it says so and
 * writes nothing (no UPDATE, no audit row).
 */
import db from '../src/db.js';
import { logAudit } from '../src/audit.js';
import { buildLetterhead, LETTERHEAD_COLUMNS, PRODUCT_NAME } from '../src/letterhead.js';

// --- field definitions ------------------------------------------------------
// key: the organizations column. Flags: the CLI spellings accepted for it.
const FIELDS = {
 name: { flags: ['name'], label: 'Organization name' },
 address_line: { flags: ['address-line'], label: 'Street address' },
 address_line2: { flags: ['address-line-2', 'suite'], label: 'Suite / address line 2' },
 city: { flags: ['city'], label: 'City' },
 state: { flags: ['state'], label: 'State' },
 postal_code: { flags: ['postal-code', 'zip'], label: 'ZIP' },
 phone: { flags: ['phone'], label: 'Phone', kind: 'phone' },
 fax: { flags: ['fax'], label: 'Fax', kind: 'phone' },
 npi: { flags: ['npi'], label: 'NPI', kind: 'npi' },
 credential_line: { flags: ['credential-line'], label: 'Credential line' },
};
const COLUMNS = ['name', ...LETTERHEAD_COLUMNS];
const FLAG_TO_FIELD = new Map();
for (const [field, spec] of Object.entries(FIELDS)) for (const f of spec.flags) FLAG_TO_FIELD.set(f, field);

const USAGE = `Set an organization's letterhead (printed on every generated document).

  npm run org:letterhead -- --slug <slug> [options]

Locate the organization (exactly one of):
  --slug <slug>            e.g. default, demo
  --id <number>            organization id

Set values (only what you pass is written; nothing is defaulted):
  --name <text>            organization display name
  --address-line <text>    street address        (e.g. "2002 Orange Rd")
  --address-line-2 <text>  suite / line 2        (e.g. "Suite 106")
  --city <text>            --state <text>        --postal-code <text>
  --phone <text>           --fax <text>          --npi <digits>
  --credential-line <text> licence/credential line (e.g. LBA number)
  --set <field>=<value>    any of the above, repeatable
                           fields: ${COLUMNS.join(', ')}

Other:
  --show                   print the current letterhead and exit (no write)
  --dry-run                print what would change, write nothing
  --help                   this text

Phone and fax are normalized to 757-544-9140 for print; the NPI is kept as 10
digits. Values are never invented and an unknown organization is refused.`;

function die(message) {
 console.error(`error: ${message}`);
 console.error('\nRun with --help for usage.');
 process.exit(1);
}

// --- argument parsing -------------------------------------------------------
function parseArgs(argv) {
 const opts = { sets: {}, show: false, dryRun: false, help: false, slug: null, id: null };
 for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
  if (arg === '--show') { opts.show = true; continue; }
  if (arg === '--dry-run') { opts.dryRun = true; continue; }
  if (!arg.startsWith('--')) die(`unexpected argument "${arg}"`);
  const name = arg.slice(2);
  // Support both `--flag value` and `--flag=value`.
  if (name.includes('=')) {
   const at = name.indexOf('=');
   assign(opts, name.slice(0, at), name.slice(at + 1));
   continue;
  }
  if (i + 1 >= argv.length) die(`--${name} needs a value`);
  assign(opts, name, argv[++i]);
 }
 return opts;
}

function assign(opts, name, value) {
 if (name === 'slug') { opts.slug = value; return; }
 if (name === 'id') { opts.id = value; return; }
 if (name === 'set') {
  const at = String(value).indexOf('=');
  if (at < 1) die(`--set needs field=value (got "${value}")`);
  const field = value.slice(0, at);
  if (!COLUMNS.includes(field)) die(`unknown field "${field}" in --set — fields: ${COLUMNS.join(', ')}`);
  opts.sets[field] = value.slice(at + 1);
  return;
 }
 const field = FLAG_TO_FIELD.get(name);
 if (!field) die(`unknown option --${name}`);
 opts.sets[field] = value;
}

// --- value normalization ----------------------------------------------------
/** "757-544-9140" / "(757) 544 9140" / "17575449140" → 757-544-9140. */
function normalizePhone(raw, field) {
 const text = String(raw).trim();
 if (!text) return '';
 const digits = text.replace(/\D/g, '');
 const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
 if (national.length !== 10) {
  die(`--${FIELDS[field].flags[0]} "${text}" is not a 10-digit US number — pass it as 757-544-9140 (or 17575449140). Nothing was written.`);
 }
 return `${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`;
}

/** NPI is a 10-digit identifier (it has a checksum; we keep it verbatim). */
function normalizeNpi(raw) {
 const text = String(raw).trim();
 if (!text) return '';
 const digits = text.replace(/\D/g, '');
 if (digits.length !== 10) die(`--npi "${text}" must be exactly 10 digits (got ${digits.length}). Nothing was written.`);
 return digits;
}

function normalize(field, raw) {
 const kind = FIELDS[field] && FIELDS[field].kind;
 if (kind === 'phone') return normalizePhone(raw, field);
 if (kind === 'npi') return normalizeNpi(raw);
 return raw == null ? '' : String(raw).trim();
}

// --- output -----------------------------------------------------------------
function printLetterhead(org) {
 const lh = buildLetterhead(org);
 const width = Math.max(lh.name.length, ...lh.lines.map((l) => l.length), 0);
 console.log(`  ┌${'─'.repeat(width + 2)}`);
 console.log(`  │ ${lh.name}`);
 for (const line of lh.lines) console.log(`  │ ${line}`);
 if (!lh.lines.length) console.log('  │ (no contact lines set)');
 console.log(`  └${'─'.repeat(width + 2)}`);
 return lh;
}

function printValues(org) {
 for (const col of COLUMNS) {
  const value = org[col];
  console.log(`  ${col.padEnd(16)} ${value == null || value === '' ? '—' : value}`);
 }
}

// --- main -------------------------------------------------------------------
async function main() {
 const opts = parseArgs(process.argv.slice(2));
 if (opts.help) { console.log(USAGE); return; }
 if (!opts.slug && !opts.id) die('give the organization with --slug <slug> (or --id <n>)');

 const target = db.mode === 'postgres'
  ? 'PostgreSQL (DATABASE_URL)'
  : `SQLite (${process.env.DATABASE_PATH || 'data/clearpathfba.sqlite'})`;
 console.log(`ClearPathFBA organization letterhead — target: ${target}`);
 await db.ready; // schema + guarded migrations (the letterhead columns are added here)

 // Refuse to write to an organization we cannot find: no creating, no guessing.
 const where = opts.slug ? 'slug=?' : 'id=?';
 const key = opts.slug ? String(opts.slug) : Number(opts.id);
 const org = await db.prepare(`SELECT id, name, slug, status, ${LETTERHEAD_COLUMNS.join(', ')} FROM organizations WHERE ${where}`).get(key);
 if (!org) {
  console.error(`\nerror: no organization with ${opts.slug ? `slug "${opts.slug}"` : `id ${opts.id}`} — nothing was written.`);
  const orgs = await db.prepare('SELECT id, slug, name FROM organizations ORDER BY id').all();
  console.error(`Existing organizations: ${orgs.length ? orgs.map((o) => `#${o.id} ${o.slug} (${o.name})`).join(', ') : '(none)'}`);
  process.exitCode = 1;
  return;
 }
 console.log(`Organization: #${org.id} ${org.slug} — status ${org.status}`);

 if (opts.show) {
  console.log('\nCurrent letterhead:');
  printLetterhead(org);
  console.log('\nCurrent values:');
  printValues(org);
  return;
 }

 // Only the fields actually passed are considered; everything else is untouched.
 const wanted = {};
 for (const [field, raw] of Object.entries(opts.sets)) wanted[field] = normalize(field, raw);
 if (!Object.keys(wanted).length) die('nothing to set — pass at least one field (or --show to read the current values)');

 const changed = [];
 const same = [];
 for (const [field, value] of Object.entries(wanted)) {
  const before = org[field] == null ? '' : String(org[field]);
  if (before === value) same.push(field); else changed.push({ field, before, after: value });
 }

 console.log('\nBefore:');
 printLetterhead(org);

 if (!changed.length) {
  console.log('\nNo change — every value passed already matches the database. Nothing was written.');
  return;
 }

 console.log('\nChanges:');
 for (const c of changed) {
  console.log(`  ${c.field.padEnd(16)} ${c.before === '' ? '(empty)' : c.before}  →  ${c.after === '' ? '(cleared)' : c.after}`);
 }
 if (same.length) console.log(`Unchanged (not rewritten): ${same.join(', ')}`);

 const after = { ...org, ...Object.fromEntries(changed.map((c) => [c.field, c.after])) };
 console.log('\nAfter:');
 printLetterhead(after);

 if (opts.dryRun) {
  console.log('\nDry run — nothing was written.');
  return;
 }

 const assignments = changed.map((c) => `${c.field}=?`).join(', ');
 const values = changed.map((c) => c.after);
 await db.prepare(`UPDATE organizations SET ${assignments} WHERE id=?`).run(...values, org.id);
 await logAudit(db, {
  assessment_id: null,
  actor: 'cli:org-letterhead',
  action: 'organization_letterhead_updated',
  details: {
   label: `Letterhead updated for ${org.slug}`,
   organization_id: Number(org.id),
   slug: org.slug,
   changed: Object.fromEntries(changed.map((c) => [c.field, { before: c.before, after: c.after }])),
  },
 });

 // Read back from the database so the confirmation is the stored truth, not the intent.
 const saved = await db.prepare(`SELECT id, name, slug, status, ${LETTERHEAD_COLUMNS.join(', ')} FROM organizations WHERE id=?`).get(org.id);
 const lh = buildLetterhead(saved);
 const expected = buildLetterhead(after);
 if (JSON.stringify(lh.lines) !== JSON.stringify(expected.lines) || lh.name !== expected.name) {
  console.error('\nerror: the stored letterhead does not match what was written — investigate before relying on it.');
  process.exitCode = 1;
  return;
 }
 console.log(`\nSaved ${changed.length} field(s) on organization #${saved.id} (${saved.slug}); audit action organization_letterhead_updated.`);
 console.log(`Every generated document for a client of this organization now prints "${lh.name || PRODUCT_NAME}" with ${lh.lines.length} contact line(s).`);
}

main()
 .then(() => process.exit(process.exitCode || 0))
 .catch((err) => {
  console.error('\nLetterhead update failed:', err && err.message ? err.message : err);
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
 });
