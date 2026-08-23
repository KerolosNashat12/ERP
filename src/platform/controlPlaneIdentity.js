/**
 * The guard: a deployment and the control plane it just opened must agree
 * about which environment they are.
 *
 * ── What this is for ─────────────────────────────────────────────────────────
 * A bad deploy is not the realistic accident. The realistic accident is one
 * environment variable copied from the wrong project — `MM_PLATFORM_DB_URL`
 * from production, pasted into the staging project — after which a staging
 * deployment resolves real tenants, opens real shop databases, and a test run
 * writes to shops that are open for business.
 *
 * Nothing in the environment can catch that, because the environment is what is
 * wrong. So the check is made against something the deployment did not supply:
 * the control-plane database itself, which carries one row saying what it is
 * (`control_plane_identity`, see platform/schema.js). Two claims, from two
 * different places, checked against each other at boot.
 *
 * ── Four rules ───────────────────────────────────────────────────────────────
 *  1. FAIL CLOSED AND LOUDLY. A disagreement stops the process. It does not
 *     warn and carry on, because carrying on is the accident.
 *  2. A DELIBERATE RE-PURPOSE MUST BE POSSIBLE. Making a staging control plane
 *     by copying production's is the normal way to get realistic data, and the
 *     copy arrives wearing production's stamp. `MM_CONTROL_PLANE_REPURPOSE`
 *     re-stamps it — and has to name the environment being moved TO, so a
 *     stray `=1` cannot do it.
 *  3. A FIRST RUN AGAINST AN EMPTY DATABASE IS NEVER BLOCKED. An empty control
 *     plane has nothing to disagree with; it is stamped and the process starts.
 *  4. IT MAY NOT TAKE PRODUCTION DOWN ON THE UPGRADE. Every control plane in
 *     existence today is unstamped. An unstamped database plus a deployment
 *     that has not DECLARED an environment is the state of the world the moment
 *     this ships, and it warns rather than refuses — otherwise shipping this
 *     feature is itself the outage it was written to prevent.
 *
 * ── Why "declared" carries so much weight ────────────────────────────────────
 * Only an environment a human typed may be written into a database (see
 * config/deployment.js). A default is a guess, and a guess that brands a
 * database becomes the thing every later boot trusts. The one asymmetry: a
 * populated, unstamped control plane may be adopted by a deployment that says
 * `production` and may NOT be adopted by one that says `staging`. An existing
 * fleet with six shops in it is production by definition — that is what
 * "existing" means here — and a staging deployment finding one is either
 * pointed at the wrong database or performing a re-purpose it has not admitted
 * to. Both need a human.
 *
 * ── Where it runs ────────────────────────────────────────────────────────────
 * Once per process, inside `initPlatformDb()`, which is memoised — so this is
 * one extra SELECT on a cold start and nothing at all on every request after
 * it. It is armed only when the control plane is a hosted (libsql) database:
 * the shop PC's `data/platform.db` is a file on the machine somebody is
 * standing at and cannot be production's control plane reached by accident, so
 * the single-shop build never meets this code.
 */
import { AppError } from '../shared/errors.js';
import config from '../config/index.js';

/** Human-facing names, so a message reads the way the variable is written. */
const NAMES = { production: 'PRODUCTION', staging: 'STAGING', local: 'LOCAL' };
const name = (value) => NAMES[value] || String(value || 'UNKNOWN').toUpperCase();

/**
 * The refusal. Status 500 rather than 503 on purpose: 503 means "ask again in a
 * moment", and this will never fix itself. `AppError` rather than a bare Error
 * so the sentence actually reaches whoever calls the API — an unhandled error
 * is answered with "Something went wrong on the server", which is exactly the
 * mystery this is meant to replace.
 */
export class ControlPlaneMismatchError extends AppError {
  constructor(message) {
    super(message, { status: 500, code: 'CONTROL_PLANE_MISMATCH' });
  }
}

/** The same three lines end both refusals; written once so they cannot drift. */
const remedy = (claimed) => [
  '',
  '  What to do — one of these, and nothing else is needed:',
  `    · If this deployment really is ${name(claimed)}, it is pointed at the wrong`,
  '      database. Fix MM_PLATFORM_DB_URL / MM_PLATFORM_DB_TOKEN on this project.',
  `    · If this deployment is NOT ${name(claimed)}, say so: set MM_DEPLOYMENT to`,
  '      production, staging or local, and redeploy.',
  `    · If you meant to turn this database into a ${name(claimed)} one — a staging`,
  '      control plane copied from production is a normal thing to have — set',
  `      MM_CONTROL_PLANE_REPURPOSE=${claimed} once, redeploy, then remove it.`,
  '',
  '  Nothing was read from this database and nothing was written to it.',
].join('\n');

export function mismatchMessage({ claimed, stamped }) {
  return [
    '',
    `  ✖ REFUSING TO START — this deployment says it is ${name(claimed)}, but the`,
    `    control-plane database it opened says it is ${name(stamped)}.`,
    '',
    '    One of the two is wrong, and a deployment that guesses here writes to',
    '    the wrong shops.',
    remedy(claimed),
  ].join('\n');
}

export function unlabelledMessage({ claimed, shops }) {
  return [
    '',
    `  ✖ REFUSING TO START — this deployment says it is ${name(claimed)}, but the`,
    `    control-plane database it opened already holds ${shops} shop(s) and has`,
    '    never been labelled.',
    '',
    '    A control plane with shops in it that nobody has labelled is production',
    `    until somebody says otherwise. A ${name(claimed)} deployment will not adopt`,
    '    one.',
    remedy(claimed),
  ].join('\n');
}

/** True when this control plane already holds a fleet, or an owner account. */
async function countShops(db) {
  const tenants = await db.prepare('SELECT COUNT(*) AS n FROM tenants').get();
  const users = await db.prepare('SELECT COUNT(*) AS n FROM platform_users').get();
  return Number(tenants?.n || 0) + Number(users?.n || 0);
}

async function stamp(db, { environment, by, note = null }) {
  await db.prepare(`
    INSERT INTO control_plane_identity (id, environment, stamped_at, stamped_by, note)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      environment = excluded.environment,
      stamped_at  = excluded.stamped_at,
      stamped_by  = excluded.stamped_by,
      note        = excluded.note
  `).run(environment, new Date().toISOString(), by, note);
}

/**
 * Never allowed to be the reason a boot fails. The stamp and the refusal are
 * the mechanism; the audit row is the paperwork, and paperwork that can take a
 * deployment down is worse than no paperwork.
 */
async function audit(db, action, detail) {
  try {
    await db.prepare(
      'INSERT INTO platform_audit (platform_user_id, tenant_id, action, detail, created_at) VALUES (NULL, NULL, ?, ?, ?)',
    ).run(action, detail, new Date().toISOString());
  } catch { /* the check has already done its job */ }
}

/**
 * Check this deployment against the control plane it has opened.
 *
 * Every input is a parameter with a default read from `config`, so a test can
 * put a deployment in any of the six states without a second process and
 * without re-importing the module graph.
 *
 * @returns {Promise<{action: string, environment: string|null}>}
 *   'disarmed'    — a file control plane; the single-shop build's answer.
 *   'matched'     — the database already says what this deployment says.
 *   'stamped'     — an empty control plane, now labelled.
 *   'adopted'     — a populated, unlabelled control plane taken as production.
 *   'repurposed'  — a deliberate re-stamp, recorded in platform_audit.
 *   'unlabelled'  — nothing declared, nothing written; a warning, not a refusal.
 */
export async function assertControlPlaneIdentity(db, options = {}) {
  const {
    environment = config.deployment.environment,
    declared = config.deployment.declared,
    armed = config.platform.driver === 'libsql',
    repurpose = process.env.MM_CONTROL_PLANE_REPURPOSE,
    log = console,
  } = options;

  if (!armed) return { action: 'disarmed', environment: null };

  const row = await db.prepare('SELECT environment FROM control_plane_identity WHERE id = 1').get();
  const stamped = row?.environment || null;
  const wants = String(repurpose ?? '').trim().toLowerCase();

  if (stamped) {
    if (stamped === environment) {
      if (wants) {
        log.warn?.(`  MM_CONTROL_PLANE_REPURPOSE is set but this control plane already says ${name(stamped)}. Remove the variable.`);
      }
      return { action: 'matched', environment: stamped };
    }
    if (wants && wants === environment) {
      await stamp(db, { environment, by: 'repurposed', note: `was ${stamped}` });
      await audit(db, 'control_plane.repurposed', JSON.stringify({ from: stamped, to: environment }));
      log.warn?.(`\n  ⚠  Control plane RE-PURPOSED from ${name(stamped)} to ${name(environment)} `
        + '(MM_CONTROL_PLANE_REPURPOSE). Remove that variable now.\n');
      return { action: 'repurposed', environment };
    }
    throw new ControlPlaneMismatchError(mismatchMessage({ claimed: environment, stamped }));
  }

  // No stamp. Which of the three unstamped cases is this?
  if (!declared) {
    // The state of every deployment the moment this ships. Warn; never refuse.
    log.warn?.(`\n  ⚠  This deployment has not said which environment it is, and its control\n`
      + '     plane is unlabelled, so nothing can be checked. Set MM_DEPLOYMENT=production\n'
      + '     on the live project and redeploy — until then it is treated as STAGING and\n'
      + '     every screen carries a staging banner.\n');
    return { action: 'unlabelled', environment: null };
  }

  const shops = await countShops(db);
  if (shops === 0) {
    await stamp(db, { environment, by: 'first-run' });
    await audit(db, 'control_plane.labelled', JSON.stringify({ environment, on: 'first-run' }));
    return { action: 'stamped', environment };
  }
  if (environment === 'production') {
    await stamp(db, { environment, by: 'adopted', note: `${shops} row(s) present` });
    await audit(db, 'control_plane.labelled', JSON.stringify({ environment, on: 'adopted' }));
    return { action: 'adopted', environment };
  }
  if (wants && wants === environment) {
    await stamp(db, { environment, by: 'repurposed', note: 'was unlabelled' });
    await audit(db, 'control_plane.repurposed', JSON.stringify({ from: null, to: environment }));
    log.warn?.(`\n  ⚠  Control plane RE-PURPOSED to ${name(environment)} (MM_CONTROL_PLANE_REPURPOSE). `
      + 'Remove that variable now.\n');
    return { action: 'repurposed', environment };
  }
  throw new ControlPlaneMismatchError(unlabelledMessage({ claimed: environment, shops }));
}

export default { assertControlPlaneIdentity, ControlPlaneMismatchError };
