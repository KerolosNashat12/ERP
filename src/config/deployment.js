/**
 * Which deployment this process is.
 *
 * ── The problem ──────────────────────────────────────────────────────────────
 * Every shop is on one Vercel project. A second project — a staging one — is
 * the point of this module: two deployments of the same code, and a running
 * process that can say which of them it is. Nothing else in the repository can
 * answer that question. `NODE_ENV` is 'production' on both (it is a build flag,
 * not a place), and `VERCEL_ENV` is 'production' on the production deployment
 * of BOTH projects, which is precisely the answer that would be wrong.
 *
 * ── Three values, and why ────────────────────────────────────────────────────
 *   production — the deployment paying customers are on.
 *   staging    — a second deployment of the same code, on its own data.
 *   local      — a machine somebody is standing at: a developer's laptop, and
 *                the shop PC running START.bat. Deliberately one value rather
 *                than two, because the ERP has one question to ask of it —
 *                "am I a shared deployment on the internet?" — and for both of
 *                those the answer is no. A shop PC is NOT a deployment in this
 *                sense: it gets no banner (see public/shared/deploymentBanner.js)
 *                and no control-plane guard (see platform/controlPlaneIdentity.js),
 *                which is the whole of what "the single-shop build is
 *                unaffected" means here.
 *
 * ── Which way the default fails ──────────────────────────────────────────────
 * The two mistakes are not symmetric.
 *
 * A STAGING deployment mistaken for production is silent and expensive: the
 * storefront looks like the real shop, so a customer places a real order into a
 * database that will be thrown away; a cashier rings up a real sale that no
 * report will ever contain. Nothing on any screen says otherwise, and nobody
 * finds out until the money does not add up.
 *
 * A PRODUCTION deployment mistaken for staging is loud and cheap: the real
 * shops carry a hazard frame and the word STAGING for as long as it takes
 * somebody to notice — which is minutes, because it is on every screen — and
 * the fix is one environment variable. No data is lost, no order is wrong.
 *
 * So an unset variable on something that IS a deployment resolves to `staging`.
 * The unsafe direction is never reached by forgetting; it has to be typed.
 *
 * On something that is NOT a deployment — a local file database, no Vercel,
 * no control-plane URL — it resolves to `local`, because a shop PC that has
 * never heard of any of this must behave exactly as it did before.
 */

/** The only three values. Everything else is normalised into one of them. */
export const ENVIRONMENTS = ['production', 'staging', 'local'];

/**
 * Spellings an owner might reasonably type, and what each means.
 *
 * `preview`, `test` and `uat` land on staging rather than being rejected: a
 * word that plainly is not production must never be *treated* as production
 * because it was not on a list.
 */
const ALIASES = {
  production: 'production',
  prod: 'production',
  live: 'production',
  staging: 'staging',
  stage: 'staging',
  preview: 'staging',
  test: 'staging',
  uat: 'staging',
  local: 'local',
  development: 'local',
  dev: 'local',
};

/**
 * @param {Record<string,string|undefined>} env  usually process.env
 * @param {{hosted: boolean}} options
 *   `hosted` — true when this process is a deployment rather than a machine:
 *   a hosted database, a control-plane URL, or Vercel underneath it. Passed in
 *   rather than read here so this function stays pure and testable.
 *
 * @returns {{environment: string, declared: boolean, reason: string}}
 *   `declared` is the important half. It is true only when a human typed a
 *   value this module recognised — never for a default, never for a word it had
 *   to guess at, and never for a value the Vercel clamp below overrode. Only a
 *   declared environment is allowed to write itself into a control-plane
 *   database (see platform/controlPlaneIdentity.js): a guess must never brand
 *   a database, because the branding is what the guard later trusts.
 */
export function resolveDeployment(env = {}, { hosted = false } = {}) {
  const raw = String(env.MM_DEPLOYMENT ?? '').trim().toLowerCase();
  const vercelEnv = String(env.VERCEL_ENV ?? '').trim().toLowerCase();

  let environment;
  let declared;
  let reason;

  if (!raw) {
    environment = hosted ? 'staging' : 'local';
    declared = false;
    reason = hosted ? 'default-hosted' : 'default-local';
  } else if (ALIASES[raw]) {
    environment = ALIASES[raw];
    declared = true;
    reason = 'declared';
  } else {
    // A value nobody recognises is not a reason to assume the dangerous one.
    environment = 'staging';
    declared = false;
    reason = 'unrecognised';
  }

  /**
   * A Vercel Preview deployment is never production, whatever the variable says.
   *
   * This is not politeness — it closes the hole this whole feature is about.
   * A preview deployment inherits the project's Preview-scoped environment
   * variables, and the existing deploy guide tells the owner to add secrets to
   * "Production, Preview and Development". So a branch push today produces a
   * throwaway deployment holding production's MM_PLATFORM_DB_URL: staging code
   * pointed at production's control plane, exactly the accident. Clamped here
   * it becomes a staging deployment, which the control-plane guard then refuses
   * outright when the database it opens says production.
   *
   * One-way, and it clears `declared`: a clamped value is this module's guess
   * about somebody else's intention, and a guess may not brand a database.
   */
  if (vercelEnv === 'preview' && environment === 'production') {
    environment = 'staging';
    declared = false;
    reason = 'vercel-preview';
  }

  return { environment, declared, reason };
}

export default { resolveDeployment, ENVIRONMENTS };
