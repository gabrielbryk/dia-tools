import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveRoot, deriveDatabaseKey } from './crypto';
import { loadSQLCipher } from './native';
import { openDB, validate, withSnapshot } from './store';
import { getValue, replaceValue } from './settings';
export function selfTest() {
  loadSQLCipher();
  const dir = mkdtempSync(join(tmpdir(), 'dia-tools-test-'));
  const root = deriveRoot(Buffer.from('synthetic-test-secret'));
  const key = deriveDatabaseKey(root, 'global/test');
  try {
    const path = join(dir, 'test.db');
    const db = new Database(path, { create: true });
    try {
      db.exec(`PRAGMA key = "x'${key.toString('hex')}'"`);
      db.exec('CREATE TABLE "values" (key TEXT PRIMARY KEY, value BLOB NOT NULL)');
      db.query('INSERT INTO "values" VALUES (?,?)').run('enabled', Buffer.from([0]));
      validate(db);
    } finally {
      db.close();
    }
    withSnapshot(path, (copy) => {
      const db = openDB(copy, key, false);
      try {
        db.transaction(() =>
          replaceValue(db, 'enabled', Buffer.from([0]), Buffer.from([1])),
        ).immediate();
        validate(db);
        if (!getValue(db, 'enabled')?.equals(Buffer.from([1]))) throw new Error('Write failed.');
      } finally {
        db.close();
      }
    });
    const original = openDB(path, key);
    try {
      if (!getValue(original, 'enabled')?.equals(Buffer.from([0])))
        throw new Error('Snapshot affected source.');
    } finally {
      original.close();
    }
    return {
      passed: true,
      checks: [
        'SQLCipher encryption',
        'key derivation',
        'snapshot isolation',
        'conditional setting edit',
        'integrity',
      ],
    };
  } finally {
    key.fill(0);
    root.fill(0);
    rmSync(dir, { recursive: true, force: true });
  }
}
