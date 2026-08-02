import React, { useState, useEffect } from 'react';
import {
  Activity, Check, X, ShieldAlert, Search, Loader2, Undo2, ChevronRight
} from 'lucide-react';
import { useReveal, stagger } from '../lib/motion';
import { money } from '../lib/format';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'settled', label: 'Settled' },
  { id: 'stopped', label: 'Stopped' },
];

const STOPPED = ['blocked', 'voided', 'rejected'];

export function TransactionFeed({
  transactions, pendingTxs = [], holdSeconds = 3, onRecall, onSelectTransaction,
}) {
  const [filter, setFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [recalling, setRecalling] = useState(null);
  const [revealRef, shown] = useReveal();

  // Elapsed time for in-flight cards (re-renders every second)
  const [, setTick] = useState(0);
  useEffect(() => {
    if (pendingTxs.length === 0) return;
    const t = setInterval(() => setTick(n => n + 1), 500);
    return () => clearInterval(t);
  }, [pendingTxs.length]);

  const handleRecall = async (id) => {
    setRecalling(id);
    try { await onRecall(id); } finally { setRecalling(null); }
  };

  const filtered = transactions.filter(tx => {
    if (filter === 'settled' && tx.status !== 'captured') return false;
    if (filter === 'stopped' && !STOPPED.includes(tx.status)) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return tx.payee.toLowerCase().includes(q) || (tx.reason && tx.reason.toLowerCase().includes(q));
    }
    return true;
  });

  return (
    <div ref={revealRef} className={`reveal ${shown ? 'is-visible' : ''} panel p-6 flex flex-col gap-4 min-h-[520px]`}>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-hair">
        <span className="label flex items-center gap-1.5">
          <Activity className="w-3.5 h-3.5 text-lime" />
          Security Audit Feed
          <span className="badge badge-muted !text-[9px] ml-1 tabular-nums">{transactions.length}</span>
        </span>

        <div className="flex items-center gap-1 p-1 rounded-lg bg-white/[0.02] border border-hair">
          {FILTERS.map(f => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`px-3 py-1 rounded-md font-mono text-[10px] uppercase tracking-wider transition-all duration-300 ${
                filter === f.id
                  ? 'bg-lime text-[#0A0A0A] font-bold'
                  : 'text-ink-muted hover:text-ink-2'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="w-3.5 h-3.5 absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-faint pointer-events-none" />
        <input
          type="text"
          placeholder="Filter by payee or reasoning…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="field !pl-10 font-mono"
        />
      </div>

      {/* In-flight */}
      {pendingTxs.length > 0 && (
        <div className="flex flex-col gap-2 anim-fade">
          <div className="label !text-info flex items-center gap-1.5">
            <Loader2 className="w-3 h-3 animate-spin" />
            {pendingTxs.length} held — budget reserved, no money has moved
          </div>

          {pendingTxs.map(ptx => {
            // The hold is a database row with an expiry, not a timer in this
            // tab. Reload the page and it is still here, still recallable.
            const started = new Date(ptx.timestamp).getTime();
            const expires = ptx.expiresAt ? new Date(ptx.expiresAt).getTime() : started + holdSeconds * 1000;
            const total = Math.max(1, expires - started);
            const remaining = Math.max(0, expires - Date.now());
            const progress = Math.min(100, ((total - remaining) / total) * 100);

            return (
              <div
                key={ptx.id}
                className="rounded-xl border p-3.5 flex items-center gap-3"
                style={{ borderColor: 'rgba(90,209,255,0.3)', background: 'rgba(90,209,255,0.04)' }}
              >
                <div className="w-8 h-8 rounded-lg grid place-items-center flex-shrink-0 border border-info/30 bg-info/10">
                  <Loader2 className="w-4 h-4 text-info animate-spin" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-semibold text-ink truncate">{ptx.payee}</span>
                    <span className="font-mono text-xs font-bold text-info tabular-nums flex-shrink-0">
                      {money(ptx.amount)}
                    </span>
                  </div>
                  <div className="meter mt-2">
                    <div
                      className="meter-fill"
                      style={{ width: `${progress}%`, background: 'var(--info)', boxShadow: '0 0 12px var(--info)' }}
                    />
                  </div>
                  <div className="flex justify-between mt-1.5 font-mono text-[9px]">
                    <span className="text-info tracking-wider">AUTHORIZED · AWAITING CAPTURE</span>
                    <span className="text-ink-faint tabular-nums">{(remaining / 1000).toFixed(1)}s</span>
                  </div>
                </div>

                <button
                  onClick={() => handleRecall(ptx.id)}
                  disabled={recalling === ptx.id}
                  title="Void this hold — the money never moves"
                  className="btn btn-ghost !py-1.5 !px-2.5 !text-[10px] flex-shrink-0 hover:!border-danger/50 hover:!text-danger"
                >
                  {recalling === ptx.id
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <Undo2 className="w-3 h-3" />}
                  Recall
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Ledger */}
      <div className="flex-1 overflow-y-auto max-h-[520px] pr-1 -mr-1">
        {filtered.length === 0 ? (
          <div className="h-full min-h-[240px] flex flex-col items-center justify-center gap-3 text-center">
            <div className="w-12 h-12 rounded-full grid place-items-center border border-hair-2 bg-white/[0.02]">
              <ShieldAlert className="w-5 h-5 text-ink-faint" />
            </div>
            <span className="text-xs text-ink-muted max-w-[16rem] leading-relaxed">
              No transactions recorded yet. Start the simulator or instruct the agent above.
            </span>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {filtered.map((tx, i) => (
              <TxCard key={tx.id} tx={tx} index={i} onSelect={onSelectTransaction} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Which tier actually decided this transaction. Replaces the emoji that used to
 * lead each reason line with something the reader can act on — at a glance you
 * can see whether a rule, the model, or a person made the call.
 */
const ORIGIN = {
  engine:          { code: 'L1', title: 'Decided by the engine — Postgres, inside the transaction' },
  agent2:          { code: 'L2', title: 'Decided by Agent 2 — deep risk review in the gateway' },
  owner:           { code: 'L3', title: 'Decided by the wallet owner' },
  'human-pending': { code: 'L3', title: 'Waiting on the wallet owner' },
};

function DecidedBy({ tx }) {
  const origin = ORIGIN[tx.decidedBy];
  if (!origin) return null;
  return (
    <span
      title={origin.title}
      className="font-mono text-[9px] font-semibold tracking-wider px-1.5 py-0.5 rounded
                 border border-hair-2 text-ink-muted"
    >
      {origin.code}
    </span>
  );
}

/** Settled, recalled-in-flight, or refused outright. */
const LABEL = {
  captured: 'Captured',
  voided:   'Voided',
  rejected: 'Rejected',
  blocked:  'Blocked',
};

function TxCard({ tx, index, onSelect }) {
  const isApproved = tx.status === 'captured';
  const isVoided = tx.status === 'voided';
  const risk = tx.risk_score ?? tx.riskScore ?? 10;

  const formattedTime = new Date(tx.created_at || tx.timestamp).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  const tone = isApproved
    ? { color: 'var(--lime)',   badge: 'badge-ok',     border: 'rgba(198,245,60,0.22)' }
    : isVoided
    ? { color: 'var(--info)',   badge: 'badge-info',   border: 'rgba(90,209,255,0.24)' }
    : { color: 'var(--danger)', badge: 'badge-danger', border: 'rgba(255,68,56,0.24)' };

  const riskColor = risk >= 75 ? 'var(--danger)' : risk >= 40 ? 'var(--warn)' : 'var(--lime)';

  return (
    <button
      onClick={() => onSelect(tx)}
      style={{ ...stagger(index, 40), borderColor: tone.border }}
      className="anim-reveal group text-left rounded-xl border bg-white/[0.015] p-4 flex flex-col gap-3
                 transition-all duration-300 hover:-translate-y-0.5 hover:bg-white/[0.03]
                 hover:shadow-panel"
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`badge ${tone.badge} !text-[9px]`}>
          {isApproved ? <Check className="w-3 h-3" /> : isVoided ? <Undo2 className="w-3 h-3" /> : <X className="w-3 h-3" />}
          {LABEL[tx.status] ?? tx.status}
        </span>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <DecidedBy tx={tx} />
          <span className="font-mono text-[9.5px] text-ink-faint tabular-nums">{formattedTime}</span>
        </div>
      </div>

      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-display font-bold text-sm text-ink truncate" title={tx.payee}>
          {tx.payee}
        </h3>
        <span
          className={`font-mono font-bold text-base tabular-nums flex-shrink-0 ${isApproved ? '' : 'line-through opacity-75'}`}
          style={{ color: tone.color }}
        >
          {money(tx.amount)}
        </span>
      </div>

      <p className="text-[11px] text-ink-muted leading-relaxed line-clamp-2">
        {tx.reason || 'Evaluated against the zero-trust policy engine.'}
      </p>

      <div className="pt-2.5 border-t border-hair flex items-center gap-2">
        <div className="meter flex-1 !h-1">
          <div
            className="meter-fill"
            style={{ width: `${risk}%`, background: riskColor, boxShadow: `0 0 8px ${riskColor}` }}
          />
        </div>
        <span className="font-mono text-[9.5px] text-ink-muted tabular-nums flex-shrink-0">
          risk {risk}%
        </span>
        <ChevronRight className="w-3.5 h-3.5 text-ink-faint group-hover:text-lime group-hover:translate-x-0.5 transition-all flex-shrink-0" />
      </div>
    </button>
  );
}
