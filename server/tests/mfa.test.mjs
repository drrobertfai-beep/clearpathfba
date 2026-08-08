import assert from 'node:assert/strict';
import { test } from 'node:test';
import { totp, verifyTOTP, hashBackupCode, generateBackupCodes, base32Encode } from '../src/mfa.js';
// RFC 6238 SHA-1 test secret (ASCII "12345678901234567890")
const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
test('RFC 6238 SHA-1 vectors',()=>{assert.equal(totp(secret,Math.floor(59/30)),'287082');assert.equal(totp(secret,Math.floor(1111111109/30)),'081804');assert.equal(totp(secret,Math.floor(20000000000/30)),'353130');});
test('TOTP accepts adjacent 30 second windows',()=>{const now=Date.UTC(2025,0,1,0,0,0)+30000;const code=totp(secret,Math.floor(now/30000)-1);assert.equal(verifyTOTP(secret,code,1,now),true);assert.equal(verifyTOTP(secret,code,0,now),false);});
test('backup codes are 10 random eight character values and hashes are deterministic',()=>{const codes=generateBackupCodes();assert.equal(codes.length,10);assert.ok(codes.every(c=>/^[A-F0-9]{8}$/.test(c)));assert.equal(hashBackupCode(codes[0]),hashBackupCode(codes[0]));assert.notEqual(hashBackupCode(codes[0]),codes[0]);});
test('base32 encodes 160-bit secrets to 32 chars',()=>assert.match(base32Encode(Buffer.alloc(20)),/^[A-Z2-7]{32}$/));
