import express from 'express';
import crypto from 'node:crypto';
import cors from 'cors';
import db from './db.js';
import { dataPointVocab, LABELS } from './vocab.js';
import { analyzeAssessment, topN } from './analysis.js';
import { buildReport } from './report.js';
import { buildProgressReport, parsePeriod } from './reporting.js';
import { buildBip, buildCrisisPlan, buildDataSheet } from './documents.js';
import { docxForReport, docxForBip, docxForCrisis, docxForDataSheet, docxForProgressReport, pack } from './docx-export.js';
import { deidentify } from './deidentify.js';
import { pdfForReport, pdfForBip, pdfForCrisis, pdfForDataSheet, pdfForProgressReport } from './pdf-export.js';
import { assessmentExport, csvExport, importCsv } from './portability.js';
import { logAudit, DOCUMENT_TYPE_LABELS, SIGNATORY_ROLE_LABELS, SIGN_OFF_STATUS_LABELS } from './audit.js';
import { hashPassword, verifyPassword, issueSession, getSessionUser, requireAuth, requireRole, ROLES, publicUser } from './auth.js';
import { signDocument, verifyDocument, SIGNATURE_ALGO } from './signature.js';
import { generateSecret, otpauthUri, verifyTOTP, generateBackupCodes, hashBackupCode, issueMfaToken, verifyMfaToken } from './mfa.js';
import { registerSsoRoutes } from './sso.js';
const app = express();
const port = process.env.API_PORT || 4000;
// Wrap async route handlers so rejected promises reach the error middleware
// (Express 4 does not catch async throws on its own).
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// Seed credentials are development-only; change them before any production deployment.
// Seed accounts are created inside start() (after db.ready) so the same code
// path works for the synchronous SQLite backend and the async Postgres backend.
const loginAttempts=new Map();
const authRateLimit=(req,res,next)=>{const now=Date.now(), key=req.ip||'unknown', recent=(loginAttempts.get(key)||[]).filter(t=>now-t<15*60*1000);if(recent.length>=10){res.set('Retry-After','900');return res.status(429).json({error:'Too many login attempts. Try again later.'});}recent.push(now);loginAttempts.set(key,recent);next();};
const clearLoginAttempts=ip=>loginAttempts.delete(ip||'unknown');
// Actor for audit entries = the authenticated user (requireAuth sets req.user
// with {id, username, role, display_name, active} — see auth.js). An X-Actor
// header is kept only as a fallback for callers/tests that predate auth.
const auditActor = (req) => req.user?.username || req.get('x-actor') || 'BCBA';
// Field sets used to report what changed on mutations. Comparison is JSON-aware
// so object columns (dbhds_flags) and scalar columns diff correctly.
const CLIENT_FIELDS = ['first_name', 'last_name', 'date_of_birth', 'gender', 'consent_status', 'dbhds_flags', 'notes'];
const ASSESSMENT_FIELDS = ['title', 'status', 'assessment_date', 'assessor', 'notes'];
const BEHAVIOR_FIELDS = ['name', 'operational_definition', 'safety_classification', 'is_safety_concern', 'baseline_measurement_type'];
const DATA_POINT_FIELDS = ['target_behavior_id', 'recorded_at', 'setting', 'antecedent', 'behavior', 'consequence', 'measurement_type', 'value', 'notes'];
const changedFields = (oldRow, newRow, fields) => fields.filter((f) => JSON.stringify(oldRow?.[f] ?? null) !== JSON.stringify(newRow?.[f] ?? null));
const setFields = (row, fields) => fields.filter((f) => row?.[f] != null && row[f] !== '');
const DOCUMENT_TYPES = ['fba_report', 'bip', 'crisis_plan'];
const SIGNATORY_ROLES = ['bcba', 'guardian', 'supervisor', 'other'];
// The document payload builders used by the JSON/Word/PDF export routes. The
// e-signature digests the SAME payload these builders produce, so a signature
// covers exactly what is exported for that document type.
const DOC_BUILDERS = { fba_report: buildReport, bip: buildBip, crisis_plan: buildCrisisPlan };
function validateSignOff(body) {
 const dt = body.document_type, role = body.signatory_role, name = clean(body.signatory_name);
 if (!dt || !DOCUMENT_TYPES.includes(dt)) return `Invalid document_type. Must be one of: ${DOCUMENT_TYPES.join(', ')}.`;
 if (!role || !SIGNATORY_ROLES.includes(role)) return `Invalid signatory_role. Must be one of: ${SIGNATORY_ROLES.join(', ')}.`;
 if (!name) return 'signatory_name is required.';
 if (name.length > 200) return 'signatory_name must be 200 characters or fewer.';
 return null;
}
function signOffOut(row) {
 if (!row) return null;
 return { ...row, document_type_label: DOCUMENT_TYPE_LABELS[row.document_type] || row.document_type, signatory_role_label: SIGNATORY_ROLE_LABELS[row.signatory_role] || row.signatory_role, status_label: SIGN_OFF_STATUS_LABELS[row.status] || row.status };
}
const statuses = ['not_started','in_progress','obtained','declined'];
const aStatuses = ['draft','in_progress','completed'];
const safetyClasses = ['none','self_injury','aggression','elopement','property_damage','other'];
const measurementTypes = dataPointVocab.measurementTypes;
const enumLabels = { setting:'setting', antecedent:'antecedent', consequence:'consequence' };
const functionValues = ['escape','attention','tangible','automatic','multiple','undetermined'];
const hypStatuses = ['draft','reviewed'];
function validateHypothesisOverride(body) {
 const fn = body.function;
 if (!fn || typeof fn !== 'string') return 'function is required.';
 if (!functionValues.includes(fn)) return `Invalid function. Must be one of: ${functionValues.join(', ')}.`;
 if (body.status != null && !hypStatuses.includes(body.status)) return 'Invalid status. Must be one of: draft, reviewed.';
 if (body.confidence != null && (typeof body.confidence !== 'number' || !Number.isFinite(body.confidence) || body.confidence < 0 || body.confidence > 1)) return 'confidence must be a number between 0 and 1.';
 return null;
}
function hypothesisOut(row) {
 if (!row) return null;
 let ev = {};
 try { ev = JSON.parse(row.evidence || '{}'); } catch {}
 return { ...row, evidence: ev,
  top_antecedents: topN(ev.antecedent_counts, 3),
  top_consequences: topN(ev.consequence_counts, 3),
  rationale: ev.rationale || null,
  data_completeness: typeof ev.data_completeness === 'number' ? ev.data_completeness : 0,
  stats: ev.stats || {},
  notes: Array.isArray(ev.notes) ? ev.notes : [],
 };
}
async function validateDataPoint(body, assessmentId) {
 const target = Number(body.target_behavior_id);
 if (!Number.isInteger(target) || target < 1) return 'target_behavior_id is required.';
 const tb = await db.prepare('SELECT id FROM target_behaviors WHERE id=? AND assessment_id=?').get(target, assessmentId);
 if (!tb) return 'Target behavior does not belong to this assessment.';
 if (!body.recorded_at || typeof body.recorded_at !== 'string') return 'recorded_at is required.';
 if (!measurementTypes.includes(body.measurement_type)) return 'Invalid measurement_type. Must be one of: frequency, duration, latency.';
 if (typeof body.value !== 'number' || !Number.isFinite(body.value) || body.value < 0) return 'value must be a number greater than or equal to 0.';
 for (const field of ['setting','antecedent','consequence']) if (body[field] != null && body[field] !== '' && !dataPointVocab[field+'s'].includes(body[field])) return `Invalid ${field}. Must be one of: ${dataPointVocab[field+'s'].join(', ')}.`;
 return null;
}
async function dataPointRow(id) { return await db.prepare(`SELECT dp.*, tb.name AS target_behavior_name, tb.is_safety_concern AS target_behavior_safety, tb.safety_classification AS target_behavior_safety_classification FROM data_points dp LEFT JOIN target_behaviors tb ON tb.id=dp.target_behavior_id WHERE dp.id=?`).get(id); }
app.use((req,res,next)=>{res.set({'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'"});next();});
app.use(cors()); app.use(express.json({limit:'1mb'})); app.use(express.text({type:'text/csv',limit:'5mb'}));
// MVP authentication: bearer sessions backed by SHA-256 token hashes. Permission map is in auth.js.
app.post('/api/auth/login',authRateLimit,ah(async(req,res)=>{const username=clean(req.body?.username);const password=req.body?.password;if(!username||username.length>100||typeof password!=='string'||!password)return res.status(400).json({error:'Username and password are required.'});let u=await db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);let sec=await db.prepare('SELECT * FROM login_security WHERE username=?').get(username);if(sec?.locked_until&&new Date(sec.locked_until+'Z')>new Date()){return res.status(423).json({error:'Account locked, try again later.'});}if(sec?.locked_until){await db.prepare('UPDATE login_security SET failed_count=0,locked_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE username=?').run(username);await logAudit(db,{assessment_id:null,actor:username,action:'login_unlock',details:{label:`Account unlocked: ${username}`,username,ip:req.ip}});sec=null;}if(!u||!verifyPassword(password,u.password_hash)){const count=(sec?.failed_count||0)+1;const locked=count>=5;await db.prepare(`INSERT INTO login_security(username,failed_count,locked_until) VALUES(?,?,CASE WHEN ? THEN ${db.nowPlus(15)} ELSE NULL END) ON CONFLICT(username) DO UPDATE SET failed_count=excluded.failed_count,locked_until=excluded.locked_until,updated_at=CURRENT_TIMESTAMP`).run(username,count,locked?1:0);await logAudit(db,{assessment_id:null,actor:username,action:locked?'login_lockout':'login_failed',details:{label:locked?`Account locked: ${username}`:`Failed login: ${username}`,username,ip:req.ip}});return res.status(locked?423:401).json({error:locked?'Account locked, try again later.':'Invalid username or password.'});}await db.prepare('UPDATE login_security SET failed_count=0,locked_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE username=?').run(username);clearLoginAttempts(req.ip);if(u.mfa_enabled)return res.json({mfa_required:true,mfa_token:issueMfaToken(u.id)});res.json({token:await issueSession(u.id),user:publicUser(u),must_change_password:!!u.must_change_password});}));
// The unauthenticated sign-off verification endpoint is deliberately public
// (minimal, PHI-free payload) so a document recipient can check a signature
// without an account. Everything else stays authenticated.
app.use((req,res,next)=>req.path==='/api/health'||req.path==='/api/auth/login'||req.path==='/api/auth/mfa/verify'||req.path==='/api/auth/sso/status'||req.path==='/api/auth/sso/login'||req.path==='/api/auth/sso/callback'||req.path.startsWith('/api/verify/sign-off/')?next():requireAuth(req,res,next));
registerSsoRoutes(app);
const mfaAttemptKey = id => `mfa:${id}`;
const mfaFailures = new Map();
const mfaFingerprint = (req, code) => crypto.createHash('sha256').update(`${req.ip||''}:${String(code||'').slice(0,20)}`).digest('hex').slice(0,16);
app.post('/api/auth/mfa/setup',ah(async(req,res)=>{const u=await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);const secret=generateSecret();await db.prepare('UPDATE users SET mfa_secret=? WHERE id=?').run(secret,u.id);res.json({otpauth_uri:otpauthUri(secret,u.username),secret});}));
app.post('/api/auth/mfa/enable',ah(async(req,res)=>{const u=await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);if(!u?.mfa_secret)return res.status(400).json({error:'Run MFA setup first.'});if(!verifyTOTP(u.mfa_secret,req.body?.code))return res.status(400).json({error:'Invalid authenticator code.'});const codes=generateBackupCodes();const tx=db.transaction(async()=>{await db.prepare('DELETE FROM mfa_backup_codes WHERE user_id=?').run(u.id);const ins=db.prepare('INSERT INTO mfa_backup_codes(user_id,code_hash) VALUES(?,?)');for(const c of codes)await ins.run(u.id,hashBackupCode(c));await db.prepare('UPDATE users SET mfa_enabled=1 WHERE id=?').run(u.id);});await tx();await logAudit(db,{assessment_id:null,actor:u.username,action:'mfa_enabled',details:{label:`MFA enabled: ${u.username}`,username:u.username}});res.json({mfa_enabled:true,backup_codes:codes});}));
app.post('/api/auth/mfa/disable',ah(async(req,res)=>{const u=await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);if(u.role!=='admin'&&!verifyTOTP(u.mfa_secret,req.body?.code))return res.status(400).json({error:'A valid authenticator code is required.'});await db.prepare('UPDATE users SET mfa_enabled=0,mfa_secret=NULL WHERE id=?').run(u.id);await db.prepare('DELETE FROM mfa_backup_codes WHERE user_id=?').run(u.id);await logAudit(db,{assessment_id:null,actor:u.username,action:'mfa_disabled',details:{label:`MFA disabled: ${u.username}`,username:u.username}});res.json({mfa_enabled:false});}));
app.post('/api/auth/mfa/verify',ah(async(req,res)=>{const v=verifyMfaToken(req.body?.mfa_token);if(!v)return res.status(401).json({error:'MFA verification step expired. Sign in again.'});const u=await db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(v.userId);if(!u||!u.mfa_enabled)return res.status(401).json({error:'MFA verification unavailable.'});const key=mfaAttemptKey(u.id), state=mfaFailures.get(key);if(state?.until>Date.now())return res.status(423).json({error:'MFA locked, try again later.'});if(state?.until){mfaFailures.delete(key);}let ok=verifyTOTP(u.mfa_secret,req.body?.code),backup=null;if(!ok){backup=await db.prepare('SELECT * FROM mfa_backup_codes WHERE user_id=? AND code_hash=? AND used_at IS NULL').get(u.id,hashBackupCode(req.body?.code));if(backup){await db.prepare('UPDATE mfa_backup_codes SET used_at=CURRENT_TIMESTAMP WHERE id=?').run(backup.id);ok=true;}}if(!ok){const count=(state?.count||0)+1;const locked=count>=5;mfaFailures.set(key,{count,until:locked?Date.now()+15*60*1000:0});await logAudit(db,{assessment_id:null,actor:u.username,action:'mfa_verify_failure',details:{label:`MFA verification failed: ${u.username}`,username:u.username,fingerprint:mfaFingerprint(req,req.body?.code)}});return res.status(locked?423:401).json({error:locked?'MFA locked, try again later.':'Invalid MFA code.'});}mfaFailures.delete(key);await logAudit(db,{assessment_id:null,actor:u.username,action:'mfa_verify_success',details:{label:`MFA verification succeeded: ${u.username}`,username:u.username,backup_code:!!backup}});res.json({token:await issueSession(u.id),user:publicUser(u),must_change_password:!!u.must_change_password});}));
// Least-privilege route gates: reads/documents are authenticated; mutations are role constrained.
app.use((req,res,next)=>{const p=req.path,m=req.method,r=req.user?.role;let allowed=null;
 if(m==='DELETE'&&(/^\/api\/(clients|assessments|target-behaviors)\//.test(p)))allowed=['admin','bcba'];
 else if((m==='POST'||m==='PUT')&&(/^\/api\/clients/.test(p)||/^\/api\/assessments\/\d+$/.test(p)||/^\/api\/assessments\/\d+\/target-behaviors/.test(p)))allowed=['admin','bcba','specialist'];
 else if(m==='POST'&&/\/import\/csv$/.test(p))allowed=['admin','bcba','specialist'];
 else if((m==='POST'||m==='PUT')&&(p.startsWith('/api/assessments/')&&p.includes('/data-points')||p.startsWith('/api/data-points/')))allowed=['admin','bcba','specialist','staff'];
 else if(m==='POST'&&/function-hypotheses\/generate/.test(p))allowed=['admin','bcba','specialist','supervisor'];
 else if(m==='PUT'&&/function-hypotheses/.test(p))allowed=['admin','bcba','specialist','supervisor'];
 else if(m==='POST'&&/sign-offs$/.test(p))allowed=['admin','bcba','specialist','supervisor'];
 else if(m==='POST'&&/sign-offs\/\d+\/sign$/.test(p))allowed=['admin','bcba','specialist','supervisor'];
 else if(m==='DELETE'&&/sign-offs\//.test(p))allowed=['admin','bcba','specialist','supervisor'];
 if(allowed&&!allowed.includes(r)&&!(r==='guardian'&&m==='POST'&&/sign-offs\/\d+\/sign$/.test(p)))return res.status(403).json({error:'Insufficient permissions.'});next();});

app.post('/api/auth/logout',ah(async(req,res)=>{const raw=(req.get('authorization')||'').slice(7);await db.prepare('DELETE FROM sessions WHERE token_hash=?').run(crypto.createHash('sha256').update(raw).digest('hex'));res.status(204).end();}));
app.put('/api/auth/password',ah(async(req,res)=>{const current=req.body?.current_password,newPassword=req.body?.new_password;if(typeof current!=='string'||!current||typeof newPassword!=='string'||newPassword.length<8)return res.status(400).json({error:'current_password is required and new_password must be at least 8 characters.'});if(current===newPassword)return res.status(400).json({error:'New password must differ from current password.'});const row=await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);if(!row||!verifyPassword(current,row.password_hash))return res.status(400).json({error:'Current password is incorrect.'});const raw=(req.get('authorization')||'').slice(7),keep=crypto.createHash('sha256').update(raw).digest('hex');await db.prepare('UPDATE users SET password_hash=?,must_change_password=0,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(hashPassword(newPassword),row.id);await db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(row.id,keep);await logAudit(db,{assessment_id:null,actor:req.user.username,action:'password_changed',details:{label:`Password changed: ${req.user.username}`,username:req.user.username}});res.json({ok:true,must_change_password:false});}));
app.get('/api/auth/me',(req,res)=>res.json(req.user));
app.get('/api/admin/users',requireRole('admin'),ah(async(req,res)=>res.json(await db.prepare('SELECT id,username,email,role,display_name,active,created_at,updated_at FROM users ORDER BY username').all())));
const normalizeEmail = value => { if (value == null || String(value).trim() === '') return null; const email = String(value).trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : false; };
const emailConflict = async (email, id = null) => email && await db.prepare('SELECT id FROM users WHERE lower(email)=? AND id<>?').get(email, id || 0);
app.post('/api/admin/users',requireRole('admin'),ah(async(req,res)=>{const {username,password,role,display_name,email}=req.body||{};if(!username||!password||!ROLES.includes(role))return res.status(400).json({error:'username, password, and valid role are required.'});const normalizedEmail=normalizeEmail(email);if(normalizedEmail===false)return res.status(400).json({error:'email must be a valid email address.'});if(await emailConflict(normalizedEmail))return res.status(409).json({error:'Email address already exists.'});try{const r=await db.prepare('INSERT INTO users(username,password_hash,role,display_name,email) VALUES (?,?,?,?,?)').run(clean(username),hashPassword(password),role,clean(display_name)||null,normalizedEmail);const created=await db.prepare('SELECT id,username,email,role,display_name,active,created_at,updated_at FROM users WHERE id=?').get(r.lastInsertRowid);await logAudit(db,{assessment_id:null,actor:auditActor(req),action:'user_created',details:{label:`User created: ${created.username} (${created.role})`,entity:'user',id:created.id,changed:['username','role','display_name','password','email']}});res.status(201).json(created);}catch(e){if(String(e.message).includes('UNIQUE'))return res.status(409).json({error:String(e.message).includes('email')?'Email address already exists.':'Username already exists.'});throw e;}}));
app.put('/api/admin/users/:id',requireRole('admin'),ah(async(req,res)=>{const cur=await db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);if(!cur)return res.status(404).json({error:'User not found.'});const role=req.body.role||cur.role;if(!ROLES.includes(role))return res.status(400).json({error:'Invalid role.'});const normalizedEmail=req.body.email==null?cur.email:normalizeEmail(req.body.email);if(normalizedEmail===false)return res.status(400).json({error:'email must be a valid email address.'});if(await emailConflict(normalizedEmail,cur.id))return res.status(409).json({error:'Email address already exists.'});try{await db.prepare('UPDATE users SET role=?,display_name=?,email=?,active=?,password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(role,req.body.display_name??cur.display_name,normalizedEmail,req.body.active==null?cur.active:(req.body.active?1:0),req.body.password?hashPassword(req.body.password):cur.password_hash,req.params.id);}catch(e){if(String(e.message).includes('UNIQUE'))return res.status(409).json({error:'Email address or username already exists.'});throw e;}const after=await db.prepare('SELECT id,username,email,role,display_name,active,created_at,updated_at FROM users WHERE id=?').get(req.params.id);const changed=changedFields({role:cur.role,display_name:cur.display_name,email:cur.email,active:cur.active},{role:after.role,display_name:after.display_name,email:after.email,active:after.active},['role','display_name','email','active']);if(req.body.password)changed.push('password');await logAudit(db,{assessment_id:null,actor:auditActor(req),action:'user_updated',details:{label:`User updated: ${after.username}`,entity:'user',id:after.id,changed}});res.json(after);}));
// --- URL id hardening: every :id route param must be a positive integer ---
// Malformed/empty ids (e.g. /api/assessments/xxx/...) get a 400 instead of a 500.
app.param('id', (req, res, next, value) => {
 const n = /^\d+$/.test(String(value)) ? Number(value) : NaN;
 if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: 'Invalid id in URL.' });
 req.params.id = n;
 next();
});
const clean = (v) => typeof v === 'string' ? v.trim() : (v ?? '');
const dateRe = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const select = db.prepare(`SELECT id, first_name, last_name, date_of_birth, gender, consent_status, dbhds_flags, notes, created_at, updated_at FROM clients WHERE deleted_at IS NULL ORDER BY ${db.orderCi('last_name')}, ${db.orderCi('first_name')}`);
const clientExists = db.prepare('SELECT id FROM clients WHERE id=? AND deleted_at IS NULL');
const assessmentExists = db.prepare('SELECT id FROM assessments WHERE id=? AND deleted_at IS NULL');
function row(c) { if (!c) return null; return {...c, dbhds_flags: (() => { try{return JSON.parse(c.dbhds_flags || '{}')}catch{return {}} })()}; }
function validate(body) {
 const first_name=clean(body.first_name), last_name=clean(body.last_name), consent_status=body.consent_status || 'not_started';
 if (!first_name || !last_name) return 'First name and last name are required.';
 if (first_name.length>100 || last_name.length>100) return 'Names must be 100 characters or fewer.';
 if (body.date_of_birth && !dateRe.test(body.date_of_birth)) return 'Date of birth must use YYYY-MM-DD.';
 if (!statuses.includes(consent_status)) return 'Invalid consent status.';
 return null;
}
function validateAssessment(body) {
 const title=clean(body.title), status=body.status||'draft';
 if (!title) return 'Assessment title is required.';
 if (title.length>200) return 'Title must be 200 characters or fewer.';
 if (!aStatuses.includes(status)) return 'Invalid status. Must be one of: draft, in_progress, completed.';
 if (body.assessment_date && !dateRe.test(body.assessment_date)) return 'Assessment date must use YYYY-MM-DD.';
 if (clean(body.assessor).length>200) return 'Assessor must be 200 characters or fewer.';
 return null;
}
function validateBehavior(body) {
 const name=clean(body.name), def=clean(body.operational_definition), sc=body.safety_classification||'none', m=body.baseline_measurement_type||null;
 if (!name) return 'Behavior name is required.';
 if (name.length>200) return 'Behavior name must be 200 characters or fewer.';
 if (!def) return 'Operational definition is required.';
 if (!safetyClasses.includes(sc)) return 'Invalid safety classification.';
 if (m!==null && !measurementTypes.includes(m)) return 'Invalid baseline measurement type. Must be one of: frequency, duration, latency.';
 return null;
}
// --- Clients (existing) ---
app.get('/api/health', (_,res)=>res.json({ok:true, mode: db.mode}));
app.get('/api/clients', ah(async(_,res)=>res.json((await select.all()).map(row))));
app.get('/api/clients/:id', ah(async(req,res)=>{ const c=row(await db.prepare('SELECT id, first_name, last_name, date_of_birth, gender, consent_status, dbhds_flags, notes, created_at, updated_at FROM clients WHERE id=? AND deleted_at IS NULL').get(req.params.id)); if(!c)return res.status(404).json({error:'Client not found.'}); res.json(c); }));
app.post('/api/clients', ah(async(req,res)=>{const e=validate(req.body);if(e)return res.status(400).json({error:e});const b=req.body;const info=await db.prepare('INSERT INTO clients (first_name,last_name,date_of_birth,gender,consent_status,dbhds_flags,notes) VALUES (?,?,?,?,?,?,?)').run(clean(b.first_name),clean(b.last_name),b.date_of_birth||null,clean(b.gender)||null,b.consent_status||'not_started',JSON.stringify(b.dbhds_flags||{}),clean(b.notes)||null);const created=row(await db.prepare('SELECT * FROM clients WHERE id=?').get(info.lastInsertRowid));await logAudit(db,{assessment_id:null,actor:auditActor(req),action:'client_created',details:{label:`Client created: ${created.first_name} ${created.last_name}`,entity:'client',id:created.id,changed:setFields(created,CLIENT_FIELDS)}});res.status(201).json(created);}));
app.put('/api/clients/:id', ah(async(req,res)=>{const e=validate(req.body);if(e)return res.status(400).json({error:e});const old=await db.prepare('SELECT * FROM clients WHERE id=? AND deleted_at IS NULL').get(req.params.id);if(!old)return res.status(404).json({error:'Client not found.'});const b=req.body;await db.prepare('UPDATE clients SET first_name=?,last_name=?,date_of_birth=?,gender=?,consent_status=?,dbhds_flags=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(clean(b.first_name),clean(b.last_name),b.date_of_birth||null,clean(b.gender)||null,b.consent_status||'not_started',JSON.stringify(b.dbhds_flags||{}),clean(b.notes)||null,req.params.id);const updated=row(await db.prepare('SELECT * FROM clients WHERE id=?').get(req.params.id));await logAudit(db,{assessment_id:null,actor:auditActor(req),action:'client_updated',details:{label:`Client updated: ${updated.first_name} ${updated.last_name}`,entity:'client',id:updated.id,changed:changedFields(old,updated,CLIENT_FIELDS)}});res.json(updated);}));
app.delete('/api/clients/:id', ah(async(req,res)=>{const old=await db.prepare('SELECT * FROM clients WHERE id=? AND deleted_at IS NULL').get(req.params.id);if(!old)return res.status(404).json({error:'Client not found.'});await db.prepare("UPDATE clients SET deleted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL").run(req.params.id);await logAudit(db,{assessment_id:null,actor:auditActor(req),action:'client_deleted',details:{label:`Client deleted: ${old.first_name} ${old.last_name}`,entity:'client',id:old.id,changed:['deleted']}});res.status(204).end();}));
// --- Assessments ---
const listAssessments = db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM target_behaviors tb WHERE tb.assessment_id=a.id) AS behavior_count
 FROM assessments a WHERE a.client_id=? AND a.deleted_at IS NULL ORDER BY a.created_at DESC, a.id DESC`);
const getAssessment = db.prepare('SELECT * FROM assessments WHERE id=? AND deleted_at IS NULL');
const listBehaviors = db.prepare('SELECT * FROM target_behaviors WHERE assessment_id=? ORDER BY id');
app.get('/api/clients/:id/assessments', ah(async(req,res)=>{ if(!await clientExists.get(req.params.id))return res.status(404).json({error:'Client not found.'}); res.json(await listAssessments.all(req.params.id)); }));
app.post('/api/clients/:id/assessments', ah(async(req,res)=>{ if(!await clientExists.get(req.params.id))return res.status(404).json({error:'Client not found.'}); const e=validateAssessment(req.body); if(e)return res.status(400).json({error:e}); const b=req.body;
 const info=await db.prepare('INSERT INTO assessments (client_id,title,status,assessment_date,assessor,notes) VALUES (?,?,?,?,?,?)').run(req.params.id,clean(b.title),b.status||'draft',b.assessment_date||null,clean(b.assessor)||null,clean(b.notes)||null);
 const a=await getAssessment.get(info.lastInsertRowid); await logAudit(db,{assessment_id:Number(info.lastInsertRowid),actor:auditActor(req),action:'assessment_created',details:{label:`Assessment created: ${a.title}`,entity:'assessment',id:a.id,changed:setFields(a,ASSESSMENT_FIELDS)}}); res.status(201).json({...a,behavior_count:0,behaviors:[]}); }));
app.get('/api/assessments/:id', ah(async(req,res)=>{ const a=await getAssessment.get(req.params.id); if(!a)return res.status(404).json({error:'Assessment not found.'}); res.json({...a,behaviors:await listBehaviors.all(a.id)}); }));
app.put('/api/assessments/:id', ah(async(req,res)=>{ const old=await getAssessment.get(req.params.id); if(!old)return res.status(404).json({error:'Assessment not found.'}); const e=validateAssessment(req.body); if(e)return res.status(400).json({error:e}); const b=req.body;
 await db.prepare('UPDATE assessments SET title=?,status=?,assessment_date=?,assessor=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(clean(b.title),b.status||'draft',b.assessment_date||null,clean(b.assessor)||null,clean(b.notes)||null,req.params.id);
 const a=await getAssessment.get(req.params.id); await logAudit(db,{assessment_id:a.id,actor:auditActor(req),action:'assessment_updated',details:{label:`Assessment updated: ${a.title}`,entity:'assessment',id:a.id,changed:changedFields(old,a,ASSESSMENT_FIELDS)}}); res.json({...a,behaviors:await listBehaviors.all(a.id)}); }));
app.delete('/api/assessments/:id', ah(async(req,res)=>{ const old=await getAssessment.get(req.params.id); if(!old)return res.status(404).json({error:'Assessment not found.'}); await db.prepare("UPDATE assessments SET deleted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL").run(req.params.id); await logAudit(db,{assessment_id:old.id,actor:auditActor(req),action:'assessment_deleted',details:{label:`Assessment deleted: ${old.title}`,entity:'assessment',id:old.id,changed:['deleted']}}); res.status(204).end(); }));
// --- Target behaviors ---
app.get('/api/assessments/:id/target-behaviors', ah(async(req,res)=>{ if(!await getAssessment.get(req.params.id))return res.status(404).json({error:'Assessment not found.'}); res.json(await listBehaviors.all(req.params.id)); }));
app.post('/api/assessments/:id/target-behaviors', ah(async(req,res)=>{ if(!await getAssessment.get(req.params.id))return res.status(404).json({error:'Assessment not found.'}); const e=validateBehavior(req.body); if(e)return res.status(400).json({error:e}); const b=req.body;
 const sc=b.safety_classification||'none';
 const info=await db.prepare('INSERT INTO target_behaviors (assessment_id,name,operational_definition,safety_classification,is_safety_concern,baseline_measurement_type) VALUES (?,?,?,?,?,?)').run(req.params.id,clean(b.name),clean(b.operational_definition),sc,sc!=='none'?1:0,b.baseline_measurement_type||null);
 const created=await db.prepare('SELECT * FROM target_behaviors WHERE id=?').get(info.lastInsertRowid); await logAudit(db,{assessment_id:req.params.id,actor:auditActor(req),action:'behavior_created',details:{label:`Target behavior created: ${created.name}`,entity:'target_behavior',id:created.id,changed:setFields(created,BEHAVIOR_FIELDS)}});
 res.status(201).json(created); }));
app.put('/api/target-behaviors/:id', ah(async(req,res)=>{ const cur=await db.prepare('SELECT * FROM target_behaviors WHERE id=?').get(req.params.id); if(!cur)return res.status(404).json({error:'Target behavior not found.'}); const e=validateBehavior(req.body); if(e)return res.status(400).json({error:e}); const b=req.body;
 const sc=b.safety_classification||'none';
 await db.prepare('UPDATE target_behaviors SET name=?,operational_definition=?,safety_classification=?,is_safety_concern=?,baseline_measurement_type=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(clean(b.name),clean(b.operational_definition),sc,sc!=='none'?1:0,b.baseline_measurement_type||null,req.params.id);
 const updated=await db.prepare('SELECT * FROM target_behaviors WHERE id=?').get(req.params.id); await logAudit(db,{assessment_id:cur.assessment_id,actor:auditActor(req),action:'behavior_updated',details:{label:`Target behavior updated: ${updated.name}`,entity:'target_behavior',id:updated.id,changed:changedFields(cur,updated,BEHAVIOR_FIELDS)}});
 res.json(updated); }));
app.delete('/api/target-behaviors/:id', ah(async(req,res)=>{ const cur=await db.prepare('SELECT * FROM target_behaviors WHERE id=?').get(req.params.id); if(!cur)return res.status(404).json({error:'Target behavior not found.'});
 try { await db.prepare('DELETE FROM target_behaviors WHERE id=?').run(req.params.id); }
 catch { return res.status(409).json({error:'This behavior has recorded data points and cannot be deleted.'}); }
 await logAudit(db,{assessment_id:cur.assessment_id,actor:auditActor(req),action:'behavior_deleted',details:{label:`Target behavior deleted: ${cur.name}`,entity:'target_behavior',id:cur.id,changed:['deleted']}});
 res.status(204).end(); }));
// --- Data points ---
app.get('/api/assessments/:id/data-points', ah(async(req,res)=>{ if(!await getAssessment.get(req.params.id)) return res.status(404).json({error:'Assessment not found.'}); res.json(await db.prepare(`SELECT dp.*, tb.name AS target_behavior_name, tb.is_safety_concern AS target_behavior_safety, tb.safety_classification AS target_behavior_safety_classification FROM data_points dp LEFT JOIN target_behaviors tb ON tb.id=dp.target_behavior_id WHERE dp.assessment_id=? ORDER BY dp.recorded_at DESC, dp.id DESC`).all(req.params.id)); }));
app.get('/api/assessments/:id/data-points/summary', ah(async(req,res)=>{ if(!await getAssessment.get(req.params.id)) return res.status(404).json({error:'Assessment not found.'}); const byBehavior=await db.prepare(`SELECT tb.id AS target_behavior_id,tb.name AS target_behavior_name,COUNT(dp.id) AS count FROM target_behaviors tb LEFT JOIN data_points dp ON dp.target_behavior_id=tb.id AND dp.assessment_id=? WHERE tb.assessment_id=? GROUP BY tb.id ORDER BY tb.id`).all(req.params.id,req.params.id); const byMeasurementType=await db.prepare('SELECT measurement_type,COUNT(*) AS count FROM data_points WHERE assessment_id=? GROUP BY measurement_type').all(req.params.id); const total=(await db.prepare('SELECT COUNT(*) AS count FROM data_points WHERE assessment_id=?').get(req.params.id)).count; res.json({total,by_behavior:byBehavior,by_measurement_type:byMeasurementType}); }));
app.post('/api/assessments/:id/data-points', ah(async(req,res)=>{ if(!await getAssessment.get(req.params.id)) return res.status(404).json({error:'Assessment not found.'}); const e=await validateDataPoint(req.body,req.params.id); if(e)return res.status(400).json({error:e}); const b=req.body; const info=await db.prepare('INSERT INTO data_points (assessment_id,target_behavior_id,recorded_at,setting,antecedent,behavior,consequence,measurement_type,value,notes) VALUES (?,?,?,?,?,?,?,?,?,?)').run(req.params.id,Number(b.target_behavior_id),b.recorded_at,clean(b.setting)||null,clean(b.antecedent)||null,clean(b.behavior)||null,clean(b.consequence)||null,b.measurement_type,b.value,clean(b.notes)||null); const created=await dataPointRow(info.lastInsertRowid); await logAudit(db,{assessment_id:req.params.id,actor:auditActor(req),action:'data_point_created',details:{label:`Data point recorded (${created.target_behavior_name||'behavior'} #${created.target_behavior_id})`,entity:'data_point',id:created.id,changed:setFields(created,DATA_POINT_FIELDS)}}); res.status(201).json(created); }));
app.put('/api/data-points/:id', ah(async(req,res)=>{ const cur=await db.prepare('SELECT * FROM data_points WHERE id=?').get(req.params.id); if(!cur)return res.status(404).json({error:'Data point not found.'}); const e=await validateDataPoint(req.body,cur.assessment_id); if(e)return res.status(400).json({error:e}); const b=req.body; await db.prepare('UPDATE data_points SET target_behavior_id=?,recorded_at=?,setting=?,antecedent=?,behavior=?,consequence=?,measurement_type=?,value=?,notes=? WHERE id=?').run(Number(b.target_behavior_id),b.recorded_at,clean(b.setting)||null,clean(b.antecedent)||null,clean(b.behavior)||null,clean(b.consequence)||null,b.measurement_type,b.value,clean(b.notes)||null,req.params.id); const updated=await dataPointRow(req.params.id); await logAudit(db,{assessment_id:cur.assessment_id,actor:auditActor(req),action:'data_point_updated',details:{label:`Data point updated`,entity:'data_point',id:cur.id,changed:changedFields(cur,updated,DATA_POINT_FIELDS)}}); res.json(updated); }));
app.delete('/api/data-points/:id', ah(async(req,res)=>{ const cur=await db.prepare('SELECT * FROM data_points WHERE id=?').get(req.params.id); if(!cur)return res.status(404).json({error:'Data point not found.'}); await db.prepare('DELETE FROM data_points WHERE id=?').run(req.params.id); await logAudit(db,{assessment_id:cur.assessment_id,actor:auditActor(req),action:'data_point_deleted',details:{label:'Data point deleted',entity:'data_point',id:cur.id,changed:['deleted']}}); res.status(204).end(); }));
// --- Function hypotheses ---
const hypSelect = `SELECT fh.*, tb.name AS target_behavior_name FROM function_hypotheses fh JOIN target_behaviors tb ON tb.id = fh.target_behavior_id WHERE fh.assessment_id = ? ORDER BY fh.target_behavior_id`;
app.get('/api/assessments/:id/function-hypotheses', ah(async (req, res) => {
 if (!await getAssessment.get(req.params.id)) return res.status(404).json({ error: 'Assessment not found.' });
 res.json((await db.prepare(hypSelect).all(req.params.id)).map(hypothesisOut));
}));
app.post('/api/assessments/:id/function-hypotheses/generate', ah(async (req, res) => {
 if (!await getAssessment.get(req.params.id)) return res.status(404).json({ error: 'Assessment not found.' });
 const behaviors = await listBehaviors.all(req.params.id);
 const points = await db.prepare('SELECT * FROM data_points WHERE assessment_id = ?').all(req.params.id);
 const results = analyzeAssessment(behaviors, points);
 const upsert = db.prepare(`INSERT INTO function_hypotheses (assessment_id, target_behavior_id, function, confidence, evidence, status)
  VALUES (?, ?, ?, ?, ?, 'draft')
  ON CONFLICT(assessment_id, target_behavior_id) DO UPDATE SET
   function = excluded.function, confidence = excluded.confidence, evidence = excluded.evidence,
   status = 'draft', updated_at = CURRENT_TIMESTAMP`);
 for (const r of results) await upsert.run(req.params.id, r.target_behavior_id, r.function, r.confidence, JSON.stringify(r.evidence));
 await logAudit(db, { assessment_id: req.params.id, actor: auditActor(req), action: 'analysis_generated', details: {
  label: `Generated analysis (${results.length} behavior${results.length === 1 ? '' : 's'} analyzed from ${points.length} data point${points.length === 1 ? '' : 's'})`,
  behavior_count: behaviors.length, point_count: points.length, hypothesis_count: results.length,
 } });
 res.json({ generated: results.length, hypotheses: (await db.prepare(hypSelect).all(req.params.id)).map(hypothesisOut) });
}));
app.put('/api/function-hypotheses/:id', ah(async (req, res) => {
 const cur = await db.prepare('SELECT * FROM function_hypotheses WHERE id = ?').get(req.params.id);
 if (!cur) return res.status(404).json({ error: 'Function hypothesis not found.' });
 const e = validateHypothesisOverride(req.body);
 if (e) return res.status(400).json({ error: e });
 const b = req.body;
 const confidence = b.confidence != null ? b.confidence : cur.confidence;
 const status = b.status || cur.status;
 const oldFn = cur.function;
 const newFn = b.function;
 const tbName = ((await db.prepare('SELECT name FROM target_behaviors WHERE id=?').get(cur.target_behavior_id)) || {}).name || 'Unknown behavior';
 const fLabel = (code) => (LABELS && LABELS.functions && LABELS.functions[code]) || code;
 await db.prepare('UPDATE function_hypotheses SET function = ?, confidence = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newFn, confidence, status, req.params.id);
 await logAudit(db, { assessment_id: cur.assessment_id, actor: auditActor(req), action: 'hypothesis_overridden', details: {
  label: `Overrode hypothesis: ${fLabel(oldFn)} → ${fLabel(newFn)} (${tbName})`,
  hypothesis_id: cur.id, target_behavior_id: cur.target_behavior_id, target_behavior_name: tbName,
  from_function: oldFn, from_function_label: fLabel(oldFn), to_function: newFn, to_function_label: fLabel(newFn),
  confidence, status,
 } });
 res.json(hypothesisOut(await db.prepare(`SELECT fh.*, tb.name AS target_behavior_name FROM function_hypotheses fh JOIN target_behaviors tb ON tb.id = fh.target_behavior_id WHERE fh.id = ?`).get(req.params.id)));
}));
// --- Data portability ---
app.get('/api/assessments/:id/export.csv', ah(async(req,res) => {
 const out=await csvExport(req.params.id); if(!out)return res.status(404).json({error:'Assessment not found.'});
 const deid=req.query.deidentified==='true'; const date=String(out.payload.assessment.assessment_date||new Date().toISOString()).slice(0,10);
 const name=deid?`Assessment_${req.params.id}`:`Data_Points_${out.payload.client?.first_name||'Client'}_${out.payload.client?.last_name||''}_${date}`.replace(/[^a-z0-9_.-]+/gi,'_');
 res.set({'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${name}.csv"`});res.send(out.csv);
}));
app.get('/api/assessments/:id/export.json', ah(async(req,res) => { const p=await assessmentExport(req.params.id);if(!p)return res.status(404).json({error:'Assessment not found.'});res.set('Content-Disposition',`attachment; filename="${req.query.deidentified==='true'?`Assessment_${req.params.id}`:`Assessment_${p.client?.first_name||'Client'}_${p.client?.last_name||''}`}.json"`);res.json(req.query.deidentified==='true'?deidentify(p):p); }));
app.post('/api/assessments/:id/import/csv', ah(async(req,res) => { const result=await importCsv(req.params.id,req.body);if(result.notFound)return res.status(404).json({error:'Assessment not found.'});if(result.error)return res.status(400).json({error:result.error});const insert=db.prepare('INSERT INTO data_points (assessment_id,target_behavior_id,recorded_at,setting,antecedent,behavior,consequence,measurement_type,value,notes) VALUES (?,?,?,?,?,?,?,?,?,?)');const tx=db.transaction(async rows=>{for(const x of rows)await insert.run(x.assessment_id,x.target_behavior_id,x.recorded_at,x.setting,x.antecedent,x.behavior,x.consequence,x.measurement_type,x.value,x.notes);});await tx(result.valid);await logAudit(db,{assessment_id:req.params.id,actor:auditActor(req),action:'data_points_imported',details:{label:`Imported ${result.valid.length} data points`,imported:result.valid.length,rejected_count:result.rejected.length}});res.json({imported:result.valid.length,rejected:result.rejected}); }));
// --- FBA report ---
app.get('/api/assessments/:id/report', ah(async (req, res) => {
 const report = await buildReport(req.params.id);
 if (!report) return res.status(404).json({ error: 'Assessment not found.' });
 const deidentified = req.query.deidentified === 'true';
 // Document generation is deliberately logged (one entry per view/print) so the
 // audit trail covers the full lifecycle: analysis → document → signatures.
 await logAudit(db, { assessment_id: req.params.id, actor: auditActor(req), action: 'document_generated', details: {
  label: `Generated ${DOCUMENT_TYPE_LABELS.fba_report}${deidentified ? ' (de-identified)' : ''}`, document_type: 'fba_report', document_type_label: DOCUMENT_TYPE_LABELS.fba_report, deidentified,
 } });
 res.json(deidentified ? deidentify(report) : report);
}));
// --- Word document exports ---
const wordType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const safeFile = (p, label) => {
 // De-identified exports must not embed a client name in the filename.
 if (p.deidentified) return `${label}_Assessment_${String(p.assessment?.id || '0').replace(/[^a-z0-9]+/gi, '_')}_${String(p.assessment?.assessment_date || new Date().toISOString().slice(0, 10)).slice(0, 10)}`;
 const n = `${p.client?.first_name || 'Client'}_${p.client?.last_name || ''}`.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '');
 return `${label}_${n || 'Client'}_${String(p.assessment?.assessment_date || new Date().toISOString().slice(0,10)).slice(0,10)}`;
};
async function sendWord(req, res, buildPayload, buildDocx, label, docType) { const p0 = await buildPayload(req.params.id); if (!p0) return res.status(404).json({ error: 'Assessment not found.' }); const deidentified = req.query.deidentified === 'true'; const p = deidentified ? deidentify(p0) : p0; await logAudit(db, { assessment_id: req.params.id, actor: auditActor(req), action: 'document_generated', details: { label: `Generated ${label}${deidentified ? ' (de-identified)' : ''}`, document_type: docType, document_type_label: label, deidentified, format: 'docx' } }); try { const buf = await pack(buildDocx(p)); res.set({ 'Content-Type': wordType, 'Content-Disposition': `attachment; filename="${safeFile(p, label)}.docx"` }); return res.send(buf); } catch (e) { console.error('docx export failed', e); return res.status(500).json({ error: 'Unable to generate Word document.' }); } }
app.get('/api/assessments/:id/report.docx', ah((req,res) => sendWord(req,res,buildReport,docxForReport,'FBA_Report','fba_report')));
app.get('/api/assessments/:id/bip.docx', ah((req,res) => sendWord(req,res,buildBip,docxForBip,'BIP','bip')));
app.get('/api/assessments/:id/crisis-plan.docx', ah((req,res) => sendWord(req,res,buildCrisisPlan,docxForCrisis,'Crisis_Plan','crisis_plan')));
app.get('/api/assessments/:id/data-sheet.docx', ah((req,res) => sendWord(req,res,buildDataSheet,docxForDataSheet,'Data_Sheet','data_sheet')));
async function sendPdf(req, res, buildPayload, buildPdf, label, docType) { const p0=await buildPayload(req.params.id); if(!p0)return res.status(404).json({error:'Assessment not found.'}); const p=req.query.deidentified==='true'?deidentify(p0):p0; try { const buf=await buildPdf(p); res.set({'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${safeFile(p,label)}.pdf"`}); return res.send(buf); } catch(e) { console.error('pdf export failed',e); return res.status(500).json({error:'Unable to generate PDF document.'}); } }
app.get('/api/assessments/:id/report.pdf',ah((req,res)=>sendPdf(req,res,buildReport,pdfForReport,'FBA_Report','fba_report')));
app.get('/api/assessments/:id/bip.pdf',ah((req,res)=>sendPdf(req,res,buildBip,pdfForBip,'BIP','bip')));
app.get('/api/assessments/:id/crisis-plan.pdf',ah((req,res)=>sendPdf(req,res,buildCrisisPlan,pdfForCrisis,'Crisis_Plan','crisis_plan')));
app.get('/api/assessments/:id/data-sheet.pdf',ah((req,res)=>sendPdf(req,res,buildDataSheet,pdfForDataSheet,'Data_Sheet','data_sheet')));
app.get('/api/progress-reports/:id.pdf', ah(async (req,res) => { const row=await db.prepare('SELECT * FROM progress_reports WHERE id=?').get(req.params.id); if(!row)return res.status(404).json({error:'Progress report not found.'}); try { let p={id:row.id,...JSON.parse(row.payload),created_at:row.created_at}; if(req.query.deidentified==='true')p=deidentify(p); const buf=await pdfForProgressReport(p); res.set({'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${safeFile(p,'Progress_Report')}_${row.period}.pdf"`}); return res.send(buf); } catch(e) { console.error('pdf export failed',e); return res.status(500).json({error:'Unable to generate PDF document.'}); } }));
app.get('/api/progress-reports/:id.docx', ah(async (req,res) => { const row=await db.prepare('SELECT * FROM progress_reports WHERE id=?').get(req.params.id); if (!row) return res.status(404).json({ error: 'Progress report not found.' }); const deidentified = req.query.deidentified === 'true'; try { let p={id:row.id,...JSON.parse(row.payload),created_at:row.created_at}; if (deidentified) p = deidentify(p); const buf=await pack(docxForProgressReport(p)); res.set({ 'Content-Type': wordType, 'Content-Disposition': `attachment; filename="${safeFile(p,'Progress_Report')}_${row.period}.docx"` }); return res.send(buf); } catch { return res.status(500).json({error:'Unable to generate Word document.'}); } }));
// --- Period progress reports ---
app.post('/api/assessments/:id/progress-reports', ah(async(req,res) => {
 if (!await getAssessment.get(req.params.id)) return res.status(404).json({error:'Assessment not found.'});
 const type=req.body.period_type, period=req.body.period, parsed=parsePeriod(type,period);
 if (!parsed) return res.status(400).json({error:'Invalid period. Use month YYYY-MM or quarter YYYY-Q1 through YYYY-Q4.'});
 const payload=await buildProgressReport(req.params.id,type,period);
 const info=await db.prepare('INSERT INTO progress_reports (assessment_id,period_type,period,period_label,start_date,end_date,payload) VALUES (?,?,?,?,?,?,?)').run(req.params.id,type,period,parsed.label,parsed.start,parsed.end,JSON.stringify(payload));
 await logAudit(db,{assessment_id:req.params.id,actor:auditActor(req),action:'progress_report_created',details:{label:`Progress report generated: ${parsed.label}`,entity:'progress_report',id:Number(info.lastInsertRowid),period_type:type,period}});
 res.status(201).json({id:Number(info.lastInsertRowid),...payload});
}));
app.get('/api/assessments/:id/progress-reports', ah(async(req,res) => {
 if (!await getAssessment.get(req.params.id)) return res.status(404).json({error:'Assessment not found.'});
 res.json(await db.prepare('SELECT id,period_type,period,period_label,created_at FROM progress_reports WHERE assessment_id=? ORDER BY created_at DESC,id DESC').all(req.params.id));
}));
app.get('/api/progress-reports/:id', ah(async(req,res) => {
 const row=await db.prepare('SELECT * FROM progress_reports WHERE id=?').get(req.params.id); if(!row)return res.status(404).json({error:'Progress report not found.'});
 try { const p={id:row.id,...JSON.parse(row.payload),created_at:row.created_at}; return res.json(req.query.deidentified === 'true' ? deidentify(p) : p); } catch { return res.status(500).json({error:'Stored report payload is invalid.'}); }
}));
// --- Printable support documents (BIP / crisis plan / blank data sheets) ---
// Same shape and validation as /report: builders in server/src/documents.js.
// Each view is audit-logged (document_generated), consistent with /report.
app.get('/api/assessments/:id/bip', ah(async (req, res) => {
 const doc = await buildBip(req.params.id);
 if (!doc) return res.status(404).json({ error: 'Assessment not found.' });
 const deidentified = req.query.deidentified === 'true';
 await logAudit(db, { assessment_id: req.params.id, actor: auditActor(req), action: 'document_generated', details: {
  label: `Generated ${DOCUMENT_TYPE_LABELS.bip}${deidentified ? ' (de-identified)' : ''}`, document_type: 'bip', document_type_label: DOCUMENT_TYPE_LABELS.bip, deidentified,
 } });
 res.json(deidentified ? deidentify(doc) : doc);
}));
app.get('/api/assessments/:id/crisis-plan', ah(async (req, res) => {
 const doc = await buildCrisisPlan(req.params.id);
 if (!doc) return res.status(404).json({ error: 'Assessment not found.' });
 const deidentified = req.query.deidentified === 'true';
 await logAudit(db, { assessment_id: req.params.id, actor: auditActor(req), action: 'document_generated', details: {
  label: `Generated ${DOCUMENT_TYPE_LABELS.crisis_plan}${deidentified ? ' (de-identified)' : ''}`, document_type: 'crisis_plan', document_type_label: DOCUMENT_TYPE_LABELS.crisis_plan, deidentified,
 } });
 res.json(deidentified ? deidentify(doc) : doc);
}));
app.get('/api/assessments/:id/data-sheet', ah(async (req, res) => {
 const doc = await buildDataSheet(req.params.id);
 if (!doc) return res.status(404).json({ error: 'Assessment not found.' });
 const deidentified = req.query.deidentified === 'true';
 await logAudit(db, { assessment_id: req.params.id, actor: auditActor(req), action: 'document_generated', details: {
  label: `Generated ${DOCUMENT_TYPE_LABELS.data_sheet}${deidentified ? ' (de-identified)' : ''}`, document_type: 'data_sheet', document_type_label: DOCUMENT_TYPE_LABELS.data_sheet, deidentified,
 } });
 res.json(deidentified ? deidentify(doc) : doc);
}));
// --- Sign-offs (typed-name record + formal Ed25519 e-signature) ---
// Decision notes (kept in one place so the semantics are stable):
//  * Duplicate (assessment, document_type, signatory_role) POST -> 409 Conflict.
//    No upsert: each role signs each document once, and the audit trail keeps
//    exactly one "created" event per row. The UI pre-disables already-added roles.
//  * POST /sign -> 400 when already signed (no silent re-sign). A signed record
//    is revoked first via DELETE, keeping the trail explicit.
//  * Signing computes a SHA-256 digest over the canonical JSON of the SAME
//    document payload the export builders produce (buildReport/buildBip/
//    buildCrisisPlan), signs the digest bytes with the org Ed25519 key, and
//    stores signature + digest + key fingerprint on the row. Verification
//    re-checks both the cryptography and the current document content.
//  * DELETE revoke -> hard-deletes the row; the audit entry preserves the
//    signatory + status (was_signed) at the time of removal.
//  * Data sheets carry no signatures, so sign_offs only covers the three
//    signable documents: fba_report, bip, crisis_plan.
const signOffById = db.prepare('SELECT * FROM sign_offs WHERE id = ?');
app.get('/api/assessments/:id/sign-offs', ah(async (req, res) => {
 if (!await getAssessment.get(req.params.id)) return res.status(404).json({ error: 'Assessment not found.' });
 const dt = req.query.document_type;
 if (dt != null && !DOCUMENT_TYPES.includes(dt)) return res.status(400).json({ error: `Invalid document_type. Must be one of: ${DOCUMENT_TYPES.join(', ')}.` });
 const rows = dt
  ? await db.prepare('SELECT * FROM sign_offs WHERE assessment_id=? AND document_type=? ORDER BY id').all(req.params.id, dt)
  : await db.prepare('SELECT * FROM sign_offs WHERE assessment_id=? ORDER BY id').all(req.params.id);
 res.json(rows.map(signOffOut));
}));
app.post('/api/assessments/:id/sign-offs', ah(async (req, res) => {
 if (!await getAssessment.get(req.params.id)) return res.status(404).json({ error: 'Assessment not found.' });
 const e = validateSignOff(req.body);
 if (e) return res.status(400).json({ error: e });
 const b = req.body, name = clean(b.signatory_name);
 let info;
 try {
  info = await db.prepare('INSERT INTO sign_offs (assessment_id, document_type, signatory_role, signatory_name) VALUES (?, ?, ?, ?)')
   .run(req.params.id, b.document_type, b.signatory_role, name);
 } catch (err) {
  if (String(err.message).includes('UNIQUE')) {
   return res.status(409).json({ error: `A ${SIGNATORY_ROLE_LABELS[b.signatory_role]} signatory already exists for the ${DOCUMENT_TYPE_LABELS[b.document_type]} on this assessment. Each role signs each document once — revoke the existing signatory first if you need to replace them.` });
  }
  throw err;
 }
 const row = signOffOut(await db.prepare('SELECT * FROM sign_offs WHERE id = ?').get(info.lastInsertRowid));
 await logAudit(db, { assessment_id: req.params.id, actor: auditActor(req), action: 'sign_off_created', details: {
  label: `Signatory added: ${row.signatory_role_label} (${row.signatory_name}) — ${row.document_type_label}`,
  sign_off_id: row.id, document_type: row.document_type, document_type_label: row.document_type_label,
  signatory_role: row.signatory_role, signatory_role_label: row.signatory_role_label, signatory_name: row.signatory_name,
 } });
 res.status(201).json(row);
}));
app.post('/api/sign-offs/:id/sign', ah(async (req, res) => {
 const row = await signOffById.get(req.params.id);
 if (!row) return res.status(404).json({ error: 'Sign-off not found.' });
 if (row.status === 'signed') return res.status(400).json({ error: 'This signatory has already signed. The recorded signature is in the audit trail; revoke the sign-off first if the signature needs to be redone.' });
 const sig = clean(req.body.signature);
 if (!sig) return res.status(400).json({ error: 'signature is required — type the signatory name as the in-app signature.' });
 if (sig.length > 500) return res.status(400).json({ error: 'signature must be 500 characters or fewer.' });
 // Formal e-signature: digest + sign the exact payload the export builders
 // produce for this assessment/document_type, so the signature covers what is
 // actually exported (report/bip/crisis-plan).
 const build = DOC_BUILDERS[row.document_type];
 const payload = build ? await build(row.assessment_id) : null;
 if (!payload) return res.status(404).json({ error: 'Assessment not found.' });
 const { digest, signature: sigB64, fingerprint } = await signDocument(payload, row.document_type);
 const signedAt = new Date().toISOString();
 // `signature` stores the base64 Ed25519 signature bytes (verifiable later);
 // `signature_typed` keeps the human-readable typed-name signature.
 await db.prepare("UPDATE sign_offs SET status = 'signed', signature = ?, signature_algo = ?, signature_digest = ?, signature_key_fingerprint = ?, signature_typed = ?, signed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
  .run(sigB64, SIGNATURE_ALGO, digest, fingerprint, sig, signedAt, req.params.id);
 const updated = signOffOut(await signOffById.get(req.params.id));
 await logAudit(db, { assessment_id: updated.assessment_id, actor: auditActor(req), action: 'sign_off_signed', details: {
  label: `Signed ${updated.document_type_label} as ${updated.signatory_role_label} (${updated.signatory_name}) — Ed25519 ${String(updated.signature_key_fingerprint).slice(0, 8)}…`,
  sign_off_id: updated.id, document_type: updated.document_type, document_type_label: updated.document_type_label,
  signatory_role: updated.signatory_role, signatory_role_label: updated.signatory_role_label,
  signatory_name: updated.signatory_name, signature_typed: updated.signature_typed, signed_at: updated.signed_at,
  // Cryptographic details so the audit trail can re-verify the signature.
  signature_algo: updated.signature_algo, signature_digest: updated.signature_digest,
  signature_key_fingerprint: updated.signature_key_fingerprint,
 } });
 res.json(updated);
}));
// Shared verification: cryptographic check against the stored digest AND a
// content check (the digest of the CURRENT document payload must equal the
// stored digest — so editing the assessment after signing flips valid=false,
// tampered=true).
async function verifySignOffRow(row) {
 if (!row || row.status !== 'signed' || !row.signature_digest) return { error: 'This sign-off has not been digitally signed.' };
 const build = DOC_BUILDERS[row.document_type];
 const payload = build ? await build(row.assessment_id) : null;
 if (!payload) return { error: 'Assessment not found.' };
 const v = await verifyDocument(payload, row.document_type, {
  digest: row.signature_digest, signature: row.signature, fingerprint: row.signature_key_fingerprint,
 });
 return { result: {
  valid: v.valid, tampered: v.tampered,
  signed_at: row.signed_at, signatory_name: row.signatory_name,
  document_type: row.document_type, document_type_label: DOCUMENT_TYPE_LABELS[row.document_type] || row.document_type,
  algorithm: row.signature_algo || SIGNATURE_ALGO, key_fingerprint: row.signature_key_fingerprint,
 } };
}
app.get('/api/sign-offs/:id/verify', ah(async (req, res) => {
 const row = await signOffById.get(req.params.id);
 if (!row) return res.status(404).json({ error: 'Sign-off not found.' });
 const out = await verifySignOffRow(row);
 if (out.error) return res.status(400).json({ error: out.error });
 res.json(out.result);
}));
// Unauthenticated verification for document recipients: returns ONLY the
// minimal verification payload — no client or assessment PHI whatsoever.
app.get('/api/verify/sign-off/:id', ah(async (req, res) => {
 const row = await signOffById.get(req.params.id);
 if (!row) return res.status(404).json({ error: 'Sign-off not found.' });
 const out = await verifySignOffRow(row);
 if (out.error) return res.status(400).json({ error: out.error });
 res.json({
  valid: out.result.valid, tampered: out.result.tampered,
  signed_at: out.result.signed_at, document_type: out.result.document_type,
  algorithm: out.result.algorithm, key_fingerprint: out.result.key_fingerprint,
  signatory_name: out.result.signatory_name,
 });
}));
app.delete('/api/sign-offs/:id', ah(async (req, res) => {
 const row = await signOffById.get(req.params.id);
 if (!row) return res.status(404).json({ error: 'Sign-off not found.' });
 const wasSigned = row.status === 'signed';
 await db.prepare('DELETE FROM sign_offs WHERE id = ?').run(req.params.id);
 await logAudit(db, { assessment_id: row.assessment_id, actor: auditActor(req), action: 'sign_off_revoked', details: {
  label: `Sign-off revoked: ${SIGNATORY_ROLE_LABELS[row.signatory_role]} (${row.signatory_name}) — ${DOCUMENT_TYPE_LABELS[row.document_type]}${wasSigned ? ` (had signed ${String(row.signed_at).slice(0, 10)})` : ''}`,
  sign_off_id: row.id, document_type: row.document_type, document_type_label: DOCUMENT_TYPE_LABELS[row.document_type],
  signatory_role: row.signatory_role, signatory_role_label: SIGNATORY_ROLE_LABELS[row.signatory_role],
  signatory_name: row.signatory_name, was_signed: wasSigned, signed_at: row.signed_at,
 } });
 res.status(204).end();
}));
// --- Audit trail ---
app.get('/api/assessments/:id/audit-log', ah(async (req, res) => {
 if (!await getAssessment.get(req.params.id)) return res.status(404).json({ error: 'Assessment not found.' });
 const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
 const rows = await db.prepare('SELECT * FROM audit_log WHERE assessment_id=? ORDER BY id DESC LIMIT ?').all(req.params.id, limit);
 res.json(rows.map((r) => {
  let details = {};
  try { details = JSON.parse(r.details || '{}'); } catch {}
  return { ...r, details };
 }));
}));
// Global audit feed (admin only) — every recorded action across all clients and
// assessments, newest first, for supervision. Includes client-level events
// (assessment_id null) that the per-assessment endpoint cannot surface.
app.get('/api/admin/audit-log', requireRole('admin'), ah(async (req, res) => {
 const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
 const rows = await db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
 res.json(rows.map((r) => {
  let details = {};
  try { details = JSON.parse(r.details || '{}'); } catch {}
  return { ...r, details };
 }));
}));
app.use((err,_,res,__)=>(console.error(err),res.status(500).json({error:'Internal server error.'})));
export { app };
// Boot: wait for schema creation/migration (instant for SQLite, async for
// Postgres) and seed the development accounts. Exported separately from
// listen() so a serverless platform (Vercel) can await the same boot path
// before serving requests — the API surface is identical either way.
export async function bootstrap() {
 // Wait for schema creation/migration (instant for SQLite, async for Postgres).
 await db.ready;
 // Seed accounts are development-only; change them before any production deployment.
 if ((await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n===0){
  await db.prepare('INSERT INTO users(username,password_hash,role,display_name,must_change_password) VALUES (?,?,?,?,1)').run('admin',hashPassword('admin123'),'admin','Administrator');
  await db.prepare('INSERT INTO users(username,password_hash,role,display_name,must_change_password) VALUES (?,?,?,?,1)').run('bcba',hashPassword('admin123'),'bcba','Sam Rivera, BCBA');
  console.log('Seeded default users: admin / admin123, bcba / admin123 — CHANGE BEFORE PRODUCTION.');
 }
 for(const name of ['admin','bcba']){const seed=await db.prepare('SELECT * FROM users WHERE username=?').get(name);if(seed&&!seed.must_change_password&&verifyPassword('admin123',seed.password_hash))await db.prepare('UPDATE users SET must_change_password=1 WHERE id=?').run(seed.id);}
}
// When run directly (local dev / a Node host), listen. Under a serverless
// platform (VERCEL set) the platform invokes the exported app via vercel-entry.
if (!process.env.VERCEL) {
 bootstrap().then(() => {
  app.listen(port,'0.0.0.0',()=>console.log(`ClearPathFBA API listening on ${port}`));
 }).catch((err) => { console.error('Startup failed:', err); process.exit(1); });
}
