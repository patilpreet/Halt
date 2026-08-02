/**
 * Motion primitives — the small set of hooks the UI animates with.
 * All of them no-op gracefully when the user prefers reduced motion.
 */

import { useState, useEffect, useRef, useCallback } from 'react';

export function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Scroll reveal. Returns `[ref, visible]` — render the `is-visible` class from
 * `visible` rather than letting the hook write it onto the node.
 *
 *   const [ref, shown] = useReveal();
 *   <div ref={ref} className={`reveal ${shown ? 'is-visible' : ''}`}>…</div>
 *
 * The visibility MUST live in React state: any element whose className also
 * depends on props (a panel that gains `panel-live` when the wallet freezes)
 * would otherwise have an imperatively-added class silently overwritten on the
 * next render, leaving it stuck at opacity 0.
 */
export function useReveal({ threshold = 0.12, rootMargin = '0px 0px -8% 0px', once = true } = {}) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }

    // IntersectionObserver does not report intersections while the document is
    // hidden, so a tab that loads in the background (or is prerendered) would
    // otherwise stay blank forever. Reveal anything already on screen up front,
    // and keep a timer as a last-resort escape hatch.
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight * 1.05 && rect.bottom > 0) {
      setVisible(true);
      if (once) return;
    }

    const failsafe = setTimeout(() => {
      if (document.hidden) setVisible(true);
    }, 1200);

    const obs = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            setVisible(true);
            if (once) obs.unobserve(entry.target);
          } else if (!once) {
            setVisible(false);
          }
        });
      },
      { threshold, rootMargin }
    );

    obs.observe(el);
    return () => {
      clearTimeout(failsafe);
      obs.disconnect();
    };
  }, [threshold, rootMargin, once]);

  return [ref, visible];
}

/**
 * Eased count-up to `target`. Returns the current display value.
 * Re-animates from wherever it currently sits whenever the target changes.
 */
export function useCountUp(target = 0, { duration = 900, decimals = 0 } = {}) {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef(null);

  useEffect(() => {
    const from = fromRef.current;
    const to = Number(target) || 0;

    if (from === to) return;
    if (prefersReducedMotion()) {
      fromRef.current = to;
      setValue(to);
      return;
    }

    const start = performance.now();
    const tick = now => {
      const t = Math.min(1, (now - start) / duration);
      // easeOutExpo — fast commit, soft landing
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      const next = from + (to - from) * eased;
      setValue(decimals > 0 ? Number(next.toFixed(decimals)) : Math.round(next));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration, decimals]);

  return value;
}

/**
 * Types `text` out one character at a time. Restarts when the text changes.
 * `done` lets callers drop the caret once the line has finished.
 */
export function useTypewriter(text = '', { speed = 22, startDelay = 0 } = {}) {
  const [out, setOut] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    const full = String(text || '');

    if (prefersReducedMotion() || !full) {
      setOut(full);
      setDone(true);
      return;
    }

    setOut('');
    setDone(false);

    let i = 0;
    let interval = null;
    const timeout = setTimeout(() => {
      interval = setInterval(() => {
        i += 1;
        setOut(full.slice(0, i));
        if (i >= full.length) {
          clearInterval(interval);
          setDone(true);
        }
      }, speed);
    }, startDelay);

    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, [text, speed, startDelay]);

  return { text: out, done };
}

/**
 * Normalised scroll progress (0→1) across the document. Drives the hero dial,
 * mirroring the reference interaction where the ring fills as the page scrolls.
 */
export function useScrollProgress() {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const read = () => {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(scrollable <= 0 ? 0 : Math.min(1, Math.max(0, window.scrollY / scrollable)));
    };

    read();
    window.addEventListener('scroll', read, { passive: true });
    window.addEventListener('resize', read);
    return () => {
      window.removeEventListener('scroll', read);
      window.removeEventListener('resize', read);
    };
  }, []);

  return progress;
}

/**
 * Fires `true` for `ms` whenever `trigger` changes — for one-shot flashes
 * (a card pulsing as a decision lands, the dial kicking on a state change).
 */
export function usePulse(trigger, ms = 700) {
  const [on, setOn] = useState(false);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setOn(true);
    const t = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(t);
  }, [trigger, ms]);

  return on;
}

/** Stable per-index animation delay for staggered lists. */
export const stagger = (i, step = 45, max = 8) => ({
  animationDelay: `${Math.min(i, max) * step}ms`,
});

/** Ticking clock string, updated once a second. */
export function useClock() {
  const [time, setTime] = useState(() => new Date().toLocaleTimeString());
  useEffect(() => {
    const t = setInterval(() => setTime(new Date().toLocaleTimeString()), 1000);
    return () => clearInterval(t);
  }, []);
  return time;
}

/** requestAnimationFrame-driven boolean that flips after mount — for entrance transitions. */
export function useMounted(delay = 0) {
  const [mounted, setMounted] = useState(false);
  const cb = useCallback(() => setMounted(true), []);
  useEffect(() => {
    const t = setTimeout(() => requestAnimationFrame(cb), delay);
    return () => clearTimeout(t);
  }, [delay, cb]);
  return mounted;
}
