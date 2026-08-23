/**
 * A button whose work is still running stops looking tappable.
 *
 * The visible half of "one tap, one order" — the half that actually guarantees
 * it is the dedupe in `core/api.js` and the server's own guard. This is the
 * half the shopper experiences: on a phone with two bars, "Confirm order" that
 * looks untouched for three seconds gets tapped again, and being right about
 * that is not the shopper's mistake. So it goes busy the instant the order is
 * actually on its way and comes back the instant the request settles —
 * including when it fails, because a customer left staring at a dead button
 * has no way forward at all.
 *
 * It is installed inside `el()` in `core/dom.js`, the one place this site
 * builds an element, so nothing has to opt in and nothing written later has to
 * remember. A deliberately small, separate copy of the ERP's
 * `public/js/core/actions.js` for the same reason `dom.js` is a separate copy
 * of `ui.js`: the storefront ships on its own and must not depend on the back
 * office's files.
 *
 * What must not break: the checkout form fails validation without doing
 * anything asynchronous, and has to be usable again immediately — so a press
 * that starts no work releases in the same tick and never visibly changes.
 * And every press carries a watchdog, so a request that never settles (a phone
 * that goes into a tunnel mid-POST) cannot leave the only button on the page
 * dead. Releasing early is safe: `api.js` still holds the request in flight, so
 * the extra tap is deduped rather than sent.
 */
import { pendingRequests, settledRequests } from './api.js';

/** Longest a tap may hold a button, whatever the network is doing. */
const WATCHDOG_MS = 45_000;

const isThenable = (value) => Boolean(value) && typeof value.then === 'function';

/**
 * The buttons a form submit is "coming from".
 *
 * Checkout's "place order" sits in the summary column OUTSIDE the form and is
 * tied back to it by `form="checkout-form"`, so a search that only looked
 * inside the form would find nothing and guard nothing.
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
 * Wrap a handler so what was tapped cannot be tapped again while its work is
 * running. Anything that is not a button click or a form submit is returned
 * untouched, so this costs nothing anywhere else on the site.
 */
export function guardHandler(node, type, handler) {
  const isClick = type === 'click' && node.tagName === 'BUTTON';
  const isSubmit = type === 'submit' && node.tagName === 'FORM';
  if (!isClick && !isSubmit) return handler;

  return function guarded(event) {
    // Enter in the phone-number field is the same order as tapping the button,
    // so it meets the same flag — before the handler runs, rather than by
    // hoping a browser will not submit a form whose button is disabled.
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
