'use strict';
/*
 * Shared countdown used by both the control bar and each individual note.
 *
 * The clock is driven off an absolute wall-clock deadline rather than a
 * decrementing counter, so a hidden/throttled renderer - or a full app restart -
 * can never make it drift. `remainingMs` is only authoritative while paused.
 */

window.fmtTime = function fmtTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};

/** "7" -> 7 min, "1:30" -> 1 min 30 s, "0.5" -> 30 s. Returns null if unparseable. */
window.parseDuration = function parseDuration(raw) {
  const t = String(raw).trim();
  let ms = null;
  if (/^\d+:\d{1,2}$/.test(t)) {
    const [m, s] = t.split(':').map(Number);
    ms = (m * 60 + s) * 1000;
  } else if (/^\d+(\.\d+)?$/.test(t)) {
    ms = Math.round(parseFloat(t) * 60 * 1000);
  }
  if (!ms || ms <= 0) return null;
  return Math.min(ms, 24 * 3600 * 1000);
};

/** Three short beeps, generated so the app ships without an audio asset. */
window.beep = function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.28, 0.56].forEach((offset) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.2);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.22);
    });
    setTimeout(() => ctx.close(), 1500);
  } catch { /* no audio device - the notification and the visuals still fire */ }
};

window.DEFAULT_DURATION = 25 * 60 * 1000;

window.createTimer = function createTimer({ onChange, onDone } = {}) {
  let durationMs = window.DEFAULT_DURATION;
  let remainingMs = durationMs;
  let deadline = null;      // absolute ms timestamp while running
  let finished = false;
  let loop = null;

  const msLeft = () => (deadline ? Math.max(0, deadline - Date.now()) : remainingMs);

  const snapshot = () => ({
    durationMs, remainingMs, deadline, finished,
    running: !!deadline,
    msLeft: msLeft(),
  });

  const emit = () => onChange && onChange(snapshot());
  const startLoop = () => { if (!loop) loop = setInterval(tick, 250); };
  const stopLoop = () => { clearInterval(loop); loop = null; };

  function tick() {
    if (!deadline) return stopLoop();
    if (Date.now() >= deadline) {
      deadline = null;
      remainingMs = 0;
      finished = true;
      stopLoop();
      emit();
      if (onDone) onDone(snapshot());
      return;
    }
    emit();
  }

  const api = {
    snapshot,

    /** Restore from persisted state; a deadline that already passed lands as finished. */
    hydrate(s) {
      if (!s) return emit();
      durationMs = s.durationMs || durationMs;
      remainingMs = s.remainingMs != null ? s.remainingMs : durationMs;
      deadline = s.deadline || null;
      finished = !!s.finished;
      if (deadline && Date.now() >= deadline) {
        deadline = null;
        remainingMs = 0;
        finished = true;
      }
      if (deadline) startLoop();
      emit();
    },

    start() {
      if (finished || remainingMs <= 0) { remainingMs = durationMs; finished = false; }
      deadline = Date.now() + remainingMs;
      startLoop();
      emit();
    },

    pause() {
      if (!deadline) return;
      remainingMs = msLeft();
      deadline = null;
      stopLoop();
      emit();
    },

    toggle() { if (deadline) api.pause(); else api.start(); },

    reset(ms) {
      if (ms) durationMs = ms;
      remainingMs = durationMs;
      deadline = null;
      finished = false;
      stopLoop();
      emit();
    },

    /** Change the dial without starting; a running timer keeps counting. */
    setDuration(ms) {
      durationMs = ms;
      if (!deadline) { remainingMs = ms; finished = false; }
      emit();
    },

    dispose() { stopLoop(); },
  };

  return api;
};
