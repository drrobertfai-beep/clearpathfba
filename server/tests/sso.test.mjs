import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createState, consumeState, resetSsoState, verifyIdToken, ssoEnabled } from '../src/sso.js';

const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function tokenFor({ privateKey, alg = 'RS256', claims, kid = 'test-key' }) {
  const header = enc({ alg, typ: 'JWT', kid });
  const body = enc(claims);
  const input = `${header}.${body}`;
  const signer = crypto.createSign(alg === 'RS256' ? 'RSA-SHA256' : 'SHA256');
  signer.update(input); signer.end();
  let signature = alg === 'ES256' ? signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }) : signer.sign(privateKey);
  if (alg === 'ES256') {
    // Node emits DER ECDSA signatures; JWT requires fixed-width R||S.
    // dsaEncoding above already produces JWT's fixed-width R||S format.
    signature = signature;
  }
  return `${input}.${signature.toString('base64url')}`;
}

test('SSO is disabled without OIDC configuration', () => {
  const saved = { issuer: process.env.OIDC_ISSUER, id: process.env.OIDC_CLIENT_ID, secret: process.env.OIDC_CLIENT_SECRET };
  delete process.env.OIDC_ISSUER; delete process.env.OIDC_CLIENT_ID; delete process.env.OIDC_CLIENT_SECRET;
  assert.equal(ssoEnabled(), false);
  for (const [key, value] of Object.entries({ OIDC_ISSUER: saved.issuer, OIDC_CLIENT_ID: saved.id, OIDC_CLIENT_SECRET: saved.secret })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('state is single-use and expired or unknown states are rejected', () => {
  resetSsoState();
  const made = createState('/callback');
  const consumed = consumeState(made.state);
  assert.equal(consumed.state, made.state);
  assert.equal(consumed.nonce, made.nonce);
  assert.equal(consumed.redirect, '/callback');
  assert.ok(consumed.expires > Date.now());
  assert.equal(consumeState(made.state), null);
  assert.equal(consumeState('unknown'), null);
});

test('RS256 ID tokens verify and claim or signature tampering fails', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }); jwk.kid = 'rsa';
  const claims = { iss: 'https://issuer.example', aud: 'client', exp: Math.floor(Date.now() / 1000) + 300, nonce: 'nonce', sub: 'u1', email: 'person@example.com' };
  const token = tokenFor({ privateKey, claims, kid: 'rsa' });
  assert.equal(verifyIdToken(token, { keys: [jwk] }, { issuer: claims.iss, clientId: 'client', nonce: 'nonce' }).sub, 'u1');
  const parts = token.split('.');
  const sigBytes = Buffer.from(parts[2], 'base64url'); sigBytes[0] ^= 1;
  const badSig = `${parts[0]}.${parts[1]}.${sigBytes.toString('base64url')}`;
  assert.throws(() => verifyIdToken(badSig, { keys: [jwk] }, { issuer: claims.iss, clientId: 'client', nonce: 'nonce' }));
  for (const key of ['nonce', 'iss', 'aud', 'exp']) {
    const altered = { ...claims, [key]: key === 'exp' ? 1 : `bad-${key}` };
    assert.throws(() => verifyIdToken(tokenFor({ privateKey, claims: altered, kid: 'rsa' }), { keys: [jwk] }, { issuer: claims.iss, clientId: 'client', nonce: 'nonce' }));
  }
});

test('ES256 ID tokens verify', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }); jwk.kid = 'ec';
  const claims = { iss: 'https://issuer.example', aud: ['client'], exp: Math.floor(Date.now() / 1000) + 300, nonce: 'nonce', sub: 'u1' };
  assert.equal(verifyIdToken(tokenFor({ privateKey, claims, kid: 'ec', alg: 'ES256' }), { keys: [jwk] }, { issuer: claims.iss, clientId: 'client', nonce: 'nonce' }).sub, 'u1');
});
