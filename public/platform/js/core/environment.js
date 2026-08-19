/**
 * What this deployment can do, asked once per session.
 *
 * Its own module because two unrelated screens depend on the same answer and
 * on it changing: the create-shop form asks "can the server make me a
 * database?", and the Integrations screen is where that answer is *changed*.
 * A cache held inside either one of them would leave the other showing a fact
 * that stopped being true a moment ago — which, on the create form, reads as
 * "I connected Turso and it did not work".
 *
 * Deliberately not fetched when this module loads: the console imports every
 * view at boot, including before anyone has signed in, and a 401 from a
 * speculative probe would drop the app back to the sign-in screen. It is asked
 * the first time a screen that needs the answer wants it, and a probe that
 * fails assumes the conservative answer — no automatic database — so the owner
 * is offered the path that always works rather than one that may not.
 */
import api from './api.js';

const CONSERVATIVE = { hostedControlPlane: false, canProvision: false };

let environmentPromise = null;

export function platformEnvironment() {
  if (!environmentPromise) {
    environmentPromise = api.get('/environment').catch(() => ({ ...CONSERVATIVE }));
  }
  return environmentPromise;
}

/**
 * Ask again, now. Called after Turso is connected or disconnected — the one
 * moment in the console when the previous answer is known to be stale.
 */
export function refreshPlatformEnvironment() {
  environmentPromise = api.get('/environment').catch(() => ({ ...CONSERVATIVE }));
  return environmentPromise;
}

export default { platformEnvironment, refreshPlatformEnvironment };
