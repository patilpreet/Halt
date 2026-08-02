/**
 * Round-trip check: sign the way the agent does, verify the way the gateway
 * does. Catches canonical-string drift and any base64url mistake.
 */
import { webcrypto as crypto } from 'node:crypto';

const b64u = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ── gateway side (copied verbatim from supabase/functions/gateway/index.ts) ──
function canonical(r) {
  return `${r.agent_id}|${r.nonce}|${r.host}|${r.amount_paise}|${r.ts}`;
}
function b64uToBuffer(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}
async function verifySignature(publicJwk, payload, sigB64u) {
  const key = await crypto.subtle.importKey(
    'jwk', { ...publicJwk, key_ops: ['verify'], ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
  );
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, key,
    b64uToBuffer(sigB64u), new TextEncoder().encode(payload),
  );
}

// ── agent side ──
const pair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
);
const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
const publicJwk = { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y };

async function sign({ agent_id, nonce, host, amountPaise, ts, signAs }) {
  const payload = `${agent_id}|${nonce}|${host}|${signAs ?? amountPaise}|${ts}`;
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey,
    new TextEncoder().encode(payload),
  );
  return { agent_id, nonce, host, amount_paise: amountPaise, ts, signature: b64u(sig) };
}

const base = {
  agent_id: '0f9b1e2c-4a5d-4c8e-9f11-2b3c4d5e6f70',
  nonce: b64u(crypto.getRandomValues(new Uint8Array(16))),
  host: 'aws.amazon.com',
  amountPaise: 2400000,
  ts: Date.now(),
};

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  console.log(`${ok ? '  \x1b[32mPASS\x1b[0m' : '  \x1b[31mFAIL\x1b[0m'}  ${name}`);
  ok ? pass++ : fail++;
};

// 1. honest request verifies
const honest = await sign(base);
check('honest request verifies', await verifySignature(publicJwk, canonical(honest), honest.signature), true);

// 2. tampered amount fails — this is "sign ₹400, submit ₹40,000"
const tampered = await sign({ ...base, amountPaise: 4000000, signAs: 40000 });
check('tampered amount rejected', await verifySignature(publicJwk, canonical(tampered), tampered.signature), false);

// 3. tampered host fails
const hostSwap = { ...honest, host: 'unknown-hacker.xyz' };
check('tampered host rejected', await verifySignature(publicJwk, canonical(hostSwap), hostSwap.signature), false);

// 4. tampered timestamp fails
const tsSwap = { ...honest, ts: honest.ts + 1 };
check('tampered timestamp rejected', await verifySignature(publicJwk, canonical(tsSwap), tsSwap.signature), false);

// 5. a different key's signature fails
const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const otherPub = await crypto.subtle.exportKey('jwk', other.publicKey);
check('wrong key rejected', await verifySignature(
  { kty: otherPub.kty, crv: otherPub.crv, x: otherPub.x, y: otherPub.y },
  canonical(honest), honest.signature), false);

// 6. a private JWK is recognisable so the console can refuse it
const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
check('private key has a "d" field to detect', 'd' in privJwk, true);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
