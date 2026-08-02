import React, { useState } from 'react';
import {
  Fingerprint, Link2, ShieldCheck, ShieldX, Loader2, Ban, CheckCircle2, Plus, X,
} from 'lucide-react';
import { useReveal, stagger } from '../lib/motion';

/**
 * Who is allowed to ask, and whether the record can be trusted.
 *
 * Two controls that answer the same judge's question from opposite ends:
 * an agent is a registered public key that the owner can revoke instantly,
 * and the audit log is a hash chain that cannot be edited without saying so.
 */
export function TrustPanel({
  agents = [], activeAgentId, chain, auditCount = 0,
  onVerifyChain, onRevokeAgent, onRegisterExternal, busy,
}) {
  const [revealRef, shown] = useReveal();
  const [adding, setAdding] = useState(false);
  const [jwkText, setJwkText] = useState('');
  const [label, setLabel] = useState('');
  const [addError, setAddError] = useState(null);
  const active = agents.filter((a) => a.status === 'active');

  const submitExternal = async (e) => {
    e.preventDefault();
    setAddError(null);
    let jwk;
    try {
      jwk = JSON.parse(jwkText);
    } catch {
      return setAddError('That is not valid JSON. Paste the public JWK that keygen printed.');
    }
    // Refuse a private key before it crosses the network. The database checks
    // this too, but nobody should be able to say we transmitted it first.
    if (jwk && typeof jwk === 'object' && 'd' in jwk) {
      return setAddError('That is a PRIVATE key. Register the public half only — the object without "d".');
    }
    try {
      await onRegisterExternal(label.trim() || 'External agent', jwk);
      setJwkText('');
      setLabel('');
      setAdding(false);
    } catch (err) {
      setAddError(err.message);
    }
  };

  return (
    <div ref={revealRef} className={`reveal ${shown ? 'is-visible' : ''} panel panel-hover p-6 flex flex-col gap-5`}>
      {/* ── agent identity ── */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="label flex items-center gap-1.5">
            <Fingerprint className="w-3.5 h-3.5 text-lime" />
            Registered Agents
          </span>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-ink-muted tabular-nums">
              {active.length} active
            </span>
            <button
              onClick={() => { setAdding(!adding); setAddError(null); }}
              title="Register an agent running on another machine"
              className="p-1 rounded border border-hair-2 text-ink-muted hover:text-lime hover:border-lime/50 transition-colors"
            >
              {adding ? <X className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
            </button>
          </div>
        </div>

        {/* Register an external agent — the one running on another laptop. */}
        {adding && (
          <form onSubmit={submitExternal} className="anim-fade flex flex-col gap-2">
            <input
              type="text"
              placeholder="Label — e.g. Procurement bot (laptop 2)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="field font-mono !py-2 !text-[11px]"
            />
            <textarea
              rows={4}
              placeholder='{"kty":"EC","crv":"P-256","x":"…","y":"…"}'
              value={jwkText}
              onChange={(e) => { setJwkText(e.target.value); setAddError(null); }}
              className="field !rounded-xl !p-2.5 font-mono !text-[10px] resize-none"
            />
            {addError && (
              <span className="font-mono text-[10px] text-danger leading-relaxed">{addError}</span>
            )}
            <button type="submit" disabled={busy || !jwkText.trim()} className="btn btn-lime !py-2">
              <Plus className="w-3.5 h-3.5" /> Register public key
            </button>
            <span className="font-mono text-[9px] text-ink-faint leading-relaxed">
              Run <code className="text-ink-muted">node agent/keygen.mjs</code> on the other machine
              and paste what it prints. Only the public half — the private key stays there.
            </span>
          </form>
        )}

        {agents.length === 0 ? (
          <p className="text-[11px] text-ink-muted leading-relaxed">
            No agent registered yet. One is created automatically the first time you
            instruct the console — it gets its own keypair, and the private half never
            leaves this browser.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {agents.map((a, i) => {
              const revoked = a.status !== 'active';
              return (
                <div
                  key={a.id}
                  className="anim-reveal rounded-xl border px-3 py-2.5 flex items-center justify-between gap-2"
                  style={{
                    ...stagger(i),
                    borderColor: revoked ? 'rgba(255,68,56,0.25)' : 'var(--hair)',
                    background: revoked ? 'rgba(255,68,56,0.04)' : 'rgba(255,255,255,0.015)',
                  }}
                >
                  <div className="min-w-0 flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5">
                      <span className="font-display font-bold text-[11px] text-ink truncate">
                        {a.label}
                      </span>
                      {a.id === activeAgentId && !revoked && (
                        <span className="badge badge-ok !text-[8.5px] !py-0">this browser</span>
                      )}
                    </div>
                    <span className="font-mono text-[9.5px] text-ink-faint truncate" title={a.id}>
                      {a.id.slice(0, 8)}… · ECDSA P-256
                    </span>
                  </div>

                  {revoked ? (
                    <span className="badge badge-danger !text-[9px] flex-shrink-0">
                      <Ban className="w-3 h-3" /> Revoked
                    </span>
                  ) : (
                    <button
                      onClick={() => onRevokeAgent(a.id)}
                      disabled={busy}
                      title="Stop accepting this agent's signatures and reverse anything it has in flight"
                      className="btn btn-ghost !py-1 !px-2.5 !text-[10px] flex-shrink-0 hover:!border-danger/50 hover:!text-danger"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="tickrail opacity-30" />

      {/* ── audit chain ── */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="label flex items-center gap-1.5">
            <Link2 className="w-3.5 h-3.5 text-lime" />
            Audit Chain Integrity
          </span>
          <span className="font-mono text-[10px] text-ink-muted tabular-nums">
            {auditCount} entries
          </span>
        </div>

        <p className="text-[11px] text-ink-muted leading-relaxed">
          Every decision is appended by the database inside the transaction that caused
          it, and each entry commits to the one before it. Edit any row and the chain
          breaks at exactly that entry.
        </p>

        <button onClick={onVerifyChain} disabled={busy} className="btn btn-ghost w-full">
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
          Verify chain from genesis
        </button>

        {chain && (
          <div
            className="anim-fade flex items-start gap-2.5 px-3 py-2.5 rounded-xl border"
            style={{
              borderColor: chain.ok ? 'rgba(198,245,60,0.35)' : 'rgba(255,68,56,0.35)',
              background: chain.ok ? 'rgba(198,245,60,0.05)' : 'rgba(255,68,56,0.06)',
            }}
          >
            {chain.ok
              ? <CheckCircle2 className="w-3.5 h-3.5 text-lime flex-shrink-0 mt-0.5" />
              : <ShieldX className="w-3.5 h-3.5 text-danger flex-shrink-0 mt-0.5" />}
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className={`label ${chain.ok ? '!text-lime' : '!text-danger'}`}>
                {chain.ok ? 'Chain intact' : `Broken at entry ${chain.broken_at}`}
              </span>
              <span className="font-mono text-[10px] text-ink-muted leading-relaxed break-words">
                {chain.detail}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
