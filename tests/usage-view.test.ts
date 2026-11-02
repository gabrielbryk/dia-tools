import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportUsage, usageHTML } from '../src/usage-view';
import type { UsageReport } from '../src/usage';

const report: UsageReport = {
  formatVersion: 1,
  generatedAt: '2026-11-01T12:00:00.000Z',
  timezone: 'America/Chicago',
  status: 'complete',
  scope: '</script><script>globalThis.injected = true</script>',
  method: 'Synthetic report',
  limitations: [],
  diagnostics: [],
  profiles: [],
  arcProfiles: [],
  unmatchedArcProfiles: [],
};

test('usage export embeds untrusted text as data and refuses to replace prior reports', () => {
  const html = usageHTML(report);
  expect(html).not.toContain(report.scope);
  const embedded = JSON.parse(
    html.match(/id="usageData" type="application\/json">([\s\S]*?)<\/script>/)![1],
  );
  expect(embedded.scope).toBe(report.scope);
  const directory = mkdtempSync(join(tmpdir(), 'dia-usage-view-'));
  try {
    exportUsage(report, directory);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, 'dia-usage.json')).mode & 0o777).toBe(0o600);
    expect(() => exportUsage({ ...report, scope: 'replacement' }, directory)).toThrow(
      'new or empty',
    );
    expect(JSON.parse(readFileSync(join(directory, 'dia-usage.json'), 'utf8')).scope).toBe(
      report.scope,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
