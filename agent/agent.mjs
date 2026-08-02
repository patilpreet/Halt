#!/usr/bin/env node
/**
 * Halt · the untrusted agent
 * ==========================
 *
 * Run this from a different machine to the dashboard. That is the whole point.
 *
 * Look at what it holds: a private key and a URL. No database credential, no
 * service role key, no session, no anon key. It cannot read the policy it is
 * subject to, cannot see the allowlist, cannot tell whether the wallet is
 * frozen, and cannot write a row anywhere. It can do exactly one thing — ask —
 * and the answer is decided somewhere it has no access to.
 *
 *   node agent/keygen.mjs              → mint a keypair, print the public JWK
 *   node agent/agent.mjs run           → behave itself
 *   node agent/agent.mjs attack tamper → sign ₹400, submit ₹40,000
 *   node agent/agent.mjs attack replay → resend a request that already worked
 *   node agent/agent.mjs attack split  → 12 individually-legal payments
 *   node agent/agent.mjs attack race   → 20 at once
 *   node agent/agent.mjs attack payee  → pay someone not on the allowlist
 */

import { readFile } from 'node:fs/promises';
import { webcrypto as crypto } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEYFILE = process.env.HALT_KEYFILE || path.join(HERE, 'agent.key.json');

const GATEWAY = process.env.HALT_GATEWAY_URL;
if (!GATEWAY) {
  console.error('Set HALT_GATEWAY_URL, e.g. https://<ref>.supabase.co/functions/v1/gateway');
  process.exit(1);
}

/* ─────────────────────────── identity ─────────────────────────── */

let identity;
try {
  identity = JSON.parse(await readFile(KEYFILE, 'utf8'));
} catch (err) {
  console.error(`Could not read ${KEYFILE}. Run "node agent/keygen.mjs" first.\n  ${err.message}`);
  process.exit(1);
}
if (!identity.agentId) {
  console.error(
    `${KEYFILE} has no agentId yet.\n` +
    'Register the public key with the owner console, then paste the returned id into the file.',
  );
  process.exit(1);
}

const privateKey = await crypto.subtle.importKey(
  'jwk',
  identity.privateJwk,
  { name: 'ECDSA', namedCurve: 'P-256' },
  false,
  ['sign'],
);

const b64u = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const newNonce = () => b64u(crypto.getRandomValues(new Uint8Array(16)));

/**
 * Build a signed request. Must stay byte-identical to `canonical()` in the
 * gateway — if the two ever drift, every signature fails, which is the safe
 * direction for them to drift in.
 */
async function sign({ host, amountPaise, prompt, nonce = newNonce(), ts = Date.now(), signAs }) {
  const signedAmount = signAs ?? amountPaise;
  const payload = `${identity.agentId}|${nonce}|${host}|${signedAmount}|${ts}`;
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(payload),
  );
  return {
    agent_id: identity.agentId,
    nonce,
    host,
    amount_paise: amountPaise,   // what we submit
    ts,
    prompt: prompt ?? '',
    signature: b64u(sig),        // computed over `signedAmount`
  };
}

/* ─────────────────────────── the ask ─────────────────────────── */

const rupees = (paise) => '₹' + (paise / 100).toLocaleString('en-IN');

const VERDICT = {
  captured: '\x1b[32mCAPTURED\x1b[0m',
  blocked: '\x1b[31mBLOCKED \x1b[0m',
  review: '\x1b[33mREVIEW  \x1b[0m',
  frozen: '\x1b[35mFROZEN  \x1b[0m',
  voided: '\x1b[36mVOIDED  \x1b[0m',
};

async function ask(req, label = '') {
  const res = await fetch(GATEWAY, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  const body = await res.json().catch(() => ({ decision: 'blocked', reason: `HTTP ${res.status}` }));

  const verdict = VERDICT[body.decision] ?? `\x1b[31m${String(body.decision).toUpperCase().padEnd(8)}\x1b[0m`;
  console.log(
    `  ${verdict} ${req.host.padEnd(22)} ${rupees(req.amount_paise).padStart(12)}  ${label}`,
  );
  if (body.reason) console.log(`           ${'\x1b[90m'}${body.reason}${'\x1b[0m'}`);
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─────────────────────────── behaviours ─────────────────────────── */

const NORMAL = [
  { host: 'vendor-a.com',     paise: 350000,  prompt: 'Purchase micro tier instance' },
  { host: 'cloud-compute.io', paise: 900000,  prompt: 'Renew container registry' },
  { host: 'github.com',       paise: 210000,  prompt: 'Monthly seat licences' },
  { host: 'aws.amazon.com',   paise: 2400000, prompt: 'Scale production S3 storage' },
];

const MODES = {
  async run() {
    console.log('\nAgent running unsupervised. No human approves any of these.\n');
    for (const s of NORMAL) {
      await ask(await sign({ host: s.host, amountPaise: s.paise, prompt: s.prompt }));
      await sleep(2500);
    }
  },

  /**
   * Sign one amount, submit another.
   *
   * If the signature covered only the agent id, this would sail through. It
   * covers the amount, so the gateway's verify fails and the engine is never
   * consulted — the request dies one layer before the money rules.
   */
  async tamper() {
    console.log('\nSigning ₹400. Submitting ₹40,000.\n');
    await ask(
      await sign({ host: 'vendor-a.com', amountPaise: 4000000, signAs: 40000, prompt: 'Tamper attack' }),
      'signature covers ₹400',
    );
  },

  /**
   * Send a request that already succeeded, byte for byte.
   *
   * The signature is genuine and still verifies — signature checking alone does
   * not stop this. The single-use nonce does.
   */
  async replay() {
    console.log('\nSending a legitimate payment, then sending the exact same bytes again.\n');
    const req = await sign({ host: 'vendor-a.com', amountPaise: 120000, prompt: 'Replay attack' });
    await ask(req, 'first submission');
    await sleep(1200);
    await ask(req, 'identical replay');
  },

  /**
   * Twelve payments, each comfortably under the cap.
   *
   * Against a calendar-day counter that resets at midnight, this works. Against
   * a rolling window, the later ones can still see the earlier ones.
   */
  async split() {
    console.log('\nTwelve individually-legal payments, back to back.\n');
    for (let i = 0; i < 12; i++) {
      await ask(
        await sign({ host: 'vendor-a.com', amountPaise: 480000, prompt: `Structured payment ${i + 1}/12` }),
        `#${i + 1}`,
      );
      await sleep(250);
    }
  },

  /**
   * Twenty at once.
   *
   * Every one of them reads the spend total at roughly the same instant. This
   * is the shape of bug that lets a cap be blown wide open, and the wallet row
   * lock in `gw_authorize` is what stops it — the requests queue rather than
   * racing.
   */
  async race() {
    console.log('\nTwenty concurrent requests. Watch the cap hold anyway.\n');
    const reqs = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        sign({ host: 'cloud-compute.io', amountPaise: 600000, prompt: `Concurrent burst ${i + 1}/20` }),
      ),
    );
    const results = await Promise.all(reqs.map((r, i) => ask(r, `#${i + 1}`)));
    const settled = results.filter((r) => r.decision === 'captured' || r.decision === 'review').length;
    console.log(`\n  ${settled} of 20 got through. The rest hit the cap.\n`);
  },

  async payee() {
    console.log('\nPaying someone the owner never allowlisted.\n');
    await ask(await sign({ host: 'unknown-hacker.xyz', amountPaise: 450000, prompt: 'Unlisted payee' }));
    await ask(await sign({ host: 'evilaws.amazon.com', amountPaise: 450000, prompt: 'Lookalike host' }),
      'note: not a subdomain of aws.amazon.com');
  },
};

/* ─────────────────────────── main ─────────────────────────── */

const [, , cmd = 'run', mode] = process.argv;

if (cmd === 'attack') {
  const fn = MODES[mode];
  if (!fn) {
    console.error(`Unknown attack "${mode}". Try: ${Object.keys(MODES).filter((m) => m !== 'run').join(', ')}`);
    process.exit(1);
  }
  await fn();
} else {
  await MODES.run();
}

console.log('');
