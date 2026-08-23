/**
 * A button whose work is still running stops looking pressable.
 *
 * The visible half of "one save, one thing saved". The half that actually
 * guarantees it is the dedupe in `core/api.js` and the server's own guard
 * (`src/api/middleware/idempotency.js`); this is the half the owner sees, and
 * without it the other two are only cleaning up after a press that should never
 * have happened. Provisioning a shop takes seconds, and a Create button that
 * still looks untouched after two of them WILL be pressed again.
 *
 * It is installed inside `h()` in `core/dom.js`, the one place this console
 * builds an element, so no screen has to opt in and nothing written later has
 * to remember. A deliberately separate copy of the ERP's
 * `public/js/core/actions.js`, for the same reason `dom.js` is a separate copy
 * of `ui.js`: the console owns everything under `public/platform/` and depends
 * on nothing outside it.
 *
 * What must not break: a form that fails validation does nothing asynchronous
 * and has to be usable again at once, so a press that starts no work releases
 * in the same tick and never visibly changes. And every press carries a
 * watchdog — a request that never settles must not leave a dead button on the
 * screen. Releasing early is safe: `api.js` still holds the request in flight,
 * so the extra press is deduped rather than sent.
 */
import { pendingRequests, settledRequests } from './api.js';

/** Longest a press may hold a button, whatever the network is doing. */
const WATCHDOG_MS = 45_000;

const isThenable = (value) => Boolean(value) && typeof value.then === 'function';

/**
 * The buttons a form submit is "coming from" — including one placed outside
 * the form and tied back to it by `form="…"`, which a search confined to the
 * form's own descendants would miss entirely.
 */
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
    // Only give back the state we took: a button already disabled for its own
    // reasons stays disabled.
    node.disabled = node.dataset.mmWasDisabled === '1';
    delete node.dataset.mmBusy;
    delete node.dataset.mmWasDisabled;
    node.removeAttribute('aria-busy');
    node.classList.remove('is-busy');
  }
}

/**
 * Wrap a handler so what was pressed cannot be pressed again while its work is
 * running. Anything that is not a button click or a form submit is returned
 * untouched, so this costs nothing anywhere else in the console.
 */
export function guardHandler(node, type, handler) {
  const isClick = type === 'click' && node.tagName === 'BUTTON';
  const isSubmit = type === 'submit' && node.tagName === 'FORM';
  if (!isClick && !isSubmit) return handler;

  return function guarded(event) {
    // Enter in a text field is the same request as clicking Save, so it meets
    // the same flag — before the handler runs, rather than by hoping a browser
    // will not submit a form whose button is disabled.
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
