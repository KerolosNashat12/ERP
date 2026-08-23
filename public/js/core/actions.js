/**
 * A button whose work is still running stops looking pressable.
 *
 * The visible half of "one save, one purchase order". The half that actually
 * guarantees it is in `core/api.js` (identical requests in flight are one
 * request) and on the server (`api/middleware/idempotency.js`); this half is
 * what stops a person pressing Save five times in the first place, and — just
 * as important — tells them the press was heard. A button that looks untouched
 * for two seconds on a slow connection is a button that WILL be pressed again,
 * and being right about that is not the user's mistake.
 *
 * It is installed inside `h()` in `core/ui.js`, which is the one place in this
 * app where an element is built. Nothing has to opt in, no screen has to
 * remember, and a button written next year is covered the day it is written.
 * That is the whole reason it lives here rather than in twenty save handlers.
 *
 * ── What counts as "still running" ──────────────────────────────────────────
 * The handler's own promise, first: nearly every handler in this app is
 * `async () => …` or `() => save()`, so the promise it returns is exactly the
 * work. For a handler that returns nothing but fires a request anyway, the
 * fallback is the request itself — `api.js` counts what is in the air, and if
 * the count went up while the handler ran, the button waits for it.
 *
 * ── What must NOT happen ────────────────────────────────────────────────────
 * A form that fails validation returns without doing anything asynchronous at
 * all, and must be usable again immediately — so a press that starts no work
 * leaves the button exactly as it found it, untouched rather than restored.
 *
 * And no button may be left dead. Every disable carries a watchdog, because a
 * request that never settles is a real thing (a phone that goes into a tunnel
 * mid-POST) and a screen with a permanently grey Save is worse than the
 * duplicate this file exists to prevent. Releasing early is safe: `api.js`
 * still holds the in-flight request, so the extra press is deduped rather than
 * sent.
 */
import { pendingRequests, settledRequests } from './api.js';

/** Longest a press may hold a button, whatever the network is doing. */
const WATCHDOG_MS = 45_000;

const isThenable = (value) => Boolean(value) && typeof value.then === 'function';

/** The buttons a form submit is "coming from", so they go busy with it. */
function submitters(form) {
  const own = [...form.querySelectorAll('button:not([type=button]), input[type=submit]')];
  const outside = form.id
    ? [...document.querySelectorAll(`button[form="${CSS.escape(form.id)}"]`)]
    : [];
  return [...new Set([...own, ...outside])];
}

const busy = (node) => node.dataset.mmBusy === '1';

function hold(nodes) {
  for (const node of nodes) {
    if (busy(node)) continue;
    node.dataset.mmBusy = '1';
    node.dataset.mmWasDisabled = node.disabled ? '1' : '0';
    node.disabled = true;
    node.setAttribute('aria-busy', 'true');
    node.classList.add('is-busy');
  }
}

function release(nodes) {
  for (const node of nodes) {
    if (!busy(node)) continue;
    // Only give back the state we took. A button that was already disabled for
    // its own reasons stays disabled.
    node.disabled = node.dataset.mmWasDisabled === '1';
    delete node.dataset.mmBusy;
    delete node.dataset.mmWasDisabled;
    node.removeAttribute('aria-busy');
    node.classList.remove('is-busy');
  }
}

/**
 * Wrap a handler so the thing that was pressed cannot be pressed again while
 * its work is running. Returns the handler untouched for everything that is
 * not a button click or a form submit, so this costs nothing anywhere else.
 */
export function guardHandler(node, type, handler) {
  const isClick = type === 'click' && node.tagName === 'BUTTON';
  const isSubmit = type === 'submit' && node.tagName === 'FORM';
  if (!isClick && !isSubmit) return handler;

  return function guarded(event) {
    // Enter in a text field is the same request as clicking Save, so it is
    // stopped by the same flag — and stopped here, before the handler runs,
    // rather than by hoping the browser will not submit a form whose button is
    // disabled.
    const targets = isSubmit ? submitters(node) : [node];
    if (targets.some(busy)) {
      if (isSubmit) event.preventDefault();
      return undefined;
    }

    const before = pendingRequests();
    const outcome = handler.call(this, event);

    const work = isThenable(outcome)
      ? Promise.resolve(outcome)
      // Nothing was returned to wait on. If the handler nonetheless put a
      // request on the wire, wait for that.
      : (pendingRequests() > before ? settledRequests() : null);

    // Nothing asynchronous happened, so nothing is in flight to guard against
    // and this press is already over. Return without touching the button at
    // all — deliberately, and it is not an optimisation. A quantity stepper
    // disables its own "+" at the last unit in stock, and a form marks its own
    // fields; taking a snapshot before the handler runs and putting it back
    // afterwards would undo exactly those decisions. The only state this file
    // is entitled to restore is state it took.
    if (!work) return outcome;

    // A second click cannot be dispatched until a later task, so holding here
    // — after the handler has had its say about the button — is just as early
    // as holding before it, and does not overwrite what the handler decided.
    hold(targets);
    const done = () => release(targets);
    const timer = setTimeout(done, WATCHDOG_MS);
    work.then(() => { clearTimeout(timer); done(); }, () => { clearTimeout(timer); done(); });

    return outcome;
  };
}

export default guardHandler;
