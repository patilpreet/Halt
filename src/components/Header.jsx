import React from 'react';
import { LogOut, ShieldX, Zap, User } from 'lucide-react';
import { useClock, useCountUp } from '../lib/motion';

export function Header({ isFrozen, dbConnected, email, transactions = [], onSignOut }) {
  const time = useClock();

  // Live threat counters — derived from the transaction log
  const blockedCount = transactions.filter(t =>
    t.status === 'blocked' || t.status === 'voided' || t.status === 'rejected'
  ).length;
  const autoKillCount = transactions.filter(t =>
    (t.reason || '').includes('AUTO-KILL') || (t.reason || '').includes('RECALLED')
  ).length;

  const blockedShown = useCountUp(blockedCount, { duration: 500 });
  const killShown = useCountUp(autoKillCount, { duration: 500 });

  return (
    <header className="sticky top-0 z-40 -mx-4 md:-mx-8 px-4 md:px-8 py-3 backdrop-blur-xl bg-bg/80 border-b border-hair">
      <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <MarkDial frozen={isFrozen} />
          <div className="leading-none">
            <div className="flex items-center gap-2">
              <span className="display text-xl text-ink tracking-tight">Halt</span>
              <span className="badge badge-muted !text-[9px]">AI Guard v3.0</span>
            </div>
            <div className="flex items-center gap-2 mt-1 text-[10px] font-mono text-ink-muted">
              <span>Wallet Security Console</span>
              <span className="text-ink-faint">/</span>
              <span className="tabular-nums">{time}</span>
            </div>
          </div>
        </div>

        {/* Status cluster */}
        <div className="flex flex-wrap items-center gap-2">
          <span className={`badge ${dbConnected ? 'badge-muted' : 'badge-warn'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${dbConnected ? 'bg-lime' : 'bg-warn'} anim-blink`} />
            {dbConnected ? 'Systems Nominal' : 'Offline Mode'}
          </span>

          {blockedCount > 0 && (
            <span className="badge badge-danger anim-fade">
              <ShieldX className="w-3 h-3" />
              {blockedShown} Blocked
            </span>
          )}

          {autoKillCount > 0 && (
            <span className="badge badge-danger anim-danger-pulse">
              <Zap className="w-3 h-3" />
              {killShown} Auto-Killed
            </span>
          )}

          <span className={`badge hud hud-flare ${isFrozen ? 'badge-danger hud-danger' : 'badge-ok'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${isFrozen ? 'bg-danger anim-blink' : 'bg-lime'}`} />
            {isFrozen ? 'Emergency Lockdown' : 'System Armed'}
          </span>

          {email && (
            <span className="badge badge-muted max-w-[13rem]" title={email}>
              <User className="w-3 h-3 flex-shrink-0" />
              <span className="truncate">{email}</span>
            </span>
          )}

          <button
            onClick={onSignOut}
            title="Sign out"
            className="p-2 rounded-lg border border-hair-2 text-ink-muted hover:text-danger hover:border-danger/50 hover:bg-danger/5 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
}

/** Miniature of the main dial, used as the wordmark. */
function MarkDial({ frozen }) {
  const accent = frozen ? 'var(--danger)' : 'var(--lime)';
  return (
    <div
      className="relative w-9 h-9 rounded-full grid place-items-center flex-shrink-0"
      style={{
        background: 'radial-gradient(circle at 50% 28%, #2A2A2A, #0A0A0A 74%)',
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.07), inset 0 -3px 8px rgba(0,0,0,0.8)',
      }}
    >
      <svg viewBox="0 0 40 40" className="absolute inset-0 w-full h-full overflow-visible">
        <circle
          cx="20" cy="20" r="16"
          fill="none" stroke={accent} strokeWidth="3" strokeLinecap="round"
          strokeDasharray="76 100" transform="rotate(-90 20 20)"
          style={{ filter: `drop-shadow(0 0 4px ${accent})` }}
          className={frozen ? 'anim-spin-rev' : ''}
        />
      </svg>
      <span
        className="w-2 h-2 rounded-full"
        style={{ background: accent, boxShadow: `0 0 8px ${accent}` }}
      />
    </div>
  );
}
