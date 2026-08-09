/**
 * Hardware QR / barcode scanner support.
 *
 * USB and Bluetooth scanners behave as keyboards: they "type" the payload very
 * fast and finish with Enter. We watch for that signature globally, so a scan
 * works on any screen without focusing a specific box — and we ignore it while
 * the user is genuinely typing into a form field.
 *
 * Everything that varies between scanner models is configurable in
 * Settings → Devices, because no two cheap scanners behave the same:
 *   - speed threshold  (how fast counts as "not a human typing")
 *   - minimum length   (rejects stray keystrokes)
 *   - prefix / suffix  (many scanners are factory-set to wrap the payload)
 */
import { devices } from './store.js';

const listeners = new Set();
const diagnosticListeners = new Set();

let buffer = '';
let lastKeyTime = 0;
let startTime = 0;

/** Defaults used before the session (and therefore settings) has loaded. */
const FALLBACK = { enabled: true, maxKeyIntervalMs: 60, minLength: 3, stripPrefix: '', stripSuffix: '', beep: true };

function config() {
  try {
    return devices().scanner;
  } catch {
    return FALLBACK;
  }
}

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return Boolean(target.isContentEditable);
  // A dedicated scan box opts in with data-scan-target and is left alone.
  return !target.dataset.scanTarget;
}

/** Removes whatever wrapper characters the scanner was configured with. */
export function normalise(code, cfg = config()) {
  let value = String(code || '').trim();
  if (cfg.stripPrefix && value.startsWith(cfg.stripPrefix)) value = value.slice(cfg.stripPrefix.length);
  if (cfg.stripSuffix && value.endsWith(cfg.stripSuffix)) value = value.slice(0, -cfg.stripSuffix.length);
  return value.trim();
}

function handleKey(event) {
  const cfg = config();
  if (!cfg.enabled) return;

  const now = Date.now();
  const gap = now - lastKeyTime;
  lastKeyTime = now;

  if (event.key === 'Enter') {
    const raw = buffer;
    const code = normalise(raw, cfg);
    const elapsed = startTime ? now - startTime : 0;
    buffer = '';
    startTime = 0;

    diagnose({ raw, code, elapsed, accepted: false, reason: null });
    if (code.length < cfg.minLength) {
      if (raw) diagnose({ raw, code, elapsed, accepted: false, reason: 'too_short' });
      return;
    }
    if (isTypingTarget(event.target)) {
      diagnose({ raw, code, elapsed, accepted: false, reason: 'typing_in_field' });
      return;
    }
    event.preventDefault();
    diagnose({ raw, code, elapsed, accepted: true, reason: null });
    if (cfg.beep) beep();
    emit(code);
    return;
  }

  if (event.key.length !== 1) return;
  if (gap > 300) { buffer = ''; startTime = now; }
  if (!startTime) startTime = now;
  buffer += event.key;
  // Only characters arriving in a rapid burst count as part of a scan.
  if (gap > cfg.maxKeyIntervalMs && buffer.length > 1) {
    buffer = event.key;
    startTime = now;
  }
}

function emit(code) {
  for (const fn of listeners) {
    try { fn(code); } catch { /* a failing listener must not block the rest */ }
  }
}

function diagnose(info) {
  for (const fn of diagnosticListeners) {
    try { fn(info); } catch { /* diagnostics are best-effort */ }
  }
}

/** Short confirmation tone — the cheap scanners that lack a buzzer need this. */
function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 1760;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.06);
    setTimeout(() => ctx.close(), 250);
  } catch { /* audio is a nicety, never a requirement */ }
}

export function startScanner() {
  document.addEventListener('keydown', handleKey, true);
}

/** Subscribe to scans. Returns an unsubscribe function. */
export function onScan(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Subscribe to raw scan diagnostics — used by the Settings test panel. */
export function onScanDiagnostic(fn) {
  diagnosticListeners.add(fn);
  return () => diagnosticListeners.delete(fn);
}

/** Manual trigger — used by the topbar search box and the test panel. */
export const triggerScan = (code) => {
  const value = normalise(code);
  if (value) emit(value);
};
