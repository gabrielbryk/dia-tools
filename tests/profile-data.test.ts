import { expect, test } from 'bun:test';
import { dataCell, redactURL } from '../src/profile-data';
import { extract } from '../src/schema';
import { explorerHTML } from '../src/explorer';
import { profileFixture } from './profile-fixture';
test('profiles recover folder hierarchy, split panes, removed ancestors, orphan nodes, and cycles', () => {
  const f = profileFixture();
  try {
    const catalog = extract(f.directory, f.root, 'synthetic', () => {}, { includeData: true });
    const p = catalog.profiles![0];
    expect(catalog.summary.readableDatabases).toBe(3);
    expect(p.name).toBe('Researcher');
    expect(p.email).toBe('researcher@example.test');
    const map = new Map(p.nodes.map((n) => [n.id, n]));
    expect(map.get('10')!.children).toContain('11');
    expect(map.get('20')!.children).toEqual(['200', '201']);
    expect(map.get('200')!.pages[0].url).toBe('https://example.test/a');
    expect(map.get('22')!.effectiveDeleted).toBe(true);
    expect(map.get('220')!.effectiveDeleted).toBe(true);
    expect(p.roots).toContain('23');
    expect(p.issues.some((s) => s.startsWith('Cycle'))).toBe(true);
    expect(map.get('20')!.spaceId).toBe('main');
    const text = JSON.stringify(catalog);
    expect(text).not.toContain('synthetic-secret-marker');
    expect(text).not.toContain('NEVER_EXPORT_LOCAL_STATE_SECRET');
    expect(catalog.dataCoverage!.truncatedTables).toBe(0);
    const raw = JSON.parse(
      explorerHTML(catalog).match(/id="catalogData">([\s\S]*?)<\/script>/)![1],
    );
    expect(raw.profiles[0].nodes.find((n: any) => n.id === '210').title).toBe(
      'Nested <script>alert(1)</script>',
    );
  } finally {
    f.cleanup();
  }
});
test('data extraction respects explicit row limits and marks partial tables', () => {
  const f = profileFixture();
  try {
    const catalog = extract(f.directory, f.root, 'synthetic', () => {}, {
      includeData: true,
      rowLimit: 2,
    });
    expect(catalog.dataCoverage!.truncatedTables).toBeGreaterThan(0);
    expect(catalog.databases.every((d) => (d.data ?? []).every((t) => t.rows.length <= 2))).toBe(
      true,
    );
    expect(() =>
      extract(f.directory, f.root, 'synthetic', () => {}, { includeData: true, rowLimit: -1 }),
    ).toThrow();
  } finally {
    f.cleanup();
  }
});
test('credential values and embedded credential fields are removed before serialization', () => {
  expect(
    dataCell(Buffer.from('secret'), 'DeviceIdentity.signingKey', 'key_value_store').cell.kind,
  ).toBe('redacted');
  const cell = dataCell(
    JSON.stringify({
      apiKey: 'fake-secret',
      nested: { access_token: 'fake-token' },
      enabled: true,
    }),
    'preferences',
    'key_value_store',
  );
  expect(JSON.stringify(cell)).not.toContain('fake-secret');
  expect(JSON.stringify(cell)).not.toContain('fake-token');
  expect(cell.redacted).toBe(true);
  expect(redactURL('https://user:password@example.test/?token=synthetic&safe=1')).not.toContain(
    'password',
  );
  expect(redactURL('https://example.test/#access_token=synthetic')).not.toContain('synthetic');
  expect(dataCell(Buffer.from([0, 255]), 'unknown', 'key_value_store').cell.kind).toBe('binary');
  expect(dataCell('x'.repeat(300000), 'note', 'tabs').cell.kind).toBe('truncated');
});
