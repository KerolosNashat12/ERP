/**
 * A WEEKLY REPEAT, END TO END — and the monthly one it must not disturb.
 *
 * The arithmetic is proved next door in `recurring-frequency.test.js`. What is
 * proved here is that the arithmetic is what the shop actually gets: the
 * column exists after the migration, the API accepts and stores the new
 * fields, the waiting list offers the right dates, confirming them writes real
 * costs, and running it twice writes nothing the second time.
 *
 * Two of these matter more than the rest:
 *
 *   · **A template saved as weekly and then edited to monthly must not keep
 *     its weekday.** A leftover value in a column nothing reads is harmless
 *     until the day something reads it, which is how a "monthly" rent starts
 *     arriving on Tuesdays.
 *   · **A monthly template that predates all of this is untouched.** One is
 *     inserted with a raw INSERT naming only the columns that existed before
 *     migration 030 — which is exactly the shape of every row in his live
 *     database — and its months, its dates and its already-posted entries must
 *     come out the other side identical.
 *
 * Both drivers, as everything that touches a database here does.
 */
import './single-shop.js'; // must be first — see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'recurring-frequency-http-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.MM_DB_FILE = path.join(dir, 'unused-default.db');

const { createApp } = await import('../src/server.js');
const {
  openConnection, runWithTenant, getDb, closeDb,
} = await import('../src/infrastructure/database/connection.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');

const DRIVERS = [
  { name: 'sqlite', descriptor: (file) => ({ driver: 'sqlite', file }) },
  { name: 'libsql', descriptor: (file) => ({ driver: 'libsql', url: `file:${file}` }) },
];

let base = '';
let server = null;
let cookie = '';
let active = null;
const app = createApp();
const scoped = (fn) => runWithTenant(null, active, fn);

async function call(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      'Idempotency-Key': `t-${Math.random().toString(36).slice(2)}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

const one = (sql, ...params) => scoped(() => getDb().prepare(sql).get(...params));
const many = (sql, ...params) => scoped(() => getDb().prepare(sql).all(...params));

test('repeating costs repeat at the frequency they were given', async (t) => {
  /*
   * Every request runs inside `scoped`, exactly as the harness next door does.
   * On a single-shop build `getDb()` falls back to the PROCESS default, which
   * these tests never open — so an app served directly by `app.listen` answers
   * "no such table: users" on the very first sign-in. Wrapping the server is
   * what points the whole request at the driver connection under test.
   */
  server = await new Promise((resolve) => {
    const listening = http.createServer((req, res) => scoped(() => app(req, res)))
      .listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeDb();
  });

  for (const driver of DRIVERS) {
    await t.test(driver.name, async (dt) => {
      const connection = await openConnection(driver.descriptor(path.join(dir, `${driver.name}.db`)));
      await connection.applySchema();
      active = connection;
      cookie = '';
      await runWithTenant(null, connection, async () => {
        await runMigrations();
        await seedBaseline();
      });
      dt.after(() => connection.close());

      const login = await call('/api/auth/login', {
        method: 'POST', body: { username: 'admin', password: 'admin123' },
      });
      assert.equal(login.status, 200, `the fixture must be able to sign in: ${JSON.stringify(login.data)}`);

      const category = await one("SELECT id FROM cost_categories WHERE code = 'ELECTRICITY'");
      const rent = await one("SELECT id FROM cost_categories WHERE code = 'RENT'");

      await dt.test('the migration gave the table its three new columns', async () => {
        const columns = (await many('PRAGMA table_info(recurring_costs)')).map((c) => c.name);
        for (const name of ['frequency', 'day_of_week', 'month_of_year']) {
          assert.ok(columns.includes(name), `recurring_costs has no ${name}`);
        }
      });

      let weeklyId = null;

      await dt.test('a weekly template is accepted and stored as weekly', async () => {
        // 2026-03-04 is a Wednesday; 5 is Friday.
        const made = await call('/api/costs/recurring', {
          method: 'POST',
          body: {
            category_id: category.id,
            amount: 300,
            frequency: 'weekly',
            day_of_week: 5,
            starts_on: '2026-03-04',
            description: 'Cleaner',
          },
        });
        assert.equal(made.status, 201, JSON.stringify(made.data));
        weeklyId = made.data.id;
        const row = await one('SELECT * FROM recurring_costs WHERE id = ?', weeklyId);
        assert.equal(row.frequency, 'weekly');
        assert.equal(row.day_of_week, 5);
        assert.equal(row.month_of_year, null, 'a weekly template must not carry a month');
      });

      await dt.test('and it owes one entry per Friday, not per month', async () => {
        const due = await call('/api/costs/recurring/due?asOf=2026-03-25');
        const mine = due.data.rows.filter((r) => r.recurring_id === weeklyId);
        assert.deepEqual(mine.map((r) => r.due_on), ['2026-03-06', '2026-03-13', '2026-03-20']);
        assert.deepEqual(mine.map((r) => r.period_key), ['2026-03-06', '2026-03-13', '2026-03-20']);
      });

      await dt.test('confirming them writes real costs, and twice writes none', async () => {
        const first = await call('/api/costs/recurring/generate', {
          method: 'POST', body: { asOf: '2026-03-25' },
        });
        assert.equal(first.status, 200, JSON.stringify(first.data));
        const posted = await many(
          'SELECT spent_on, period_key, amount FROM costs WHERE recurring_id = ? ORDER BY spent_on',
          weeklyId,
        );
        assert.deepEqual(posted.map((r) => r.spent_on), ['2026-03-06', '2026-03-13', '2026-03-20']);
        assert.deepEqual(posted.map((r) => r.amount), [300, 300, 300]);

        const again = await call('/api/costs/recurring/generate', {
          method: 'POST', body: { asOf: '2026-03-25' },
        });
        assert.equal(again.status, 200);
        const after = await many('SELECT id FROM costs WHERE recurring_id = ?', weeklyId);
        assert.equal(after.length, 3, 'generating twice made a second set of entries');
      });

      await dt.test('editing it to monthly DROPS the weekday it no longer uses', async () => {
        const saved = await call(`/api/costs/recurring/${weeklyId}`, {
          method: 'PUT',
          body: {
            category_id: category.id,
            amount: 300,
            frequency: 'monthly',
            day_of_month: 9,
            starts_on: '2026-03-04',
            // Deliberately still sending it, the way a form that merely hid
            // the field would. The server is what must refuse to keep it.
            day_of_week: 5,
          },
        });
        assert.equal(saved.status, 200, JSON.stringify(saved.data));
        const row = await one('SELECT * FROM recurring_costs WHERE id = ?', weeklyId);
        assert.equal(row.frequency, 'monthly');
        assert.equal(row.day_of_week, null, 'a monthly template kept a weekday');
        assert.equal(row.day_of_month, 9);
      });

      await dt.test('a yearly template keeps a month and no weekday', async () => {
        const made = await call('/api/costs/recurring', {
          method: 'POST',
          body: {
            category_id: category.id,
            amount: 9000,
            frequency: 'yearly',
            month_of_year: 3,
            day_of_month: 10,
            starts_on: '2025-03-10',
            description: 'Licence',
          },
        });
        assert.equal(made.status, 201, JSON.stringify(made.data));
        const row = await one('SELECT * FROM recurring_costs WHERE id = ?', made.data.id);
        assert.equal(row.month_of_year, 3);
        assert.equal(row.day_of_week, null);

        const due = await call('/api/costs/recurring/due?asOf=2026-06-01');
        const mine = due.data.rows.filter((r) => r.recurring_id === made.data.id);
        assert.deepEqual(mine.map((r) => r.period_key), ['2025', '2026']);
      });

      await dt.test('a frequency nobody has heard of is refused, not stored', async () => {
        const bad = await call('/api/costs/recurring', {
          method: 'POST',
          body: {
            category_id: category.id, amount: 100, frequency: 'fortnightly', starts_on: '2026-03-01',
          },
        });
        assert.equal(bad.status, 422, JSON.stringify(bad.data));
        assert.ok(
          !(await one("SELECT id FROM recurring_costs WHERE frequency = 'fortnightly'")),
          'a frequency the engine cannot step reached the table',
        );
      });

      // ------------------------------------------------ the row he already has

      await dt.test('A TEMPLATE FROM BEFORE ALL OF THIS IS UNTOUCHED', async () => {
        /*
         * Written the way it exists in his live database: only the columns
         * that existed before migration 030, so `frequency` comes from the
         * DEFAULT and the two new ones are NULL. If any of this had changed
         * its behaviour, a shop would open the costs page and be offered every
         * month it has ever posted, all over again.
         */
        await scoped(() => getDb().prepare(`
          INSERT INTO recurring_costs
            (id, category_id, warehouse_id, description, amount, payment_method,
             day_of_month, starts_on, ends_on, is_active)
          VALUES (900, ?, 1, 'Shop rent', 4000, 'cash', 5, '2026-01-05', NULL, 1)
        `).run(rent.id));

        const stored = await one('SELECT * FROM recurring_costs WHERE id = 900');
        assert.equal(stored.frequency, 'monthly', 'the default did not carry it to monthly');
        assert.equal(stored.day_of_week, null);

        const due = await call('/api/costs/recurring/due?asOf=2026-03-20');
        const mine = due.data.rows.filter((r) => r.recurring_id === 900);
        assert.deepEqual(mine.map((r) => r.period_key), ['2026-01', '2026-02', '2026-03']);
        assert.deepEqual(mine.map((r) => r.due_on), ['2026-01-05', '2026-02-05', '2026-03-05']);

        // And a month it has ALREADY posted is still recognised as posted —
        // the single claim the whole `YYYY-MM` decision rests on.
        const posted = await call(`/api/costs/recurring/900/post`, {
          method: 'POST', body: { period_key: '2026-01' },
        });
        assert.equal(posted.status, 201, JSON.stringify(posted.data));
        const second = await call('/api/costs/recurring/due?asOf=2026-03-20');
        assert.deepEqual(
          second.data.rows.filter((r) => r.recurring_id === 900).map((r) => r.period_key),
          ['2026-02', '2026-03'],
          'a month that was just posted is being offered again',
        );
      });
    });
  }
});
