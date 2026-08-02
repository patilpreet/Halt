import React, { useMemo } from 'react';

/**
 * SecurityDial — the machined rotary dial the whole interface is built around.
 *
 * A brushed-metal disc under a lime progress torus, ringed by 60 radial ticks
 * that light up to the fill point, with a glowing glyph at the hub. Driven by
 * `progress` (0→1) so it can be scrolled, scored, or toggled.
 */

const TICK_COUNT = 60;

export function SecurityDial({
  progress = 0,
  state = 'armed',        // 'armed' | 'frozen'
  size = 320,
  onClick,
  glyph,                  // optional override for the hub mark
  spinning = false,
  className = '',
  ariaLabel,
}) {
  const clamped = Math.min(1, Math.max(0, progress));
  const frozen = state === 'frozen';
  const accent = frozen ? 'var(--danger)' : 'var(--lime)';

  // Geometry in a 200-unit viewBox, scaled by CSS.
  const R_ARC = 84;
  const CIRC = 2 * Math.PI * R_ARC;

  const ticks = useMemo(() => {
    const out = [];
    for (let i = 0; i < TICK_COUNT; i++) {
      const angle = (i / TICK_COUNT) * 2 * Math.PI - Math.PI / 2;
      const inner = 54;
      const outer = 66;
      out.push({
        i,
        x1: 100 + Math.cos(angle) * inner,
        y1: 100 + Math.sin(angle) * inner,
        x2: 100 + Math.cos(angle) * outer,
        y2: 100 + Math.sin(angle) * outer,
        lit: i / TICK_COUNT <= clamped,
      });
    }
    return out;
  }, [clamped]);

  const Tag = onClick ? 'button' : 'div';

  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-label={ariaLabel}
      className={`dial ${frozen ? 'is-frozen' : 'is-armed'} ${onClick ? 'is-interactive' : ''} ${className}`}
      style={{ width: size, height: size, '--dial-accent': accent }}
    >
      {/* Bloom behind the whole assembly */}
      <span className="dial-bloom" aria-hidden="true" />

      {/* Machined outer body */}
      <span className="dial-body" aria-hidden="true">
        <span className="dial-brushed" />
      </span>

      {/* Lime progress torus */}
      <svg className="dial-arc" viewBox="0 0 200 200" aria-hidden="true">
        <defs>
          <linearGradient id="dialArcGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={frozen ? '#FF7A70' : 'var(--lime-bright)'} />
            <stop offset="55%" stopColor={accent} />
            <stop offset="100%" stopColor={frozen ? '#B02219' : 'var(--lime-deep)'} />
          </linearGradient>
          <filter id="dialArcGlow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="6" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Unfilled track */}
        <circle
          cx="100" cy="100" r={R_ARC}
          fill="none"
          stroke="rgba(255,255,255,0.045)"
          strokeWidth="15"
        />

        {/* Filled arc */}
        <circle
          className="dial-arc-fill"
          cx="100" cy="100" r={R_ARC}
          fill="none"
          stroke="url(#dialArcGrad)"
          strokeWidth="15"
          strokeLinecap="round"
          strokeDasharray={CIRC}
          strokeDashoffset={CIRC * (1 - clamped)}
          filter="url(#dialArcGlow)"
          transform="rotate(-90 100 100)"
        />
      </svg>

      {/* Inner plate + ticks + hub */}
      <span className="dial-plate" aria-hidden="true">
        <svg className={`dial-ticks ${spinning ? 'anim-spin-slow' : ''}`} viewBox="0 0 200 200">
          {ticks.map(t => (
            <line
              key={t.i}
              x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
              stroke={t.lit ? accent : 'rgba(255,255,255,0.10)'}
              strokeWidth="2.4"
              strokeLinecap="round"
              style={t.lit ? { filter: `drop-shadow(0 0 3px ${accent})` } : undefined}
            />
          ))}
        </svg>

        <span className="dial-plate-inner">
          <span className="dial-hub">
            <span className="dial-hub-glow" />
            {glyph ?? <DialAsterisk frozen={frozen} />}
          </span>
        </span>
      </span>

      {/* Specular highlight over the whole dome */}
      <span className="dial-gloss" aria-hidden="true" />
    </Tag>
  );
}

/** The six-armed hub mark — lime when armed, red when the wallet is locked. */
function DialAsterisk({ frozen }) {
  return (
    <svg viewBox="0 0 24 24" className="dial-glyph" aria-hidden="true">
      <g
        stroke={frozen ? 'var(--danger)' : 'var(--lime-hot)'}
        strokeWidth="3.1"
        strokeLinecap="round"
      >
        <line x1="12" y1="3.5" x2="12" y2="20.5" />
        <line x1="12" y1="3.5" x2="12" y2="20.5" transform="rotate(60 12 12)" />
        <line x1="12" y1="3.5" x2="12" y2="20.5" transform="rotate(120 12 12)" />
      </g>
    </svg>
  );
}

/**
 * HudLabel — the bracketed callout that floats beside the dial in the
 * reference. `side` decides which way the connector tick points.
 */
export function HudLabel({ children, tone = 'lime', side = 'left', className = '', style }) {
  const toneClass =
    tone === 'danger' ? 'hud-danger' :
    tone === 'hold' ? 'hud-hold' :
    tone === 'muted' ? 'hud-muted' : '';

  return (
    <span
      className={`hud-label hud ${toneClass} hud-label-${side} ${className}`}
      style={style}
    >
      {children}
    </span>
  );
}
