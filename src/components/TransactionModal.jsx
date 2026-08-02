import React, { useEffect } from 'react';
import { X, ShieldCheck, ShieldAlert, Cpu, Calendar, Globe, Layers, Bot, Activity, Key, Clock } from 'lucide-react';
import { money } from '../lib/format';

const STATUS_COLOR = {
  APPROVE: 'var(--lime)',
  BLOCK: 'var(--danger)',
  FREEZE: 'var(--danger)',
  REJECT: 'var(--danger)',
  ESCALATE: 'var(--hold)',
  OFFLINE: 'var(--warn)',
  ERROR: 'var(--warn)',
};

export function TransactionModal({ transaction, onClose }) {
  // Escape to close
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!transaction) return null;

  const isApproved = transaction.status === 'captured';
  const risk = transaction.risk_score ?? transaction.riskScore ?? 15;
  const aiReasoning = transaction.ai_reasoning || transaction.aiReasoning || transaction.reason;
  const riskColor = risk >= 75 ? 'var(--danger)' : risk >= 40 ? 'var(--warn)' : 'var(--lime)';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md anim-fade"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="anim-reveal-scale panel scanner w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 flex flex-col gap-5"
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-lg text-ink-muted hover:text-danger hover:bg-danger/10 transition-colors z-10"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Header */}
        <div className="flex items-center gap-3.5">
          <div
            className="w-12 h-12 rounded-xl grid place-items-center flex-shrink-0 border"
            style={{
              color: isApproved ? 'var(--lime)' : 'var(--danger)',
              borderColor: isApproved ? 'rgba(198,245,60,0.3)' : 'rgba(255,68,56,0.3)',
              background: isApproved ? 'rgba(198,245,60,0.07)' : 'rgba(255,68,56,0.07)',
            }}
          >
            {isApproved ? <ShieldCheck className="w-6 h-6" /> : <ShieldAlert className="w-6 h-6" />}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`badge ${isApproved ? 'badge-ok' : 'badge-danger'}`}>
                {transaction.status}
              </span>
              <span className="font-mono text-[10px] text-ink-faint truncate" title={transaction.id}>
                {String(transaction.id).slice(0, 8)}…
              </span>
            </div>
            <h2 className="display text-3xl text-ink mt-1.5 tabular-nums">
              {money(transaction.amount)}
            </h2>
          </div>
        </div>

        {/* Risk audit */}
        <section className="rounded-xl border border-hair-2 bg-white/[0.02] p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <span className="label flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-lime" /> Risk Audit
            </span>
            <span className="font-mono text-[10px] font-bold tabular-nums" style={{ color: riskColor }}>
              {risk}/100
            </span>
          </div>

          <div className="meter">
            <div
              className="meter-fill"
              style={{ width: `${risk}%`, background: riskColor, boxShadow: `0 0 12px ${riskColor}` }}
            />
          </div>

          <p className="text-[11.5px] text-ink-2 leading-relaxed rounded-lg bg-black/40 border border-hair p-3">
            {aiReasoning}
          </p>
        </section>

        {/* Escalation path */}
        {(transaction.decidedBy || transaction.trace?.length > 0) && (
          <section className="rounded-xl border border-hair-2 bg-white/[0.02] p-4 flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="label flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-lime" /> Escalation Path
              </span>
              {transaction.decidedBy && (
                <span className="font-mono text-[9.5px] text-ink-muted">
                  resolved by {transaction.decidedBy === 'human-pending' ? 'human' : transaction.decidedBy}
                </span>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              {(transaction.trace || []).map((t, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-hair bg-black/30 px-2.5 py-2 flex flex-col gap-1"
                >
                  <div className="flex items-center gap-2 font-mono text-[10.5px]">
                    <span className="font-bold text-ink-faint w-5 flex-shrink-0">L{t.layer}</span>
                    <span
                      className="font-bold w-[68px] flex-shrink-0"
                      style={{ color: STATUS_COLOR[t.status] || 'var(--text-muted)' }}
                    >
                      {t.status}
                    </span>
                    <span className="text-ink-muted flex-1 truncate" title={t.detail}>
                      {t.detail}
                    </span>
                  </div>

                  {/* Where Layer 2's number actually came from */}
                  {t.aiScore != null && (
                    <div className="flex flex-wrap items-center gap-1.5 pl-7">
                      <span className="badge badge-muted !text-[8.5px] !py-0 tabular-nums">
                        model {t.aiScore}%
                      </span>
                      <span className="badge badge-muted !text-[8.5px] !py-0 tabular-nums">
                        policy floor {t.policyFloor}%
                      </span>
                      <span
                        className={`badge !text-[8.5px] !py-0 ${t.governedBy === 'policy' ? 'badge-warn' : 'badge-ok'}`}
                      >
                        governed by {t.governedBy}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Metadata */}
        <div className="grid grid-cols-2 gap-3">
          <Meta icon={Bot} label="Requesting Agent" value={transaction.agent_name || transaction.agentName || 'Main compute agent'} />
          <Meta icon={Globe} label="Payee Endpoint" value={transaction.payee} />
          <Meta icon={Activity} label="Threat Classification" value={transaction.threatLevel || 'LOW'} />
          <Meta
            icon={Calendar}
            label="Requested"
            value={new Date(transaction.timestamp).toLocaleString()}
          />
          <Meta
            icon={Clock}
            label="Settled"
            value={transaction.settledAt ? new Date(transaction.settledAt).toLocaleTimeString() : 'Not settled'}
          />
          {/*
            This used to render a random 64-hex string labelled "Payment Receipt
            Hash". It was generated client-side with Math.random() and referred
            to nothing — a fabricated settlement identifier presented as real.
            The spend's actual primary key is a reference that resolves.
          */}
          <Meta
            icon={Key}
            label="Payment Reference"
            value={String(transaction.id).slice(0, 18) + '…'}
            fullValue={transaction.id}
          />
        </div>

        {(transaction.agent_prompt || transaction.agentPrompt) && (
          <div className="rounded-xl border border-hair-2 bg-white/[0.02] p-3.5">
            <div className="label mb-1.5">Agent Intent</div>
            <p className="text-[11.5px] text-ink-2 italic leading-relaxed">
              "{transaction.agent_prompt || transaction.agentPrompt}"
            </p>
          </div>
        )}

        <button onClick={onClose} className="btn btn-ghost w-full">
          Close Inspector
        </button>
      </div>
    </div>
  );
}

function Meta({ icon: Icon, label, value, fullValue }) {
  return (
    <div className="rounded-xl border border-hair-2 bg-white/[0.02] p-3.5 min-w-0">
      <div className="label flex items-center gap-1.5">
        <Icon className="w-3 h-3 text-lime" /> {label}
      </div>
      <div className="font-mono text-[11.5px] font-semibold text-ink mt-1.5 truncate" title={fullValue || value}>
        {value}
      </div>
    </div>
  );
}
