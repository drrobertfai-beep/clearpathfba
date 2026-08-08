import crypto from 'node:crypto';
const ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf){let out='',bits=0,val=0;for(const b of buf){val=(val<<8)|b;bits+=8;while(bits>=5){out+=ALPHABET[(val>>>(bits-5))&31];bits-=5;}}if(bits)out+=ALPHABET[(val<<(5-bits))&31];return out;}
function base32Decode(s){let bits=0,val=0,out=[];for(const c of String(s).toUpperCase().replace(/=+$/,'')){const n=ALPHABET.indexOf(c);if(n<0)continue;val=(val<<5)|n;bits+=5;if(bits>=8){out.push((val>>>(bits-8))&255);bits-=8;}}return Buffer.from(out);}
export function generateSecret(){return base32Encode(crypto.randomBytes(20));}
export function otpauthUri(secret,account,issuer='ClearPathFBA'){return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;}
export function totp(secret,counter){const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(counter));const h=crypto.createHmac('sha1',base32Decode(secret)).update(b).digest();const off=h[19]&15;const n=((h[off]&127)<<24)|(h[off+1]<<16)|(h[off+2]<<8)|h[off+3];return String(n%1000000).padStart(6,'0');}
export function verifyTOTP(secret,code,window=1,now=Date.now()){const c=String(code||'').replace(/\s/g,'');if(!/^\d{6}$/.test(c))return false;const counter=Math.floor(now/30000);return Array.from({length:window*2+1},(_,i)=>counter+i-window).some(x=>crypto.timingSafeEqual(Buffer.from(totp(secret,x)),Buffer.from(c)));}
export function generateBackupCodes(){return Array.from({length:10},()=>crypto.randomBytes(5).toString('hex').toUpperCase().slice(0,8));}
export function hashBackupCode(code){return crypto.createHash('sha256').update(String(code).replace(/[-\s]/g,'').toUpperCase()).digest('hex');}
const key=()=>Buffer.from(process.env.MFA_TOKEN_SECRET||'clearpathfba-mfa-change-in-production');
export function issueMfaToken(userId){const p=Buffer.from(JSON.stringify({userId,exp:Date.now()+5*60*1000})).toString('base64url');return `${p}.${crypto.createHmac('sha256',key()).update(p).digest('base64url')}`;}
export function verifyMfaToken(token){try{const [p,s]=String(token).split('.');const good=crypto.createHmac('sha256',key()).update(p).digest('base64url');if(!s||!crypto.timingSafeEqual(Buffer.from(s),Buffer.from(good)))return null;const v=JSON.parse(Buffer.from(p,'base64url'));return v.exp>Date.now()?v:null;}catch{return null;}}
