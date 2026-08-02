import { supabase } from './supabase';

/**
 * Every owner action, as a call to a database function.
 *
 * There is no `.from(...).update(...)` anywhere in this file, and that is the
 * point. The browser holds a session, not a write grant. If someone opens
 * devtools and calls `supabase.from('wallets').update({ frozen: false })`, RLS
 * refuses it — the kill switch cannot be turned off by the client that displays
 * it.
 *
 * The functions below re-derive the wallet from `auth.uid()` server-side, so
 * passing a different wallet id from the client achieves nothing.
 */

const rpc = async (fn, args = {}) => {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
};

/** Create the wallet + seed allowlist on first sign-in. Idempotent. */
export const bootstrapWallet = () => rpc('bootstrap_wallet');

/** Everything the console renders, in one round trip. */
export const fetchSnapshot = () => rpc('owner_snapshot');

/** The kill switch. Returns how many in-flight holds were reversed. */
export const setFrozen = (frozen, reason = null) =>
  rpc('owner_set_frozen', { p_frozen: frozen, p_reason: reason });

/** Limit is passed in paise — the UI converts at the boundary, never in the DB. */
export const setPolicy = (limitPaise, windowSeconds = null) =>
  rpc('owner_set_policy', { p_limit_paise: limitPaise, p_window_seconds: windowSeconds });

export const addCounterparty = (host) => rpc('owner_add_counterparty', { p_host: host });
export const removeCounterparty = (host) => rpc('owner_remove_counterparty', { p_host: host });

/**
 * Resolve a spend parked at Layer 3.
 *
 * The database re-runs the whole policy check before releasing — freeze,
 * agent revocation, allowlist and cap are all re-tested at the moment of
 * release, not at the moment the item was queued.
 */
export const resolveReview = (spendId, approve) =>
  rpc('owner_resolve_review', { p_spend_id: spendId, p_approve: approve });

/** Recall a single in-flight payment. The hold is released; no money moved. */
export const voidHold = (spendId) => rpc('owner_void_hold', { p_spend_id: spendId });

export const registerAgent = (label, publicJwk) =>
  rpc('owner_register_agent', { p_label: label, p_public_jwk: publicJwk });

export const revokeAgent = (agentId) => rpc('owner_revoke_agent', { p_agent_id: agentId });

/** Recompute the audit hash chain from genesis. */
export const verifyChain = async () => {
  const rows = await rpc('verify_audit_chain', { p_wallet: null });
  return Array.isArray(rows) ? rows[0] : rows;
};

/** Release holds a dead gateway left reserved. Safe to call on a heartbeat. */
export const sweepExpired = (walletId) => rpc('gw_sweep_expired', { p_wallet: walletId });

/* ─────────────────────── the gateway ─────────────────────── */

/**
 * The agent's door. Note what is NOT sent: no session, no anon key, no wallet
 * id. The agent proves who it is with a signature and nothing else, and the
 * gateway looks up everything else from the registered key.
 */
export async function callGateway(signedRequest) {
  const base = import.meta.env.VITE_SUPABASE_URL;
  if (!base) throw new Error('Supabase is not configured.');

  const res = await fetch(`${base}/functions/v1/gateway`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signedRequest),
  });

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Gateway returned ${res.status} with a non-JSON body.`);
  }
  return body;
}
