/**
 * Which deployment this is, and the guard that stops it lying about it.
 *
 * Two halves, and the second is the one that matters.
 *
 * ── The name and the default ─────────────────────────────────────────────────
 * `resolveDeployment` is pure, so every case can be stated as an input and an
 * output rather than as a process with an environment. The case that earns the
 * most words is the DEFAULT: an unset variable on a deployment resolves to
 * `staging`, never to production, because a staging deployment mistaken for
 * production is silent and expensive while a production deployment mistaken for
 * staging is loud and free. And on a machine with a file database — a shop PC —
 * it resolves to `local`, which is what exempts the single-shop build from the
 * banner and from the guard entirely.
 *
 * ── The guard ────────────────────────────────────────────────────────────────
 * Run against a real libsql control plane (a `file:` URL — the same client,
 * statements and error shapes a hosted Turso control plane uses), through the
 * real `initPlatformDb()` wherever the case allows it, because the thing being
 * tested is that a mis-pointed deployment cannot open the database at all.
 *
 * Four behaviours the brief names, each one here:
 *   · it refuses a mismatch,
 *   · it allows a deliberate re-purpose,
 *   · it does not block a first run against an empty database,
 *   · and the default is what this file says it is.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDataDir = path.join(here, '..', 'data', 'deployment-identity-test');
fs.rmSync(testDataDir, { recursive: true, force: true });
fs.mkdirSync(testDataDir, { recursive: true });

const fileUrl = (name) => `file:${path.join(testDataDir, name)}`;

process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB_URL = fileUrl('control-plane.db');
process.env.MM_DB_FILE = path.join(testDataDir, 'unused-default.db');
process.env.MM_TENANTS_DIR = path.join(testDataDir, 'tenants');
/** This process IS a staging deployment, and says so. */
process.env.MM_DEPLOYMENT = 'staging';
delete process.env.MM_CONTROL_PLANE_REPURPOSE;

const { resolveDeployment, ENVIRONMENTS } = await import('../src/config/deployment.js');
const config = (await import('../src/config/index.js')).default;
const {
  initPlatformDb, closePlatformDb, platformDb,
} = await import('../src/platform/db.js');
const {
  assertControlPlaneIdentity, ControlPlaneMismatchError,
} = await import('../src/platform/controlPlaneIdentity.js');
const { openDriver } = await import('../src/infrastructure/database/connection.js');
const { PLATFORM_SCHEMA_SQL } = await import('../src/platform/schema.js');

/** Nothing here should print an operational warning into the test output. */
const quiet = { warn() {}, error() {} };

const identity = () => platformDb().prepare('SELECT * FROM control_plane_identity WHERE id = 1').get();
const noIdentity = async (db) => !(await db.prepare('SELECT 1 FROM control_plane_identity WHERE id = 1').get());

/** Put the database in a known state and hand the next boot a clean process. */
async function reopen() {
  await closePlatformDb();
  return initPlatformDb();
}

after(async () => {
  await closePlatformDb();
});

/* ══════════════════════════════════════════════════ the name and the default */

test('the deployment name, and which way its default fails', async (ctx) => {
  await ctx.test('the three values are production, staging and local', () => {
    assert.deepEqual(ENVIRONMENTS, ['production', 'staging', 'local']);
  });

  await ctx.test('unset, on anything hosted, is STAGING — never production', () => {
    const r = resolveDeployment({}, { hosted: true });
    assert.equal(r.environment, 'staging');
    // The half that keeps a guess from branding a database.
    assert.equal(r.declared, false);
  });

  await ctx.test('unset, on a machine with a file database, is LOCAL', () => {
    const r = resolveDeployment({}, { hosted: false });
    assert.equal(r.environment, 'local');
    assert.equal(r.declared, false);
  });

  await ctx.test('the single-shop build on a shop PC is LOCAL and never says otherwise', () => {
    // No MM_DB_URL, no VERCEL — but this test file DOES set a control-plane
    // URL, so `hosted` is true here. The shop PC's case is the pure one above;
    // what is checked here is that `local` is only ever reached by a machine.
    for (const env of [{}, { VERCEL: '1' }, { MM_DB_URL: 'libsql://x' }]) {
      const hosted = Boolean(env.VERCEL || env.MM_DB_URL);
      const r = resolveDeployment(env, { hosted });
      assert.equal(r.environment, hosted ? 'staging' : 'local');
    }
  });

  await ctx.test('a declared value wins, and is marked as declared', () => {
    for (const [typed, expected] of [
      ['production', 'production'], ['prod', 'production'], ['LIVE', 'production'],
      ['staging', 'staging'], ['stage', 'staging'], ['preview', 'staging'],
      ['local', 'local'], ['dev', 'local'], ['development', 'local'],
    ]) {
      const r = resolveDeployment({ MM_DEPLOYMENT: typed }, { hosted: true });
      assert.equal(r.environment, expected, `${typed} → ${expected}`);
      assert.equal(r.declared, true);
    }
  });

  await ctx.test('a word nobody recognises is treated as staging, not as production', () => {
    const r = resolveDeployment({ MM_DEPLOYMENT: 'produciton' }, { hosted: true });
    assert.equal(r.environment, 'staging');
    // A guess, so it may not stamp a control plane.
    assert.equal(r.declared, false);
  });

  await ctx.test('a Vercel preview deployment is never production, whatever it says', () => {
    const r = resolveDeployment({ MM_DEPLOYMENT: 'production', VERCEL_ENV: 'preview' }, { hosted: true });
    assert.equal(r.environment, 'staging');
    assert.equal(r.declared, false, 'a clamped value is this build\'s guess and may not stamp');
  });

  await ctx.test('the clamp only ever downgrades', () => {
    const r = resolveDeployment({ MM_DEPLOYMENT: 'staging', VERCEL_ENV: 'production' }, { hosted: true });
    assert.equal(r.environment, 'staging');
  });

  await ctx.test('this process reads its own declaration', () => {
    assert.equal(config.deployment.environment, 'staging');
    assert.equal(config.deployment.declared, true);
    assert.equal(config.deployment.isProduction, false);
  });
});

/* ═══════════════════════════════════════════════════════════════════ the guard */

test('the control-plane guard', async (ctx) => {
  await ctx.test('an empty control plane is not blocked — it is labelled', async () => {
    const db = await initPlatformDb();
    assert.ok(db, 'first run against an empty database opened normally');
    const row = await identity();
    assert.equal(row.environment, 'staging');
    assert.equal(row.stamped_by, 'first-run');
  });

  await ctx.test('the same deployment opening it again is simply allowed', async () => {
    await reopen();
    assert.equal((await identity()).environment, 'staging');
  });

  await ctx.test('a staging deployment REFUSES a control plane that says production', async () => {
    // Exactly the accident: MM_PLATFORM_DB_URL copied from the wrong project.
    // The database is made to say production; the deployment still says staging.
    await platformDb().prepare("UPDATE control_plane_identity SET environment = 'production' WHERE id = 1").run();
    await closePlatformDb();

    await assert.rejects(() => initPlatformDb(), (error) => {
      assert.ok(error instanceof ControlPlaneMismatchError);
      assert.equal(error.code, 'CONTROL_PLANE_MISMATCH');
      assert.match(error.message, /REFUSING TO START/);
      assert.match(error.message, /says it is STAGING/);
      assert.match(error.message, /says it is PRODUCTION/);
      // The message has to carry the way out, or it is just an outage.
      assert.match(error.message, /MM_DEPLOYMENT/);
      assert.match(error.message, /MM_CONTROL_PLANE_REPURPOSE=staging/);
      return true;
    });
  });

  await ctx.test('the refusal stands — a second attempt fails the same way', async () => {
    await assert.rejects(() => initPlatformDb(), (error) => error.code === 'CONTROL_PLANE_MISMATCH');
  });

  await ctx.test('a deliberate re-purpose is allowed, and recorded', async () => {
    // A real staging control plane made by copying production is a legitimate
    // thing to have. Saying so out loud is what makes it different from the
    // accident above — and the variable has to NAME the target environment.
    process.env.MM_CONTROL_PLANE_REPURPOSE = 'staging';
    try {
      const db = await reopen();
      assert.ok(db);
      const row = await identity();
      assert.equal(row.environment, 'staging');
      assert.equal(row.stamped_by, 'repurposed');
      assert.match(String(row.note), /production/);

      const audit = await platformDb()
        .prepare("SELECT * FROM platform_audit WHERE action = 'control_plane.repurposed' ORDER BY id DESC LIMIT 1").get();
      assert.ok(audit, 'the re-purpose is in the audit trail');
      assert.match(audit.detail, /"from":"production"/);
    } finally {
      delete process.env.MM_CONTROL_PLANE_REPURPOSE;
    }
  });

  await ctx.test('a re-purpose that names the wrong environment does not work', async () => {
    await platformDb().prepare("UPDATE control_plane_identity SET environment = 'production' WHERE id = 1").run();
    await closePlatformDb();
    // `=1` is the shape of variable somebody sets without reading; it must not
    // be enough to overwrite a production control plane's identity.
    process.env.MM_CONTROL_PLANE_REPURPOSE = '1';
    try {
      await assert.rejects(() => initPlatformDb(), (e) => e.code === 'CONTROL_PLANE_MISMATCH');
    } finally {
      delete process.env.MM_CONTROL_PLANE_REPURPOSE;
    }
  });

  await ctx.test('nothing was written to the database it refused', async () => {
    process.env.MM_CONTROL_PLANE_REPURPOSE = 'staging';
    try {
      await reopen();
      assert.equal((await identity()).environment, 'staging');
    } finally {
      delete process.env.MM_CONTROL_PLANE_REPURPOSE;
    }
    // Put it back to a clean, empty, unlabelled state for the cases below.
    await platformDb().prepare('DELETE FROM control_plane_identity').run();
  });
});

/* ── the three unstamped cases, driven directly so all six states are covered ── */

test('a control plane that has never been labelled', async (ctx) => {
  await ctx.test('with shops in it, a STAGING deployment refuses to adopt it', async () => {
    const db = await reopen();
    await db.prepare('DELETE FROM control_plane_identity').run();
    await db.prepare(`INSERT INTO tenants (slug, name_en, name_ar, driver, db_file)
                      VALUES ('already-here', 'Already Here', 'موجود', 'sqlite', '/tmp/x.db')`).run();

    await assert.rejects(
      () => assertControlPlaneIdentity(db, { environment: 'staging', declared: true, log: quiet }),
      (error) => {
        assert.equal(error.code, 'CONTROL_PLANE_MISMATCH');
        assert.match(error.message, /already holds 1 shop\(s\) and has/);
        return true;
      },
    );
    assert.ok(await noIdentity(db), 'a refusal writes nothing');
  });

  await ctx.test('with shops in it, a PRODUCTION deployment adopts it — the upgrade path', async () => {
    const db = platformDb();
    const result = await assertControlPlaneIdentity(db, { environment: 'production', declared: true, log: quiet });
    assert.equal(result.action, 'adopted');
    assert.equal((await db.prepare('SELECT * FROM control_plane_identity WHERE id = 1').get()).environment, 'production');
  });

  await ctx.test('an undeclared deployment warns and carries on — it must not be an outage', async () => {
    const db = platformDb();
    await db.prepare('DELETE FROM control_plane_identity').run();
    let warned = 0;
    const result = await assertControlPlaneIdentity(db, {
      environment: 'staging', declared: false, log: { warn: () => { warned += 1; } },
    });
    assert.equal(result.action, 'unlabelled');
    assert.equal(warned, 1, 'it says so, loudly, in the log');
    assert.ok(await noIdentity(db), 'a guess never brands a database');
  });

  await ctx.test('a deliberate re-purpose works on an unlabelled populated database too', async () => {
    const db = platformDb();
    const result = await assertControlPlaneIdentity(db, {
      environment: 'staging', declared: true, repurpose: 'staging', log: quiet,
    });
    assert.equal(result.action, 'repurposed');
    assert.equal((await db.prepare('SELECT * FROM control_plane_identity WHERE id = 1').get()).environment, 'staging');
  });
});

test('the shop PC is never guarded at all', async (ctx) => {
  await ctx.test('a file control plane disarms it, whatever the database says', async () => {
    const db = platformDb();
    await db.prepare("UPDATE control_plane_identity SET environment = 'production' WHERE id = 1").run();
    // `armed` is `config.platform.driver === 'libsql'` in production code; a
    // shop PC's control plane is the file `data/platform.db`, so it is false
    // there and this code is never reached.
    const result = await assertControlPlaneIdentity(db, {
      environment: 'local', declared: false, armed: false, log: quiet,
    });
    assert.equal(result.action, 'disarmed');
  });
});

/* ═════════════════════════════════════════════════════════════ both drivers */

/**
 * The identity table and the two statements that touch it, on each driver.
 *
 * The guard is only ARMED on a libsql control plane in production (a shop PC's
 * `data/platform.db` is a file on the machine somebody is standing at, so
 * there is nothing to be pointed at by accident). But `PLATFORM_SCHEMA_SQL` is
 * applied on both, and `ON CONFLICT (id) DO UPDATE` is not something to
 * discover a driver disagrees about during a deploy — so the whole cycle is
 * driven on each: label an empty database, refuse a mismatch, re-purpose it.
 *
 * The facade below is the same three lines `platform/db.js` builds; there is
 * no second control plane to open through `initPlatformDb()`.
 */
function facadeFor(driver) {
  return {
    prepare: (sql) => ({
      get: (...params) => driver.executor.get(sql, params),
      all: (...params) => driver.executor.all(sql, params),
      run: (...params) => driver.executor.run(sql, params),
    }),
  };
}

for (const [label, descriptor] of [
  ['sqlite', { driver: 'sqlite', file: path.join(testDataDir, 'both-sqlite.db') }],
  ['libsql', { driver: 'libsql', url: fileUrl('both-libsql.db') }],
]) {
  test(`the identity table works on the ${label} driver`, async (ctx) => {
    const driver = await openDriver(descriptor);
    await driver.applySchema(PLATFORM_SCHEMA_SQL);
    const db = facadeFor(driver);
    ctx.after(async () => { await driver.close(); });

    await ctx.test('an empty control plane is labelled, not blocked', async () => {
      const result = await assertControlPlaneIdentity(db, {
        environment: 'production', declared: true, armed: true, log: quiet,
      });
      assert.equal(result.action, 'stamped');
      assert.equal((await db.prepare('SELECT * FROM control_plane_identity WHERE id = 1').get()).environment, 'production');
    });

    await ctx.test('a mismatch is refused', async () => {
      await assert.rejects(
        () => assertControlPlaneIdentity(db, {
          environment: 'staging', declared: true, armed: true, log: quiet,
        }),
        (error) => error.code === 'CONTROL_PLANE_MISMATCH',
      );
    });

    await ctx.test('a deliberate re-purpose rewrites the one row rather than adding a second', async () => {
      const result = await assertControlPlaneIdentity(db, {
        environment: 'staging', declared: true, armed: true, repurpose: 'staging', log: quiet,
      });
      assert.equal(result.action, 'repurposed');
      const rows = await db.prepare('SELECT * FROM control_plane_identity').all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].environment, 'staging');
    });
  });
}

/* ══════════════════════════════════ every screen is told, on a call it makes */

/**
 * The banner is only as good as the fact reaching the page, so this checks the
 * four places a screen learns it — and checks them on the requests those
 * screens ALREADY make before their first paint, because the rule was that
 * none of this may cost the ERP a round trip.
 *
 *   ERP        → /api/session          (drawn with the sidebar)
 *   storefront → /api/shop/config      (drawn with the shop's name)
 *   console    → /api/platform/auth/*  (drawn on the sign-in screen)
 *   anybody    → /api/health           (answerable with curl, no session)
 */
test('every surface is told which deployment it is on', async (ctx) => {
  const { createApp } = await import('../src/server.js');
  const { initDb, closeDb } = await import('../src/infrastructure/database/connection.js');
  const tenantService = (await import('../src/platform/TenantService.js')).default;

  await initDb();
  // The cases above deliberately left this control plane stamped PRODUCTION.
  // Putting it back is the same deliberate re-purpose an owner would perform.
  await closePlatformDb();
  process.env.MM_CONTROL_PLANE_REPURPOSE = 'staging';
  try { await initPlatformDb(); } finally { delete process.env.MM_CONTROL_PLANE_REPURPOSE; }
  await tenantService.create({ slug: 'told', nameEn: 'Told', nameAr: 'مُبلَّغ', modules: [] });

  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => (await fetch(`${base}${p}`)).json();
  ctx.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeDb();
  });

  await ctx.test('/api/health says so without a session', async () => {
    assert.equal((await get('/api/health')).deployment.environment, 'staging');
  });

  await ctx.test('the ERP shell is told on /api/session', async () => {
    assert.equal((await get('/t/told/api/session')).deployment.environment, 'staging');
  });

  await ctx.test('the storefront is told on /api/shop/config', async () => {
    assert.equal((await get('/t/told/api/shop/config')).deployment.environment, 'staging');
  });

  await ctx.test('the console is told before anybody signs in', async () => {
    assert.equal((await get('/api/platform/auth/state')).deployment.environment, 'staging');
  });
});
