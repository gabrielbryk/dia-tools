import { chromium } from 'playwright';
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../tests/fixtures';
import { explorerHTML } from '../src/explorer';
import { extract, schemaBundle } from '../src/schema';
const f = fixture();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
});
try {
  f.settings();
  f.folders();
  const catalog = extract(f.directory, f.root, 'synthetic');
  const htmlPath = join(f.directory, 'explorer.html');
  writeFileSync(htmlPath, explorerHTML(catalog));
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  const errors: string[] = [],
    requests: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (/^https?:/.test(r.url())) requests.push(r.url());
  });
  await page.goto(new URL('file://' + htmlPath).href);
  await page.locator('#globalSearch').fill('nested');
  await page.waitForSelector('.result');
  await page.locator('.result').first().click();
  await page.locator('[data-mode="raw"]').click();
  assert.equal(JSON.parse(await page.locator('#jsonCode').innerText()).type, 'object');
  const tabs = catalog.databases.find((d) => d.family === 'tabs')!;
  await page.locator('[data-db="' + tabs.id + '"]').click();
  await page.locator('[data-tab="relationships"]').click();
  await page.locator('.graph-node').first().click();
  assert.ok(await page.locator('#sqlBody tbody tr').count());
  await page.locator('#exportToggle').click();
  const pending = page.waitForEvent('download');
  await page.locator('[data-export="json"]').click();
  const download = await pending;
  assert.deepEqual(
    JSON.parse(readFileSync((await download.path())!, 'utf8')).$defs,
    schemaBundle(catalog).$defs,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#mobileNav').click();
  await page.locator('#closeNav').click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  console.log(
    'UI smoke test passed: search, JSON, relationships, exports, mobile, no network requests.',
  );
} finally {
  await browser.close();
  f.cleanup();
}
