import crypto from 'node:crypto';
import db from './db.js';
import { issueSession } from './auth.js';
import { logAudit } from './audit.js';

const states = new Map();
let discoveryCache = null;
const ttl = 60 * 60 * 1000;
export const ssoEnabled = () => Boolean(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET);
const issuer = () => String(process.env.OIDC_ISSUER || '').replace(/\/$/, '');
const publicBase = req => `${req.protocol}://${req.get('host')}`;
export const redirectUri = req => process.env.OIDC_REDIRECT_URI || `${publicBase(req)}/api/auth/sso/callback`;
const disabled = res => res.status(503).json({ error: 'SSO is not configured.' });
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
const prune = () => { const now = Date.now(); for (const [k,v] of states) if (v.expires < now) states.delete(k); };

export async function discover() {
 if (!ssoEnabled()) throw new Error('SSO is not configured.');
 if (discoveryCache && discoveryCache.expires > Date.now()) return discoveryCache.value;
 const r = await fetch(`${issuer()}/.well-known/openid-configuration`);
 if (!r.ok) throw new Error('OIDC discovery failed.');
 const d = await r.json();
 if (!d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri || d.issuer !== issuer()) throw new Error('Invalid OIDC discovery document.');
 discoveryCache = { value: d, expires: Date.now() + ttl }; return d;
}
export function resetSsoState() { states.clear(); discoveryCache = null; }
export const createState = (redirect, lifetimeMs = 10 * 60 * 1000) => { prune(); const state=crypto.randomBytes(32).toString('hex'), nonce=crypto.randomBytes(32).toString('hex'); states.set(state,{state,nonce,redirect,expires:Date.now()+lifetimeMs}); return {state,nonce}; };
export const consumeState = state => { prune(); const v=states.get(state); if (v) states.delete(state); return v && v.expires>Date.now() ? v : null; };

const b64 = s => Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/'), 'base64');
const derInt = b => { let x=Buffer.from(b); while(x.length>1&&x[0]===0)x=x.subarray(1); if(x[0]&128)x=Buffer.concat([Buffer.from([0]),x]); return Buffer.concat([Buffer.from([2,x.length]),x]); };
const joseToDer = sig => { const n=sig.length/2; const r=derInt(sig.subarray(0,n)),s=derInt(sig.subarray(n)); const body=Buffer.concat([r,s]); return Buffer.concat([Buffer.from([48,body.length]),body]); };
export function verifyIdToken(token, jwks, { issuer: iss, clientId, nonce, now=Math.floor(Date.now()/1000) }) {
 const p=String(token).split('.'); if(p.length!==3) throw new Error('Invalid ID token.');
 const header=JSON.parse(b64(p[0])), claims=JSON.parse(b64(p[1]));
 if(!['RS256','ES256'].includes(header.alg)||!header.kid) throw new Error('Unsupported ID token signature.');
 const jwk=(jwks.keys||[]).find(k=>k.kid===header.kid); if(!jwk) throw new Error('ID token key not found.');
 const key=crypto.createPublicKey({key:jwk,format:'jwk'}); const verifier=crypto.createVerify(header.alg==='RS256'?'RSA-SHA256':'SHA256'); verifier.update(`${p[0]}.${p[1]}`); verifier.end();
 if(!verifier.verify(key,header.alg==='ES256'?joseToDer(b64(p[2])):b64(p[2]))) throw new Error('Invalid ID token signature.');
 const aud=Array.isArray(claims.aud)?claims.aud:[claims.aud]; if(claims.iss!==iss||!aud.includes(clientId)||!claims.exp||claims.exp<=now||claims.nonce!==nonce) throw new Error('Invalid ID token claims.');
 return claims;
}
async function userInfo(d, accessToken) { if(!d.userinfo_endpoint) return {}; const r=await fetch(d.userinfo_endpoint,{headers:{Authorization:`Bearer ${accessToken}`}}); if(!r.ok) throw new Error('OIDC userinfo failed.'); return r.json(); }
const failRedirect = (req, code) => `${publicBase(req)}/#/sso?error=${encodeURIComponent(code)}`;
export function registerSsoRoutes(app) {
 app.get('/api/auth/sso/status',(req,res)=>res.json({enabled:ssoEnabled(),provider_name:process.env.OIDC_PROVIDER_NAME|| (process.env.OIDC_ISSUER ? new URL(process.env.OIDC_ISSUER).hostname : 'SSO')}));
 app.get('/api/auth/sso/login',async(req,res)=>{if(!ssoEnabled())return disabled(res); try {const d=await discover(); const {state,nonce}=createState(redirectUri(req)); await logAudit(db,{assessment_id:null,actor:'sso',action:'sso_login_start',details:{provider:d.issuer}}); const u=new URL(d.authorization_endpoint); for(const [k,v] of Object.entries({response_type:'code',client_id:process.env.OIDC_CLIENT_ID,redirect_uri:redirectUri(req),scope:'openid email profile',state,nonce}))u.searchParams.set(k,v); res.redirect(u.toString());}catch(e){res.status(502).json({error:e.message||'SSO provider unavailable.'});}});
 app.get('/api/auth/sso/callback',async(req,res)=>{if(!ssoEnabled())return disabled(res); const st=consumeState(req.query.state); if(!st)return res.status(400).json({error:'Invalid or expired SSO state.'}); if(!req.query.code)return res.redirect(failRedirect(req,'sso_failed')); try {const d=await discover(); const basic=Buffer.from(`${process.env.OIDC_CLIENT_ID}:${process.env.OIDC_CLIENT_SECRET}`).toString('base64'); const tr=await fetch(d.token_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Authorization:`Basic ${basic}`},body:new URLSearchParams({grant_type:'authorization_code',code:String(req.query.code),redirect_uri:st.redirect})}); if(!tr.ok)throw new Error('OIDC token exchange failed.'); const tok=await tr.json(); const jr=await fetch(d.jwks_uri); if(!jr.ok)throw new Error('OIDC JWKS fetch failed.'); const jwks=await jr.json(); const claims=verifyIdToken(tok.id_token,jwks,{issuer:d.issuer,clientId:process.env.OIDC_CLIENT_ID,nonce:st.nonce}); const info=await userInfo(d,tok.access_token); const email=String(info.email||claims.email||'').trim().toLowerCase(); if(!email)throw new Error('SSO email is required.'); const u=await db.prepare('SELECT * FROM users WHERE lower(email)=? AND active=1').get(email); if(!u){await logAudit(db,{assessment_id:null,actor:'sso',action:'sso_login_failure',details:{email_hash:hash(email),provider_sub:claims.sub,reason:'no_account'}});return res.redirect(failRedirect(req,'no_account'));} const token=await issueSession(u.id); await logAudit(db,{assessment_id:null,actor:u.username,action:'sso_login_success',details:{email_hash:hash(email),provider_sub:claims.sub}}); res.redirect(`${publicBase(req)}/#/sso?token=${encodeURIComponent(token)}`); }catch(e){await logAudit(db,{assessment_id:null,actor:'sso',action:'sso_login_failure',details:{provider_sub:'unknown',reason:e.message}}); res.redirect(failRedirect(req,'sso_failed'));}});
}
