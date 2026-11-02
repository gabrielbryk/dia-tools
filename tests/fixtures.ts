import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deriveDatabaseKey, deriveRoot } from '../src/crypto';
import { loadSQLCipher } from '../src/native';
import { resolveStore } from '../src/store';
export function fixture() {
  loadSQLCipher();
  const directory = mkdtempSync(join(tmpdir(), 'dia-tools-fixture-'));
  const root = deriveRoot(Buffer.from('synthetic-fixture-secret'));
  function database(profile: string, family: string, sql: string) {
    const store = resolveStore(directory, profile, family);
    mkdirSync(dirname(store.path), { recursive: true });
    const key = deriveDatabaseKey(root, store.context);
    const db = new Database(store.path, { create: true });
    db.exec(`PRAGMA key = "x'${key.toString('hex')}'"`);
    db.exec(sql);
    return { db, store, key };
  }
  function settings() {
    const f = database(
      'Global',
      'global_key_value_store',
      'CREATE TABLE "values" (key TEXT PRIMARY KEY,value BLOB NOT NULL)',
    );
    f.db
      .query('INSERT INTO "values" VALUES (?,?)')
      .run(
        'layout.preferences',
        Buffer.from(JSON.stringify({ width: 300, nested: { mode: 'sidebar' }, list: [] })),
      );
    f.db.query('INSERT INTO "values" VALUES (?,?)').run('enabled', Buffer.from([1]));
    f.db.query('INSERT INTO "values" VALUES (?,?)').run('opaque', Buffer.from([0, 2, 255]));
    f.db.close();
    return f;
  }
  function folders(profile = 'Default') {
    const f = database(
      profile,
      'tabs',
      `CREATE TABLE nodes (id INTEGER PRIMARY KEY,deleted_at TEXT); CREATE TABLE tab_groups (id TEXT PRIMARY KEY,node_id INTEGER REFERENCES nodes(id),title TEXT,icon TEXT,icon_source TEXT,theme TEXT);`,
    );
    const data = [
      ['one', 'Projects', { emoji: '📁' }, null],
      ['two', 'Research', { emoji: '🔬' }, null],
      ['three', 'Archive', { emoji: '📁' }, '2025-01-01'],
      ['four', 'Reference', { symbol: 'folder' }, null],
    ];
    for (const [i, [id, title, icon, deleted]] of data.entries()) {
      f.db.query('INSERT INTO nodes VALUES (?,?)').run(i + 1, deleted as string | null);
      f.db
        .query('INSERT INTO tab_groups VALUES (?,?,?,?,?,?)')
        .run(id as string, i + 1, title as string, JSON.stringify(icon), 'diaGenerated', 'neutral');
    }
    f.db.close();
    return f;
  }
  return {
    directory,
    root,
    database,
    settings,
    folders,
    cleanup() {
      root.fill(0);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
