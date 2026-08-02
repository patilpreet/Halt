/**
 * The browser-resident demo agent's identity.
 * ==========================================
 *
 * The agent gets a keypair. The wallet owner registers the **public** half.
 * From then on the agent proves who it is by signing each request, and the
 * gateway checks that signature before the engine sees the request at all.
 *
 * Worth being clear about what this does and does not buy:
 *
 *   it proves      — this request came from the agent the owner registered,
 *                    and these exact values are the ones it signed
 *   it does NOT    — grant the agent any authority whatsoever
 *
 * That separation is the whole design. Holding the key lets the agent *ask*.
 * Whether it may spend is decided in Postgres, by rules the key has no bearing
 * on. So it is not a contradiction that this key lives in the browser next to
 * the dashboard: the agent is supposed to be untrusted, and giving an untrusted
 * party its own key changes nothing about what it can do.
 *
 * The private key is generated non-extractable and kept as a `CryptoKey` in
 * IndexedDB. Even this page cannot read the raw bytes back out — it can only
 * ask WebCrypto to sign with it.
 */

const DB_NAME = 'halt-agent';
const STORE = 'keys';
const KEY_ID = 'agent-signing-key';
const AGENT_ID_STORAGE = 'halt.agent_id';

/* ─────────────────────────── IndexedDB ─────────────────────────── */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDel(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ─────────────────────────── keys ─────────────────────────── */

/**
 * Fetch the stored keypair, or mint one.
 *
 * `extractable: false` on the private key means the raw material never exists
 * in JavaScript memory. A cross-site script that fully compromises this page
 * can ask the key to sign — it cannot steal the key and keep signing after the
 * owner revokes the agent.
 */
export async function getOrCreateKeyPair() {
  const existing = await idbGet(KEY_ID);
  if (existing?.privateKey && existing?.publicKey) return existing;

  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, // private key is non-extractable
    ['sign', 'verify'],
  );
  await idbSet(KEY_ID, pair);
  return pair;
}

/** The public half, as a JWK, ready to hand to `owner_register_agent`. */
export async function exportPublicJwk() {
  const { publicKey } = await getOrCreateKeyPair();
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  // Strip the fields the server does not need and would only have to validate.
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

export const getStoredAgentId = () => localStorage.getItem(AGENT_ID_STORAGE);
export const storeAgentId = (id) => localStorage.setItem(AGENT_ID_STORAGE, id);

/** Forget this browser's agent entirely — new keypair on next use. */
export async function forgetAgent() {
  localStorage.removeItem(AGENT_ID_STORAGE);
  await idbDel(KEY_ID);
}

/* ─────────────────────────── signing ─────────────────────────── */

const bytesToB64u = (buf) => {
  let bin = '';
  const view = new Uint8Array(buf);
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** A fresh 128-bit nonce per request. Single-use, enforced by the database. */
const newNonce = () => bytesToB64u(crypto.getRandomValues(new Uint8Array(16)));

/**
 * Build a signed spend request.
 *
 * The signed string covers the amount, so tampering with it in transit — the
 * classic "sign ₹40, submit ₹4,000" — produces a signature the gateway
 * refuses. This must stay byte-identical to `canonical()` in the gateway.
 */
export async function signSpendRequest({ agentId, host, amountPaise, prompt = '' }) {
  const { privateKey } = await getOrCreateKeyPair();
  const nonce = newNonce();
  const ts = Date.now();

  const payload = `${agentId}|${nonce}|${host}|${amountPaise}|${ts}`;
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(payload),
  );

  return {
    agent_id: agentId,
    nonce,
    host,
    amount_paise: amountPaise,
    ts,
    prompt,
    signature: bytesToB64u(sig),
  };
}

/**
 * Sign one request but describe a different one — the tamper attack, as a
 * first-class demo mode rather than something a judge has to take on faith.
 * The signature is computed over `signedAmountPaise`; the body carries
 * `sentAmountPaise`.
 */
export async function signTamperedRequest({ agentId, host, signedAmountPaise, sentAmountPaise, prompt = '' }) {
  const req = await signSpendRequest({ agentId, host, amountPaise: signedAmountPaise, prompt });
  return { ...req, amount_paise: sentAmountPaise };
}
