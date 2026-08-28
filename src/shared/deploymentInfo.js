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

/**
 * WHICH BUILD is answering, alongside which deployment.
 *
 * The owner published a release, opened the ERP, could not find the feature in
 * it, and asked whether it had deployed. There was no way to answer that from
 * outside - not by looking at the screen, not with curl - so the answer took a
 * browser, a fetch of the JavaScript and a search for a function name inside it.
 * That is a silly amount of work for "is my update live", and it is a question
 * that gets asked after every single release.
 *
 * Vercel puts the commit in the environment. It is seven characters, it is
 * already public on GitHub, and it turns the question into a glance.
 */
const build = () => {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.MM_BUILD_SHA || '';
  const at = process.env.VERCEL_DEPLOYMENT_ID ? null : (process.env.MM_BUILD_AT || null);
  return {
    commit: sha ? String(sha).slice(0, 7) : null,
    message: process.env.VERCEL_GIT_COMMIT_MESSAGE
      ? String(process.env.VERCEL_GIT_COMMIT_MESSAGE).split('\n')[0].slice(0, 120)
      : null,
    at,
  };
};

export const deploymentInfo = () => ({
  environment: config.deployment.environment,
  build: build(),
});

export default deploymentInfo;
