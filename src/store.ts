import { Database } from 'bun:sqlite';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  openSync,
  readSync,
  closeSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { deriveDatabaseKey } from './crypto';
import { loadSQLCipher } from './native';
import type { SQLRow, Store } from './types';
export const USER_DATA = join(homedir(), 'Library/Application Support/Dia/User Data');
export const BACKUPS = join(homedir(), 'Library/Application Support/dia-tools/backups');
export const quoteIdentifier = (s: string) => '"' + s.replaceAll('"', '""') + '"';
export function profileName(profile: string): string {
  if (profile !== 'Global' && profile !== 'Default' && !/^Profile \d+$/.test(profile))
    throw new Error('Profile must be Global, Default, or Profile N.');
  return profile;
}
export function resolveStore(root: string, profile: string, family: string): Store {
  profileName(profile);
  if (!/^[A-Za-z0-9_-]+$/.test(family)) throw new Error('Invalid database family.');
  const relativePath = profile === 'Global' ? `${family}.db` : `${profile}/${family}.db`;
  return {
    path: join(resolve(root), relativePath),
    relativePath,
    profile,
    family,
    context: profile === 'Global' ? `global/${family}` : `profile/${profile}/${family}`,
  };
}
export function discover(root: string): Store[] {
  const folders = [
    'Global',
    ...readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && (d.name === 'Default' || /^Profile \d+$/.test(d.name)))
      .map((d) => d.name)
      .sort(),
  ];
  return folders.flatMap((profile) =>
    readdirSync(profile === 'Global' ? root : join(root, profile))
      .filter((f) => f.endsWith('.db'))
      .sort()
      .map((f) => resolveStore(root, profile, f.slice(0, -3)))
      .filter((s) => lstatSync(s.path).isFile()),
  );
}
function stamp(path: string): string | null {
  try {
    const x = statSync(path, { bigint: true });
    return [x.ino, x.size, x.mtimeNs, x.ctimeNs].join(':');
  } catch (e: any) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
export function snapshot(source: string, destination: string): string {
  if (!lstatSync(source).isFile()) throw new Error('Database must be a regular file.');
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  chmodSync(destination, 0o700);
  const paths = [source, source + '-wal'];
  for (let attempt = 0; attempt < 30; attempt++) {
    const before = paths.map(stamp);
    let contents: (Buffer | null)[];
    try {
      contents = paths.map((p, i) => (before[i] === null ? null : readFileSync(p)));
    } catch (e: any) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    if (JSON.stringify(before) !== JSON.stringify(paths.map(stamp))) {
      Bun.sleepSync(50);
      continue;
    }
    paths.forEach((p, i) => {
      const out = join(destination, basename(p));
      if (contents[i] === null) rmSync(out, { force: true });
      else writeFileSync(out, contents[i]!, { mode: 0o600, flag: 'wx' });
    });
    return join(destination, basename(source));
  }
  throw new Error('Database kept changing. Quit Dia normally and retry.');
}
export function withSnapshot<T>(source: string, fn: (copy: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'dia-tools-'));
  chmodSync(dir, 0o700);
  try {
    return fn(snapshot(source, dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
export function openDB(path: string, key?: Uint8Array, readonly = true): Database {
  loadSQLCipher();
  const db = new Database(path, { readonly, create: false, strict: true, safeIntegers: true });
  try {
    if (key) {
      if (key.length !== 32) throw new Error('Invalid database key size.');
      db.exec(`PRAGMA key = "x'${Buffer.from(key).toString('hex')}'"`);
    }
    db.exec('PRAGMA busy_timeout=3000');
    if (readonly) db.exec('PRAGMA query_only=ON');
    return db;
  } catch {
    db.close();
    throw new Error('Could not initialize encrypted database.');
  }
}
export function all(db: Database, sql: string, ...params: any[]): SQLRow[] {
  return (db.query(sql).all(...params) as SQLRow[]).map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => [
        k,
        typeof v === 'bigint' &&
        v <= BigInt(Number.MAX_SAFE_INTEGER) &&
        v >= BigInt(Number.MIN_SAFE_INTEGER)
          ? Number(v)
          : v,
      ]),
    ),
  );
}
export function validate(db: Database): void {
  const result = all(db, 'PRAGMA integrity_check');
  if (result.length !== 1 || result[0].integrity_check !== 'ok')
    throw new Error('Database integrity check failed.');
  if (all(db, 'PRAGMA cipher_integrity_check').length)
    throw new Error('SQLCipher page authentication failed.');
}
export function plainSQLite(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const b = Buffer.alloc(16);
    readSync(fd, b, 0, 16, 0);
    return b.equals(Buffer.from('SQLite format 3\0'));
  } finally {
    closeSync(fd);
  }
}
export function readStore<T>(store: Store, root: Uint8Array, fn: (db: Database) => T): T {
  return withSnapshot(store.path, (copy) => {
    const key = plainSQLite(copy) ? undefined : deriveDatabaseKey(root, store.context);
    const db = openDB(copy, key);
    try {
      validate(db);
      return fn(db);
    } finally {
      db.close();
      key?.fill(0);
    }
  });
}
export function diaRunning(): boolean {
  if (process.platform !== 'darwin') throw new Error('Live writes are supported only on macOS.');
  const r = Bun.spawnSync(['/usr/bin/pgrep', '-x', 'Dia'], { stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0 && r.exitCode !== 1)
    throw new Error('Cannot determine whether Dia is running.');
  return r.exitCode === 0;
}
export function requireClosed(): void {
  if (diaRunning())
    throw new Error('Quit Dia normally before applying changes. Dia is still running.');
}
export function safeWriteTarget(store: Store, userData: string): void {
  const rel = relative(realpathSync(userData), realpathSync(store.path));
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || lstatSync(store.path).isSymbolicLink())
    throw new Error('Write target must be inside the selected User Data directory.');
}
export function backupStore(store: Store, root: Uint8Array, backupRoot = BACKUPS): string {
  const dir = join(
    resolve(backupRoot),
    new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID(),
    store.profile,
  );
  const copy = snapshot(store.path, dir);
  const key = deriveDatabaseKey(root, store.context);
  const db = openDB(copy, key);
  try {
    validate(db);
  } finally {
    db.close();
    key.fill(0);
  }
  writeFileSync(
    join(dirname(copy), 'manifest.json'),
    JSON.stringify(
      {
        version: 1,
        originalPath: store.path,
        context: store.context,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return copy;
}
export function writeStore<T>(
  store: Store,
  root: Uint8Array,
  options: { writeLive?: boolean; userData: string; backupDir?: string },
  fn: (db: Database) => T,
): { result: T; backup: string } {
  if (!options.writeLive)
    throw new Error('Applying changes requires --write-live. Review the dry run first.');
  safeWriteTarget(store, options.userData);
  requireClosed();
  const backup = backupStore(store, root, options.backupDir);
  requireClosed();
  const key = deriveDatabaseKey(root, store.context);
  const db = openDB(store.path, key, false);
  try {
    db.exec('PRAGMA foreign_keys=ON');
    const result = db
      .transaction(() => {
        const r = fn(db);
        validate(db);
        return r;
      })
      .immediate();
    validate(db);
    return { result, backup };
  } finally {
    db.close();
    key.fill(0);
  }
}
export function jsonString(value: unknown, pretty = true): string {
  return JSON.stringify(
    value,
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    pretty ? 2 : undefined,
  );
}
