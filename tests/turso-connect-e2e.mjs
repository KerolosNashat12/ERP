/**
 * The walkthrough this feature exists for, driven end to end in a real browser.
 *
 *   node tests/turso-connect-e2e.mjs ar
 *   node tests/turso-connect-e2e.mjs en
 *
 * It starts from the state the owner is actually in — a console with no Turso
 * credentials anywhere, on a host whose environment is empty — opens the
 * create-shop form, finds the automatic option greyed out, connects Turso
 * through the dialog, and creates the shop. The assertion that matters is made
 * across the dialog: the shop name typed *before* connecting is still in the
 * form afterwards, and the automatic option is selected.
 *
 * The Turso Platform API is stubbed on 127.0.0.1, exactly as the unit tests do
 * it — a real browser, a real server, a real fetch client, and no packet
 * leaving this machine. Development aid, not part of the shipped app or of
 * `npm test`.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const LANG = (process.argv[2] || 'ar') === 'en' ? 'en' : 'ar';
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, '..', 'data', `turso-e2e-${LANG}`);
const databasesDir = path.join(dataDir, 'turso');
const OUT = process.env.MM_SHOT_DIR || `/tmp/mm-turso-connect/${LANG}`;

fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(databasesDir, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const API_TOKEN = 'the-token-the-owner-pasted-into-a-chat-window';
const ORG = 'habb-el-banat';

// ---------------------------------------------------------------- the stub

const databases = new Map();
const stub = http.createServer(async (req, res) => {
  const raw = await new Promise((resolve) => {
    let text = '';
    req.on('data', (c) => { text += c; });
    req.on('end', () => resolve(text));
  });
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }

  const send = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  if (req.headers.authorization !== `Bearer ${API_TOKEN}`) {
    return send(401, { error: 'could not authenticate api token' });
  }
  if (req.method === 'GET' && req.url === '/v1/organizations') {
    return send(200, [{ name: 'Habb El Banat', slug: ORG }]);
  }
  const prefix = `/v1/organizations/${ORG}`;
  if (!req.url.startsWith(prefix)) return send(404, { error: 'unknown organization' });
  const route = req.url.slice(prefix.length);

  if (req.method === 'GET' && route === '/databases') {
    return send(200, {
      databases: [...databases.entries()].map(([Name, Hostname]) => ({ Name, Hostname })),
    });
  }
  if (req.method === 'POST' && route === '/databases') {
    const hostname = `file:${path.join(databasesDir, `${body.name}.db`)}`;
    databases.set(body.name, hostname);
    return send(200, { database: { Name: body.name, Hostname: hostname } });
  }
  const token = route.match(/^\/databases\/([^/]+)\/auth\/tokens$/);
  if (req.method === 'POST' && token) return send(200, { jwt: `stub-db-token-${token[1]}` });
  const remove = route.match(/^\/databases\/([^/]+)$/);
  if (req.method === 'DELETE' && remove) {
    databases.delete(remove[1]);
    return send(200, {});
  }
  return send(404, { error: `no stub route for ${req.method} ${req.url}` });
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const stubUrl = `http://127.0.0.1:${stub.address().port}`;

// ------------------------------------------------------------- the server

// A host with nothing set on it. TURSO_API_TOKEN and TURSO_ORG are absent on
// purpose: that is the whole situation this feature is about.
const OWNER_PASSWORD = 'owner-password-for-the-walkthrough';
process.env.MM_PLATFORM = '1';
process.env.MM_PLATFORM_DB = path.join(dataDir, 'platform.db');
process.env.MM_TENANTS_DIR = path.join(dataDir, 'tenants');
process.env.MM_DB_FILE = path.join(dataDir, 'unused-default.db');
process.env.MM_DEFAULT_TENANT = '';
process.env.MM_PLATFORM_OWNER_PASSWORD = OWNER_PASSWORD;
process.env.TURSO_API_URL = stubUrl;
delete process.env.TURSO_API_TOKEN;
delete process.env.TURSO_ORG;

const { createApp } = await import('../src/server.js');
const { initDb, closeDb } = await import('../src/infrastructure/database/connection.js');
const { initPlatformDb, closePlatformDb } = await import('../src/platform/db.js');
const config = (await import('../src/config/index.js')).default;

assert.equal(config.turso.apiUrl, stubUrl, 'the client must be pointed at the local stub');
assert.equal(config.turso.apiToken, '', 'this walkthrough starts with no credentials anywhere');

await initDb();
await initPlatformDb();
const app = createApp();
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
});
const BASE = `http://127.0.0.1:${server.address().port}`;

// ------------------------------------------------------------ the browser

const errors = [];
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1360, height: 940 } });
page.on('console', (msg) => {
  if (msg.type() === 'error' && !msg.text().includes('401')) errors.push(`[console] ${msg.text()}`);
});
page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
// The console reads its language from localStorage, so it is chosen before the
// first paint rather than by clicking a toggle and reloading.
await page.addInitScript((lang) => {
  window.localStorage.setItem('mm.platform.lang', lang);
}, LANG);

const shots = [];
async function shot(name) {
  await page.waitForTimeout(450);
  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file });
  shots.push(file);
}

const NAMES = {
  ar: { en: 'Habb El Banat', ar: 'حب البنات', slug: 'habb-el-banat' },
  en: { en: 'Habb El Banat EN', ar: 'حب البنات', slug: 'habb-el-banat-en' },
}[LANG];

try {
  // ── sign in ───────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/platform/`);
  await page.waitForSelector('.login-card', { timeout: 20000 });
  await page.fill('input[name=username]', 'owner');
  await page.fill('input[name=password]', OWNER_PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForSelector('.shell', { timeout: 20000 });
  await page.waitForTimeout(900);
  await shot('01-console-signed-in');

  // ── the Integrations screen, with nothing connected ───────────────────────
  await page.goto(`${BASE}/platform/#/integrations`);
  await page.waitForSelector('.card .state', { timeout: 20000 });
  await shot('02-integrations-not-connected');

  // ── the create-shop form, with the automatic option out of reach ──────────
  await page.goto(`${BASE}/platform/#/tenants`);
  await page.waitForTimeout(1200);
  await page.locator('.page-actions .btn.primary').click();
  await page.waitForSelector('.modal', { timeout: 20000 });

  const nameEn = page.locator('.modal .field input.input').first();
  await nameEn.fill(NAMES.en);
  await page.locator('.modal .field input.input').nth(1).fill(NAMES.ar);
  await page.waitForTimeout(700);

  const modeSelect = page.locator('.modal select.select').first();
  assert.equal(await modeSelect.locator('option[value=auto]').isDisabled(), true,
    'the automatic option starts out of reach — that is the bug being fixed');
  const connectButton = page.locator('.modal .panel button', { hasText: /Connect Turso|اربط Turso/ });
  assert.equal(await connectButton.count(), 1, 'and the fix is offered right there, as a button');
  await shot('03-create-form-cannot-provision');

  // What is in the form before the dialog opens. Everything below is about
  // this surviving.
  const typedEn = await nameEn.inputValue();
  const typedAr = await page.locator('.modal .field input.input').nth(1).inputValue();
  const typedSlug = await page.locator('.modal .field input.input').nth(2).inputValue();
  assert.equal(typedSlug, NAMES.slug, 'the slug was suggested from the name');

  // ── connect Turso, without leaving the form ───────────────────────────────
  await connectButton.click();
  await page.waitForTimeout(500);
  const dialog = page.locator('.modal').last();
  await dialog.locator('input[type=password]').fill(API_TOKEN);
  await shot('04-turso-dialog');

  await dialog.locator('.modal-foot .btn.primary').click();
  await page.waitForTimeout(1600);
  assert.equal(await page.locator('.modal').count(), 1, 'the dialog closes on success');

  // The whole point, asserted: nothing the owner typed was lost, and the
  // option he was reaching for is now the one selected.
  assert.equal(await nameEn.inputValue(), typedEn, 'the English name survived the dialog');
  assert.equal(await page.locator('.modal .field input.input').nth(1).inputValue(), typedAr,
    'and the Arabic name');
  assert.equal(await page.locator('.modal .field input.input').nth(2).inputValue(), typedSlug,
    'and the slug');
  assert.equal(await modeSelect.inputValue(), 'auto', 'the automatic option is selected for him');
  assert.equal(await modeSelect.locator('option[value=auto]').isDisabled(), false);
  assert.equal(await connectButton.isVisible(), false,
    'and the note that told him to connect is gone from the page, because he has');
  await shot('05-form-after-connecting');

  // ── create the shop ───────────────────────────────────────────────────────
  await page.locator('.modal .modal-foot .btn.primary').click();
  await page.waitForSelector('.otp-panel', { timeout: 30000 });
  await shot('06-shop-created');

  assert.ok(databases.has(`mm-${NAMES.slug}`), 'Turso was asked for a database, and gave one');
  const shown = await page.locator('.modal').innerText();
  assert.ok(!shown.includes(API_TOKEN), 'the platform token is nowhere on screen');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(1200);
  await shot('07-shops-list');
  assert.ok((await page.locator('table.data').innerText()).includes(NAMES.slug), 'the shop is in the list');

  // ── the Integrations screen, connected ────────────────────────────────────
  await page.goto(`${BASE}/platform/#/integrations`);
  await page.waitForSelector('.card-head .tag.ok', { timeout: 20000 });
  const card = await page.locator('.card').first().innerText();
  assert.ok(card.includes(ORG), `the organisation is shown — got: ${card}`);
  assert.ok(!card.includes(API_TOKEN), 'the token is not — not even masked');
  await shot('08-integrations-connected');

  if (errors.length) {
    console.error(`\n${errors.length} console error(s):`);
    for (const line of errors) console.error(`  ${line}`);
  }
  console.log(`\n[${LANG}] walkthrough passed. ${shots.length} screenshots:`);
  for (const file of shots) console.log(`  ${file}`);
  console.log(`[${LANG}] console errors: ${errors.length}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => stub.close(resolve));
  await closeDb();
  await closePlatformDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
