import Ajv2020 from 'ajv/dist/2020';
import type { JSONSchema, SQLRow } from './types';
export const DIALECT = 'https://json-schema.org/draft/2020-12/schema';
export const ajv = new Ajv2020({ strict: false, validateFormats: false, allowUnionTypes: true });
export function dynamicKey(k: string): boolean {
  return (
    k.length > 100 ||
    /[\s/@\\]/.test(k) ||
    /^\d+$/.test(k) ||
    /^[\da-f]{16,}$/i.test(k) ||
    /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(k) ||
    /^(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?$/i.test(k)
  );
}
export class ShapeNode {
  n = 0;
  types = new Set<string>();
  props = new Map<string, ShapeNode>();
  dynamic?: ShapeNode;
  items?: ShapeNode;
  objectCount = 0;
  emptyArrays = 0;
  minItems: number | null = null;
  maxItems = 0;
  limited = false;
  add(value: any, depth = 0): void {
    this.n++;
    const t =
      value === null
        ? 'null'
        : Array.isArray(value)
          ? 'array'
          : typeof value === 'number'
            ? Number.isInteger(value)
              ? 'integer'
              : 'number'
            : typeof value === 'bigint'
              ? 'integer'
              : typeof value;
    this.types.add(t);
    if (depth >= 64) {
      this.limited = true;
      return;
    }
    if (t === 'object') {
      this.objectCount++;
      for (const [k, v] of Object.entries(value)) {
        if (dynamicKey(k)) {
          this.dynamic ??= new ShapeNode();
          this.dynamic.add(v, depth + 1);
        } else {
          if (!this.props.has(k)) this.props.set(k, new ShapeNode());
          this.props.get(k)!.add(v, depth + 1);
        }
      }
    } else if (t === 'array') {
      if (!value.length) this.emptyArrays++;
      this.minItems = this.minItems === null ? value.length : Math.min(this.minItems, value.length);
      this.maxItems = Math.max(this.maxItems, value.length);
      this.items ??= new ShapeNode();
      for (const item of value) this.items.add(item, depth + 1);
    }
  }
  schema(): JSONSchema {
    if (!this.n) return { description: 'No values observed; type is unknown.' };
    const ts = [...this.types].filter((t) => !(t === 'integer' && this.types.has('number'))).sort();
    const s: JSONSchema = { type: ts.length === 1 ? ts[0] : ts, 'x-observations': this.n };
    if (this.limited) return { ...s, 'x-depthLimited': true };
    if (ts.includes('object')) {
      if (this.props.size)
        s.properties = Object.fromEntries(
          [...this.props.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, v.schema()]),
        );
      s.additionalProperties = this.dynamic ? this.dynamic.schema() : true;
      if (this.dynamic) s['x-dynamicPropertyNamesOmitted'] = true;
      s['x-observedObjectCount'] = this.objectCount;
      s['x-observedInEveryObject'] = [...this.props]
        .filter(([, v]) => v.n === this.objectCount)
        .map(([k]) => k)
        .sort();
    }
    if (ts.includes('array')) {
      s.items = this.items?.schema() ?? {};
      s['x-observedArrayLengths'] = {
        min: this.minItems,
        max: this.maxItems,
        empty: this.emptyArrays,
      };
    }
    return s;
  }
}
export function parseJSON(value: unknown): { ok: boolean; value?: any } {
  if (typeof value !== 'string' && !(value instanceof Uint8Array)) return { ok: false };
  try {
    const text =
      typeof value === 'string' ? value : new TextDecoder('utf-8', { fatal: true }).decode(value);
    const parsed = JSON.parse(text);
    return { ok: true, value: parsed };
  } catch {
    return { ok: false };
  }
}
export function classify(value: any): {
  encoding: string;
  value?: any;
  hasShape: boolean;
  json: boolean;
  structured: boolean;
} {
  const result = (encoding: string, v: any, hasShape = true, json = false, structured = false) => ({
    encoding,
    value: v,
    hasShape,
    json,
    structured,
  });
  if (value === null) return result('sql-null', null);
  if (value instanceof Uint8Array) {
    if (value.length === 1 && value[0] <= 1) return result('boolean-byte', value[0] === 1);
    if (!value.length) return result('empty-bytes', undefined, false);
    if (Buffer.from(value).subarray(0, 8).toString() === 'bplist00')
      return result('binary-plist', undefined, false);
  }
  const parsed = parseJSON(value);
  if (parsed.ok) {
    const structured = parsed.value !== null && typeof parsed.value === 'object';
    return result(
      structured ? 'json' : 'json-scalar-candidate',
      parsed.value,
      true,
      true,
      structured,
    );
  }
  if (typeof value === 'string') return result('utf8-string', value);
  if (value instanceof Uint8Array) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(value);
      if (!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return result('utf8-string', text);
    } catch {}
    return result('opaque-binary', undefined, false);
  }
  return result('sqlite-scalar', value);
}
export function rowSchema(
  id: string,
  table: string,
  cols: SQLRow[],
  withoutRowid: boolean,
  strict: boolean,
): JSONSchema {
  const props: JSONSchema = Object.create(null);
  const required: string[] = [];
  const primary = cols.filter((c) => c.pk);
  for (const c of cols) {
    const decl = String(c.type).toUpperCase();
    const affinity = decl.includes('INT')
      ? 'INTEGER'
      : /CHAR|CLOB|TEXT/.test(decl)
        ? 'TEXT'
        : !decl || decl.includes('BLOB')
          ? 'BLOB'
          : /REAL|FLOA|DOUB/.test(decl)
            ? 'REAL'
            : 'NUMERIC';
    const types =
      affinity === 'INTEGER'
        ? ['integer']
        : affinity === 'REAL'
          ? ['number']
          : affinity === 'NUMERIC'
            ? ['number', 'string']
            : ['string'];
    const notnull = Boolean(
      c.notnull ||
        (c.pk && (withoutRowid || strict || (primary.length === 1 && decl === 'INTEGER'))),
    );
    if (!notnull) types.push('null');
    const p: JSONSchema = {
      type: types.length === 1 ? types[0] : types,
      'x-sqliteAffinity': affinity,
      'x-declaredSqlType': c.type,
      'x-nullable': !notnull,
    };
    if (affinity === 'BLOB')
      Object.assign(p, {
        contentEncoding: 'base64',
        description: 'JSON projection of SQLite bytes as base64; the database stores bytes.',
      });
    if (c.dflt_value !== null) p['x-sqlDefault'] = c.dflt_value;
    if (c.pk) p['x-primaryKeyPosition'] = c.pk;
    if (c.hidden === 2 || c.hidden === 3) Object.assign(p, { readOnly: true, 'x-generated': true });
    props[c.name] = p;
    if (notnull) required.push(c.name);
  }
  return {
    $schema: DIALECT,
    $id: 'urn:dia-schema:' + id,
    title: table + ' — SQL row projection',
    type: 'object',
    properties: props,
    additionalProperties: false,
    ...(required.length ? { required } : {}),
    description:
      'Declared SQL affinity projected into JSON. Non-STRICT SQLite can store other classes; this is not a complete SQLite constraint model.',
  };
}
