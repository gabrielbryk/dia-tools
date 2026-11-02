import { chromium } from 'playwright';
import { strict as assert } from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { profileFixture } from '../tests/profile-fixture';
import { analyzeUsage } from '../src/usage';
import { usageHTML } from '../src/usage-view';

const f = profileFixture();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
});
try {
  const report = analyzeUsage({ userData: f.directory, root: f.root, arcUserData: null });
  const p = report.profiles[0];
  p.savedTabs[0].exact = { days30: 2, visits30: 3, days90: 3, visits90: 4, lastVisit: null };
  p.savedTabs.push({
    ...p.savedTabs[0],
    id: 'favorite-ui',
    title: 'Frequent favorite',
    placement: 'favorite',
    containerKind: 'favorites',
    folderId: null,
    folderPath: [],
    exact: { days30: 10, visits30: 12, days90: 15, visits90: 20, lastVisit: null },
  });
  const file = join(f.directory, 'usage.html');
  writeFileSync(file, usageHTML(report));
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [],
    requests: string[] = [];
  let dialogs = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (/^https?:/.test(r.url())) requests.push(r.url());
  });
  page.on('dialog', async (d) => {
    dialogs++;
    await d.dismiss();
  });
  await page.goto(pathToFileURL(file).href);
  assert.equal(await page.locator('#rows tr').count(), p.savedTabs.length);
  assert.match(await page.locator('#rows tr').first().innerText(), /Frequent favorite/);
  assert.match(await page.locator('#status').innerText(), /Partial evidence/);
  await page.getByLabel('Saved placement', { exact: true }).selectOption('favorite');
  assert.equal(await page.locator('#rows tr').count(), 1);
  await page.locator('#placement').selectOption('');
  await page.locator('#matched').check();
  assert.equal(await page.locator('#rows tr').count(), 2);
  await page.locator('#matched').uncheck();
  await page.locator('#search').fill('Nested <script>');
  assert.equal(await page.locator('#rows tr').count(), 1);
  assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
  assert.equal(dialogs, 0);
  await page.locator('#search').fill('');
  await page.locator('#sort').selectOption('days90');
  assert.match(await page.locator('#rows tr').first().innerText(), /Frequent favorite/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  console.log(
    'Saved usage UI: filters, sorting, partial diagnostics, escaping, mobile, and offline checks passed.',
  );
} finally {
  await browser.close();
  f.cleanup();
}
