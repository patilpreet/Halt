let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

export function playFreezeAlert() {
  try {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') ctx.resume();

    const now = ctx.currentTime;
    const duration = 1.2;

    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.connect(ctx.destination);

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.connect(master);
    osc.start(now);
    osc.stop(now + duration);

    for (let i = 0; i < 4; i++) {
      const t0 = now + i * 0.3;
      osc.frequency.setValueAtTime(660, t0);
      osc.frequency.linearRampToValueAtTime(990, t0 + 0.15);
      osc.frequency.linearRampToValueAtTime(660, t0 + 0.3);
    }

    master.gain.linearRampToValueAtTime(0.35, now + 0.05);
    master.gain.setValueAtTime(0.35, now + 1.0);
    master.gain.linearRampToValueAtTime(0.0001, now + duration);
  } catch (e) {
    // Ignore audio errors — alert sound is non-critical
  }
}
