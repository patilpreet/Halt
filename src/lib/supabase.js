import { createClient } from '@supabase/supabase-js';

/**
 * Supabase client + session helpers.
 *
 * Two deliberate changes from the previous version:
 *
 * 1. **No hardcoded fallback URL or key.** The old file defaulted to a literal
 *    project ref, so a misconfigured deploy silently pointed at a stale
 *    database instead of failing. Missing config is now loud.
 *
 * 2. **No local shadow state.** The old file kept a module-level `localPolicy`
 *    that the UI fell back to whenever a query failed, and incremented it
 *    client-side on every approval. That made the dashboard capable of showing
 *    a spend total the database had never agreed to. There is exactly one
 *    source of truth now, and it is Postgres.
 *
 * The anon key still ships in the bundle — that is what it is for, and it is
 * safe here precisely because it grants nothing. RLS scopes every SELECT to the
 * signed-in owner, and no table grants INSERT, UPDATE or DELETE to any browser
 * role. Every mutation goes through a SECURITY DEFINER function.
 */

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isConfigured = Boolean(url && anonKey);

if (!isConfigured) {
  console.error(
    'Halt: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set. Copy .env.example to .env and fill them in.',
  );
}

export const supabase = isConfigured
  ? createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

/* ─────────────────────────── auth ─────────────────────────── */

export async function signUp(email, password) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw error;
  // `session` is null when the project requires email confirmation — the caller
  // uses that to decide between "check your inbox" and "you're in".
  return { user: data.user, session: data.session };
}

export async function signIn(email, password) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

export async function sendPasswordReset(email) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin,
  });
  if (error) throw error;
}

export async function getSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session ?? null;
}

export function onAuthChange(cb) {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_event, session) => cb(session));
  return () => data.subscription.unsubscribe();
}
