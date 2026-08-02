import React from 'react';
import { Database, Cpu, UserCheck, Check, X, Clock, Layers } from 'lucide-react';
import { useReveal, stagger } from '../lib/motion';
import { money } from '../lib/format';

/**
 * The cascade, and the queue where the owner resolves what it could not.
 *
 * Layer 1 is drawn without a health toggle on purpose. The old panel let you
 * switch the frontline agent "offline" to demo failover, but that agent was a
 * function in this bundle — a control the browser could turn off was never an
 * enforcement layer. Layer 1 is now a Postgres function inside the transaction
 * that moves the money. There is no switch for it because there cannot be one.
 */
export function EscalationPanel({ humanQueue = [], onHumanDecision, lastResult, busy }) {
  const [revealRef, shown] = useReveal();

  // Which layer produced the last decision (to highlight the active path)?
  const decision = lastResult?.decision;
  const lastLayer =
    decision === 'blocked' ? 1 :
    decision === 'captured' || decision === 'frozen' || decision === 'voided' ? 2 :
    decision === 'review' ? 3 : 0;

  return (
    <div ref={revealRef} className={`reveal ${shown ? 'is-visible' : ''} panel panel-hover p-6 flex flex-col gap-3`}>
      <div className="flex items-center justify-between mb-1">
        <span className="label flex items-center gap-1.5">
          <Layers className="w-3.5 h-3.5 text-lime" />
          Escalation Pipeline
        </span>
        <span className="badge badge-muted">Engine → AI → Human</span>
      </div>

      <Layer
        n={1} icon={Database}
        title="Engine · Postgres"
        subtitle="Inside the transaction, under a row lock"
        work="signature, nonce, freeze, allowlist, rolling cap"
        routes="fails → blocked"
        active={lastLayer === 1}
      />

      <Connector lit={lastLayer >= 2} />

      <Layer
        n={2} icon={Cpu}
        title="Deep Risk Agent"
        subtitle="Groq scoring, server-side in the gateway"
        work="judges what the engine already permitted"
        routes="extreme → freeze"
        active={lastLayer === 2}
      />

      <Connector lit={lastLayer >= 3} />

      <Layer
        n={3} icon={UserCheck}
        title="Human-in-the-loop"
        subtitle="Wallet owner — final authority"
        work="decides on high-risk & unresolved"
        routes={humanQueue.length ? `${humanQueue.length} waiting` : 'approve / reject'}
        active={lastLayer === 3}
      />

      {/* Last decision trace */}
      {lastResult && (
        <div className="anim-fade mt-1 rounded-xl border border-hair-2 bg-white/[0.02] px-3 py-2.5">
          <div className="label !text-[9px] !text-lime mb-1">
            Gateway returned “{lastResult.decision}”
          </div>
          <p className="font-mono text-[10.5px] text-ink-2 leading-relaxed">
            {lastResult.reason}
          </p>
        </div>
      )}

      {/* Human Review Queue */}
      {humanQueue.length > 0 && (
        <div className="flex flex-col gap-2 pt-2">
          <div className="label !text-hold flex items-center gap-1.5">
            <Clock className="w-3 h-3" />
            Review Queue — hold retained, budget still reserved
          </div>

          {humanQueue.map((item, i) => (
            <div
              key={item.id}
              className="anim-slide-right rounded-xl border p-3.5 flex flex-col gap-2.5"
              style={{
                ...stagger(i),
                borderColor: 'rgba(255,197,61,0.28)',
                background: 'rgba(255,197,61,0.045)',
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-ink truncate">{item.payee}</span>
                <span className="font-mono text-xs font-bold text-hold tabular-nums flex-shrink-0">
                  {money(item.amount)}
                </span>
              </div>

              <p className="text-[10.5px] text-ink-muted leading-relaxed">
                {item.reason}
              </p>

              <div className="flex flex-wrap items-center gap-1.5">
                {(item.trace || []).map((t, ti) => (
                  <span key={ti} className="badge badge-muted !text-[9px] !py-0.5">
                    L{t.layer}:{t.status}
                  </span>
                ))}
                <span className="badge badge-hold !text-[9px] !py-0.5 tabular-nums">
                  risk {item.riskScore}%
                </span>
              </div>

              <div className="flex items-center gap-2 pt-0.5">
                <button
                  onClick={() => onHumanDecision(item.id, 'approve')}
                  disabled={busy}
                  className="btn btn-lime flex-1 !py-2"
                >
                  <Check className="w-3.5 h-3.5" /> Approve
                </button>
                <button
                  onClick={() => onHumanDecision(item.id, 'reject')}
                  disabled={busy}
                  className="btn btn-danger flex-1 !py-2"
                >
                  <X className="w-3.5 h-3.5" /> Reject
                </button>
              </div>

              {/* The release is not a rubber stamp: the database re-checks the
                  freeze, the agent, the allowlist and the cap at this moment. */}
              <p className="font-mono text-[9px] text-ink-faint leading-relaxed">
                Approving re-runs the full policy check. If the wallet is frozen, the
                release is refused and the hold is voided.
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** One tier in the cascade. */
function Layer({ n, icon: Icon, title, subtitle, work, routes, active }) {
  const tone = active
    ? { label: 'Resolved Here', color: 'var(--lime)', badge: 'badge-ok', border: 'rgba(198,245,60,0.35)', bg: 'rgba(198,245,60,0.05)' }
    : { label: 'Ready', color: 'var(--text-muted)', badge: 'badge-muted', border: 'var(--hair)', bg: 'rgba(255,255,255,0.015)' };

  return (
    <div
      className="rounded-xl border p-3.5 flex flex-col gap-2 transition-all duration-500"
      style={{ borderColor: tone.border, background: tone.bg }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="w-8 h-8 rounded-lg grid place-items-center flex-shrink-0 border"
            style={{
              color: tone.color,
              borderColor: tone.border,
              background: 'rgba(255,255,255,0.03)',
            }}
          >
            <Icon className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="font-display font-bold text-xs text-ink flex items-center gap-1.5">
              <span className="font-mono text-ink-faint">L{n}</span>
              <span className="truncate">{title}</span>
            </div>
            <div className="text-[10px] text-ink-muted leading-tight truncate">{subtitle}</div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className={`badge ${tone.badge} !text-[9px] !py-0.5`}>
            <span className="w-1 h-1 rounded-full anim-blink" style={{ background: tone.color }} />
            {tone.label}
          </span>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 pl-10">
        <span className="text-[10px] text-ink-muted truncate">{work}</span>
        <span className="font-mono text-[9px] text-ink-2 border border-hair-2 rounded px-1.5 py-0.5 flex-shrink-0">
          {routes}
        </span>
      </div>
    </div>
  );
}

/** Animated flow line between tiers. */
function Connector({ lit }) {
  return (
    <div className="flex justify-center py-0.5">
      <div className="relative w-px h-5 bg-hair overflow-hidden">
        {lit && (
          <span
            className="absolute inset-x-0 h-2 anim-fade"
            style={{
              background: 'linear-gradient(180deg, transparent, var(--lime), transparent)',
              animation: 'scanline 1.4s linear infinite',
            }}
          />
        )}
      </div>
    </div>
  );
}
