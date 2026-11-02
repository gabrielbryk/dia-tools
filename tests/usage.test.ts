import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyzeUsage,
  classifySavedProfile,
  deduplicateVisitEvents,
  matchArcProfiles,
  mergeVisitEvents,
  usageMetrics,
  type VisitEvent,
} from '../src/usage';
import { profileFixture } from './profile-fixture';
import { openDB } from '../src/store';
import type { BrowserNode, BrowserProfile } from '../src/types';
const chrome = (iso: string) => BigInt(Date.parse(iso)) * 1000n + 11644473600000000n;
const now = new Date('2026-11-01T18:00:00Z');
function node(
  id: string,
  kind: string,
  parentId: string | null,
  deletedAt: string | null = null,
): BrowserNode {
  return {
    id,
    entityId: id,
    kind,
    parentId,
    order: 0,
    spaceId: 'main',
    deletedAt,
    effectiveDeleted: false,
    title: id,
    icon: null,
    pages: [],
    children: [],
    metadata: {},
  };
}
function profile(nodes: BrowserNode[]): BrowserProfile {
  for (const n of nodes) nodes.find((p) => p.id === n.parentId)?.children.push(n.id);
  return {
    id: 'Default',
    name: 'Main',
    dbId: 'test',
    capturedAt: now.toISOString(),
    status: 'ok',
    roots: nodes.filter((n) => n.parentId === null).map((n) => n.id),
    nodes,
    spaces: [{ id: 'main', title: 'Main', theme: 'neutral' }],
    folderCount: 0,
    tabCount: 0,
    urlCount: 0,
    issues: [],
  };
}
test('saved inventory excludes ordinary window groups, deleted ancestors and unknowns while preserving saved containers beneath a window root', () => {
  const p = profile([
    node('window', 'window', null),
    node('pins', 'pinned_container', 'window'),
    node('favorites', 'favorites', 'window'),
    node('saved-group', 'group', 'pins'),
    node('saved', 'tab', 'saved-group'),
    node('favorite', 'tab', 'favorites'),
    node('window-group', 'group', 'window'),
    node('open', 'tab', 'window-group'),
    node('open-loose', 'tab', 'window'),
    node('deleted', 'group', 'pins', '2025-01-01'),
    node('deleted-child', 'tab', 'deleted'),
    node('orphan', 'tab', 'missing'),
    node('dynamic', 'group', 'pins'),
  ]);
  const result = classifySavedProfile(p, ['dynamic']);
  expect(result.savedTabs.map((t) => t.id).sort()).toEqual(['favorite', 'saved']);
  expect(result.savedFolders.map((f) => f.id).sort()).toEqual(['dynamic', 'saved-group']);
  expect(result.savedFolders.find((f) => f.id === 'dynamic')!.dynamic).toBe(true);
  expect(result.savedFolders.find((f) => f.id === 'dynamic')!.tabIds).toEqual([]);
  expect(result.excluded).toEqual({
    windowTabs: 2,
    windowGroups: 1,
    deletedTabs: 1,
    unclassifiedTabs: 1,
  });
  expect(result.issues.length).toBe(1);
});
test('Arc mapping uses unique known names and reserves explicit overrides before automatic decisions', () => {
  const dia = [
    { id: 'Default', name: 'Main' },
    { id: 'Profile 3', name: 'Work' },
  ];
  const arc = [
    { id: 'Profile 4', name: 'Work' },
    { id: 'Profile 7', name: 'Main' },
  ];
  expect(matchArcProfiles(dia, arc).map((m) => m.arcProfileId)).toEqual(['Profile 7', 'Profile 4']);
  const override = matchArcProfiles(dia, arc, { 'Profile 3': 'Profile 7' });
  expect(override[0].arcProfileId).toBeNull();
  expect(override[0].method).toBe('ambiguous');
  expect(override[1].method).toBe('explicit');
  expect(override[1].arcProfileId).toBe('Profile 7');
  expect(
    matchArcProfiles(
      [{ id: 'Default', name: 'Default', nameKnown: false }],
      [{ id: 'Default', name: 'Default', nameKnown: false }],
    )[0].method,
  ).toBe('unmatched');
  expect(
    matchArcProfiles(
      [
        { id: 'Default', name: 'Work' },
        { id: 'Profile 2', name: 'Work' },
      ],
      [{ id: 'Profile 7', name: 'Work' }],
    ).every((m) => m.method === 'ambiguous'),
  ).toBe(true);
  expect(() =>
    matchArcProfiles(dia, arc, { Default: 'Profile 7', 'Profile 3': 'Profile 7' }),
  ).toThrow();
  expect(() => matchArcProfiles(dia, arc, { Default: 'Profile 9' })).toThrow();
});
test('cross-browser dedup preserves same-source multiplicity and exact microsecond distinctions', () => {
  const t = chrome('2026-10-31T12:00:00Z');
  const events: VisitEvent[] = [
    { url: 'https://example.test/a', time: t, source: 'Dia' },
    { url: 'https://example.test/a', time: t, source: 'Dia' },
    { url: 'https://example.test/a', time: t, source: 'Arc' },
    { url: 'https://example.test/a', time: t + 1n, source: 'Arc' },
    { url: 'https://example.test/b', time: t, source: 'Arc' },
  ];
  const merged = mergeVisitEvents(events);
  expect(merged.length).toBe(3);
  expect(merged.find((e) => e.time === t && e.url.endsWith('/a'))!.count).toBe(2);
  expect(merged.reduce((n, e) => n + e.count, 0)).toBe(4);
  expect(merged.reduce((n, e) => n + Math.min(e.diaCount, e.arcCount), 0)).toBe(1);
});
test('probable rounded-import dedup requires one unique residual timestamp per source and preserves ambiguous near visits', () => {
  const t = chrome('2026-10-31T12:00:00Z');
  const events: VisitEvent[] = [
    { url: 'https://example.test/rounded', time: t, source: 'Dia' },
    { url: 'https://example.test/rounded', time: t, source: 'Dia' },
    { url: 'https://example.test/rounded', time: t + 123n, source: 'Arc' },
    { url: 'https://example.test/fractional', time: t + 2n, source: 'Dia' },
    { url: 'https://example.test/fractional', time: t + 3n, source: 'Arc' },
    { url: 'https://example.test/ambiguous', time: t, source: 'Dia' },
    { url: 'https://example.test/ambiguous', time: t + 2n, source: 'Arc' },
    { url: 'https://example.test/ambiguous', time: t + 3n, source: 'Arc' },
    { url: 'https://example.test/exact', time: t, source: 'Dia' },
    { url: 'https://example.test/exact', time: t, source: 'Arc' },
  ];
  const result = deduplicateVisitEvents(events);
  expect(result.exactShared).toBe(1);
  expect(result.probableRoundedShared).toBe(1);
  expect(result.exactOnlyCombined).toBe(9);
  expect(result.ambiguousBuckets).toBe(1);
  expect(result.ambiguousVisits).toBe(3);
  expect(result.events.reduce((n, e) => n + e.count, 0)).toBe(8);
  expect(result.events.find((e) => e.url.endsWith('/rounded'))!.count).toBe(2);
  expect(result.events.find((e) => e.url.endsWith('/rounded'))!.time).toBe(t + 123n);
  expect(result.events.filter((e) => e.url.endsWith('/fractional')).length).toBe(2);
});
test('rolling windows count local visited dates and omit future or older visits', () => {
  const events: VisitEvent[] = [
    '2026-10-31T23:30:00Z',
    '2026-11-01T01:00:00Z',
    '2026-09-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    '2027-01-01T00:00:00Z',
  ].map((iso) => ({ url: 'https://example.test/', time: chrome(iso), source: 'Dia' }));
  const result = usageMetrics(mergeVisitEvents(events), now, 'America/Chicago');
  expect(result).toEqual({
    days30: 1,
    visits30: 2,
    days90: 2,
    visits90: 3,
    lastVisit: '2026-11-01T01:00:00.000Z',
  });
  expect(() => usageMetrics([], now, 'Invalid/Zone')).toThrow();
});
test('live-style read-only analysis joins saved splits to exact history, retains site context separately and reports overlap', () => {
  const f = profileFixture(),
    arc = mkdtempSync(join(tmpdir(), 'arc-usage-fixture-'));
  try {
    const tabs = openDB(f.store.path, f.key, false);
    // Same URL in two panes must not count a visit twice for this tab.
    tabs.query('UPDATE web_contents SET url=? WHERE id=?').run('https://example.test/a', 201);
    tabs
      .query('UPDATE web_contents SET url=? WHERE id=?')
      .run('https://example.test/?token=PRIVATE_TOKEN', 210);
    tabs.close();
    function history(root: string, profileId: string, events: [string, bigint][]) {
      mkdirSync(join(root, profileId), { recursive: true });
      const db = new Database(join(root, profileId, 'History'), { create: true });
      db.exec(
        'CREATE TABLE urls(id INTEGER PRIMARY KEY,url TEXT); CREATE TABLE visits(id INTEGER PRIMARY KEY,url INTEGER,visit_time INTEGER);',
      );
      for (const [i, [url, time]] of events.entries()) {
        db.query('INSERT INTO urls VALUES (?,?)').run(i + 1, url);
        db.query('INSERT INTO visits VALUES (?,?,?)').run(i + 1, i + 1, time);
      }
      db.close();
    }
    const time = chrome('2026-10-30T12:00:00Z');
    history(f.directory, 'Default', [
      ['https://example.test/a', time],
      ['https://example.test/a', time],
    ]);
    history(arc, 'Profile 4', [
      ['https://example.test/a', time],
      ['https://example.test/other-route', time],
      ['https://example.test/?token=PRIVATE_TOKEN', time],
    ]);
    writeFileSync(
      join(arc, 'Local State'),
      JSON.stringify({ profile: { info_cache: { 'Profile 4': { name: 'Researcher' } } } }),
    );
    const before = readFileSync(join(f.directory, 'Default', 'History'));
    const report = analyzeUsage({
      userData: f.directory,
      arcUserData: arc,
      root: f.root,
      now,
      timezone: 'America/Chicago',
    });
    const p = report.profiles[0],
      split = p.savedTabs.find((t) => t.nodeId === '20')!,
      secret = p.savedTabs.find((t) => t.nodeId === '21')!;
    expect(p.arcMapping.arcProfileId).toBe('Profile 4');
    expect(split.exact.visits30).toBe(2);
    expect(split.exact.days30).toBe(1);
    expect(split.siteContext.visits30).toBe(4);
    expect(secret.matchablePages).toBe(0);
    expect(secret.exact.visits90).toBe(0);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_TOKEN');
    expect(p.overlap).toEqual({
      diaVisits90: 2,
      arcVisits90: 3,
      sharedVisits90: 1,
      exactSharedVisits90: 1,
      roundedSharedVisits90: 0,
      ambiguousBuckets90: 0,
      ambiguousVisits90: 0,
      exactOnlyCombinedVisits90: 4,
      combinedVisits90: 4,
    });
    expect(readFileSync(join(f.directory, 'Default', 'History'))).toEqual(before);
    expect(p.excluded.unclassifiedTabs).toBe(1);
    expect(report.status).toBe('partial');
    expect(() =>
      analyzeUsage({
        userData: f.directory,
        arcUserData: null,
        root: f.root,
        arcProfileMap: { Default: 'Profile 4' },
      }),
    ).toThrow();
    // Simulate Chromium retaining an exclusive History connection while idle.
    const lockedHistory = openDB(join(f.directory, 'Default', 'History'), undefined, false);
    lockedHistory.exec('BEGIN EXCLUSIVE');
    try {
      const locked = analyzeUsage({
        userData: f.directory,
        arcUserData: null,
        root: f.root,
        now,
        timezone: 'America/Chicago',
      });
      expect(locked.profiles[0].sourceCoverage[0].status).toBe('ok');
      expect(locked.profiles[0].sourceCoverage[0].readMethod).toBe('bounded-stable-snapshot');
      expect(locked.profiles[0].savedTabs.find((t) => t.nodeId === '20')!.exact.visits30).toBe(2);
      expect(readFileSync(join(f.directory, 'Default', 'History'))).toEqual(before);
    } finally {
      lockedHistory.exec('ROLLBACK');
      lockedHistory.close();
    }
    rmSync(join(f.directory, 'Default', 'History'));
    const missing = analyzeUsage({
      userData: f.directory,
      arcUserData: null,
      root: f.root,
      now,
      timezone: 'America/Chicago',
    });
    expect(missing.profiles[0].sourceCoverage[0].status).toBe('missing');
    expect(missing.status).toBe('partial');
  } finally {
    f.cleanup();
    rmSync(arc, { recursive: true, force: true });
  }
});
