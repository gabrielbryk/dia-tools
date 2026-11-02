import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyFlagPlan,
  flagPlan,
  parseOverrides,
  validateFlagPlan,
  overridesFromPlist,
} from '../src/feature-flags';
import {
  applyRules,
  changeRules,
  planRules,
  readRules,
  updateRules,
  validateRule,
  validateRulePlan,
  verifyRules,
  type LinkRule,
} from '../src/link-rules';
import { openDB, readStore } from '../src/store';
import { fixture } from './fixtures';

describe('hidden-feature overrides', () => {
  test.skipIf(process.platform !== 'darwin')(
    'extracts only the override from plists containing date/data values',
    () => {
      const plist = (value: string) =>
        Buffer.from(`<?xml version="1.0"?><plist version="1.0"><dict>
      <key>date</key><date>2025-01-01T00:00:00Z</date><key>data</key><data>AAEC</data>${value}</dict></plist>`);
      expect(
        overridesFromPlist(
          plist('<key>transientFeatureFlagOverrides</key><string>target=true|keep=false</string>'),
        ),
      ).toBe('target=true|keep=false');
      expect(
        overridesFromPlist(plist('<key>transientFeatureFlagOverrides</key><string></string>')),
      ).toBe('');
      expect(overridesFromPlist(plist(''))).toBeNull();
      expect(() =>
        overridesFromPlist(plist('<key>transientFeatureFlagOverrides</key><true/>')),
      ).toThrow('must be a string');
      expect(() => overridesFromPlist(Buffer.from('invalid plist'))).toThrow();
    },
  );
  test('set, remove, and undo preserve unrelated flags and absent versus empty preferences', () => {
    const before = 'keep=true|target=false|tail=variant';
    const plan = flagPlan(before, 'target', 'true');
    expect(plan.after).toBe('keep=true|target=true|tail=variant');
    expect(flagPlan(plan.after, 'target', parseOverrides(before).get('target')!).after).toBe(
      before,
    );
    expect(flagPlan(before, 'target', null).after).toBe('keep=true|tail=variant');
    expect(flagPlan('target=true', 'target', null).after).toBeNull();
    expect(flagPlan(null, 'target', null).after).toBeNull();
    expect(flagPlan('', 'target', null).after).toBe('');
    expect(flagPlan(null, 'target', 'true').after).toBe('target=true');
    expect(applyFlagPlan(plan, false)).toEqual({ dryRun: true, plan });
  });
  test('ambiguous serialization and expanded plans fail before preference access', () => {
    for (const raw of ['target=true|target=false', 'target', 'target=true|', 'target=a=b'])
      expect(() => parseOverrides(raw)).toThrow();
    expect(() => flagPlan(null, 'target', 'true|other=true')).toThrow();
    const plan = flagPlan('keep=true', 'target', 'true');
    expect(() => validateFlagPlan({ ...plan, after: 'keep=false|target=true' })).toThrow(
      'unrelated',
    );
    expect(() => validateFlagPlan({ ...plan, flag: undefined })).toThrow('Invalid flag');
    expect(() => validateFlagPlan({ ...plan, value: true })).toThrow();
  });
});

const rule = (
  host: string,
  spaceID = 'space-a',
  matchScope: LinkRule['matchScope'] = 'exact_host',
): LinkRule => ({ host, matchScope, spaceID });

function routingFixture() {
  const f = fixture();
  const tabs = f.database(
    'Default',
    'tabs',
    'CREATE TABLE spaces(id TEXT PRIMARY KEY,title TEXT NOT NULL)',
  );
  tabs.db.exec("INSERT INTO spaces VALUES ('space-a','Personal'),('space-b','Work')");
  tabs.db.close();
  tabs.key.fill(0);
  const s = f.database(
    'Global',
    'external_link_rules',
    `CREATE TABLE external_link_destination_rules (
    host TEXT NOT NULL, match_scope TEXT NOT NULL, space_id TEXT NOT NULL, PRIMARY KEY(host,match_scope));
    INSERT INTO external_link_destination_rules VALUES
      ('keep.example.com','exact_host','space-a'),
      ('move.example.com','exact_host','space-a'),
      ('old.example.com','exact_host','space-a');`,
  );
  s.db.close();
  return {
    ...f,
    s,
    cleanup() {
      s.key.fill(0);
      f.cleanup();
    },
  };
}
const changes = {
  upsert: [rule('move.example.com', 'space-b'), rule('new.example.com', 'space-b')],
  remove: [{ host: 'old.example.com', matchScope: 'exact_host' }],
};

describe('incoming-link rule plans', () => {
  test('scoped changes preserve unspecified rows and reject ambiguous hosts and overlaps', () => {
    const before = [rule('keep.example.com'), rule('move.example.com'), rule('old.example.com')];
    expect(changeRules(before, changes).after).toEqual([
      rule('keep.example.com'),
      rule('move.example.com', 'space-b'),
      rule('new.example.com', 'space-b'),
    ]);
    for (const host of [
      'https://example.com',
      'example.com/path',
      '*.example.com',
      'Example.com',
      'example.com:443',
      'example.com.',
    ])
      expect(() => validateRule(rule(host))).toThrow();
    expect(() => validateRule(rule('192.168.0.1', 'space-a', 'host_and_subdomains'))).toThrow(
      'exact_host',
    );
    const broad = rule('example.com', 'space-a', 'host_and_subdomains');
    expect(() => changeRules([broad], { upsert: [rule('api.example.com', 'space-b')] })).toThrow(
      'overlap',
    );
    expect(() => changeRules([broad], { upsert: [rule('example.com', 'space-b')] })).toThrow(
      'overlap',
    );
    expect(changeRules([broad], { upsert: [rule('api.example.com')] }).after).toHaveLength(2);
    expect(() => changeRules(before, { upsert: [before[0]], remove: [before[0]] })).toThrow(
      'conflicting',
    );
    expect(() => changeRules(before, { remove: [rule('missing.example.com')] })).toThrow('missing');
  });
  test('encrypted-copy dry run preserves source bytes; approved transaction persists and stale plans fail', () => {
    const f = routingFixture();
    try {
      const plan = planRules(f.directory, f.root, changes);
      const original = readFileSync(f.s.store.path);
      expect(applyRules(plan, f.directory, f.root, false)).toMatchObject({
        dryRun: true,
        copyValidated: true,
        ruleCount: 3,
      });
      expect(readFileSync(f.s.store.path)).toEqual(original);
      expect(readStore(f.s.store, f.root, readRules)).toEqual(plan.before);
      expect(() => verifyRules(plan, f.directory, f.root)).toThrow('differ');
      const db = openDB(f.s.store.path, f.s.key, false);
      try {
        db.transaction(() => updateRules(db, plan)).immediate();
        expect(readRules(db)).toEqual(plan.after);
      } finally {
        db.close();
      }
      expect(verifyRules(plan, f.directory, f.root)).toMatchObject({
        persisted: true,
        uiVerified: false,
      });
      expect(() => applyRules(plan, f.directory, f.root, false)).toThrow('changed');
    } finally {
      f.cleanup();
    }
  });
  test('destination drift, invalid IDs, expanded changes, and different roots are refused', () => {
    const f = routingFixture();
    try {
      const plan = planRules(f.directory, f.root, changes);
      expect(() => validateRulePlan(plan, join(f.directory, 'other'))).toThrow('root');
      expect(() =>
        validateRulePlan(
          { ...plan, after: [...plan.after, rule('extra.example.com')] },
          f.directory,
        ),
      ).toThrow('scoped');
      expect(() =>
        planRules(f.directory, f.root, { upsert: [rule('missing.example.com', 'no-space')] }),
      ).toThrow('Destination');
      const altered = {
        ...plan,
        destinations: plan.destinations.map((s) => ({ ...s, title: 'Outdated' })),
      };
      expect(() => applyRules(altered, f.directory, f.root, false)).toThrow('Destination');
    } finally {
      f.cleanup();
    }
  });
  test('a database failure rolls back removals and earlier upserts', () => {
    const f = routingFixture();
    try {
      const plan = planRules(f.directory, f.root, changes);
      const db = openDB(f.s.store.path, f.s.key, false);
      try {
        db.exec(`CREATE TRIGGER reject_new BEFORE INSERT ON external_link_destination_rules
          WHEN NEW.host = 'new.example.com' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
        expect(() => db.transaction(() => updateRules(db, plan)).immediate()).toThrow(
          'synthetic failure',
        );
        expect(readRules(db)).toEqual(plan.before);
      } finally {
        db.close();
      }
    } finally {
      f.cleanup();
    }
  });
});
