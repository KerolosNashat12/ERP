/**
 * Whether this instance is answering from the control plane or from memory.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * `api/middleware/tenant.js` will keep a shop trading through a control-plane
 * outage by serving the descriptor it last read (see the rules written there).
 * That is the right behaviour and it is also, by construction, invisible: the
 * till works, the storefront works, and nothing on any screen is different. A
 * platform that silently runs on remembered state is a platform where nobody
 * finds out the control plane has been down for two hours until something that
 * genuinely needs it — creating a shop, suspending one — fails.
 *
 * So the degradation is recorded here, in one place, and surfaced three ways:
 *
 *   - on the wire, per request: `X-MM-Tenant-Source: fresh | cached | remembered`
 *     and, when remembered, `X-MM-Control-Plane: degraded` with the age of the
 *     descriptor in seconds. Anyone with `curl` can tell, from outside, whether
 *     the answer they just got came from the control plane or from memory.
 *   - on `/api/health`, unauthenticated: the state of this instance, when it
 *     last reached the control plane, and how many shops it is currently
 *     holding in memory. Counts only — never a slug, never an error message,
 *     never a database URL (a driver's message quotes the URL back, and a URL
 *     is half of a credential; `FleetService` refuses to echo them for the same
 *     reason).
 *   - in `platform_audit`, one row per outage. Written on RECOVERY rather than
 *     when the outage starts, because during the outage the table it would be
 *     written to is the thing that is unreachable. The row therefore carries
 *     the whole episode: when it began, how long it lasted, how many reads
 *     failed, how many requests were served from memory, and how many were
 *     refused outright.
 *
 * ── Per instance, deliberately ───────────────────────────────────────────────
 * Serverless: every instance has its own copy of this, because every instance
 * has its own copy of the memory it is describing. A count here is "what THIS
 * instance is doing", which is exactly the question, and pretending otherwise
 * would need a shared store — the very thing that is unreachable.
 */
import { platformDb } from './db.js';

/** Nothing that reaches this module may ever throw into a request. */
const quietly = (fn) => { try { const r = fn(); if (r?.catch) r.catch(() => {}); } catch { /* noop */ } };

const state = {
  /** False from the first failed read until the next successful one. */
  degraded: false,
  lastOkAt: null,
  lastFailureAt: null,
  degradedSince: null,
  /** Reset at the start of each outage — these describe the current episode. */
  failures: 0,
  servedFromMemory: 0,
  refused: 0,
  /**
   * The constructor name of the last failure, never its message. "TypeError"
   * or "LibsqlError" is enough to tell a wrong credential from a dead socket;
   * the message is where the URL lives.
   */
  lastErrorName: null,
  /** Episodes since this instance started, so a flapping control plane shows. */
  outages: 0,
};

/**
 * How many shops this instance could still serve from memory right now, and
 * the two windows that decide it — registered by `api/middleware/tenant.js`,
 * which owns both. Reported rather than re-read from the environment so what
 * `/api/health` prints is what the middleware is actually using.
 */
let rememberedCount = () => 0;
let windows = { ttlMs: null, graceMs: null };
export const setRememberedCounter = (fn) => { rememberedCount = fn; };
export const setWindows = (next) => { windows = next; };

export function recordOk() {
  const now = new Date().toISOString();
  state.lastOkAt = now;
  if (!state.degraded) return;

  const episode = {
    startedAt: state.degradedSince,
    endedAt: now,
    durationMs: Date.parse(now) - Date.parse(state.degradedSince),
    failedReads: state.failures,
    servedFromMemory: state.servedFromMemory,
    refused: state.refused,
    error: state.lastErrorName,
  };
  state.degraded = false;
  state.degradedSince = null;
  state.failures = 0;
  state.servedFromMemory = 0;
  state.refused = 0;

  // eslint-disable-next-line no-console
  console.warn(`[control-plane] reachable again after ${Math.round(episode.durationMs / 1000)}s `
    + `— ${episode.servedFromMemory} request(s) were served from remembered state, `
    + `${episode.refused} refused`);

  /**
   * Best-effort, and never awaited by whatever request happened to be the one
   * that noticed. The control plane came back a millisecond ago; if this write
   * loses a race with a second wobble, the outage is simply not recorded, and
   * dropping a request on the floor to record one would be the wrong trade.
   */
  quietly(() => platformDb().prepare(`
    INSERT INTO platform_audit (platform_user_id, tenant_id, action, detail, created_at)
    VALUES (NULL, NULL, 'CONTROL_PLANE_RECOVERED', ?, ?)
  `).run(JSON.stringify(episode), now));
}

export function recordFailure(error) {
  const now = new Date().toISOString();
  state.lastFailureAt = now;
  state.failures += 1;
  state.lastErrorName = error?.constructor?.name || 'Error';
  if (state.degraded) return;
  state.degraded = true;
  state.degradedSince = now;
  state.outages += 1;
  // One line per episode, not per request: a control-plane outage on a busy
  // fleet is thousands of requests, and a log line each is both unreadable and,
  // on a metered host, expensive.
  // eslint-disable-next-line no-console
  console.warn(`[control-plane] unreachable (${state.lastErrorName}) — shops already resolved `
    + 'on this instance keep trading from remembered state until the grace window expires');
}

export const recordServedFromMemory = () => { state.servedFromMemory += 1; };
export const recordRefused = () => { state.refused += 1; };

/** What `/api/health` says. Counts and timestamps; no slug, no message, no URL. */
export function publicSnapshot() {
  return {
    state: state.degraded ? 'degraded' : 'ok',
    lastOkAt: state.lastOkAt,
    degradedSince: state.degradedSince,
    /**
     * Shops this instance could keep serving if the control plane went away
     * this second. On a cold instance it is 0, and that is the honest answer:
     * remembered state is memory, and a new instance has none.
     */
    remembered: rememberedCount(),
    servedFromMemory: state.servedFromMemory,
    refused: state.refused,
    outages: state.outages,
    ttlMs: windows.ttlMs,
    graceMs: windows.graceMs,
  };
}

/** The owner's view — the same, plus the failure class and the episode counts. */
export function ownerSnapshot() {
  return { ...publicSnapshot(), lastFailureAt: state.lastFailureAt, lastError: state.lastErrorName, failedReads: state.failures };
}

/** Tests only: put a fresh instance's state back. */
export function reset() {
  Object.assign(state, {
    degraded: false,
    lastOkAt: null,
    lastFailureAt: null,
    degradedSince: null,
    failures: 0,
    servedFromMemory: 0,
    refused: 0,
    lastErrorName: null,
    outages: 0,
  });
}

export const isDegraded = () => state.degraded;

export default {
  recordOk,
  recordFailure,
  recordServedFromMemory,
  recordRefused,
  publicSnapshot,
  ownerSnapshot,
  setRememberedCounter,
  setWindows,
  isDegraded,
  reset,
};
