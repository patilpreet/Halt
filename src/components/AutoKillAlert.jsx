import React, { useEffect, useState } from 'react';
import { ShieldX, AlertTriangle, X, Zap, Eye, Unlock } from 'lucide-react';
import { money } from '../lib/format';

/**
 * AutoKillAlert — the banner that drops in when a CRITICAL risk trips the
 * automatic freeze. Red variant of the panel language: bracketed, scanning,
 * pulsing until dismissed.
 *
 * It carries the recovery action itself: the banner is what tells the owner the
 * wallet is sealed, so it is also where "release it" has to live.
 */
export function AutoKillAlert({ event, isFrozen, onUnfreeze, onDismiss }) {
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    if (event) {
      setExiting(false);
      requestAnimationFrame(() => setVisible(true));
    } else {
      setVisible(false);
    }
  }, [event]);

  if (!event) return null;

  const handleDismiss = () => {
    setExiting(true);
    setTimeout(() => {
      setVisible(false);
      onDismiss();
    }, 350);
  };

  const { payee, amount, riskScore, aiReasoning, timestamp } = event;
  const shown = visible && !exiting;

  return (
    <div className="fixed top-0 inset-x-0 z-[9999] flex justify-center pointer-events-none px-4">
      <div
        className="w-full max-w-3xl mt-3 pointer-events-auto rounded-2xl overflow-hidden
                   border border-danger/60 bg-[#0C0505] shadow-danger-glow anim-danger-pulse"
        style={{
          transform: shown ? 'translateY(0)' : 'translateY(-130%)',
          opacity: shown ? 1 : 0,
          transition: 'transform 0.45s cubic-bezier(0.34,1.56,0.64,1), opacity 0.3s ease',
        }}
      >
        {/* Running stripe */}
        <div
          className="h-[3px]"
          style={{
            background: 'linear-gradient(90deg, var(--danger), #FF9A93, var(--danger), #FF9A93)',
            backgroundSize: '200% 100%',
            animation: 'meterSweep 1.4s linear infinite',
          }}
        />

        <div className="p-4 flex items-start gap-3.5">
          <div className="w-10 h-10 rounded-xl grid place-items-center flex-shrink-0 border border-danger/50 bg-danger/15">
            <ShieldX className="w-5 h-5 text-danger" />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1.5">
              <span className="label !text-danger flex items-center gap-1.5">
                <Zap className="w-3 h-3" /> Auto Kill Switch Activated
              </span>
              <span className="badge badge-danger !text-[9px] tabular-nums">Risk {riskScore}%</span>
              <span className="badge badge-danger !text-[9px]">Extreme Threat</span>
            </div>

            <p className="font-mono text-[11.5px] text-ink-2 mb-1.5">
              Spend request to <span className="text-danger font-bold">{payee}</span>{' '}
              for <span className="text-danger font-bold tabular-nums">{money(amount)}</span> — wallet auto-frozen.
            </p>

            <div className="flex items-start gap-1.5 text-[10.5px] text-ink-muted leading-relaxed">
              <Eye className="w-3 h-3 mt-0.5 flex-shrink-0 text-ink-faint" />
              <span className="line-clamp-2">
                {aiReasoning?.slice(0, 160)}{aiReasoning?.length > 160 ? '…' : ''}
              </span>
            </div>
          </div>

          <div className="flex flex-col items-end gap-2 flex-shrink-0">
            <button
              onClick={handleDismiss}
              title="Dismiss alert"
              className="p-1.5 rounded-lg border border-hair-2 text-ink-muted
                         hover:text-danger hover:border-danger/50 hover:bg-danger/10 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
            {timestamp && (
              <span className="font-mono text-[9px] text-ink-faint tabular-nums">
                {new Date(timestamp).toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 border-t border-danger/20 bg-danger/[0.06]">
          <AlertTriangle className="w-3 h-3 text-warn flex-shrink-0" />
          <span className="font-mono text-[10px] text-ink-muted flex-1 min-w-[12rem]">
            Every agent spend request is blocked while the wallet is sealed.
          </span>
          <button
            onClick={isFrozen ? onUnfreeze : handleDismiss}
            className="btn btn-lime !py-1.5 !px-3 !text-[10px] flex-shrink-0"
          >
            <Unlock className="w-3 h-3" />
            {isFrozen ? 'Unfreeze Wallet' : 'Dismiss'}
          </button>
        </div>
      </div>
    </div>
  );
}
