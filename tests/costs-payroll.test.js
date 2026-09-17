/**
 * صفحة التكاليف and the payroll — what would go wrong if the design were wrong.
 *
 * Five things are checked here, and each one is a specific way this feature
 * could be quietly broken for a year:
 *
 *   · **One entry per month, and not two.** A repeating cost that produces the
 *     same month twice is a shop paying rent twice on paper. Generation is run
 *     twice, then a duplicate is attempted straight against the database with
 *     the service bypassed entirely — because the guarantee is supposed to be a
 *     unique index, not a `if (already) return`, and only the raw insert can
 *     tell the two apart.
 *   · **Profit actually falls.** The report is run, a cost is added, the report
 *     is run again, and net profit must have moved by exactly the amount spent
 *     and gross profit must NOT have moved at all. Both halves matter: the
 *     second is what proves the old number kept its old meaning.
 *   · **A salary payment is counted once.** It is written through the payroll
 *     route and then looked for in the costs total, the costs list, and the
 *     salaries report — one row, one amount, in all three.
 *   · **Day, week and month arithmetic.** Pure, and including the two cases
 *     that are wrong in most implementations: a week is seven days inclusive,
 *     and a month starting on the 31st does not roll into the month after next.
 *   · **A photograph of the bill** goes through the one attachment mechanism,
 *     and comes back as a preview in the list rather than the full picture.
 *
 * A later round added attendance: a work-day schedule per employee, absence,
 * lateness and overtime worked out from it at payment time, and the paperwork
 * (بطاقة، فيش جنائي، شهادة جامعية…) each with its own photograph. Checked
 * separately, further down:
 *
 *   · **The day rate is the actual calendar month's, not a flat "salary ÷ 30".**
 *     Absence, lateness and overtime all derive from it, and the arithmetic is
 *     the owner's own formulas, to the piastre.
 *   · **No schedule, no adjustment.** An employee nobody configured a work-day
 *     pattern for gets a clear refusal, never a guessed number.
 *   · **Deductions cannot take a payment to zero or below** — `costs.amount`
 *     cannot be zero, and the service refuses before the database would.
 *   · **Closing an employee sets `is_active` too**, so every existing "active
 *     employees only" query keeps meaning what it always meant.
 *   · **A document's photograph** goes through the same one attachment
 *     mechanism a cost's bill does, under its own owner type.
 *
 * Everything that touches a database runs twice, once per driver: `node:sqlite`
 * is the shop counter, libSQL against a local file is the same client,
 * statement encoding and row decoding a hosted Turso deployment uses. The
 * harness is the one `supplier-payments.test.js` established next door.
 */
import './single-shop.js'; // must be first — see that file
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'costs-payroll-test');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.MM_DB_FILE = path.join(dir, 'unused-default.db');

const { createApp } = await import('../src/server.js');
const {
  openConnection, runWithTenant, getDb, transaction, closeDb,
} = await import('../src/infrastructure/database/connection.js');
const { seedBaseline } = await import('../src/infrastructure/database/seed.js');
const { runMigrations } = await import('../src/infrastructure/database/migrations/index.js');
const payroll = await import('../src/shared/payroll.js');
const { dueOccurrences, occurrenceDate } = await import('../src/shared/costs.js');

const DRIVERS = [
  { name: 'sqlite', descriptor: (file) => ({ driver: 'sqlite', file }) },
  { name: 'libsql', descriptor: (file) => ({ driver: 'libsql', url: `file:${file}` }) },
];

let active = null;
let base = '';
let server = null;
let cookie = '';
const app = createApp();
const scoped = (fn) => runWithTenant(null, active, fn);

async function call(pathname, { method = 'GET', body, key, headers = {} } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      // A key per call unless one is named: without it the idempotency guard
      // fingerprints identical POSTs, and two deliberate costs of the same
      // amount on the same day are a real thing a shop does.
      'Idempotency-Key': key || `t-${Math.random().toString(36).slice(2)}`,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

const query = (sql, ...params) => scoped(() => getDb().prepare(sql).get(...params));
const rows = (sql, ...params) => scoped(() => getDb().prepare(sql).all(...params));

/**
 * A completed sale, inserted directly.
 *
 * The point of this fixture is a known gross profit, not the POS: 5000 of
 * revenue against 2000 of cost is 3000 of goods margin, exactly, with no
 * rounding and no stock to move. What the profit report does with that number
 * once costs exist is the thing under test.
 */
async function seed(connection) {
  await runWithTenant(null, connection, async () => {
    await runMigrations();
    await seedBaseline();
    await transaction(async () => {
      const db = getDb();
      await db.prepare(`
        INSERT INTO sales (id, invoice_no, sale_date, warehouse_id, status, subtotal,
                           discount_amount, tax_amount, total_amount, total_cost,
                           paid_amount, payment_method, created_by)
        VALUES (1, 'INV-1', '2026-03-10', 1, 'completed', 5000, 0, 0, 5000, 2000, 5000, 'cash', 1)
      `).run();
    });
  });
}

const categoryId = async (code) => (await query('SELECT id FROM cost_categories WHERE code = ?', code)).id;

/** A real JPEG of a given weight — see supplier-payments.test.js for why. */
function jpegOfBytes(bytes) {
  const head = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x40,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
  const tail = Buffer.from([0xff, 0xd9]);
  const padding = Math.max(0, bytes - head.length - tail.length - 4);
  const comment = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from([((padding + 2) >> 8) & 0xff, (padding + 2) & 0xff]),
    Buffer.alloc(padding, 0x20),
  ]);
  return Buffer.concat([head, comment, tail]);
}
const asDataUrl = (buffer) => `data:image/jpeg;base64,${buffer.toString('base64')}`;
const photo = (bytes = 40 * 1024) => ({
  dataUrl: asDataUrl(jpegOfBytes(bytes)),
  thumbDataUrl: asDataUrl(jpegOfBytes(2 * 1024)),
});

// =============================================================== pure arithmetic

/**
 * No database, no HTTP. These are the two files everything else here rests on,
 * and both of them are the kind of code that is wrong in a way nobody notices
 * until a payslip is short.
 */
test('salary periods: day, week and month', async (t) => {
  await t.test('a day is that day', () => {
    assert.equal(payroll.periodEnd('2026-03-09', 'day'), '2026-03-09');
    assert.equal(payroll.nextPeriodStart('2026-03-09', 'day'), '2026-03-10');
  });

  await t.test('a week is seven days INCLUSIVE, not eight', () => {
    // Sunday to Saturday is one week. Adding seven days to the start would
    // make the next period begin on the eighth day and pay one day twice a
    // fortnight — the classic off-by-one in this exact place.
    assert.equal(payroll.periodEnd('2026-03-01', 'week'), '2026-03-07');
    assert.equal(payroll.nextPeriodStart('2026-03-01', 'week'), '2026-03-08');
  });

  await t.test('a month is a calendar month, clamped at the end', () => {
    assert.equal(payroll.periodEnd('2026-03-01', 'month'), '2026-03-31');
    assert.equal(payroll.periodEnd('2026-01-15', 'month'), '2026-02-14');
    // 31 January + 1 month is 28 February, not 3 March. Rolling over is how a
    // monthly salary gets paid thirteen times in a year.
    assert.equal(payroll.addMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(payroll.periodEnd('2026-01-31', 'month'), '2026-02-27');
    // And a leap year is a leap year.
    assert.equal(payroll.addMonths('2028-01-31', 1), '2028-02-29');
  });

  await t.test('only COMPLETE periods count as owed', () => {
    // A man on a monthly salary who started on the 1st is owed nothing on the
    // 20th — not two thirds of a salary.
    assert.equal(payroll.completePeriods('2026-03-01', '2026-03-20', 'month'), 0);
    assert.equal(payroll.completePeriods('2026-03-01', '2026-03-31', 'month'), 1);
    assert.equal(payroll.completePeriods('2026-01-01', '2026-03-15', 'month'), 2);
    assert.equal(payroll.completePeriods('2026-03-01', '2026-03-21', 'week'), 3);
    assert.equal(payroll.completePeriods('2026-03-01', '2026-03-20', 'week'), 2);
    assert.equal(payroll.completePeriods('2026-03-01', '2026-03-05', 'day'), 5);
  });

  await t.test('the period offered next follows the last one paid for', () => {
    assert.deepEqual(
      payroll.nextUnpaidPeriod({ period: 'month', lastPaidEnd: '2026-02-28', today: '2026-03-20' }),
      { start: '2026-03-01', end: '2026-03-31' },
    );
    // Nobody paid yet: it starts the day they were hired.
    assert.deepEqual(
      payroll.nextUnpaidPeriod({ period: 'week', hiredOn: '2026-03-02', today: '2026-03-20' }),
      { start: '2026-03-02', end: '2026-03-08' },
    );
  });
});

test('a monthly template knows which months it owes', async (t) => {
  const template = {
    id: 1, is_active: 1, starts_on: '2026-01-05', ends_on: null, day_of_month: 5, amount: 4000,
  };

  await t.test('six weeks away leaves every missed month waiting, none of them posted', () => {
    const due = dueOccurrences(template, { asOf: '2026-03-20' });
    assert.deepEqual(due.map((row) => row.period_key), ['2026-01', '2026-02', '2026-03']);
    assert.deepEqual(due.map((row) => row.due_on), ['2026-01-05', '2026-02-05', '2026-03-05']);
  });

  await t.test('a month already posted is not offered again', () => {
    const due = dueOccurrences(template, { asOf: '2026-03-20', posted: ['2026-01', '2026-02'] });
    assert.deepEqual(due.map((row) => row.period_key), ['2026-03']);
  });

  await t.test('a stopped template owes nothing at all', () => {
    assert.deepEqual(dueOccurrences({ ...template, is_active: 0 }, { asOf: '2026-03-20' }), []);
  });

  await t.test('a day the month does not have falls on its last day', () => {
    assert.equal(occurrenceDate('2026-02', 31), '2026-02-28');
    assert.equal(occurrenceDate('2028-02', 31), '2028-02-29');
    assert.equal(occurrenceDate('2026-04', 31), '2026-04-30');
  });

  await t.test('an end date closes it, and a start date is not back-dated', () => {
    const bounded = { ...template, starts_on: '2026-01-20', ends_on: '2026-02-28' };
    // The January occurrence (5 Jan) is before the template starts, so it is
    // not owed; March is after it ends.
    assert.deepEqual(
      dueOccurrences(bounded, { asOf: '2026-03-20' }).map((row) => row.period_key),
      ['2026-02'],
    );
  });
});

// ================================================================== over HTTP

test('costs come off profit, repeat without duplicating, and carry a photograph', async (t) => {
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
      await seed(connection);
      dt.after(() => connection.close());

      const login = await call('/api/auth/login', {
        method: 'POST', body: { username: 'admin', password: 'admin123' },
      });
      assert.equal(login.status, 200, 'the fixture must be able to sign in');

      const rent = await categoryId('RENT');
      const electricity = await categoryId('ELECTRICITY');

      // ------------------------------------------------ categories are seeded

      await dt.test('the categories are seeded bilingual and extendable', async () => {
        const listed = await call('/api/cost-categories?all=1');
        assert.equal(listed.status, 200, JSON.stringify(listed.data));
        const codes = listed.data.rows.map((row) => row.code);
        for (const code of ['RENT', 'ELECTRICITY', 'WATER', 'TAXES', 'SALARIES', 'EQUIPMENT', 'MAINTENANCE']) {
          assert.ok(codes.includes(code), `${code} should be seeded`);
        }
        for (const row of listed.data.rows) {
          assert.ok(row.name_en, `${row.code} has no English name`);
          assert.ok(row.name_ar, `${row.code} has no Arabic name`);
        }

        // And he can add his own — the list is rows, not a constant.
        const added = await call('/api/cost-categories', {
          method: 'POST',
          body: { name_en: 'Security guard', name_ar: 'أمن', display_order: 200, is_active: true },
        });
        assert.equal(added.status, 201, JSON.stringify(added.data));
        assert.ok(added.data.code, 'a code is generated when none is given');
      });

      await dt.test('the salaries category cannot be removed — payroll needs it', async () => {
        const salaries = await categoryId('SALARIES');
        const refused = await call(`/api/cost-categories/${salaries}`, { method: 'DELETE' });
        // A BusinessRuleError — 400, the way every other refusal in this system
        // answers. See shared/errors.js.
        assert.equal(refused.status, 400, JSON.stringify(refused.data));
      });

      // -------------------------------------------------- profit actually moves

      /**
       * The one the owner's decision rests on.
       *
       * Gross profit must NOT move — it is goods margin and it means what it
       * always meant — and net profit must fall by exactly what was spent, to
       * the piastre. "Roughly" would let a rounding bug through, which is the
       * kind that shows up as a shop's books being eleven pounds out in March.
       */
      await dt.test('adding a cost moves net profit by exactly that amount, and leaves gross profit alone', async () => {
        const url = '/api/reports/profit_and_costs?dateFrom=2026-03-01&dateTo=2026-03-31';
        const before = (await call(url)).data.summary;
        assert.equal(before.revenue, 5000);
        assert.equal(before.gross_profit, 3000, 'the fixture sale is 5000 against 2000 of goods');
        assert.equal(before.net_profit, 3000, 'nothing has been spent yet');

        const added = await call('/api/costs', {
          method: 'POST',
          body: {
            category_id: rent, amount: 1234.56, spent_on: '2026-03-15', description: 'March rent',
          },
        });
        assert.equal(added.status, 201, JSON.stringify(added.data));

        const after = (await call(url)).data.summary;
        assert.equal(after.gross_profit, before.gross_profit, 'goods margin must not have moved');
        assert.equal(after.costs, 1234.56);
        assert.equal(after.net_profit, 1765.44, '3000 − 1234.56, exactly');
      });

      await dt.test('the old report still means what it meant, and says so', async () => {
        const summary = await call('/api/reports/sales_summary?dateFrom=2026-03-01&dateTo=2026-03-31');
        // The figure is untouched by the cost above; only its NAME moved, from
        // `profit` to `gross_profit`, so a tile cannot read "Profit" beside a
        // net profit that means something else.
        assert.equal(summary.data.summary.gross_profit, 3000, 'unchanged by the cost above');
        assert.equal(summary.data.summary.profit, undefined);
        // The column is renamed and the report carries a note in both
        // languages: this is how a reader of the old report finds out that the
        // word now has a second meaning elsewhere.
        const profitColumn = summary.data.columns.find((column) => column.key === 'profit');
        assert.match(profitColumn.labelEn, /before costs/i);
        assert.ok(profitColumn.labelAr.includes('قبل التكاليف'));
        assert.match(summary.data.noteEn, /does not include/i);
        assert.ok(summary.data.noteAr && summary.data.noteAr.length > 20, 'the note is in Arabic too');
      });

      await dt.test('money is rounded on the server, never taken from the browser', async () => {
        const added = await call('/api/costs', {
          method: 'POST',
          body: { category_id: electricity, amount: 100.005, spent_on: '2026-03-16' },
        });
        assert.equal(added.status, 201, JSON.stringify(added.data));
        assert.equal(added.data.amount, 100.01);
        const stored = await query('SELECT amount FROM costs WHERE id = ?', added.data.id);
        assert.equal(stored.amount, 100.01);
      });

      await dt.test('a cost belongs to a branch, and defaults to the one shop location', async () => {
        const listed = await call('/api/costs?dateFrom=2026-03-01&dateTo=2026-03-31');
        const location = await query("SELECT id, name_en FROM warehouses WHERE code = 'MAIN'");
        for (const row of listed.data.rows) {
          assert.equal(row.warehouse_id, location.id);
          assert.equal(row.branch_name_en, location.name_en);
        }
        const summary = await call('/api/costs/summary?dateFrom=2026-03-01&dateTo=2026-03-31');
        assert.equal(summary.data.byBranch.length, 1);
        assert.equal(summary.data.byBranch[0].warehouse_id, location.id);
      });

      // ----------------------------------------- one entry per month, and one only

      await dt.test('a repeating cost produces exactly one entry per month, and generating twice adds nothing', async () => {
        const template = await call('/api/costs/recurring', {
          method: 'POST',
          body: {
            category_id: rent, amount: 4000, day_of_month: 5,
            starts_on: '2026-01-05', description: 'Shop rent',
          },
        });
        assert.equal(template.status, 201, JSON.stringify(template.data));
        const templateId = template.data.id;

        // Nothing has been written yet: a template is not a cost.
        const posted = await query(
          'SELECT COUNT(*) AS n FROM costs WHERE recurring_id = ?', templateId,
        );
        assert.equal(posted.n, 0, 'a template must not post anything by itself');

        // Six weeks away: January, February and March are all waiting.
        const due = await call('/api/costs/recurring/due?asOf=2026-03-20');
        assert.deepEqual(due.data.rows.map((row) => row.period_key), ['2026-01', '2026-02', '2026-03']);

        const first = await call('/api/costs/recurring/generate', {
          method: 'POST', body: { asOf: '2026-03-20' },
        });
        assert.equal(first.data.posted, 3);

        const second = await call('/api/costs/recurring/generate', {
          method: 'POST', body: { asOf: '2026-03-20' },
        });
        assert.equal(second.data.posted, 0, 'the second run must post nothing');

        const months = await rows(
          'SELECT period_key, amount FROM costs WHERE recurring_id = ? ORDER BY period_key',
          templateId,
        );
        assert.deepEqual(months.map((row) => row.period_key), ['2026-01', '2026-02', '2026-03']);
        assert.deepEqual(months.map((row) => row.amount), [4000, 4000, 4000]);
      });

      /**
       * The guarantee has to be the DATABASE's, not the loop's.
       *
       * `generate()` reads what is due and skips what is posted, and that alone
       * would still lose to two requests overlapping — both read "January is
       * due" before either writes. So the real defence is a unique index, and
       * the only way to test it is to go around the service entirely and try
       * the insert the racing request would have made.
       */
      await dt.test('the database itself refuses a second entry for the same month', async () => {
        const template = await query(
          "SELECT id FROM recurring_costs WHERE description = 'Shop rent'",
        );
        await assert.rejects(
          () => scoped(() => getDb().prepare(`
            INSERT INTO costs (category_id, warehouse_id, spent_on, amount, source, recurring_id, period_key)
            VALUES (?, 1, '2026-01-05', 4000, 'recurring', ?, '2026-01')
          `).run(rent, template.id)),
          /UNIQUE constraint failed/i,
          'a second row for a month the template already produced must be impossible',
        );
      });

      await dt.test('one month can be confirmed on its own, with the amount corrected', async () => {
        const template = await call('/api/costs/recurring', {
          method: 'POST',
          body: {
            category_id: electricity, amount: 900, day_of_month: 10,
            starts_on: '2026-02-10', description: 'Electricity',
          },
        });
        const posted = await call(`/api/costs/recurring/${template.data.id}/post`, {
          method: 'POST',
          // The bill was not what the template guessed. That is the normal case.
          body: { period_key: '2026-02', amount: 1150.25 },
        });
        assert.equal(posted.status, 201, JSON.stringify(posted.data));
        assert.equal(posted.data.amount, 1150.25);
        assert.equal(posted.data.source, 'recurring');

        // And the template still says 900 — correcting one month is not editing
        // the arrangement.
        const unchanged = await query('SELECT amount FROM recurring_costs WHERE id = ?', template.data.id);
        assert.equal(unchanged.amount, 900);

        const again = await call(`/api/costs/recurring/${template.data.id}/post`, {
          method: 'POST', body: { period_key: '2026-02' },
        });
        assert.equal(again.status, 400, 'that month has been confirmed already');
      });

      await dt.test('stopping one stops the future and keeps the past', async () => {
        const template = await query("SELECT id FROM recurring_costs WHERE description = 'Electricity'");
        const before = await query(
          'SELECT COUNT(*) AS n FROM costs WHERE recurring_id = ?', template.id,
        );
        const stopped = await call(`/api/costs/recurring/${template.id}/stop`, { method: 'POST' });
        assert.equal(stopped.status, 200);
        assert.equal(stopped.data.is_active, 0);

        const due = await call('/api/costs/recurring/due?asOf=2027-06-01');
        assert.ok(
          !due.data.rows.some((row) => row.recurring_id === template.id),
          'a stopped template must never be offered again',
        );

        const after = await query('SELECT COUNT(*) AS n FROM costs WHERE recurring_id = ?', template.id);
        assert.equal(after.n, before.n, 'the entries it already made are real costs and stay');
      });

      // -------------------------------------------------- a photograph of the bill

      await dt.test('a cost carries a photograph, through the one attachment mechanism', async () => {
        const added = await call('/api/costs', {
          method: 'POST',
          body: {
            category_id: electricity,
            amount: 480,
            spent_on: '2026-03-18',
            description: 'March electricity',
            photo: photo(60 * 1024),
          },
        });
        assert.equal(added.status, 201, JSON.stringify(added.data));
        assert.equal(added.data.attachments.length, 1);

        const owner = await query(
          'SELECT owner_type, byte_size, thumb_byte_size FROM attachments WHERE owner_id = ? AND owner_type = ?',
          added.data.id, 'cost',
        );
        assert.equal(owner.owner_type, 'cost', 'costs register their own owner type, not a second table');
        assert.ok(owner.thumb_byte_size > 0 && owner.thumb_byte_size < owner.byte_size);

        // The list serves the preview, not the photograph: a costs page with
        // twenty bills on it must not pull twenty phone photographs.
        const listed = await call('/api/costs?dateFrom=2026-03-01&dateTo=2026-03-31');
        const row = listed.data.rows.find((entry) => entry.id === added.data.id);
        assert.equal(row.attachments.length, 1);
        assert.equal(row.attachments[0].data, undefined, 'no bytes in a list');

        const thumb = await fetch(
          `${base}/api/attachments/${added.data.attachments[0].id}/raw?size=thumb`,
          { headers: { cookie } },
        );
        assert.equal(thumb.status, 200);
        assert.ok(Number(thumb.headers.get('content-length')) < owner.byte_size);

        // Deleting the cost takes the bytes with it — nothing cascades on its
        // own, because `owner_id` carries no foreign key.
        await call(`/api/costs/${added.data.id}`, { method: 'DELETE' });
        const orphan = await query(
          'SELECT COUNT(*) AS n FROM attachments WHERE owner_type = ? AND owner_id = ?',
          'cost', added.data.id,
        );
        assert.equal(orphan.n, 0);
      });

      // ---------------------------------------------------------------- payroll

      await dt.test('an employee is not a user, and needs no login', async () => {
        const created = await call('/api/employees', {
          method: 'POST',
          body: {
            name: 'Mahmoud Sayed', job_title: 'Delivery', phone: '01000000001',
            salary_amount: 250, salary_period: 'week', hired_on: '2026-03-01', is_active: true,
          },
        });
        assert.equal(created.status, 201, JSON.stringify(created.data));
        assert.ok(created.data.code.startsWith('EMP-'));

        const asUser = await query('SELECT COUNT(*) AS n FROM users WHERE full_name = ?', 'Mahmoud Sayed');
        assert.equal(asUser.n, 0, 'nothing about paying somebody creates an account for them');
      });

      /**
       * The other decision the brief turned on: a salary payment lands in the
       * costs total exactly ONCE. It is checked from three directions, because
       * a mirrored second row would satisfy any one of them alone.
       */
      await dt.test('a salary payment appears in the costs total once, not twice', async () => {
        const employee = await query("SELECT id FROM employees WHERE name = 'Mahmoud Sayed'");
        const window = 'dateFrom=2026-04-01&dateTo=2026-04-30';
        const before = (await call(`/api/costs/summary?${window}`)).data;
        assert.equal(before.total, 0, 'April is empty before this test');

        const paid = await call(`/api/employees/${employee.id}/payments`, {
          method: 'POST',
          body: {
            amount: 250, paid_on: '2026-04-05',
            period_start: '2026-03-29', period_end: '2026-04-04',
            payment_method: 'cash', note: 'week 1',
          },
        });
        assert.equal(paid.status, 201, JSON.stringify(paid.data));

        // 1. One row in the ledger, and it is the payment itself.
        const ledger = await rows(
          "SELECT id, amount, source, employee_id FROM costs WHERE spent_on = '2026-04-05'",
        );
        assert.equal(ledger.length, 1, 'exactly one row — there is no mirror of it anywhere');
        assert.equal(ledger[0].amount, 250);
        assert.equal(ledger[0].source, 'salary');
        assert.equal(ledger[0].employee_id, employee.id);

        // 2. The costs total counts it once.
        const after = (await call(`/api/costs/summary?${window}`)).data;
        assert.equal(after.total, 250);
        assert.equal(after.entries, 1);

        // 3. It is filed under salaries, and both reports agree on the figure.
        const salaryCategory = await categoryId('SALARIES');
        assert.equal(after.byCategory.length, 1);
        assert.equal(after.byCategory[0].category_id, salaryCategory);

        const costsReport = await call(`/api/reports/costs_by_category?${window}`);
        assert.equal(costsReport.data.summary.costs, 250);
        const salariesReport = await call(`/api/reports/salaries_paid?${window}`);
        assert.equal(salariesReport.data.summary.paid, 250, 'the two reports read the same single row');

        // And it comes off profit the way rent does.
        const profit = await call(`/api/reports/profit_and_costs?${window}`);
        assert.equal(profit.data.summary.costs, 250);
        assert.equal(profit.data.summary.net_profit, -250);
      });

      await dt.test('the same payment is edited in one place, whichever screen opened it', async () => {
        const row = await query("SELECT id FROM costs WHERE spent_on = '2026-04-05'");
        // Opened from the costs page — the same record, and it stays a salary
        // payment against the same person.
        const edited = await call(`/api/costs/${row.id}`, {
          method: 'PUT',
          body: { amount: 260, description: 'week 1 (corrected)' },
        });
        assert.equal(edited.status, 200, JSON.stringify(edited.data));
        assert.equal(edited.data.amount, 260);
        assert.ok(edited.data.employee_id, 'it is still that employee\'s payment');

        // And the employee's own history shows the corrected figure, because it
        // is reading the row that was just edited.
        const history = await call(`/api/employees/${edited.data.employee_id}/payments`);
        assert.equal(history.data.paid_total, 260);
        assert.equal(history.data.rows.length, 1);
      });

      await dt.test('who is owed money, counted in complete periods only', async () => {
        const roster = await call('/api/employees/payroll?dateFrom=2026-04-01&dateTo=2026-04-30&asOf=2026-04-18');
        assert.equal(roster.status, 200, JSON.stringify(roster.data));
        const person = roster.data.rows.find((row) => row.name === 'Mahmoud Sayed');
        assert.equal(person.paid_up_to, '2026-04-04');
        assert.equal(person.paid_in_range, 260);
        // Paid to the 4th, asked on the 18th, paid weekly: two complete weeks
        // (5–11 and 12–18) are owed, and the part-week after them is not.
        assert.equal(person.owed_periods, 2);
        assert.equal(person.owed_amount, 500);
        assert.equal(person.owed_from, '2026-04-05');
        assert.equal(person.owed_to, '2026-04-18');
      });

      await dt.test('salaries are not offered as a repeating cost — they repeat per person', async () => {
        const salaryCategory = await categoryId('SALARIES');
        const refused = await call('/api/costs/recurring', {
          method: 'POST',
          body: {
            category_id: salaryCategory, amount: 1000, day_of_month: 1, starts_on: '2026-01-01',
          },
        });
        assert.equal(refused.status, 400, JSON.stringify(refused.data));
      });

      await dt.test('every write is in the audit trail', async () => {
        const entries = await rows(
          "SELECT action, entity_type FROM audit_logs WHERE module = 'costs' ORDER BY id",
        );
        const actions = new Set(entries.map((row) => `${row.action}:${row.entity_type}`));
        for (const expected of [
          'CREATE:cost', 'UPDATE:cost', 'DELETE:cost',
          'CREATE:recurring_cost', 'STOP:recurring_cost', 'ATTACH:attachment',
        ]) {
          assert.ok(actions.has(expected), `${expected} is missing from the audit trail`);
        }
      });

      // ---------------------------------------------------------- attendance

      await dt.test('a scheduled employee gets a day rate, an hourly rate and an overtime rate', async () => {
        const created = await call('/api/employees', {
          method: 'POST',
          body: {
            name: 'Aya Youssef', job_title: 'Cashier', phone: '01000000002',
            salary_amount: 6900, salary_period: 'month', hired_on: '2026-01-01', is_active: true,
            work_days: '4,0,2,1,3', daily_hours: 8,
            overtime_rate_type: 'multiplier', overtime_rate_value: 1.5,
          },
        });
        assert.equal(created.status, 201, JSON.stringify(created.data));
        // Stored canonically — sorted and deduplicated — however it was typed.
        assert.equal(created.data.work_days, '0,1,2,3,4');
        assert.equal(created.data.daily_hours, 8);
        assert.equal(created.data.overtime_rate_type, 'multiplier');
        assert.equal(created.data.overtime_rate_value, 1.5);

        const refused = await call('/api/employees', {
          method: 'POST',
          body: { name: 'Bad Schedule', salary_amount: 1000, salary_period: 'month', work_days: '7,9' },
        });
        assert.equal(refused.status, 422, JSON.stringify(refused.data));
      });

      await dt.test('absence, lateness and overtime are worked out from the day rate, at payment time', async () => {
        const employee = await query("SELECT id FROM employees WHERE name = 'Aya Youssef'");

        // March 2026 has 23 Sunday-to-Thursday days: 6900 ÷ 23 = 300 exactly,
        // and 300 ÷ 8 daily hours = 37.5 an hour — chosen so every figure below
        // is exact, not a rounding coincidence.
        const preview = await call(`/api/employees/${employee.id}/payments/preview`, {
          method: 'POST',
          body: {
            amount: 6900, period_start: '2026-03-01', period_end: '2026-03-31',
            absence_days: 2, late_hours: 4, overtime_hours: 3,
          },
        });
        assert.equal(preview.status, 200, JSON.stringify(preview.data));
        assert.equal(preview.data.day_rate, 300, '6900 ÷ 23 working days in March 2026');
        assert.equal(preview.data.hourly_rate, 37.5);
        assert.equal(preview.data.absence_deduction, 600, '2 days × the day rate');
        assert.equal(preview.data.late_deduction, 150, '4 hours ÷ 8 × the day rate');
        assert.equal(preview.data.overtime_pay, 168.75, '3 hours × (1.5 × the hourly rate)');
        assert.equal(preview.data.amount, 6318.75, '6900 − 600 − 150 + 168.75');
        assert.equal(preview.data.gross_amount, 6900);

        // Nothing was written by the preview.
        const before = await query(
          "SELECT COUNT(*) AS n FROM costs WHERE employee_id = ? AND period_start = '2026-03-01'", employee.id,
        );
        assert.equal(before.n, 0);

        const paid = await call(`/api/employees/${employee.id}/payments`, {
          method: 'POST',
          body: {
            amount: 6900, paid_on: '2026-04-01', period_start: '2026-03-01', period_end: '2026-03-31',
            absence_days: 2, late_hours: 4, overtime_hours: 3,
          },
        });
        assert.equal(paid.status, 201, JSON.stringify(paid.data));
        // The row itself carries the NET amount — every cost total in this
        // system is SUM(costs.amount), and it must sum to what was actually
        // handed over, not the figure before the deductions.
        assert.equal(paid.data.amount, 6318.75);
        assert.equal(paid.data.gross_amount, 6900);
        assert.equal(paid.data.absence_days, 2);
        assert.equal(paid.data.absence_deduction, 600);
        assert.equal(paid.data.late_hours, 4);
        assert.equal(paid.data.late_deduction, 150);
        assert.equal(paid.data.overtime_hours, 3);
        assert.equal(paid.data.overtime_pay, 168.75);

        const stored = await query(
          'SELECT amount, gross_amount, absence_deduction FROM costs WHERE id = ?', paid.data.id,
        );
        assert.equal(stored.amount, 6318.75);
        assert.equal(stored.gross_amount, 6900);
        assert.equal(stored.absence_deduction, 600);
      });

      await dt.test('the absence deduction can be entered by hand instead of computed', async () => {
        const employee = await query("SELECT id FROM employees WHERE name = 'Aya Youssef'");
        const paid = await call(`/api/employees/${employee.id}/payments`, {
          method: 'POST',
          body: {
            amount: 6900, paid_on: '2026-05-01', period_start: '2026-04-01', period_end: '2026-04-30',
            absence_deduction_amount: 500,
          },
        });
        assert.equal(paid.status, 201, JSON.stringify(paid.data));
        assert.equal(paid.data.amount, 6400, '6900 − 500, the amount typed in, not days × day rate');
        assert.equal(paid.data.absence_deduction, 500);
        assert.equal(paid.data.absence_days, null);
      });

      await dt.test('absence can be picked by the specific date, not just a count', async () => {
        const employee = await query("SELECT id FROM employees WHERE name = 'Aya Youssef'");

        // 2026-03-01 and 2026-03-08 are both Sundays — one of Aya's work days
        // (0,1,2,3,4) — so this is the same 2-day, 600 EGP deduction as the
        // count-only test above, just named by date instead of by number.
        const preview = await call(`/api/employees/${employee.id}/payments/preview`, {
          method: 'POST',
          body: {
            amount: 6900, period_start: '2026-03-01', period_end: '2026-03-31',
            absence_dates: ['2026-03-08', '2026-03-01', '2026-03-01'], // unsorted, with a repeat
          },
        });
        assert.equal(preview.status, 200, JSON.stringify(preview.data));
        assert.equal(preview.data.absence_days, 2, 'the count comes from the dates, deduplicated');
        assert.equal(preview.data.absence_deduction, 600);
        assert.equal(preview.data.amount, 6300);

        const paid = await call(`/api/employees/${employee.id}/payments`, {
          method: 'POST',
          body: {
            amount: 6900, paid_on: '2026-04-01', period_start: '2026-03-01', period_end: '2026-03-31',
            absence_dates: ['2026-03-08', '2026-03-01'],
          },
        });
        assert.equal(paid.status, 201, JSON.stringify(paid.data));
        assert.equal(paid.data.absence_days, 2);
        // Stored canonically — sorted, comma-joined — same idea as work_days.
        assert.equal(paid.data.absence_dates, '2026-03-01,2026-03-08');

        const stored = await query('SELECT absence_dates FROM costs WHERE id = ?', paid.data.id);
        assert.equal(stored.absence_dates, '2026-03-01,2026-03-08');
      });

      await dt.test('an absence date outside the period being paid is refused', async () => {
        const employee = await query("SELECT id FROM employees WHERE name = 'Aya Youssef'");
        // 2026-04-01 is a Wednesday (one of Aya's work days) but it falls
        // outside the March period below — the date, not the weekday, is wrong.
        const refused = await call(`/api/employees/${employee.id}/payments/preview`, {
          method: 'POST',
          body: {
            amount: 6900, period_start: '2026-03-01', period_end: '2026-03-31',
            absence_dates: ['2026-04-01'],
          },
        });
        assert.equal(refused.status, 422, JSON.stringify(refused.data));
      });

      await dt.test('an absence date that was never one of the employee’s work days is refused', async () => {
        const employee = await query("SELECT id FROM employees WHERE name = 'Aya Youssef'");
        // 2026-03-06 is a Friday — Aya works Sunday-Thursday (0,1,2,3,4), so
        // she was never scheduled to be there that day; nothing to deduct.
        const refused = await call(`/api/employees/${employee.id}/payments/preview`, {
          method: 'POST',
          body: {
            amount: 6900, period_start: '2026-03-01', period_end: '2026-03-31',
            absence_dates: ['2026-03-06'],
          },
        });
        assert.equal(refused.status, 422, JSON.stringify(refused.data));
      });

      await dt.test('absence dates take priority over a separately-sent day count', async () => {
        const employee = await query("SELECT id FROM employees WHERE name = 'Aya Youssef'");
        const preview = await call(`/api/employees/${employee.id}/payments/preview`, {
          method: 'POST',
          body: {
            amount: 6900, period_start: '2026-03-01', period_end: '2026-03-31',
            absence_days: 5, absence_dates: ['2026-03-01'],
          },
        });
        assert.equal(preview.status, 200, JSON.stringify(preview.data));
        assert.equal(preview.data.absence_days, 1, 'one date was sent, so the count is 1 — the stray absence_days: 5 is ignored');
        assert.equal(preview.data.absence_deduction, 300);
      });

      await dt.test('absence, lateness or overtime need a work schedule on the employee first', async () => {
        const employee = await query("SELECT id FROM employees WHERE name = 'Mahmoud Sayed'");
        const refused = await call(`/api/employees/${employee.id}/payments`, {
          method: 'POST',
          body: {
            amount: 250, paid_on: '2026-05-05', period_start: '2026-05-05', period_end: '2026-05-11',
            absence_days: 1,
          },
        });
        assert.equal(refused.status, 422, JSON.stringify(refused.data));
      });

      await dt.test('deductions that would take a payment to zero or below are refused', async () => {
        const employee = await query("SELECT id FROM employees WHERE name = 'Aya Youssef'");
        const refused = await call(`/api/employees/${employee.id}/payments`, {
          method: 'POST',
          body: {
            amount: 300, paid_on: '2026-06-01', period_start: '2026-05-01', period_end: '2026-05-31',
            absence_days: 5,
          },
        });
        assert.equal(refused.status, 422, JSON.stringify(refused.data));
        // Nothing was written by the refused attempt.
        const stored = await query(
          "SELECT COUNT(*) AS n FROM costs WHERE employee_id = ? AND spent_on = '2026-06-01'", employee.id,
        );
        assert.equal(stored.n, 0);
      });

      // ------------------------------------------------------------ documents

      await dt.test('employee documents carry their own photograph, through the one attachment mechanism', async () => {
        const employee = await query("SELECT id FROM employees WHERE name = 'Aya Youssef'");

        const idCard = await call(`/api/employees/${employee.id}/documents`, {
          method: 'POST',
          body: { doc_type: 'id_card', issued_on: '2020-01-01', photo: photo(50 * 1024) },
        });
        assert.equal(idCard.status, 201, JSON.stringify(idCard.data));

        const owner = await query(
          'SELECT owner_type FROM attachments WHERE owner_id = ? AND owner_type = ?',
          idCard.data.id, 'employee_document',
        );
        assert.equal(owner.owner_type, 'employee_document', 'a document registers its own owner type, not a second table');

        const refusedOther = await call(`/api/employees/${employee.id}/documents`, {
          method: 'POST',
          body: { doc_type: 'other' },
        });
        assert.equal(refusedOther.status, 422, 'a custom document needs a name to mean anything in a list');

        const other = await call(`/api/employees/${employee.id}/documents`, {
          method: 'POST',
          body: { doc_type: 'other', label: 'Gym membership' },
        });
        assert.equal(other.status, 201, JSON.stringify(other.data));

        const listed = await call(`/api/employees/${employee.id}/documents`);
        assert.equal(listed.status, 200, JSON.stringify(listed.data));
        const idCardRow = listed.data.rows.find((d) => d.id === idCard.data.id);
        assert.equal(idCardRow.attachments.length, 1);
        assert.equal(idCardRow.attachments[0].data, undefined, 'no bytes in a list, same rule as a cost');

        const renamed = await call(`/api/employees/${employee.id}/documents/${other.data.id}`, {
          method: 'PUT', body: { label: 'Gym membership (renewed)' },
        });
        assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
        assert.equal(renamed.data.label, 'Gym membership (renewed)');

        const removed = await call(`/api/employees/${employee.id}/documents/${other.data.id}`, { method: 'DELETE' });
        assert.equal(removed.status, 200, JSON.stringify(removed.data));
        const afterDelete = await call(`/api/employees/${employee.id}/documents`);
        assert.ok(!afterDelete.data.rows.some((d) => d.id === other.data.id));
      });

      await dt.test('a document past its expiry, or due soon, shows up in the renewal reminder', async () => {
        const employee = await query("SELECT id FROM employees WHERE name = 'Aya Youssef'");
        // Real wall-clock dates — the reminder reads date('now'), not any
        // fictional date the rest of this fixture uses.
        const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
        const past = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
        const farAway = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);

        const dueSoon = await call(`/api/employees/${employee.id}/documents`, {
          method: 'POST', body: { doc_type: 'criminal_record', issued_on: '2026-01-01', expires_on: soon },
        });
        const overdue = await call(`/api/employees/${employee.id}/documents`, {
          method: 'POST', body: { doc_type: 'medical_form', issued_on: '2025-01-01', expires_on: past },
        });
        const notYet = await call(`/api/employees/${employee.id}/documents`, {
          method: 'POST', body: { doc_type: 'degree', issued_on: '2020-01-01', expires_on: farAway },
        });
        assert.equal(dueSoon.status, 201, JSON.stringify(dueSoon.data));
        assert.equal(overdue.status, 201, JSON.stringify(overdue.data));
        assert.equal(notYet.status, 201, JSON.stringify(notYet.data));

        const reminder = await call('/api/employees/documents/expiring?withinDays=30');
        assert.equal(reminder.status, 200, JSON.stringify(reminder.data));
        const ids = reminder.data.rows.map((d) => d.id);
        assert.ok(ids.includes(dueSoon.data.id), 'due within 30 days must be in the reminder');
        assert.ok(ids.includes(overdue.data.id), 'already expired must be in the reminder too');
        assert.ok(!ids.includes(notYet.data.id), 'due over a year from now must not be in it');
      });

      await dt.test('a document cannot expire before it was issued', async () => {
        const employee = await query("SELECT id FROM employees WHERE name = 'Aya Youssef'");
        const refused = await call(`/api/employees/${employee.id}/documents`, {
          method: 'POST',
          body: { doc_type: 'medical_form', issued_on: '2026-06-01', expires_on: '2026-01-01' },
        });
        assert.equal(refused.status, 422, JSON.stringify(refused.data));
      });

      // -------------------------------------------------- open and close a person

      await dt.test('closing an employee sets is_active too, and reopening brings them back', async () => {
        const employee = await query("SELECT id FROM employees WHERE name = 'Aya Youssef'");

        const closed = await call(`/api/employees/${employee.id}`, {
          method: 'PUT', body: { left_on: '2026-07-01' },
        });
        assert.equal(closed.status, 200, JSON.stringify(closed.data));
        assert.equal(closed.data.left_on, '2026-07-01');
        assert.equal(closed.data.is_active, 0, 'closing turns off is_active too, not just left_on');

        const roster = await call('/api/employees/payroll?dateFrom=2026-07-01&dateTo=2026-07-31');
        const her = roster.data.rows.find((row) => row.id === employee.id);
        assert.equal(her.is_active, 0, 'every existing "active employees only" reading still works, unchanged');

        const reopened = await call(`/api/employees/${employee.id}`, {
          method: 'PUT', body: { left_on: null, is_active: true },
        });
        assert.equal(reopened.status, 200, JSON.stringify(reopened.data));
        assert.equal(reopened.data.is_active, 1);
        assert.equal(reopened.data.left_on, null);
      });

      await dt.test('an employee cannot have left before they were hired', async () => {
        const employee = await query("SELECT id FROM employees WHERE name = 'Aya Youssef'");
        const refused = await call(`/api/employees/${employee.id}`, {
          method: 'PUT', body: { left_on: '2025-01-01' },
        });
        assert.equal(refused.status, 422, JSON.stringify(refused.data));
      });

      await dt.test('the schedule, the documents and the lifecycle are all in the audit trail', async () => {
        const entries = await rows(
          "SELECT action, entity_type FROM audit_logs WHERE module = 'employees' ORDER BY id",
        );
        const actions = new Set(entries.map((row) => `${row.action}:${row.entity_type}`));
        for (const expected of [
          'CREATE:employee', 'UPDATE:employee',
          'CREATE:employee_document', 'UPDATE:employee_document', 'DELETE:employee_document',
        ]) {
          assert.ok(actions.has(expected), `${expected} is missing from the audit trail`);
        }
      });
    });
  }
});
