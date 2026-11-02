import { chromium } from 'playwright';
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { profileFixture } from '../tests/profile-fixture';
import { explorerHTML } from '../src/explorer';
import { extract } from '../src/schema';
const f = profileFixture();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
});
try {
  const catalog = extract(f.directory, f.root, 'synthetic', () => {}, { includeData: true });
  const file = join(f.directory, 'explorer.html');
  writeFileSync(file, explorerHTML(catalog));
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
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
  await page.goto(new URL('file://' + file).href);
  await page.waitForSelector('.p-profiles');
  assert.match(await page.locator('#main').innerText(), /Researcher/);
  await page.locator('.p-folder-card[data-p-node="10"]').click();
  assert.equal(await page.locator('.p-tab-card').count(), 30);
  assert.ok(await page.locator('a[href="https://example.test/a"]').count());
  assert.ok(await page.locator('a[href="https://example.test/b"]').count());
  assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
  await page.locator('[data-p-page="1"]').click();
  assert.equal(await page.locator('.p-tab-card').count(), 30);
  await page.locator('[data-p-page="0"]').click();
  await page.locator('#pRecursive').uncheck();
  assert.match(await page.locator('.p-page-head p').innerText(), /Direct contents/);
  await page.locator('#pRecursive').check();
  await page.locator('#pSpace').selectOption('main');
  assert.ok(await page.locator('.p-tab-card').count());
  await page.locator('#pDomain').selectOption('docs.example.test');
  assert.equal(await page.locator('.p-tab-card').count(), 1);
  assert.match(await page.locator('.p-tab-card').innerText(), /Nested <script>/);
  const wait = page.waitForEvent('download');
  await page.locator('[data-p-action="export-urls"]').click();
  const download = await wait;
  const urls = JSON.parse(readFileSync((await download.path())!, 'utf8'));
  assert.equal(urls.length, 1);
  assert.equal(urls[0].url, 'https://docs.example.test/research');
  await page.locator('.p-tab-card [data-p-inspect]').first().click();
  assert.ok(await page.locator('#profileDetails').isVisible());
  await page.locator('[data-p-action="close-details"]').click();
  await page.locator('#globalSearch').fill('Nested');
  await page.waitForSelector('.p-search-result');
  await page.locator('.p-search-result').first().click();
  assert.match(await page.locator('.p-page-head').innerText(), /Nested/);
  await page.locator('[data-p-section="records"]').click();
  await page.locator('#pTable').selectOption('web_contents');
  assert.equal(await page.locator('.p-record-table tbody tr').count(), 50);
  await page.locator('[data-p-row-page="1"]').click();
  assert.ok((await page.locator('.p-record-table tbody tr').count()) < 50);
  await page.locator('#pRecordSearch').fill('docs.example.test');
  assert.equal(await page.locator('.p-record-table tbody tr').count(), 1);
  await page.locator('[data-p-row]').first().click();
  assert.match(await page.locator('#pDetailCode').innerText(), /docs.example.test/);
  await page.keyboard.press('Escape');
  await page.locator('[data-p-schema]').click();
  assert.ok(await page.locator('#sqlBody').count());
  await page.locator('[data-record-table]').click();
  assert.ok(await page.locator('#pRecordsBody').count());
  await page
    .locator('#pDatabase')
    .selectOption(catalog.databases.find((d) => d.family === 'mcp_auth')!.id);
  assert.match(await page.locator('.p-record-table').innerText(), /redacted/);
  assert.ok(!(await page.content()).includes('synthetic-secret-marker'));
  await page.locator('[data-p-section="library"]').click();
  await page.locator('#pDeleted').check();
  assert.ok(await page.locator('[data-p-node="12"]').count());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#mobileNav').click();
  await page.locator('#closeNav').click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(dialogs, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  console.log(
    'Profile UI passed: hierarchy, split panes, pagination, filters, safe links, exports, search, records, schema navigation, redaction, mobile, zero network requests.',
  );
} finally {
  await browser.close();
  f.cleanup();
}
