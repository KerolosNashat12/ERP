/**
 * THE REPEAT DIALOG, IN A BROWSER — because two of its claims are only true there.
 *
 * The engine and the API are proved by `recurring-frequency.test.js` and
 * `recurring-frequency-http.test.js`. Neither of them can see the two things
 * that would actually stop a shop owner using this:
 *
 *   1. **A hidden field must not block the save.** `buildForm.validate()` marks
 *      every empty REQUIRED field in error. A weekly repeat hides "day of the
 *      month", which is required for a monthly one — so without the
 *      hidden-field rule the Save button would refuse, attach a red "required"
 *      to a field nobody can see, and give no way out. Nothing in Node can
 *      catch that; it is a dead end that only exists on screen.
 *   2. **Choosing a frequency must change the form.** The whole feature is one
 *      `change` listener away from being a picker that does nothing.
 *
 * Run it against a server you started:
 *     MM_TEST_URL=http://127.0.0.1:4000 node tests/recurring-frequency-ui-check.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.MM_TEST_URL || 'http://127.0.0.1:4000';
const failures = [];
const notes = [];
const fail = (m) => failures.push(m);
const note = (m) => notes.push(m);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
page.on('pageerror', (e) => fail(`pageerror: ${e.message}`));

await page.goto(`${BASE}/`);
await page.waitForTimeout(600);
await page.fill('input[name=username]', 'admin');
await page.fill('input[name=password]', 'admin123');
await page.click('form button[type=submit]');
await page.waitForTimeout(2500);

await page.evaluate(() => localStorage.setItem('mm.lang', 'en'));
await page.goto(`${BASE}/#/costs`);
await page.reload();
await page.waitForTimeout(2600);

/*
 * A fresh shop forces a password change on first sign-in, and that dialog is
 * ALREADY in `#modal-root` before this check opens one of its own. Dismissed
 * before the reload it simply comes back, and left there it eats the Save
 * click — which is how the first run of this check reported "saving a weekly
 * repeat did not close the dialog. Errors: Current password: Required".
 * Dismissed here, after the last navigation, and by its own ✕.
 */
async function dismissStrayDialogs() {
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const closed = await page.evaluate(() => {
      const heads = [...document.querySelectorAll('#modal-root .modal-head')];
      const stray = heads.find((head) => /password/i.test(head.textContent || ''));
      const button = stray?.querySelector('button');
      if (!button) return false;
      button.click();
      return true;
    });
    if (!closed) return;
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(350);
  }
}
await dismissStrayDialogs();

/** Open «Repeating costs» → «Add a repeating cost». */
async function openDialog() {
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll('button, a')]
      .find((n) => /repeating costs/i.test(n.textContent || ''));
    tab?.click();
  });
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const add = [...document.querySelectorAll('button')]
      .find((n) => /add a repeating cost/i.test(n.textContent || ''));
    add?.click();
  });
  await page.waitForTimeout(900);
}

await openDialog();

/**
 * Which schedule fields are ACTUALLY ON SCREEN.
 *
 * `offsetParent` alone, deliberately. The first version of this also consulted
 * `holder.hidden` — and that let the whole thing pass while every field was
 * still visible, because the `hidden` attribute loses to `.field { display:
 * grid }` and the script's answer had nothing to do with the pixels. A check
 * that asks the code what it INTENDED cannot catch the code failing to do it.
 */
const visibleFields = () => page.evaluate(() => {
  const seen = {};
  const dialog = document.querySelector('#modal-root [name="frequency"]')?.closest('.modal');
  for (const name of ['frequency', 'day_of_week', 'month_of_year', 'day_of_month']) {
    const input = dialog?.querySelector(`[name="${name}"]`);
    seen[name] = Boolean(input) && input.offsetParent !== null;
  }
  return seen;
});

const picker = await page.$('#modal-root [name="frequency"]');
if (!picker) {
  fail('there is no frequency picker in the dialog at all');
} else {
  const options = await page.evaluate(() => [...document.querySelectorAll('#modal-root [name="frequency"] option')]
    .map((o) => o.value).filter(Boolean));
  if (options.join(',') !== 'daily,weekly,monthly,yearly') {
    fail(`the picker offers ${options.join(', ')} — expected daily, weekly, monthly, yearly`);
  } else {
    note(`picker offers ${options.join(' · ')}`);
  }

  const shape = {
    monthly: { day_of_week: false, month_of_year: false, day_of_month: true },
    weekly: { day_of_week: true, month_of_year: false, day_of_month: false },
    daily: { day_of_week: false, month_of_year: false, day_of_month: false },
    yearly: { day_of_week: false, month_of_year: true, day_of_month: true },
  };

  for (const [frequency, expected] of Object.entries(shape)) {
    // eslint-disable-next-line no-await-in-loop
    await page.selectOption('#modal-root [name="frequency"]', frequency);
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(250);
    // eslint-disable-next-line no-await-in-loop
    const seen = await visibleFields();
    for (const [name, want] of Object.entries(expected)) {
      if (seen[name] !== want) {
        fail(`[${frequency}] ${name} is ${seen[name] ? 'shown' : 'hidden'}, expected ${want ? 'shown' : 'hidden'}`);
      }
    }
    note(`[${frequency}] ${Object.entries(seen).filter(([, v]) => v).map(([k]) => k).join(', ') || 'nothing extra'}`);
  }

  /* ── the one that only a browser can fail: SAVING a weekly repeat ──────── */
  await page.selectOption('#modal-root [name="frequency"]', 'weekly');
  await page.waitForTimeout(200);
  // A category is genuinely required and has no default — filling it is part
  // of saving, not part of what is being tested. (The first run of this check
  // left it empty and was correctly refused, which is the form working.)
  await page.evaluate(() => {
    const select = document.querySelector('#modal-root [name="category_id"]');
    const option = [...select.options].find((o) => o.value);
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.fill('#modal-root [name="amount"]', '250');
  await page.selectOption('#modal-root [name="day_of_week"]', '5');
  // Scoped to THE dialog with the frequency picker in it, by walking up from
  // the picker rather than trusting "the Save button in the modal root" —
  // there may be more than one dialog, and the other one's Save is a trap.
  const clicked = await page.evaluate(() => {
    const dialog = document.querySelector('#modal-root [name="frequency"]')?.closest('.modal');
    if (!dialog) return 'no dialog';
    const save = [...dialog.querySelectorAll('button')]
      .find((b) => /^\s*(save|حفظ)\s*$/i.test(b.textContent || ''));
    if (!save) return 'no save button';
    save.click();
    return 'clicked';
  });
  if (clicked !== 'clicked') fail(`could not press Save: ${clicked}`);
  await page.waitForTimeout(1800);

  const stillOpen = await page.evaluate(() => Boolean(document.querySelector('#modal-root [name="frequency"]')));
  if (stillOpen) {
    const errors = await page.evaluate(() => [...document.querySelectorAll('#modal-root .error-text')]
      .map((n) => `${n.closest('.field')?.querySelector('label')?.textContent?.trim() || '?'}: ${n.textContent}`));
    fail(`saving a weekly repeat did not close the dialog. Errors on screen: ${
      errors.length ? errors.join(' | ') : '(none — so the refusal is invisible to the user)'}`);
  } else {
    note('a weekly repeat saved and the dialog closed');
  }

  /* ── a HIDDEN required field must not be able to block the save ────────── */
  /*
   * The save above passes whether or not `validate()` skips hidden fields,
   * because every schedule field happens to carry a default and so is never
   * empty. That makes the rule in `buildForm` untested by it — and an untested
   * rule is one somebody deletes as dead code.
   *
   * So this empties the hidden one on purpose. "Day of the month" is required
   * and irrelevant to a daily repeat; with it blank and off screen, Save must
   * still work. Without the rule the dialog stays open with a red "required"
   * pinned to a field that cannot be seen or filled — a dead end with no
   * visible cause, which is precisely the failure worth paying a test for.
   */
  await openDialog();
  await page.evaluate(() => {
    const select = document.querySelector('#modal-root [name="category_id"]');
    const option = [...select.options].find((o) => o.value);
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.selectOption('#modal-root [name="frequency"]', 'daily');
  await page.waitForTimeout(250);
  await page.fill('#modal-root [name="amount"]', '15');
  // Scoped to the dialog that has the picker in it — `#modal-root` can hold
  // more than one dialog, and the first match may belong to the wrong one.
  const emptied = await page.evaluate(() => {
    const dialog = document.querySelector('#modal-root [name="frequency"]')?.closest('.modal');
    const input = dialog?.querySelector('[name="day_of_month"]');
    if (!input) return 'no day_of_month field in the dialog';
    if (input.offsetParent !== null) return 'day_of_month is still visible';
    input.value = '';
    return 'emptied';
  });
  if (emptied !== 'emptied') {
    fail(`the hidden-field rule was never exercised: ${emptied}`);
  }
  await page.evaluate(() => {
    const dialog = document.querySelector('#modal-root [name="frequency"]')?.closest('.modal');
    [...(dialog?.querySelectorAll('button') || [])]
      .find((b) => /^\s*(save|حفظ)\s*$/i.test(b.textContent || ''))?.click();
  });
  await page.waitForTimeout(1800);
  const blocked = await page.evaluate(() => Boolean(document.querySelector('#modal-root [name="frequency"]')));
  if (blocked) {
    const errors = await page.evaluate(() => [...document.querySelectorAll('#modal-root .error-text')]
      .map((n) => `${n.closest('.field')?.querySelector('label')?.textContent?.trim() || '?'}: ${n.textContent}`));
    fail('an EMPTY HIDDEN required field blocked the save — the user sees a refusal '
      + `with no field to fix. Errors: ${errors.join(' | ') || '(none visible)'}`);
  } else {
    note('an empty hidden required field did not block the save');
  }

  // And the list must describe it as weekly rather than "every month on 1".
  await page.waitForTimeout(1200);
  const row = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('td')].map((c) => c.textContent.trim());
    return cells.find((c) => /^every\b/i.test(c)) || null;
  });
  if (!row) fail('the repeating list shows no schedule for the row that was just saved');
  else if (/every month/i.test(row)) fail(`the list calls a weekly repeat "${row}"`);
  else note(`the list says "${row}"`);
}

await browser.close();
for (const n of notes) console.log(`  · ${n}`);
if (failures.length) {
  console.error(`\n✘ ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n✔ repeat dialog: four frequencies, the right fields for each, and a weekly one saves');
process.exit(0);
