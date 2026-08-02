import React, { useState, useEffect, useRef } from 'react';
import { ChevronDown, ShieldCheck, Bot, UserCheck, Zap } from 'lucide-react';
import { SecurityDial, HudLabel } from './SecurityDial';
import { useCountUp, useTypewriter, prefersReducedMotion } from '../lib/motion';

/**
 * Hero — the scroll micro-interaction.
 *
 * The dial fills as the hero scrolls past, lighting each guardian in the
 * cascade in turn and counting enforcement coverage up to 100%.
 */

const CALLOUTS = [
  { at: 0.02, side: 'left',  tone: 'lime',   icon: ShieldCheck, text: 'Allowlist enforced at the wallet' },
  { at: 0.26, side: 'right', tone: 'lime',   icon: Bot,         text: 'Deep risk review on large spends' },
  { at: 0.52, side: 'left',  tone: 'hold',   icon: UserCheck,   text: 'Human holds the final release' },
  { at: 0.76, side: 'right', tone: 'danger', icon: Zap,         text: 'Kill switch armed — one click' },
];

export function Hero({ isFrozen }) {
  const sectionRef = useRef(null);
  const [progress, setProgress] = useState(prefersReducedMotion() ? 1 : 0.06);

  useEffect(() => {
    if (prefersReducedMotion()) return;

    const read = () => {
      const el = sectionRef.current;
      if (!el) return;
      // Fill across the first ~85% of the hero's own height.
      const span = Math.max(1, el.offsetHeight * 0.85);
      const scrolled = Math.min(span, Math.max(0, window.scrollY));
      setProgress(0.06 + (scrolled / span) * 0.94);
    };

    read();
    window.addEventListener('scroll', read, { passive: true });
    window.addEventListener('resize', read);
    return () => {
      window.removeEventListener('scroll', read);
      window.removeEventListener('resize', read);
    };
  }, []);

  const pct = Math.round(Math.min(1, progress) * 100);
  const shown = useCountUp(pct, { duration: 420 });

  return (
    <section
      ref={sectionRef}
      className="relative min-h-[88vh] flex flex-col justify-center overflow-hidden"
    >
      {/* Dial stage */}
      <div className="relative flex items-center justify-center py-10">
        <SecurityDial
          progress={Math.min(1, progress)}
          state={isFrozen ? 'frozen' : 'armed'}
          size={420}
          className="max-w-[76vw] max-h-[76vw]"
        />

        {/* Bracketed callouts — revealed as the ring passes each threshold */}
        {CALLOUTS.map((c, i) => (
          <Callout
            key={c.text}
            {...c}
            index={i}
            active={progress >= c.at}
          />
        ))}
      </div>

      {/* Headline + coverage readout */}
      <div className="relative z-10 grid grid-cols-1 lg:grid-cols-12 items-end gap-8 px-1 mt-2">
        <div className="lg:col-span-7 anim-reveal">
          <h1 className="display text-[13vw] sm:text-6xl lg:text-7xl text-ink">
            Your agent spends.
            <br />
            <span className="text-lime glow-text">Halt decides.</span>
          </h1>
          <p className="mt-5 text-ink-2 text-sm sm:text-base leading-relaxed max-w-xl">
            Three guardians stand between an autonomous agent and your wallet — fast rules,
            then deep AI review, then you. Enforcement lives at the wallet layer, so the
            agent cannot talk its way past it.
          </p>
        </div>

        <div className="lg:col-span-5 flex flex-col items-start lg:items-end anim-reveal" style={{ animationDelay: '120ms' }}>
          <div
            className={`numeral-outline text-[16vw] sm:text-8xl lg:text-9xl leading-none ${pct >= 99 ? 'is-filled' : ''}`}
          >
            {shown}%
          </div>
          <div className="label !text-lime !tracking-[0.22em] mt-1">
            Enforcement Coverage
          </div>
        </div>
      </div>

      {/* Scroll cue */}
      <div className="flex justify-center mt-10 mb-2">
        <div className="flex flex-col items-center gap-1.5 text-ink-faint">
          <span className="label !text-[9px]">Scroll to arm</span>
          <ChevronDown className="w-4 h-4 anim-breath" />
        </div>
      </div>
    </section>
  );
}

/** One bracketed callout, typed out the moment its threshold is crossed. */
function Callout({ side, tone, icon: Icon, text, active, index }) {
  const { text: typed, done } = useTypewriter(active ? text : '', { speed: 16 });

  // Fanned around the dial: two per side, offset vertically.
  // `position` is set inline because the utility class would lose to
  // `.hud-label`'s own rule further down the stylesheet.
  // Left holds 0 and 2, right holds 1 and 3 — so pairing by half avoids overlap.
  const vertical = index < 2 ? '26%' : '68%';
  const edge = 'max(1rem, calc(50% - 27rem))';
  const position = side === 'left'
    ? { position: 'absolute', left: edge, top: vertical }
    : { position: 'absolute', right: edge, top: vertical };

  return (
    <HudLabel
      side={side}
      tone={tone}
      className="hidden md:inline-flex transition-all duration-700"
      style={{
        ...position,
        opacity: active ? 1 : 0,
        transform: `translateY(-50%) translateX(${active ? '0' : side === 'left' ? '-12px' : '12px'})`,
      }}
    >
      <Icon className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--hud-c)' }} />
      <span className={done ? '' : 'caret'}>{typed}</span>
    </HudLabel>
  );
}
