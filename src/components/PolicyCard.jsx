import React, { useState } from 'react';
import { Check, Plus, X, SlidersHorizontal, ShieldCheck } from 'lucide-react';
import { useCountUp, useReveal, stagger } from '../lib/motion';
import { money, moneyShort } from '../lib/format';

export function PolicyCard({ policy, onUpdatePolicy }) {
  const [newPayee, setNewPayee] = useState('');
  const [editingLimit, setEditingLimit] = useState(false);
  const [limitInput, setLimitInput] = useState(policy.spend_limit);
  const [revealRef, shown] = useReveal();

  const spentPct = Math.min(100, Math.round((policy.daily_spent / policy.spend_limit) * 100)) || 0;
  const shownPct = useCountUp(spentPct);
  const shownSpent = useCountUp(policy.daily_spent, { decimals: 2 });

  const tone = spentPct > 90 ? 'var(--danger)' : spentPct > 60 ? 'var(--warn)' : 'var(--lime)';

  const handleAddPayee = (e) => {
    e.preventDefault();
    if (!newPayee.trim()) return;
    const payeeClean = newPayee.trim().toLowerCase();
    if (!policy.allowlist.includes(payeeClean)) {
      onUpdatePolicy(policy.spend_limit, [...policy.allowlist, payeeClean]);
    }
    setNewPayee('');
  };

  const handleRemovePayee = (payeeToRemove) => {
    onUpdatePolicy(policy.spend_limit, policy.allowlist.filter(p => p !== payeeToRemove));
  };

  const handleSaveLimit = () => {
    const val = parseFloat(limitInput);
    if (!isNaN(val) && val > 0) onUpdatePolicy(val, policy.allowlist);
    setEditingLimit(false);
  };

  return (
    <div ref={revealRef} className={`reveal ${shown ? 'is-visible' : ''} panel panel-hover p-6 flex flex-col gap-6`}>
      <div className="flex items-center justify-between">
        <span className="label flex items-center gap-1.5">
          <SlidersHorizontal className="w-3.5 h-3.5 text-lime" />
          Wallet Enforcement Policy
        </span>
        <span className="badge badge-muted">Active Rules</span>
      </div>

      {/* Budget meter */}
      <div>
        <div className="flex items-end justify-between mb-3">
          <span className="text-xs text-ink-muted">Daily Budget Capacity</span>
          <div className="flex items-center gap-1.5 font-mono text-sm font-semibold tabular-nums">
            <span className="text-ink">{money(shownSpent)}</span>
            <span className="text-ink-faint">/</span>
            {editingLimit ? (
              <span className="flex items-center gap-1.5">
                <input
                  type="number"
                  value={limitInput}
                  onChange={(e) => setLimitInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveLimit()}
                  className="field !w-24 !py-1 !px-2 !text-xs font-mono"
                  autoFocus
                />
                <button onClick={handleSaveLimit} className="btn btn-lime !py-1.5 !px-3 !text-[10px]">
                  Save
                </button>
              </span>
            ) : (
              <button
                onClick={() => { setLimitInput(policy.spend_limit); setEditingLimit(true); }}
                className="text-lime hover:text-lime-bright transition-colors border-b border-dashed border-lime/40"
                title="Click to edit daily spend limit"
              >
                {moneyShort(policy.spend_limit)}
              </button>
            )}
          </div>
        </div>

        <div className="meter">
          <div
            className="meter-fill"
            style={{ width: `${spentPct}%`, background: tone, boxShadow: `0 0 14px ${tone}` }}
          />
        </div>

        <div className="tickrail mt-1.5 opacity-40" />

        <div className="flex justify-between font-mono text-[10px] text-ink-muted mt-1">
          <span className="tabular-nums">{shownPct}% consumed</span>
          <span className="tabular-nums">
            {money(Math.max(0, policy.spend_limit - policy.daily_spent))} remaining
          </span>
        </div>
      </div>

      {/* Allowlist */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <span className="label flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-lime" />
            Allowlisted Payees
          </span>
          <span className="font-mono text-[10px] text-ink-muted tabular-nums">
            {policy.allowlist.length} approved
          </span>
        </div>

        <form onSubmit={handleAddPayee} className="flex items-center gap-2 mb-3.5">
          <input
            type="text"
            placeholder="api.openai.com"
            value={newPayee}
            onChange={(e) => setNewPayee(e.target.value)}
            className="field font-mono"
          />
          <button type="submit" className="btn btn-ghost flex-shrink-0">
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        </form>

        <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto pr-1">
          {policy.allowlist.map((payee, i) => (
            <span
              key={payee}
              className="chip !cursor-default anim-reveal group"
              style={stagger(i, 35)}
            >
              <Check className="w-3 h-3 text-lime flex-shrink-0" />
              <span>{payee}</span>
              <button
                onClick={() => handleRemovePayee(payee)}
                className="ml-0.5 p-0.5 rounded text-ink-faint hover:text-danger hover:bg-danger/10 transition-colors"
                title={`Remove ${payee}`}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
