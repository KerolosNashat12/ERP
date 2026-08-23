/**
 * One click, one document.
 *
 * The owner's report: *"when I click on save a lot of times it saves a lot of
 * POs."* Disabling the button (see `public/js/core/actions.js` and its two
 * siblings) is the half of the fix a person can see, and on its own it fixes
 * nothing — it does not cover a phone on a slow connection whose request is
 * retransmitted, a page restored from the back-forward cache, a second tab, or
 * anything at all that is not this browser. The row is created by the SERVER,
 * so the refusal to create it twice has to live there too.
 *
 * ── What one "logical request" is ───────────────────────────────────────────
 * The hard part is not remembering answers, it is deciding that two requests
 * are the same request. A shop legitimately rings up two identical one-item
 * sales a minute apart, and merging those would be a worse bug than the one
 * being fixed. So there are two ways a request gets its identity, in this
 * order:
 *
 *   1. `Idempotency-Key`, chosen by the browser. All three front ends mint a
 *      random key per *submission*, hold it across retries of that submission,
 *      and mint a fresh one the moment one succeeds. Two identical sales a
 *      minute apart therefore carry two different keys and stay two sales,
 *      while a double-click, a retransmit and a resubmit all carry the same
 *      one. This is the accurate answer, so it gets the long window.
 *
 *   2. A fingerprint of the request itself — caller, path and a key-sorted
 *      rendering of the body — for anything that sent no key: a second tab, an
 *      older cached bundle, a proxy replaying the POST. Content cannot
 *      distinguish "again" from "another", so this one is deliberately timid.
 *      It lasts seconds rather than minutes — long enough to swallow a
 *      double-tap and a transport retry, far too short to touch that second
 *      sale — and it applies to POST alone, the one method where a duplicate
 *      leaves a duplicate behind.
 *
 * The caller is part of both, so two cashiers on two tills never collide, and
 * a key guessed by a stranger is worthless.
 *
 * ── Why a table and not a Map ───────────────────────────────────────────────
 * Vercel. Each request may hit a different instance with its own memory, and
 * instances are recycled constantly — the lesson `tenant.js` records at length,
 * learned twice. Whatever arbitrates has to be the one thing every instance
 * shares, which is the database. See `shared/requestReplay.js`.
 *
 * ── The protocol ────────────────────────────────────────────────────────────
 * Claiming is an INSERT on a PRIMARY KEY, so the database decides the winner
 * with no lock and no round-trip dance:
 *
 *   claim wins   -> this request owns the key. Run it. On a 2xx, store the
 *                   status and body and mark it done BEFORE the bytes go out,
 *                   so anyone waiting is guaranteed to find the answer. On
 *                   anything else, delete the row — a 500 from a hiccup and a
 *                   422 from a typo must both be retryable, never a failure
 *                   nailed in place for the rest of the window.
 *   claim loses  -> somebody got there first. If they have finished, replay
 *                   their answer verbatim. If they are still running — the
 *                   actual double-click, where the two requests overlap — wait
 *                   for them and then replay. That wait is the difference
 *                   between this and a naive "have I seen this before" check,
 *                   which lets both copies through because neither has
 *                   finished yet.
 *
 * An instance that dies mid-request would otherwise wedge its key forever, so
 * the in-flight row carries a lease. Once it lapses the key is takeable again.
 *
 * ── Why it is here and not on the routes ────────────────────────────────────
 * A guard the next route has to remember is not a guard. This is mounted once
 * per API mount point in `server.js`, in front of the routers, so every unsafe
 * request that exists today and every one added tomorrow is covered without
 * anybody opting in. The only opt-OUT is the short list below.
 */
import crypto from 'node:crypto';
import { getDb } from '../../infrastructure/database/connection.js';

/** The methods that can create or change something. GET/HEAD/OPTIONS cannot. */
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The one exemption list, and it is short on purpose: default-on is what makes
 * this a guard rather than a convention.
 *
 * These three answer with a `Set-Cookie` as well as a body, and only the body
 * is stored here — replaying one would hand a caller a success with no session
 * attached, which looks exactly like a login that silently did nothing. They
 * also create no rows, so there is no duplicate to prevent: signing in twice
 * leaves one user and one audit trail either way.
 */
const EXEMPT = new Set(['/auth/login', '/auth/logout', '/auth/setup']);

const ms = (name, fallback) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
};

/** How long a keyed answer stays replayable. Minutes: the key is precise. */
const KEYED_TTL_MS = ms('MM_IDEMPOTENCY_TTL_MS', 10 * 60_000);

/**
 * How long a *content-fingerprinted* answer stays replayable. Seconds, and
 * deliberately far below the minute in "two identical sales a minute apart":
 * without a key, identical content is only evidence of a duplicate for as long
 * as a finger and a flaky network take.
 */
const FINGERPRINT_TTL_MS = ms('MM_IDEMPOTENCY_ECHO_MS', 10_000);

/** How long a claim may be held by an instance that never comes back. */
const LEASE_MS = ms('MM_IDEMPOTENCY_LEASE_MS', 30_000);

/** How long a second copy waits for the first to answer before giving up. */
const WAIT_MS = ms('MM_IDEMPOTENCY_WAIT_MS', 20_000);

const POLL_MS = ms('MM_IDEMPOTENCY_POLL_MS', 40);

/**
 * Bodies larger than this are not stored. Nothing that creates a document
 * answers with half a megabyte of JSON; something that does is a report or an
 * export, where re-running costs a query and storing costs the shop's database.
 */
const MAX_BODY_BYTES = 512 * 1024;

const ENABLED = process.env.MM_IDEMPOTENCY !== '0';

/** Marks a request that has already been arbitrated. See the guard below. */
const GUARDED = Symbol.for('mm.idempotency.guarded');

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

const sleep = (delay) => new Promise((resolve) => { setTimeout(resolve, delay); });

/**
 * A rendering of the body in which key order does not matter.
 *
 * `JSON.stringify` would make `{a:1,b:2}` and `{b:2,a:1}` different requests,
 * and they are the same request typed into the same form by the same person —
 * object key order is decided by whatever built the object, not by intent.
 */
function canonical(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

/**
 * Who is asking, as one opaque string.
 *
 * Never the user id: this runs before `authenticate`, deliberately, so that a
 * duplicated request is stopped before it reaches anything that writes. The
 * session cookie identifies the caller just as well for this purpose and is
 * available immediately. A storefront customer has no session at all, so there
 * it falls back to the connection — two shoppers behind one café router sharing
 * a fingerprint would need identical baskets, identical addresses and the same
 * ten seconds to collide.
 */
function actorOf(req) {
  const cookie = req.get('cookie');
  if (cookie) return `c:${sha(cookie)}`;
  const authorization = req.get('authorization');
  if (authorization) return `a:${sha(authorization)}`;
  return `n:${sha(`${req.ip || ''}|${req.get('user-agent') || ''}`)}`;
}

/** A table that is not there yet is not an error worth failing a shop over. */
const missingTable = (error) => /no such table: request_replay/i.test(String(error?.message));

/**
 * @param {object} options
 * @param {() => object} options.db  the database this mount's claims live in —
 *   `getDb` for a shop (tenant-scoped by AsyncLocalStorage, so this is the
 *   caller's own database), `platformDb` for the owner's console.
 * @param {() => string} options.scope  a label mixed into every key so two
 *   shops sharing a database could never share a claim.
 */
export function idempotency({ db = getDb, scope = () => 'shop' } = {}) {
  return function guardUnsafeRequest(req, res, next) {
    if (!ENABLED) return next();
    if (!UNSAFE.has(req.method)) return next();
    if (EXEMPT.has(req.path)) return next();

    // Express tries each mount whose prefix matches until one answers, so a
    // request that falls through `/api/shop` into `/api` meets this guard
    // twice. The second meeting would find the key claimed by the FIRST — by
    // itself — and sit there waiting for a request that is already inside it.
    // One arbitration per request, whichever mount gets there first.
    if (req[GUARDED]) return next();
    req[GUARDED] = true;

    return arbitrate(db, scope, req, res, next).catch(next);
  };
}

async function arbitrate(dbOf, scopeOf, req, res, next) {
  let database;
  try {
    database = dbOf();
  } catch {
    // No database open for this mount (nothing is going to be written either).
    return next();
  }

  const supplied = String(req.get('idempotency-key') || '').trim().slice(0, 200);

  /**
   * With no key from the caller there is nothing to go on but the content, and
   * content cannot tell "again" from "another". So the guess is only made where
   * being wrong about it is cheap and being right about it matters: POST, the
   * method that creates a row. PUT, PATCH and DELETE are already idempotent by
   * construction — repeating one changes nothing the first did not already
   * change, and there is no second document to prevent. Guessing there would
   * only mean answering the second delete of the same thing with the first
   * one's "deleted" instead of the truthful "there is nothing there", which
   * trades a real answer for a duplicate that never existed.
   */
  if (!supplied && req.method !== 'POST') return next();

  const identity = [scopeOf(), actorOf(req), req.method, req.baseUrl + req.path].join('\n');
  const key = supplied
    ? `k:${sha(`${identity}\n${supplied}`)}`
    : `f:${sha(`${identity}\n${canonical(req.body)}`)}`;
  const ttl = supplied ? KEYED_TTL_MS : FINGERPRINT_TTL_MS;
  const label = `${req.method} ${req.baseUrl}${req.path}`.slice(0, 300);

  const deadline = Date.now() + WAIT_MS;

  // Three attempts, not a loop without end: each one is "claim, or wait for
  // whoever holds it". A round is only ever repeated because the holder
  // released the key without answering (it failed, or its lease lapsed), which
  // cannot happen indefinitely.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let won;
    try {
      won = await claim(database, key, label);
    } catch (error) {
      if (missingTable(error)) return next();
      throw error;
    }

    if (won) {
      sweep(database);
      captureResponse(database, key, res, ttl);
      return next();
    }

    const held = await settledAnswer(database, key, deadline);
    if (held === 'timeout') {
      // Not a failure and not a duplicate: the first copy is still working.
      // Saying so beats both waiting forever and quietly writing a second row.
      return res.status(409).json({
        error: {
          code: 'REQUEST_IN_PROGRESS',
          message: 'This request is still being processed — it has not been lost. Please wait.',
        },
      });
    }
    if (held) return replay(res, held);
    // held === null: the holder let the key go. Round again and try to take it.
  }

  return next();
}

/**
 * Stake the claim. Two statements, and the PRIMARY KEY does the arbitrating:
 * clearing an expired row first is what lets a lapsed lease or a finished
 * window be taken over, and `INSERT OR IGNORE` means the loser of a race
 * between two instances doing exactly this learns it lost from `changes === 0`
 * rather than from an exception whose text differs per driver.
 */
async function claim(db, key, label) {
  const now = Date.now();
  await db.prepare('DELETE FROM request_replay WHERE key = ? AND expires_at <= ?').run(key, now);
  const result = await db.prepare(`
    INSERT OR IGNORE INTO request_replay (key, scope, state, expires_at)
    VALUES (?, ?, 'in_flight', ?)
  `).run(key, label, now + LEASE_MS);
  return Number(result?.changes || 0) > 0;
}

/**
 * Nothing here is worth keeping once its window has passed, and the row for a
 * key nobody asks for again would otherwise sit in the shop's database
 * forever. There is no scheduler on a serverless host to sweep from, so a
 * small fraction of claims pay for it — the table stays a working set rather
 * than a log, and no single request is slowed noticeably.
 */
function sweep(db) {
  if (Math.random() > 0.02) return;
  db.prepare('DELETE FROM request_replay WHERE expires_at <= ?')
    .run(Date.now() - 60_000)
    .catch(() => {});
}

/**
 * Wait for whoever holds the key.
 *
 * Returns the finished row, `null` if the holder gave the key up (so the caller
 * should try to take it), or `'timeout'` if it is still going after WAIT_MS.
 * Polling rather than notifying because there is nothing to notify through: the
 * holder is very likely a different process on a different machine.
 */
async function settledAnswer(db, key, deadline) {
  for (;;) {
    const row = await db.prepare(
      'SELECT state, http_status, body, expires_at FROM request_replay WHERE key = ?',
    ).get(key);

    if (!row) return null;
    if (row.state === 'done') return row;
    if (Number(row.expires_at) <= Date.now()) return null;
    if (Date.now() >= deadline) return 'timeout';
    await sleep(POLL_MS);
  }
}

function replay(res, row) {
  // Says out loud that this is the first answer again, not a second one. The
  // browser ignores it; a person reading a network log should not have to guess.
  res.setHeader('Idempotent-Replay', 'true');
  res.status(Number(row.http_status) || 200);
  return res.json(row.body ? JSON.parse(row.body) : null);
}

/**
 * Own the key for the life of this response.
 *
 * `res.json` is wrapped rather than `res.on('finish')` listened to, because the
 * claim has to be settled BEFORE the bytes leave: a second copy that is
 * polling must never see `in_flight`, take the lapsed key and re-run the work
 * while the first answer is already on the wire. The cost is one write's
 * latency added to a create, which is the correct thing to spend it on.
 *
 * Every route in all three APIs answers with JSON, including the error
 * handler — so wrapping this one method covers the success path, the refusal
 * path and the crash path with nothing to remember. Anything that ends the
 * response another way, and a connection that drops, fall through to `close`
 * and simply release the key.
 */
function captureResponse(db, key, res, ttl) {
  const send = res.json.bind(res);
  let settled = false;

  res.json = (payload) => {
    if (settled) return send(payload);
    settled = true;

    const status = res.statusCode || 200;
    const finish = status >= 200 && status < 300
      ? store(db, key, status, payload, ttl)
      : release(db, key);

    // A database that will not take the record must not also swallow the
    // answer the caller is waiting for: the worst case is a duplicate, and
    // that is strictly better than a lost purchase order.
    finish.catch(() => {}).then(() => send(payload));
    return res;
  };

  res.on('close', () => {
    if (settled) return;
    settled = true;
    release(db, key).catch(() => {});
  });
}

async function store(db, key, status, payload, ttl) {
  const body = JSON.stringify(payload ?? null);
  if (body.length > MAX_BODY_BYTES) return release(db, key);
  return db.prepare(`
    UPDATE request_replay SET state = 'done', http_status = ?, body = ?, expires_at = ?
    WHERE key = ?
  `).run(status, body, Date.now() + ttl, key);
}

/**
 * Let the key go.
 *
 * This is what keeps a failure from becoming permanent. A 500 caused by a
 * hiccup, a 409 because the supplier was deleted a second ago, a 422 because a
 * field was blank — all of them leave nothing behind, so the very next attempt
 * is a first attempt.
 */
const release = (db, key) => db.prepare('DELETE FROM request_replay WHERE key = ?').run(key);

export default idempotency;
