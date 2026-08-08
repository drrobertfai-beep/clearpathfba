import crypto from 'node:crypto';
import db from './db.js';
const ROLES=['admin','bcba','specialist','staff','supervisor','guardian'];
export const PERMISSIONS={
 admin:['*'], bcba:['*'], supervisor:['read','signoff','analysis','override'], specialist:['read','client_write','assessment_write','behavior_write','data_write','analysis','override','signoff'], staff:['read','data_write'], guardian:['read','guardian_signoff']
};
export const hashPassword=(password)=>{const N=16384,r=8,p=1,salt=crypto.randomBytes(16);const hash=crypto.scryptSync(String(password),salt,64,{N,r,p,maxmem:32*1024*1024});return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;};
export const verifyPassword=(password,encoded)=>{try{const [alg,N,r,p,salt,hash]=String(encoded).split('$');if(alg!=='scrypt')return false;const got=crypto.scryptSync(String(password),Buffer.from(salt,'base64'),Buffer.from(hash,'base64').length,{N:Number(N),r:Number(r),p:Number(p),maxmem:32*1024*1024});return crypto.timingSafeEqual(got,Buffer.from(hash,'base64'));}catch{return false;}};
const publicUser=u=>({id:u.id,username:u.username,role:u.role,display_name:u.display_name,active:u.active,must_change_password:!!u.must_change_password});
export const issueSession=(userId)=>{const raw=crypto.randomBytes(32).toString('hex');const tokenHash=crypto.createHash('sha256').update(raw).digest('hex');db.prepare("INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,CURRENT_TIMESTAMP,datetime('now','+7 days'))").run(tokenHash,userId);return raw;};
export const getSessionUser=(token)=>{if(!token)return null;const h=crypto.createHash('sha256').update(token).digest('hex');const u=db.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>CURRENT_TIMESTAMP AND u.active=1").get(h);return u?publicUser(u):null;};
export const requireAuth=(req,res,next)=>{const m=req.get('authorization')||'';const u=m.startsWith('Bearer ')?getSessionUser(m.slice(7)):null;if(!u){res.set('WWW-Authenticate','Bearer');return res.status(401).json({error:'Authentication required.'});}req.user=u;next();};
export const requireRole=(...roles)=>(req,res,next)=>roles.includes(req.user?.role)?next():res.status(403).json({error:'Insufficient permissions.'});
export {ROLES,publicUser};
