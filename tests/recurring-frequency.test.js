/**
 * A REPEATING COST REPEATS DAILY, WEEKLY, MONTHLY OR YEARLY.
 *
 * The owner asked for it looking at «إضافة تكلفة متكررة», which only ever
 * offered «يوم الشهر»: *"can you please enhance this function to be have a
 * type (Monthly - weekly - and so on)"*.
 *
 * Everything here is arithmetic on a template, which means it is exactly the
 * kind of thing that is wrong in most implementations in ways nobody notices
 * for a year. The cases that earn their place:
 *
 *   · **A monthly template must not change at all.** Its dates, and above all
 *     its `YYYY-MM` period keys, are what every entry every existing shop has
 *     already posted carries. If the key shape moved, every one of those
 *     entries would look unposted and the whole history would be offered
 *     again. That is the first test in the file for a reason.
 *   · **A weekly template lands on a weekday**, not on "every seven days from
 *     whenever it was created", and it starts TODAY when today is that day.
 *   · **A yearly template clamps like a monthly one**, so 29 February on a
 *     common year is 28 February rather than nothing.
 *   · **Catch-up is bounded per frequency**, and the oldest are offered first
 *     so nothing is ever lost — only queued behind what is already waiting.
 *   · **Two frequencies cannot mint the same key by accident**, because the
 *     key is the whole duplicate guard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  dueOccurrences, periodKeyFor, firstDueOn, nextDueOn, normalizeFrequency,
  FREQUENCIES, CATCH_UP, weekdayOf, monthOf, PERIOD_KEY_PATTERN,
} = await import('../src/shared/costs.js');

const keys = (rows) => rows.map((row) => row.period_key);
const dates = (rows) => rows.map((row) => row.due_on);

// ------------------------------------------------------------ the old behaviour

test('a monthly template is exactly what it was before frequencies existed', async (t) => {
  // No `frequency` field at all — this is a row as it exists in his live
  // database today, read back after migration 030 added a column it has never
  // been given a value for other than the default.
  const legacy = {
    id: 1, is_active: 1, starts_on: '2026-01-05', ends_on: null, day_of_month: 5, amount: 4000,
  };

  await t.test('a row with no frequency reads as monthly', () => {
    assert.equal(normalizeFrequency(legacy.frequency), 'monthly');
    assert.equal(normalizeFrequency(null), 'monthly');
    assert.equal(normalizeFrequency('nonsense'), 'monthly');
    assert.equal(normalizeFrequency('WEEKLY'), 'weekly');
  });

  await t.test('the months and dates it owes are unchanged', () => {
    const due = dueOccurrences(legacy, { asOf: '2026-03-20' });
    assert.deepEqual(keys(due), ['2026-01', '2026-02', '2026-03']);
    assert.deepEqual(dates(due), ['2026-01-05', '2026-02-05', '2026-03-05']);
  });

  await t.test('THE KEY SHAPE IS STILL YYYY-MM — every posted entry depends on it', () => {
    assert.equal(periodKeyFor('monthly', '2026-03-05'), '2026-03');
    assert.equal(periodKeyFor(undefined, '2026-03-05'), '2026-03');
    // The proof that matters: months this shop already posted are still
    // recognised as posted and are not offered a second time.
    const due = dueOccurrences(legacy, { asOf: '2026-03-20', posted: ['2026-01', '2026-02'] });
    assert.deepEqual(keys(due), ['2026-03']);
  });

  await t.test('the 31st still walks back to the end of a short month and returns', () => {
    const rent = { ...legacy, day_of_month: 31, starts_on: '2026-01-31' };
    assert.deepEqual(
      dates(dueOccurrences(rent, { asOf: '2026-04-30' })),
      ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'],
    );
    // And on the 15th of April the April one is not owed YET, because it
    // falls on the 30th — a date that has not happened is not a debt.
    assert.deepEqual(
      dates(dueOccurrences(rent, { asOf: '2026-04-15' })),
      ['2026-01-31', '2026-02-28', '2026-03-31'],
    );
  });
});

// ------------------------------------------------------------------ every day

test('a daily template', async (t) => {
  const petrol = {
    id: 2, is_active: 1, frequency: 'daily', starts_on: '2026-03-01',
    ends_on: null, day_of_month: 1, amount: 50,
  };

  await t.test('owes one entry per day, keyed by the day itself', () => {
    const due = dueOccurrences(petrol, { asOf: '2026-03-04' });
    assert.deepEqual(keys(due), ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04']);
    assert.deepEqual(keys(due), dates(due), 'for a daily repeat the date IS the occurrence');
  });

  await t.test('crosses a month end and a leap day without special-casing either', () => {
    const leap = { ...petrol, starts_on: '2028-02-27' };
    assert.deepEqual(
      dates(dueOccurrences(leap, { asOf: '2028-03-01' })),
      ['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01'],
    );
  });

  await t.test('ignores day_of_month entirely — a daily cost has no day of the month', () => {
    const odd = { ...petrol, day_of_month: 17 };
    assert.deepEqual(dates(dueOccurrences(odd, { asOf: '2026-03-02' })), ['2026-03-01', '2026-03-02']);
  });
});

// ----------------------------------------------------------------- every week

test('a weekly template lands on a weekday, not seven days from whenever', async (t) => {
  // 2026-03-04 is a Wednesday. day_of_week 0 is Sunday, 5 is Friday.
  const cleaner = {
    id: 3, is_active: 1, frequency: 'weekly', starts_on: '2026-03-04',
    day_of_week: 5, ends_on: null, day_of_month: 1, amount: 300,
  };

  await t.test('the first one is the next Friday, not the start date', () => {
    assert.equal(firstDueOn(cleaner), '2026-03-06');
    assert.equal(new Date('2026-03-06T00:00:00Z').getUTCDay(), 5);
  });

  await t.test('and every one after it is a Friday too', () => {
    const due = dueOccurrences(cleaner, { asOf: '2026-03-25' });
    assert.deepEqual(dates(due), ['2026-03-06', '2026-03-13', '2026-03-20']);
    for (const day of dates(due)) {
      assert.equal(new Date(`${day}T00:00:00Z`).getUTCDay(), 5, `${day} is not a Friday`);
    }
  });

  await t.test('a template created ON its own day starts today, not in a week', () => {
    const sameDay = { ...cleaner, starts_on: '2026-03-06' };
    assert.equal(firstDueOn(sameDay), '2026-03-06');
  });

  await t.test('no weekday saved falls back to the weekday of the start date', () => {
    const derived = { ...cleaner, day_of_week: null };
    assert.equal(weekdayOf(derived), 3, 'the start date is a Wednesday');
    assert.equal(firstDueOn(derived), '2026-03-04');
  });

  await t.test('a stored 0 means Sunday and is not mistaken for "not set"', () => {
    // Number('') is 0 and Number(undefined) is NaN; a naive `|| fallback`
    // turns a deliberate Sunday into whatever the start date happens to be.
    assert.equal(weekdayOf({ ...cleaner, day_of_week: 0, starts_on: '2026-03-04' }), 0);
    assert.equal(firstDueOn({ ...cleaner, day_of_week: 0 }), '2026-03-08');
  });
});

// ----------------------------------------------------------------- every year

test('a yearly template', async (t) => {
  const licence = {
    id: 4, is_active: 1, frequency: 'yearly', starts_on: '2024-03-10',
    month_of_year: 3, day_of_month: 10, ends_on: null, amount: 9000,
  };

  await t.test('owes one entry per year, keyed by the year alone', () => {
    const due = dueOccurrences(licence, { asOf: '2026-06-01', max: 10 });
    assert.deepEqual(keys(due), ['2024', '2025', '2026']);
    assert.deepEqual(dates(due), ['2024-03-10', '2025-03-10', '2026-03-10']);
  });

  await t.test('is not owed until its month has come round', () => {
    assert.deepEqual(keys(dueOccurrences(licence, { asOf: '2026-02-01', max: 10 })), ['2024', '2025']);
  });

  await t.test('the 29th of February clamps on a common year, like a monthly one', () => {
    const leapling = { ...licence, starts_on: '2028-02-29', month_of_year: 2, day_of_month: 29 };
    assert.deepEqual(
      dates(dueOccurrences(leapling, { asOf: '2030-06-01', max: 10 })),
      ['2028-02-29', '2029-02-28', '2030-02-28'],
    );
  });

  await t.test('no month saved falls back to the month of the start date', () => {
    assert.equal(monthOf({ ...licence, month_of_year: null }), 3);
  });
});

// ------------------------------------------------------------------- the caps

test('catch-up is bounded, oldest first, and nothing is lost', async (t) => {
  await t.test('each frequency stops at about a year', () => {
    assert.deepEqual(CATCH_UP, { daily: 366, weekly: 53, monthly: 12, yearly: 2 });
  });

  const abandoned = {
    id: 5, is_active: 1, frequency: 'monthly', starts_on: '2020-01-01',
    day_of_month: 1, ends_on: null, amount: 100,
  };

  await t.test('a template nobody generated for years offers a page, not a flood', () => {
    const due = dueOccurrences(abandoned, { asOf: '2026-03-20' });
    assert.equal(due.length, 12);
    assert.equal(due[0].period_key, '2020-01', 'the OLDEST are offered first');
  });

  await t.test('posting them makes room for the next batch rather than losing them', () => {
    const first = dueOccurrences(abandoned, { asOf: '2026-03-20' });
    const next = dueOccurrences(abandoned, { asOf: '2026-03-20', posted: keys(first) });
    assert.equal(next.length, 12);
    assert.equal(next[0].period_key, '2021-01');
    assert.ok(!keys(next).some((key) => keys(first).includes(key)), 'a month was offered twice');
  });

  await t.test('a daily template years old still terminates', () => {
    const daily = { ...abandoned, frequency: 'daily' };
    const due = dueOccurrences(daily, { asOf: '2026-03-20' });
    assert.equal(due.length, 366);
    assert.equal(due[0].due_on, '2020-01-01');
  });

  await t.test('a fully-posted old daily template offers nothing and does not spin', () => {
    // Every day from the start to today already posted: the walk has to step
    // through all of them and come out the other side empty.
    const daily = { ...abandoned, frequency: 'daily', starts_on: '2026-01-01' };
    const all = keys(dueOccurrences(daily, { asOf: '2026-03-20' }));
    assert.equal(dueOccurrences(daily, { asOf: '2026-03-20', posted: all }).length, 0);
  });
});

// -------------------------------------------------------------- the boundaries

test('a start date and an end date bound every frequency', async (t) => {
  const base = { id: 6, is_active: 1, day_of_month: 10, amount: 100 };

  await t.test('nothing before the start, nothing after the end', () => {
    const bounded = {
      ...base, frequency: 'monthly', starts_on: '2026-01-20', ends_on: '2026-02-28',
    };
    assert.deepEqual(keys(dueOccurrences(bounded, { asOf: '2026-03-20' })), ['2026-02']);
  });

  await t.test('a weekly one ends on its end date, not the week after', () => {
    const weekly = {
      ...base, frequency: 'weekly', starts_on: '2026-03-02', day_of_week: 1, ends_on: '2026-03-16',
    };
    assert.deepEqual(dates(dueOccurrences(weekly, { asOf: '2026-04-01' })),
      ['2026-03-02', '2026-03-09', '2026-03-16']);
  });

  await t.test('a stopped template owes nothing at all, whatever its frequency', () => {
    for (const frequency of FREQUENCIES) {
      assert.deepEqual(
        dueOccurrences({ ...base, frequency, is_active: 0, starts_on: '2020-01-01' },
          { asOf: '2026-03-20' }),
        [], `a stopped ${frequency} template still owed something`,
      );
    }
  });
});

// ------------------------------------------------------------------- the keys

test('the period key is a real duplicate guard', async (t) => {
  await t.test('each frequency has its own shape, and all of them validate', () => {
    const shapes = {
      daily: periodKeyFor('daily', '2026-03-05'),
      weekly: periodKeyFor('weekly', '2026-03-05'),
      monthly: periodKeyFor('monthly', '2026-03-05'),
      yearly: periodKeyFor('yearly', '2026-03-05'),
    };
    assert.deepEqual(shapes, {
      daily: '2026-03-05', weekly: '2026-03-05', monthly: '2026-03', yearly: '2026',
    });
    for (const [frequency, key] of Object.entries(shapes)) {
      assert.match(key, PERIOD_KEY_PATTERN, `${frequency} mints a key the API would reject`);
    }
  });

  await t.test('one template can never mint the same key for two occurrences', () => {
    // This is the property the unique index on (recurring_id, period_key)
    // rests on. If any frequency ever produced a repeat, the second occurrence
    // would be rejected by the database as "already posted" and simply
    // disappear — money the shop spent that never reached the ledger.
    for (const frequency of FREQUENCIES) {
      const template = {
        id: 7, is_active: 1, frequency, starts_on: '2024-01-01', day_of_month: 15,
        day_of_week: 2, month_of_year: 6, ends_on: null, amount: 1,
      };
      const due = dueOccurrences(template, { asOf: '2026-12-31', max: 500 });
      assert.ok(due.length > 1, `${frequency} produced nothing to check`);
      assert.equal(new Set(keys(due)).size, due.length, `${frequency} minted a duplicate key`);
      // And the dates must strictly increase — a step that ever stood still
      // would loop for ever inside the walk's guard rather than terminate.
      for (let i = 1; i < due.length; i += 1) {
        assert.ok(due[i].due_on > due[i - 1].due_on,
          `${frequency} went backwards or stood still at ${due[i].due_on}`);
      }
    }
  });

  await t.test('every occurrence says which frequency produced it', () => {
    const due = dueOccurrences(
      { id: 8, is_active: 1, frequency: 'weekly', starts_on: '2026-03-02', day_of_week: 1, day_of_month: 1, amount: 5 },
      { asOf: '2026-03-10' },
    );
    assert.ok(due.every((row) => row.frequency === 'weekly'));
  });

  await t.test('stepping is total — every frequency answers a next date', () => {
    for (const frequency of FREQUENCIES) {
      const next = nextDueOn({ frequency, day_of_month: 15, day_of_week: 2, month_of_year: 6, starts_on: '2026-01-15' }, '2026-01-15');
      assert.match(next, /^\d{4}-\d{2}-\d{2}$/, `${frequency} did not answer a date`);
      assert.ok(next > '2026-01-15', `${frequency} did not move forward`);
    }
  });
});
