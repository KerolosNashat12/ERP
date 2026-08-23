/**
 * `vercel.json` — the file that can stop a release reaching anybody.
 *
 * This test exists because of a failure with no symptom at the place it
 * happened. A cron was added on the hour (`0 * * * *`), which a Hobby account
 * refuses at DEPLOY time:
 *
 *   Hobby accounts are limited to daily cron jobs. This cron expression would
 *   run more than once per day.
 *
 * The build failed, Vercel kept serving the previous good deployment, and the
 * site went on working perfectly — as the version from a week earlier. Three
 * pushes in a row appeared to succeed: the commits were real, the pushes were
 * real, `git log` looked right, and nothing on the live site changed. The owner
 * said "nothing changed" three times before anyone thought to ask the deployed
 * server what version it was running.
 *
 * The only reliable tell was that a NEW file answered `200 text/html` — the
 * SPA's catch-all handing back its shell for a path the build never contained
 * — which is indistinguishable from a typo unless you look at the body.
 *
 * So the rule that lives in a hosting provider's docs is asserted here, where a
 * person finds out in thirty seconds instead of a week. If the account is ever
 * upgraded to Pro this file is what to change, deliberately, with the plan
 * written down in it — not something to delete the first time it complains.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(here, '..', 'vercel.json'), 'utf8'));

/**
 * The plan this project is deployed on. Hobby caps a cron at once per day;
 * Pro allows once per minute. Changing this line is a deliberate act that
 * should accompany an actual upgrade.
 * https://vercel.com/docs/cron-jobs/usage-and-pricing
 */
const PLAN = 'hobby';

/**
 * How many times a day a 5-field expression fires — enough of a cron parser to
 * answer the only question that matters here. Anything other than a literal
 * hour and a literal minute (a list, a range, a step, a wildcard) means it runs
 * more than daily, which is precisely what Hobby refuses.
 */
function runsMoreThanDailyOn(schedule) {
  const fields = String(schedule).trim().split(/\s+/);
  if (fields.length !== 5) return true;
  const [minute, hour] = fields;
  const literal = (f) => /^\d+$/.test(f);
  return !(literal(minute) && literal(hour));
}

test('vercel.json can actually be deployed', async (ctx) => {
  await ctx.test('it is valid JSON with the shape Vercel expects', () => {
    assert.ok(Array.isArray(config.crons), 'crons must be an array');
    for (const job of config.crons) {
      assert.match(job.path, /^\/api\//, `${job.path} is not an API route`);
      assert.equal(typeof job.schedule, 'string');
      assert.equal(job.schedule.trim().split(/\s+/).length, 5, `${job.schedule} is not a 5-field expression`);
    }
  });

  await ctx.test('no cron runs more often than this plan allows', () => {
    if (PLAN !== 'hobby') return;
    for (const job of config.crons) {
      assert.ok(
        !runsMoreThanDailyOn(job.schedule),
        `"${job.schedule}" on ${job.path} runs more than once a day. A Hobby account `
        + 'REFUSES THE WHOLE DEPLOYMENT for this, and Vercel keeps serving the previous '
        + 'build — so the release silently never ships. Use a literal hour and minute.',
      );
    }
  });

  await ctx.test('the parser recognises what it is meant to catch', () => {
    // A guard that cannot fail is not a guard; these are the expressions that
    // took a week to find, and the ones that are fine.
    for (const bad of ['0 * * * *', '*/30 * * * *', '0 */4 * * *', '0 2,14 * * *', '* * * * *']) {
      assert.ok(runsMoreThanDailyOn(bad), `${bad} should be rejected`);
    }
    for (const good of ['0 2 * * *', '30 14 * * *', '0 3 * * 1']) {
      assert.ok(!runsMoreThanDailyOn(good), `${good} should be allowed`);
    }
  });

  await ctx.test('the console does not promise a cadence this plan cannot keep', () => {
    /**
     * The owner's console tells him how fresh a figure is, so a sentence in it
     * naming an interval is a claim about `vercel.json` written in a different
     * file. One said "the hourly sweep" long after the schedule became daily —
     * on the one screen whose entire job is to say when a number was last read.
     *
     * The fix was to stop naming the interval rather than to keep two files in
     * step, so this asserts the absence: no cadence word in the sweep copy.
     */
    const copy = fs.readFileSync(
      path.join(here, '..', 'public', 'platform', 'js', 'core', 'i18n.fleet.js'), 'utf8',
    );
    for (const claim of [/hourly/i, /every hour/i, /كل ساعة/]) {
      assert.ok(
        !claim.test(copy),
        `the fleet console still says ${claim} — the schedule lives in vercel.json, `
        + 'and on a Hobby account it can only be daily. Describe the sweep without '
        + 'naming an interval.',
      );
    }
  });

  await ctx.test('every scheduled path is a route that exists', () => {
    // A cron pointing at nothing is a job that runs and 404s every night in a
    // log nobody reads.
    const routes = fs.readdirSync(path.join(here, '..', 'src', 'api', 'routes'))
      .map((f) => fs.readFileSync(path.join(here, '..', 'src', 'api', 'routes', f), 'utf8'))
      .join('\n');
    const server = fs.readFileSync(path.join(here, '..', 'src', 'server.js'), 'utf8');
    for (const job of config.crons) {
      const tail = job.path.replace(/^\/api\/cron/, '');
      assert.ok(
        routes.includes(`'${tail}'`) || routes.includes(job.path) || server.includes(job.path),
        `${job.path} is scheduled but no route answers it`,
      );
    }
  });
});
