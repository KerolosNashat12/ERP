/**
 * The one thing every screen is told about this deployment.
 *
 * Three surfaces show a staging banner — the ERP, the owner's console and the
 * storefront — and each of them learns which deployment it is on from a request
 * it was already making: `/api/session`, `/api/platform/auth/*` and
 * `/api/shop/config`. No screen makes an extra round trip for this, which is
 * how the banner costs the till nothing.
 *
 * Deliberately one field. The environment's NAME is not a secret — it is about
 * to be painted across the top of the page — but nothing else here is anybody's
 * business: not the control plane's URL, not which database was opened, not
 * whether the identity guard stamped or adopted. Those are boot-time facts that
 * belong in the server log and in `platform_audit`.
 */
import config from '../config/index.js';

export const deploymentInfo = () => ({ environment: config.deployment.environment });

export default deploymentInfo;
