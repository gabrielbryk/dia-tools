import type { Database } from 'bun:sqlite';
import { all, readStore, writeStore } from './store';
import type { Store } from './types';
export type Encoding = 'bool' | 'string' | 'json' | 'hex' | 'int64' | 'float64';
export function encode(value: string, type: Encoding): Buffer {
  switch (type) {
    case 'bool':
      if (!['true', 'false'].includes(value)) throw new Error('Boolean must be true or false.');
      return Buffer.from([value === 'true' ? 1 : 0]);
    case 'string':
      return Buffer.from(value);
    case 'json':
      return Buffer.from(JSON.stringify(JSON.parse(value)));
    case 'hex':
      if (!/^(?:[0-9a-fA-F]{2})*$/.test(value))
        throw new Error('Expected even-length hexadecimal bytes.');
      return Buffer.from(value, 'hex');
    case 'int64': {
      if (!/^-?\d+$/.test(value)) throw new Error('Expected signed int64.');
      const b = Buffer.alloc(8);
      b.writeBigInt64LE(BigInt(value));
      return b;
    }
    case 'float64': {
      const n = Number(value);
      if (!value.trim() || !Number.isFinite(n)) throw new Error('Expected finite float64.');
      const b = Buffer.alloc(8);
      b.writeDoubleLE(n);
      return b;
    }
    default:
      throw new Error('Unknown encoding.');
  }
}
export function decode(value: Uint8Array, type: Encoding): unknown {
  const b = Buffer.from(value);
  switch (type) {
    case 'hex':
      return b.toString('hex');
    case 'bool':
      if (b.length !== 1 || b[0] > 1) throw new Error('Value is not a boolean byte.');
      return b[0] === 1;
    case 'string':
      return new TextDecoder('utf-8', { fatal: true }).decode(b);
    case 'json':
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b));
    case 'int64':
      if (b.length !== 8) throw new Error('Expected 8 bytes.');
      return b.readBigInt64LE().toString();
    case 'float64':
      if (b.length !== 8) throw new Error('Expected 8 bytes.');
      return b.readDoubleLE();
    default:
      throw new Error('Unknown encoding.');
  }
}
export function getValue(db: Database, key: string): Buffer | null {
  const row = all(db, 'SELECT value FROM "values" WHERE key=?', key)[0];
  if (!row) return null;
  if (!(row.value instanceof Uint8Array))
    throw new Error('Expected a BLOB setting; unsupported store layout.');
  return Buffer.from(row.value);
}
export function patchObject(document: unknown, path: string, value: unknown): unknown {
  const parts = path.split('.');
  let node: any = document;
  for (const [i, part] of parts.entries()) {
    if (
      ['__proto__', 'constructor', 'prototype'].includes(part) ||
      !node ||
      typeof node !== 'object' ||
      Array.isArray(node) ||
      !Object.hasOwn(node, part)
    )
      throw new Error('JSON path must refer to an existing object field.');
    if (i === parts.length - 1) node[part] = value;
    else node = node[part];
  }
  return document;
}
export function listSettings(db: Database) {
  return all(
    db,
    `SELECT key, length(value) AS bytes,
    CASE WHEN length(value)=1 AND value IN (x'00',x'01') THEN 'bool-byte'
    WHEN json_valid(CAST(value AS TEXT)) THEN 'json-' || json_type(CAST(value AS TEXT))
    WHEN substr(value,1,8)=x'62706c6973743030' THEN 'binary-plist' ELSE 'other' END AS format
    FROM "values" ORDER BY key`,
  );
}
export function replaceValue(
  db: Database,
  key: string,
  old: Buffer | null,
  value: Buffer,
  create = false,
): void {
  if (old === null) {
    if (!create) throw new Error('Unknown key. Creation requires --create.');
    db.query('INSERT INTO "values" (key,value) VALUES (?,?)').run(key, value);
  } else {
    const result = db
      .query('UPDATE "values" SET value=? WHERE key=? AND value=?')
      .run(value, key, old);
    if (result.changes !== 1)
      throw new Error('Setting changed since it was read; no overwrite performed.');
  }
  if (!getValue(db, key)?.equals(value)) throw new Error('Setting write verification failed.');
}
export function changeSetting(
  store: Store,
  root: Uint8Array,
  key: string,
  value: string,
  options: {
    type: Encoding;
    field?: string;
    create?: boolean;
    writeLive?: boolean;
    userData: string;
    backupDir?: string;
  },
) {
  const old = readStore(store, root, (db) => getValue(db, key));
  if (old === null && !options.create) throw new Error('Unknown key. Creation requires --create.');
  let next: Buffer;
  if (options.field !== undefined) {
    if (old === null) throw new Error('Cannot patch a missing setting.');
    next = Buffer.from(
      JSON.stringify(patchObject(decode(old, 'json'), options.field, JSON.parse(value))),
    );
  } else {
    if (old) decode(old, options.type);
    next = encode(value, options.type);
  }
  const preview = {
    key,
    database: store.relativePath,
    mode: options.writeLive ? 'applied' : 'dry-run',
    oldBytes: old?.length ?? null,
    newBytes: next.length,
    value: decode(next, options.type),
  };
  if (!options.writeLive) return preview;
  return {
    ...preview,
    ...writeStore(store, root, options, (db) => {
      replaceValue(db, key, old, next, options.create);
      return { updated: key };
    }),
  };
}
