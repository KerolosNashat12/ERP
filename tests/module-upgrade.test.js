/**
 * A module that ships after a shop was created — `src/platform/moduleUpgrade.js`.
 *
 * This is the fence around the failure that produced it. `costs` and
 * `employees` shipped, deployed, and answered on their routes; every test in
 * this suite passed; and the owner opened his ERP and said "nothing changed",
 * because `tenant_modules` had been written when his shop was created and
 * nothing had added the two new keys to it. The ERP hides a nav entry whose
 * module the tenant does not hold, so the whole feature was invisible.
 *
 * The rule under test is deliberately narrow, because the platform SELLS
 * modules: a full tenant stays full, and a tenant the owner limited stays
 * limited. Getting that backwards in either direction is a real cost — one
 * gives away the product, the other loses features silently.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULES } from '../src/shared/permissions.js';
import {
  INTRODUCED_IN, upgradeFor, modulesAddedAfter, modulesExistingAt, latestIntroduction,
} from '../src/platform/moduleUpgrade.js';

const ALL = Object.keys(MODULES);
const NEW = ['costs', 'employees'];
const OLD = ALL.filter((m) => !NEW.includes(m));

test('a module that ships late still reaches the shops that should have it', async (ctx) => {
  await ctx.test('every module in the catalogue is dated', () => {
    // A module nobody dated cannot be reasoned about, and this rule would
    // withhold it from every tenant forever without saying so.
    for (const key of ALL) {
      assert.ok(INTRODUCED_IN[key], `${key} has no entry in INTRODUCED_IN`);
    }
    // And nothing dated that is not a module — a stale key here would make
    // `latestIntroduction()` point at a release that shipped nothing.
    for (const key of Object.keys(INTRODUCED_IN)) {
      assert.ok(MODULES[key], `${key} is dated but is not a module`);
    }
  });

  await ctx.test('a full tenant gains what the release added', () => {
    assert.deepEqual(upgradeFor(OLD).sort(), [...NEW].sort());
  });

  await ctx.test('a tenant that already has them gains nothing', () => {
    assert.deepEqual(upgradeFor(ALL), []);
  });

  await ctx.test('a limited tenant is not quietly widened', () => {
    // The shop on the small package: it was deliberately given a subset, and
    // the owner sells the rest. Nothing here may hand it the costs page.
    const limited = ['dashboard', 'products', 'inventory', 'sales', 'customers'];
    assert.deepEqual(upgradeFor(limited), []);
    // Even one module short of full is short on purpose.
    assert.deepEqual(upgradeFor(OLD.filter((m) => m !== 'promotions')), []);
  });

  await ctx.test('a tenant holding one new module but missing an old one stays put', () => {
    // Half-upgraded by hand: still not a full tenant, so the rule keeps out.
    const odd = [...OLD.filter((m) => m !== 'reports'), 'costs'];
    assert.deepEqual(upgradeFor(odd), []);
  });

  await ctx.test('an empty tenant gains nothing', () => {
    assert.deepEqual(upgradeFor([]), []);
  });

  await ctx.test('the ledger splits the catalogue at this release', () => {
    const at = latestIntroduction();
    assert.equal(at, '2026-08-23');
    assert.deepEqual(modulesAddedAfter('0').sort(), [...NEW].sort());
    assert.deepEqual(modulesExistingAt('0').sort(), [...OLD].sort());
    // Everything is on one side or the other, and nothing on both.
    assert.equal(modulesAddedAfter('0').length + modulesExistingAt('0').length, ALL.length);
  });

  await ctx.test('running it twice grants nothing the second time', () => {
    const first = upgradeFor(OLD);
    const after = [...OLD, ...first];
    assert.deepEqual(upgradeFor(after), []);
  });
});
