import crypto from 'node:crypto';
import db from './db.js';
const ROLES=['admin','bcba','specialist','staff','supervisor','guardian'];
export const PERMISSIONS={
 admin:['*'], bcba:['*'], supervisor:['read','signoff','analysis','override'], specialist:['read','client_write','assessment_write','behavior_write','data_write','analysis','override','signoff'], staff:['read','data_write'], guardian:['read','guardian_signoff']
};
export const hashPassword=(password)=>{const N=16384,r=8,p=1,salt=crypto.randomBytes(16);const hash=crypto.scryptSync(String(password),salt,64,{N,r,p,maxmem:32*1024*1024});return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;};
export const verifyPassword=(password,encoded)=>{try{const [alg,N,r,p,salt,hash]=String(encoded).split('$');if(alg!=='scrypt')return false;const got=crypto.scryptSync(String(password),Buffer.from(salt,'base64'),Buffer.from(hash,'base64').length,{N:Number(N),r:Number(r),p:Number(p),maxmem:32*1024*1024});return crypto.timingSafeEqual(got,Buffer.from(hash,'base64'));}catch{return false;}};
export const publicUser=u=>({id:u.id,username:u.username,role:u.role,display_name:u.display_name,active:u.active,must_change_password:!!u.must_change_password,mfa_enabled:!!u.mfa_enabled,
 // Organization scope: resolved server-side from the session row, never from
 // the request. `is_platform_admin` is the explicit flag that allows crossing
 // organizations (see org.js); `org_name`/`org_slug` are display-only and are
 // present on session-derived users.
 org_id:u.org_id??null,org_name:u.org_name??null,org_slug:u.org_slug??null,is_platform_admin:u.is_platform_admin?1:0});
// Session issuance/reads are async-capable: `await` works in both SQLite and
// Postgres modes (awaiting a sync value is a no-op).
export const issueSession=async(userId)=>{const raw=crypto.randomBytes(32).toString('hex');const tokenHash=crypto.createHash('sha256').update(raw).digest('hex');await db.prepare(`INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,${db.currentTimestamp},${db.nowPlus(7*24*60)})`).run(tokenHash,userId);return raw;};
// The session is the only source of organization scope: the users row is
// joined to its organization here, so req.user.org_id can never be spoofed by
// a request parameter or body.
export const getSessionUser=async(token)=>{if(!token)return null;const h=crypto.createHash('sha256').update(token).digest('hex');const u=await db.prepare("SELECT u.*, o.name AS org_name, o.slug AS org_slug FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN organizations o ON o.id=u.org_id WHERE s.token_hash=? AND s.expires_at>CURRENT_TIMESTAMP AND u.active=1").get(h);return u?publicUser(u):null;};
export const requireAuth=async(req,res,next)=>{const m=req.get('authorization')||'';let u=null;try{u=m.startsWith('Bearer ')?await getSessionUser(m.slice(7)):null;}catch(err){return next(err);}if(!u){res.set('WWW-Authenticate','Bearer');return res.status(401).json({error:'Authentication required.'});}req.user=u;next();};
export const requireRole=(...roles)=>(req,res,next)=>roles.includes(req.user?.role)?next():res.status(403).json({error:'Insufficient permissions.'});
export {ROLES};
