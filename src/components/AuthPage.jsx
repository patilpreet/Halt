import React, { useState } from 'react';
import { Lock, Mail, KeyRound, Loader2, ShieldCheck, ArrowRight, AlertTriangle, MailCheck } from 'lucide-react';
import { signIn, signUp, sendPasswordReset, isConfigured } from '../lib/supabase';

/**
 * Sign in / sign up.
 *
 * The previous build had no authentication at all: whoever opened the URL was
 * the owner, and could freeze the wallet, raise the cap, allowlist a payee or
 * release a held payment. The problem statement asks for an *owner*-controlled
 * kill switch, so there has to be an owner.
 *
 * Nothing here is decorative. Every policy table is scoped by `owner_id` in
 * RLS, so the session this screen establishes is what makes one tenant's wallet
 * invisible — and unreachable — to everyone else.
 */

const MIN_PASSWORD = 8;

/** Supabase's auth errors are terse and occasionally alarming. Translate. */
function friendlyError(message = '') {
  const m = message.toLowerCase();
  if (m.includes('invalid login credentials')) return 'That email and password combination is not recognised.';
  if (m.includes('email not confirmed')) return 'Confirm your email address first — check your inbox for the link.';
  if (m.includes('already registered')) return 'That email already has an account. Sign in instead.';
  if (m.includes('rate limit') || m.includes('too many')) return 'Too many attempts. Wait a minute and try again.';
  if (m.includes('password')) return message;
  return message || 'Something went wrong. Try again.';
}

export function AuthPage() {
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup' | 'reset'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const switchMode = (next) => {
    setMode(next);
    setError(null);
    setNotice(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setNotice(null);

    if (!email.trim()) return setError('Enter your email address.');
    if (mode !== 'reset' && password.length < MIN_PASSWORD) {
      return setError(`Password must be at least ${MIN_PASSWORD} characters.`);
    }

    setBusy(true);
    try {
      if (mode === 'reset') {
        await sendPasswordReset(email.trim());
        setNotice('If that address has an account, a reset link is on its way.');
      } else if (mode === 'signup') {
        const { session } = await signUp(email.trim(), password);
        if (!session) {
          // Email confirmation is on. Say so plainly rather than dumping the
          // user back at a login form that will refuse them.
          setNotice('Account created. Check your inbox and click the confirmation link to activate it.');
          setMode('signin');
          setPassword('');
        }
        // With confirmation off, the session arrives and App swaps this screen out.
      } else {
        await signIn(email.trim(), password);
      }
    } catch (err) {
      setError(friendlyError(err.message));
    } finally {
      setBusy(false);
    }
  };

  if (!isConfigured) {
    return (
      <Shell>
        <div className="flex items-start gap-2.5 px-3.5 py-3 rounded-xl border border-danger/35 bg-danger/[0.06]">
          <AlertTriangle className="w-4 h-4 text-danger flex-shrink-0 mt-0.5" />
          <div className="flex flex-col gap-1">
            <span className="label !text-danger">Not configured</span>
            <span className="text-[11px] text-ink-muted leading-relaxed">
              <code className="font-mono text-ink-2">VITE_SUPABASE_URL</code> and{' '}
              <code className="font-mono text-ink-2">VITE_SUPABASE_ANON_KEY</code> are missing.
              Copy <code className="font-mono text-ink-2">.env.example</code> to{' '}
              <code className="font-mono text-ink-2">.env</code> and fill them in.
            </span>
          </div>
        </div>
      </Shell>
    );
  }

  const isReset = mode === 'reset';
  const isSignup = mode === 'signup';

  return (
    <Shell>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field
          icon={Mail}
          type="email"
          autoComplete="email"
          placeholder="owner@company.com"
          value={email}
          onChange={(v) => { setEmail(v); setError(null); }}
          label="Email"
        />

        {!isReset && (
          <Field
            icon={KeyRound}
            type="password"
            autoComplete={isSignup ? 'new-password' : 'current-password'}
            placeholder={isSignup ? `At least ${MIN_PASSWORD} characters` : '••••••••'}
            value={password}
            onChange={(v) => { setPassword(v); setError(null); }}
            label="Password"
          />
        )}

        {error && (
          <div className="anim-fade flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl border border-danger/35 bg-danger/[0.06]">
            <AlertTriangle className="w-3.5 h-3.5 text-danger flex-shrink-0 mt-0.5" />
            <span className="text-[11px] text-ink-2 leading-relaxed">{error}</span>
          </div>
        )}

        {notice && (
          <div className="anim-fade flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl border border-lime/35 bg-lime/[0.05]">
            <MailCheck className="w-3.5 h-3.5 text-lime flex-shrink-0 mt-0.5" />
            <span className="text-[11px] text-ink-2 leading-relaxed">{notice}</span>
          </div>
        )}

        <button type="submit" disabled={busy} className="btn btn-lime hud hud-flare w-full !py-3 mt-1">
          {busy ? (
            <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Working</>
          ) : (
            <>
              {isReset ? 'Send reset link' : isSignup ? 'Create wallet' : 'Sign in'}
              <ArrowRight className="w-3.5 h-3.5" />
            </>
          )}
        </button>
      </form>

      <div className="flex flex-col gap-2 pt-4 mt-4 border-t border-hair text-[11px]">
        {mode !== 'signup' && (
          <Switcher onClick={() => switchMode('signup')} prompt="No wallet yet?" action="Create one" />
        )}
        {mode !== 'signin' && (
          <Switcher onClick={() => switchMode('signin')} prompt="Already have a wallet?" action="Sign in" />
        )}
        {mode !== 'reset' && (
          <Switcher onClick={() => switchMode('reset')} prompt="Forgotten your password?" action="Reset it" />
        )}
      </div>
    </Shell>
  );
}

/* ─────────────────────────── chrome ─────────────────────────── */

function Shell({ children }) {
  return (
    <div className="min-h-screen grid place-items-center px-4 py-12">
      <div className="w-full max-w-[26rem] flex flex-col gap-7">
        {/* Wordmark */}
        <div className="flex flex-col items-center gap-3 text-center">
          <div
            className="relative w-14 h-14 rounded-full grid place-items-center"
            style={{
              background: 'radial-gradient(circle at 50% 28%, #2A2A2A, #0A0A0A 74%)',
              boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.07), inset 0 -3px 8px rgba(0,0,0,0.8)',
            }}
          >
            <svg viewBox="0 0 40 40" className="absolute inset-0 w-full h-full overflow-visible">
              <circle
                cx="20" cy="20" r="16" fill="none"
                stroke="var(--lime)" strokeWidth="2.5" strokeLinecap="round"
                strokeDasharray="76 100" transform="rotate(-90 20 20)"
                style={{ filter: 'drop-shadow(0 0 5px var(--lime))' }}
              />
            </svg>
            <Lock className="w-4 h-4 text-lime" strokeWidth={2.4} />
          </div>

          <div>
            <h1 className="display text-3xl text-ink tracking-tight">Halt</h1>
            <p className="text-[11px] text-ink-muted mt-1.5 leading-relaxed max-w-[20rem]">
              Wallet-layer enforcement for autonomous agents.
              <br />
              Sign in to reach your kill switch.
            </p>
          </div>
        </div>

        <div className="panel p-7 flex flex-col">{children}</div>

        <div className="flex items-center justify-center gap-2 text-[10px] font-mono text-ink-faint">
          <ShieldCheck className="w-3 h-3 text-lime/60" />
          <span>Policy is enforced in Postgres, not in this browser</span>
        </div>
      </div>
    </div>
  );
}

function Field({ icon: Icon, label, value, onChange, ...rest }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="label">{label}</span>
      <div className="relative">
        <Icon className="w-3.5 h-3.5 absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
        <input
          {...rest}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="field !pl-10 font-mono !py-2.5"
        />
      </div>
    </label>
  );
}

function Switcher({ onClick, prompt, action }) {
  return (
    <div className="flex items-center justify-center gap-1.5">
      <span className="text-ink-muted">{prompt}</span>
      <button
        type="button"
        onClick={onClick}
        className="text-lime hover:text-lime-bright transition-colors border-b border-dashed border-lime/40"
      >
        {action}
      </button>
    </div>
  );
}
