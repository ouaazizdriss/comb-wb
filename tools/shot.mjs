// Usage: node tools/shot.mjs <out.png> [--tab kind] [--table schema.table] [--theme light] [--w 1440] [--h 900]
// Signs in as the dev owner, opens the demo connection, optionally opens a tab, and screenshots.
import { chromium } from 'playwright-core';
const args = Object.fromEntries(process.argv.slice(3).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const out = process.argv[2] ?? 'shot.png';
const BASE = process.env.WEB ?? 'http://127.0.0.1:5173';
const EMAIL = process.env.COMB_EMAIL ?? 'owner@acme.test';
const PASS = process.env.COMB_PASS ?? 'correct horse battery staple';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const page = await browser.newPage({ viewport: { width: Number(args.w ?? 1440), height: Number(args.h ?? 900) } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
// Set the theme before any app code reads it.
await page.addInitScript((t) => localStorage.setItem('comb.theme', JSON.stringify(t)), args.theme ?? 'dark');
await page.goto(BASE);
await page.waitForTimeout(500);
if (await page.locator('text=Sign in').first().isVisible().catch(() => false)) {
  await page.fill('input[type=email]', EMAIL);
  await page.fill('input[type=password]', PASS);
  await page.click('button:has-text("Sign in")');
}
await page.waitForSelector('input[placeholder="Search connections"]', { timeout: 10000 }).catch(async () => {
  console.log('login did not reach the launcher'); await page.screenshot({ path: out }); process.exit(1);
});
if (!args.launcher) {
  const card = page.locator('text=shop_demo').first();
  if (await card.isVisible().catch(() => false)) { await card.click(); await page.waitForTimeout(1200); }
  if (args.table) {
    const [s, t] = args.table.split('.');
    await page.evaluate(([s, t]) => window.__comb?.openTab('table', t, { schema: s, table: t }), [s, t]);
  }
  if (args.tab) await page.evaluate((k) => window.__comb?.openTab(k, k), args.tab);
  if (args.eval) await page.evaluate(args.eval);
  await page.waitForTimeout(Number(args.wait ?? 1800));
}
await page.screenshot({ path: out });
if (errors.length) console.log('PAGE ERRORS:\n' + errors.join('\n'));
await browser.close();
