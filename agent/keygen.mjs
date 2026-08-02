#!/usr/bin/env node
/**
 * Mint an agent identity.
 *
 * Writes `agent.key.json` next to this file, containing the private key — which
 * is why `agent/*.key.json` is gitignored. Prints the PUBLIC half for you to
 * register.
 *
 * Registering happens through the owner console, with an owner session. That
 * asymmetry is deliberate: an agent can generate a key all day, but only the
 * wallet owner can grant one the right to be listened to.
 */

import { writeFile, readFile } from 'node:fs/promises';
import { webcrypto as crypto } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEYFILE = process.env.HALT_KEYFILE || path.join(HERE, 'agent.key.json');

let existing = null;
try {
  existing = JSON.parse(await readFile(KEYFILE, 'utf8'));
} catch {
  /* first run */
}

if (existing && !process.argv.includes('--force')) {
  console.log(`\n${KEYFILE} already exists.\n`);
  console.log('Public JWK (register this):');
  console.log(JSON.stringify(existing.publicJwk, null, 2));
  console.log(`\nagentId: ${existing.agentId ?? '(not registered yet)'}`);
  console.log('\nPass --force to replace the keypair.\n');
  process.exit(0);
}

const pair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true, // extractable, because it has to be written to disk for a CLI agent
  ['sign', 'verify'],
);

const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
const publicJwk = { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y };

await writeFile(
  KEYFILE,
  JSON.stringify({ agentId: null, publicJwk, privateJwk }, null, 2) + '\n',
  { mode: 0o600 },
);

console.log(`\nWrote ${KEYFILE}\n`);
console.log('1. Register this public key — Owner console → Registered Agents → Add external agent:\n');
console.log(JSON.stringify(publicJwk, null, 2));
console.log('\n2. Paste the agent id it returns into the "agentId" field of that file.');
console.log('3. export HALT_GATEWAY_URL=https://<ref>.supabase.co/functions/v1/gateway');
console.log('4. node agent/agent.mjs run\n');
