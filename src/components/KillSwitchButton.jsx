import React from 'react';
import { Lock, Unlock, Radio } from 'lucide-react';
import { SecurityDial } from './SecurityDial';
import { useCountUp, usePulse, useReveal } from '../lib/motion';

/**
 * KillSwitchButton — the owner's emergency control, built on the dial.
 *
 * The torus reads budget headroom: full lime when the wallet is untouched,
 * draining as the agent spends. Freezing flips the whole assembly red and
 * locks the hub. Clicking anywhere on the dial toggles the freeze.
 */
export function KillSwitchButton({ isFrozen, policy, onToggleFreeze }) {
  const limit = policy?.spend_limit || 0;
  const spent = policy?.daily_spent || 0;
  const headroom = limit > 0 ? Math.max(0, Math.min(1, 1 - spent / limit)) : 1;

  // Frozen = fully sealed, so the ring reads 100% rather than "headroom".
  const progress = isFrozen ? 1 : headroom;
  const shown = useCountUp(Math.round(progress * 100));
  const kick = usePulse(isFrozen);
  const [revealRef, revealed] = useReveal();

  return (
    <div
      ref={revealRef}
      className={`reveal ${revealed ? 'is-visible' : ''} panel scanner p-6 flex flex-col items-center gap-5 ${isFrozen ? 'panel-live' : ''}`}
      style={isFrozen ? { borderColor: 'rgba(255,68,56,0.35)' } : undefined}
    >
      {/* Card header */}
      <div className="flex items-center justify-between w-full">
        <span className="label flex items-center gap-1.5">
          <Radio className={`w-3.5 h-3.5 ${isFrozen ? 'text-danger anim-blink' : 'text-lime'}`} />
          Owner Emergency Control
        </span>
        <span className={`badge ${isFrozen ? 'badge-danger' : 'badge-ok'}`}>
          <span
            className={`w-1.5 h-1.5 rounded-full ${isFrozen ? 'bg-danger anim-blink' : 'bg-lime'}`}
          />
          {isFrozen ? 'Frozen' : 'Armed'}
        </span>
      </div>

      {/* The dial */}
      <div className={`flex flex-col items-center gap-3 ${kick ? 'anim-reveal-scale' : ''}`}>
        <SecurityDial
          progress={progress}
          state={isFrozen ? 'frozen' : 'armed'}
          size={228}
          onClick={onToggleFreeze}
          ariaLabel={isFrozen ? 'Unfreeze wallet' : 'Freeze wallet'}
          glyph={
            isFrozen
              ? <Lock className="dial-glyph text-danger" strokeWidth={2.4} />
              : undefined
          }
        />

        {/* Readout sits in flow so the dial's bloom cannot wash it out */}
        <span
          className="font-mono text-[10px] font-semibold tracking-[0.18em] uppercase tabular-nums"
          style={{
            color: isFrozen ? 'var(--danger)' : 'var(--lime)',
            textShadow: `0 0 14px ${isFrozen ? 'rgba(255,68,56,0.5)' : 'var(--lime-a35)'}`,
          }}
        >
          {isFrozen ? 'Wallet Sealed' : `${shown}% Headroom`}
        </span>
      </div>

      {/* Action legend */}
      <button
        onClick={onToggleFreeze}
        className={`btn hud hud-flare w-full ${isFrozen ? 'btn-lime' : 'btn-danger hud-danger'}`}
      >
        {isFrozen ? <Unlock className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
        {isFrozen ? 'Release Lockdown' : 'Freeze Wallet'}
      </button>

      <p className="text-[11px] text-ink-muted leading-relaxed text-center max-w-[15rem]">
        {isFrozen
          ? 'Wallet sealed. Server policy rejects every agent spend attempt on arrival — including transactions already in flight.'
          : 'Enforced at the wallet layer, not inside the agent. One click overrides every downstream decision in real time.'}
      </p>
    </div>
  );
}
