import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveDatabaseKey, deriveRoot } from '../src/crypto';
import {
  all,
  backupStore,
  openDB,
  readStore,
  validate,
  withSnapshot,
  writeStore,
} from '../src/store';
import { decode, encode, getValue, patchObject, replaceValue } from '../src/settings';
import { iconJSON, parsePlan, planFolders, updateFolders, verifyFolders } from '../src/folders';
import { fixture } from './fixtures';
describe('encrypted store invariants', () => {
  test('derivation is context-separated and deterministic', () => {
    const root = deriveRoot(Buffer.from('synthetic-fixture-secret'));
    expect(root.toString('hex')).toBe('025e7f8410bbc65c853dc4c34c02eab9');
    expect(deriveDatabaseKey(root, 'profile/Default/tabs').toString('hex')).toBe(
      '02d0a18f956f2c034cac153433568045ba36af396ac8e3e43120b662c4092c86',
    );
    expect(deriveDatabaseKey(root, 'profile/Profile 2/tabs')).not.toEqual(
      deriveDatabaseKey(root, 'profile/Default/tabs'),
    );
  });
  test('WAL snapshots include committed writes and cannot change the source', () => {
    const f = fixture();
    try {
      const s = f.settings();
      const writer = openDB(s.store.path, s.key, false);
      try {
        writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
        writer.query('INSERT INTO "values" VALUES (?,?)').run('wal-only', Buffer.from('committed'));
        withSnapshot(s.store.path, (copy) => {
          const db = openDB(copy, s.key, false);
          try {
            expect(getValue(db, 'wal-only')?.toString()).toBe('committed');
            db.transaction(() =>
              replaceValue(db, 'enabled', Buffer.from([1]), Buffer.from([0])),
            ).immediate();
            validate(db);
          } finally {
            db.close();
          }
        });
        expect(getValue(writer, 'enabled')).toEqual(Buffer.from([1]));
      } finally {
        writer.close();
      }
    } finally {
      f.cleanup();
    }
  });
  test('wrong context cannot read encrypted metadata', () => {
    const f = fixture();
    try {
      const s = f.settings();
      const db = openDB(s.store.path, deriveDatabaseKey(f.root, 'global/wrong'));
      try {
        expect(() => all(db, 'SELECT * FROM sqlite_master')).toThrow();
      } finally {
        db.close();
      }
    } finally {
      f.cleanup();
    }
  });
  test('conflicting edits rollback and valid edits preserve other values', () => {
    const f = fixture();
    try {
      const s = f.settings();
      withSnapshot(s.store.path, (copy) => {
        const db = openDB(copy, s.key, false);
        try {
          expect(() =>
            db
              .transaction(() => {
                replaceValue(db, 'enabled', Buffer.from([1]), Buffer.from([0]));
                replaceValue(db, 'layout.preferences', Buffer.from('stale'), Buffer.from('{}'));
              })
              .immediate(),
          ).toThrow();
          expect(getValue(db, 'enabled')).toEqual(Buffer.from([1]));
          const old = getValue(db, 'layout.preferences')!;
          const next = Buffer.from(
            JSON.stringify(patchObject(decode(old, 'json'), 'nested.mode', 'top')),
          );
          db.transaction(() => replaceValue(db, 'layout.preferences', old, next)).immediate();
          expect(decode(getValue(db, 'layout.preferences')!, 'json')).toEqual({
            width: 300,
            nested: { mode: 'top' },
            list: [],
          });
          validate(db);
        } finally {
          db.close();
        }
      });
    } finally {
      f.cleanup();
    }
  });
  test('backup remains encrypted, readable, and has context metadata', () => {
    const f = fixture();
    try {
      const s = f.settings();
      const path = backupStore(s.store, f.root, join(f.directory, 'backups'));
      expect(readFileSync(path).subarray(0, 16).toString()).not.toBe('SQLite format 3\0');
      const db = openDB(path, s.key);
      try {
        validate(db);
        expect(getValue(db, 'enabled')).toEqual(Buffer.from([1]));
      } finally {
        db.close();
      }
    } finally {
      f.cleanup();
    }
  });
  test('writes require the explicit live flag before touching data', () => {
    const f = fixture();
    try {
      const s = f.settings();
      const before = readFileSync(s.store.path);
      expect(() =>
        writeStore(s.store, f.root, { userData: f.directory }, () => {
          throw new Error('must not run');
        }),
      ).toThrow('--write-live');
      expect(readFileSync(s.store.path)).toEqual(before);
    } finally {
      f.cleanup();
    }
  });
});
describe('encodings and JSON patching', () => {
  test('all supported encodings round-trip', () => {
    for (const [type, value] of [
      ['bool', 'false'],
      ['string', 'hello 🧪'],
      ['hex', '00ff'],
      ['int64', '9223372036854775807'],
      ['float64', '1.25'],
    ] as const)
      expect(encode(String(decode(encode(value, type), type)), type)).toEqual(encode(value, type));
  });
  test('bad encodings and unsafe/missing paths are refused', () => {
    expect(() => encode('x1', 'hex')).toThrow();
    expect(() => encode('9223372036854775808', 'int64')).toThrow();
    expect(() => decode(Buffer.from([2]), 'bool')).toThrow();
    expect(() => patchObject({}, 'missing', true)).toThrow();
    expect(() => patchObject(JSON.parse('{"__proto__":{}}'), '__proto__.x', true)).toThrow();
    expect(() => patchObject({ list: [1] }, 'list.0', 2)).toThrow();
  });
});
describe('folder plans', () => {
  test('only active matching emojis change; reference symbols preserve shape', () => {
    const f = fixture();
    try {
      const s = f.folders();
      f.folders('Profile 2');
      const plan = planFolders(f.directory, f.root, {
        profile: 'all',
        referenceId: 'four',
        referenceProfile: 'Default',
      });
      expect(plan.changes).toHaveLength(2);
      expect(
        plan.changes.every((c) => c.id === 'one' && c.after.icon === '{"symbol":"folder"}'),
      ).toBe(true);
      withSnapshot(s.store.path, (copy) => {
        const db = openDB(copy, s.key, false);
        try {
          const before = all(db, 'SELECT * FROM tab_groups ORDER BY id');
          db.transaction(() =>
            updateFolders(
              db,
              plan.changes.filter((c) => c.profile === 'Default'),
            ),
          ).immediate();
          const after = all(db, 'SELECT * FROM tab_groups ORDER BY id');
          expect(after.filter((r) => r.id !== 'one')).toEqual(before.filter((r) => r.id !== 'one'));
          expect(after.find((r) => r.id === 'one')?.theme).toBe('neutral');
          validate(db);
          expect(() =>
            db
              .transaction(() =>
                updateFolders(
                  db,
                  plan.changes.filter((c) => c.profile === 'Default'),
                ),
              )
              .immediate(),
          ).toThrow('changed since planning');
        } finally {
          db.close();
        }
      });
      expect(() => verifyFolders(plan, f.directory, f.root)).toThrow('does not match');
    } finally {
      f.cleanup();
    }
  });
  test('duplicate IDs, traversal profiles, malformed icons are rejected', () => {
    expect(() => iconJSON({ symbol: 'folder', emoji: '📁' })).toThrow();
    const c = {
      profile: 'Default',
      id: 'one',
      title: 'Example',
      before: { icon: null, icon_source: null },
      after: { icon: '{"symbol":"folder"}', icon_source: 'userGenerated' },
    };
    expect(() => parsePlan({ version: 1, operation: 'folder-icons', changes: [c, c] })).toThrow(
      'Duplicate',
    );
    expect(() =>
      parsePlan({
        version: 1,
        operation: 'folder-icons',
        changes: [{ ...c, profile: '../outside' }],
      }),
    ).toThrow();
  });
});
