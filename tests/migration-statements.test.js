/**
 * Statements a hosted database will not accept — the fence around an outage.
 *
 * Migration 014 ran `ANALYZE` to make the planner choose the partial index it
 * had just created. On the shop PC that is free and correct. On Turso the
 * server refuses the statement outright:
 *
 *   LibsqlError: SQL_PARSE_ERROR: SQL not allowed statement: ANALYZE
 *
 * A migration runs inside a transaction, so the refusal aborted the migration;
 * `runMigrations` re-raised it; and `runMigrations` is called on the first
 * request of every cold serverless instance. The result was every route on
 * every surface — the ERP, the storefront and the owner's console — answering
 * 500 within seconds of the deployment going live, for a statement that only
 * ever gathers statistics and could not affect a single row.
 *
 * The lesson is not "remember not to write ANALYZE". It is that an optimisation
 * must fail like an optimisation, so `migrations/index.js` grew `analyze()`,
 * which asks the driver first and swallows a refusal. This file makes sure
 * nothing goes round it: no migration may hand one of these statements to
 * `ddl()` or straight to `prepare()`.
 *
 * Both drivers run the same schema byte-for-byte, which is the property that
 * makes this codebase's testing work — and it is exactly why a statement only
 * one of them accepts has to be caught by reading the source. A `file:` libSQL
 * database, which is what the hosted path is tested against, ALLOWS `ANALYZE`;
 * only the real server refuses it. No integration test here could have found
 * this. A source scan can, in milliseconds, forever.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'src', 'infrastructure', 'database', 'migrations');

/**
 * Statements libSQL's server rejects with SQL_PARSE_ERROR. Every one of them is
 * maintenance — none changes what a query returns — which is why the right
 * answer is always "skip it", never "find another way to run it".
 */
const REFUSED = ['ANALYZE', 'VACUUM', 'PRAGMA optimize'];

/** Comments explain WHY a statement is banned; they are not the statement. */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const files = fs.readdirSync(dir).filter((f) => /^\d{3}-.*\.js$/.test(f));

test('no migration sends a statement a hosted database refuses', async (ctx) => {
  await ctx.test('the migration folder was actually read', () => {
    // A scan that silently found no files is a guard that cannot fail.
    assert.ok(files.length > 10, `expected the numbered migrations, found ${files.length}`);
  });

  await ctx.test('none of them contains a refused statement', () => {
    for (const file of files) {
      const code = stripComments(fs.readFileSync(path.join(dir, file), 'utf8'));
      for (const statement of REFUSED) {
        assert.ok(
          !new RegExp(`['"\`]\\s*${statement}`, 'i').test(code),
          `${file} runs ${statement}. Turso REFUSES it — and because a migration `
          + 'runs in a transaction, that refusal aborts every request on every '
          + `surface. Use the injected analyze() helper instead, which asks the `
          + 'driver first and treats a refusal as "carry on".',
        );
      }
    }
  });

  await ctx.test('the helper is what migrations are given', async () => {
    // If `analyze` ever stops being passed to up(), the two migrations that
    // call it break at run time on the shop PC — and this says so here.
    const index = fs.readFileSync(path.join(dir, 'index.js'), 'utf8');
    assert.match(index, /migration\.up\(\{[^}]*\banalyze\b/s, 'up() is not given analyze()');
    const { analyze } = await import('../src/infrastructure/database/migrations/index.js');
    assert.equal(typeof analyze, 'function');
  });

  await ctx.test('every migration that wanted statistics goes through it', () => {
    // The two that measured a real gain from ANALYZE must still ask for it —
    // deleting the call would quietly undo the index work they exist to do.
    for (const file of ['014-fleet-summary-indexes.js', '016-lifetime-report-indexes.js']) {
      const code = stripComments(fs.readFileSync(path.join(dir, file), 'utf8'));
      assert.match(code, /await analyze\(\)/, `${file} no longer collects statistics`);
      assert.match(code, /async up\(\{[^}]*\banalyze\b/, `${file} does not receive analyze()`);
    }
  });
});
