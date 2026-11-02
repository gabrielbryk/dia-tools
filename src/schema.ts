import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, discover, jsonString, plainSQLite, quoteIdentifier as q, readStore } from './store';
import { extractTableData, buildProfile, profileNames } from './profile-data';
import { ajv, classify, DIALECT, parseJSON, rowSchema, ShapeNode } from './infer';
import type { Catalog, JSONSchema, Shape, StoreSchema, Table } from './types';
export const ident = (...s: string[]) =>
  's_' + createHash('sha256').update(s.join('\0')).digest('hex').slice(0, 16);
export function extract(
  userData: string,
  root: Uint8Array,
  diaVersion = 'unknown',
  progress: (path: string) => void = () => {},
  options: { includeData?: boolean; rowLimit?: number } = {},
): Catalog {
  const rowLimit = options.rowLimit ?? 0;
  if (!Number.isSafeInteger(rowLimit) || rowLimit < 0)
    throw new Error('Row limit must be a nonnegative integer.');
  const stores = discover(userData);
  const validation = {
    schemasChecked: 0,
    jsonDocumentsValidated: 0,
    interpretedValuesValidated: 0,
  };
  const checked = (node: ShapeNode, samples: unknown[]) => {
    const schema = node.schema();
    const validator = ajv.compile(schema);
    validation.schemasChecked++;
    for (const sample of samples)
      if (!validator(sample)) throw new Error('Inferred schema rejected an observed value.');
    validation.interpretedValuesValidated += samples.length;
    ajv.removeSchema(schema);
    return schema;
  };
  const databases: StoreSchema[] = stores.map((store) => {
    const d: StoreSchema = {
      id: ident(store.relativePath),
      path: store.relativePath,
      profile: store.profile,
      family: store.family,
      storage: plainSQLite(store.path) ? 'SQLite' : 'SQLCipher',
      context: store.context,
      capturedAt: new Date().toISOString(),
      status: 'pending',
      objects: [],
      tables: [],
      jsonSchemas: [],
    };
    if (d.storage === 'SQLite') d.context = null;
    try {
      readStore(store, root, (db) => {
        d.objects = all(db, 'SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name');
        const metadata = new Map(all(db, 'PRAGMA table_list').map((r) => [r.name, r]));
        for (const object of d.objects.filter((o) => ['table', 'view'].includes(o.type))) {
          const name = object.name;
          const cols = all(db, 'SELECT * FROM pragma_table_xinfo(?)', name);
          const meta = metadata.get(name) ?? {};
          const t: Table = {
            id: ident(store.relativePath, name),
            name,
            kind: object.type,
            sql: object.sql,
            columns: cols,
            foreignKeys: all(db, 'SELECT * FROM pragma_foreign_key_list(?)', name),
            indexes: [],
            triggers: d.objects.filter((o) => o.type === 'trigger' && o.tbl_name === name),
            withoutRowid: Boolean(meta.wr),
            strict: Boolean(meta.strict),
            rowCount: Number(all(db, `SELECT count(*) AS n FROM ${q(name)}`)[0].n),
            jsonSchemaIds: [],
            rowJsonSchema: rowSchema(
              ident(store.relativePath, name, 'row'),
              name,
              cols,
              Boolean(meta.wr),
              Boolean(meta.strict),
            ),
          };
          if (!ajv.validateSchema(t.rowJsonSchema)) throw new Error('Invalid SQL row schema.');
          validation.schemasChecked++;
          t.indexes = all(db, 'SELECT * FROM pragma_index_list(?)', name).map((i) => ({
            ...i,
            columns: all(db, 'SELECT * FROM pragma_index_xinfo(?)', i.name),
            sql: d.objects.find((o) => o.type === 'index' && o.name === i.name)?.sql ?? null,
          }));
          const kv =
            name === 'values' && ['key', 'value'].every((n) => cols.some((c) => c.name === n));
          const add = (shape: Shape) => {
            d.jsonSchemas.push(shape);
            t.jsonSchemaIds.push(shape.id);
          };
          if (kv)
            for (const row of all(db, `SELECT key,value FROM ${q(name)} ORDER BY key`)) {
              const c = classify(row.value);
              const node = new ShapeNode();
              if (c.hasShape) node.add(c.value);
              add({
                id: ident(store.relativePath, name, 'value', row.key),
                table: name,
                column: 'value',
                key: row.key,
                label: row.key,
                kind: 'key-value',
                encoding: c.encoding,
                samples: 1,
                bytes:
                  typeof row.value === 'string'
                    ? Buffer.byteLength(row.value)
                    : row.value instanceof Uint8Array
                      ? row.value.byteLength
                      : undefined,
                inferred: true,
                structuredJson: c.structured,
                hasShape: c.hasShape,
                schema: c.hasShape
                  ? checked(node, [c.value])
                  : { description: 'No decoded shape inferred for ' + c.encoding + '.' },
              });
              if (c.json) validation.jsonDocumentsValidated++;
            }
          for (const col of cols) {
            col.storageClasses = all(
              db,
              `SELECT typeof(${q(col.name)}) AS type,count(*) AS count FROM ${q(name)} GROUP BY typeof(${q(col.name)})`,
            );
            col.nullCount = col.storageClasses.find((x: any) => x.type === 'null')?.count ?? 0;
            if (kv) continue;
            const node = new ShapeNode();
            const samples: unknown[] = [];
            let textn = 0,
              structured = 0;
            for (const row of db
              .query(
                `SELECT ${q(col.name)} AS v FROM ${q(name)} WHERE typeof(${q(col.name)}) IN ('text','blob')`,
              )
              .iterate() as Iterable<{ v: unknown }>) {
              textn++;
              const parsed = parseJSON(row.v);
              if (!parsed.ok) continue;
              if (parsed.value !== null && typeof parsed.value === 'object') structured++;
              node.add(parsed.value);
              samples.push(parsed.value);
            }
            Object.assign(col, {
              jsonDocuments: samples.length,
              structuredJsonDocuments: structured,
              textOrBlobValues: textn,
            });
            if (samples.length) {
              add({
                id: ident(store.relativePath, name, col.name, 'json'),
                table: name,
                column: col.name,
                label: name + '.' + col.name,
                kind: 'column',
                encoding: structured === samples.length ? 'json' : 'json-with-scalar-candidates',
                samples: samples.length,
                structuredJson: structured > 0,
                hasShape: true,
                inferred: true,
                schema: checked(node, samples),
              });
              validation.jsonDocumentsValidated += samples.length;
            }
          }
          if (options.includeData) {
            d.data ??= [];
            d.data.push(extractTableData(db, t, d.family, rowLimit));
          }
          d.tables.push(t);
        }
      });
      d.status = 'ok';
      d.integrity = 'ok';
    } catch {
      d.status = 'error';
      d.error =
        'Database extraction failed; check SQLCipher compatibility and retry with Dia closed.';
    }
    progress(store.relativePath + ': ' + d.status);
    return d;
  });
  const tables = databases.flatMap((d) => d.tables),
    shapes = databases.flatMap((d) => d.jsonSchemas);
  const identity = options.includeData ? profileNames(userData) : {};
  const dataTables = databases.flatMap((d) => d.data ?? []);
  return {
    ...(options.includeData
      ? {
          profiles: databases
            .filter((d) => d.family === 'tabs')
            .map((d) => buildProfile(d, identity[d.profile])),
          dataCoverage: {
            rowLimit,
            rows: dataTables.reduce((n, t) => n + t.rows.length, 0),
            redactedCells: dataTables.reduce((n, t) => n + t.redactedCells, 0),
            binaryCells: dataTables.reduce((n, t) => n + t.binaryCells, 0),
            truncatedTables: dataTables.filter((t) => t.truncated).length,
            description:
              'All rows from the selected .db stores unless a row limit is set. Credential fields are redacted, opaque binary cells are represented by metadata, and cells larger than 256 KiB are omitted. Profile names and emails are read from Local State. This file contains private browsing data.',
          },
        }
      : {}),
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    diaVersion,
    jsonSchemaDialect: DIALECT,
    scope: {
      description:
        'Every .db file directly in Dia User Data and its Default/Profile folders, including adjacent Chromium .db files. Extensionless Chromium stores such as History, Cookies and Login Data, and cache subdirectories, are outside this scope.',
      discoveredFiles: stores.length,
      globalAtomicSnapshot: false,
    },
    inference: {
      authoritative:
        'SQL definitions, columns, indexes, foreign keys, views and triggers are extracted from database metadata.',
      json: 'Payload shapes are inferred from all observed parseable JSON. No required fields, enums, examples or defaults are inferred.',
      dynamicKeys: 'Identifier-like object keys are generalized as map values.',
      coverage:
        'Empty tables and opaque binary values may have no JSON shape. JSON-looking scalars are ambiguous.',
      valuesExported: Boolean(options.includeData),
    },
    validation,
    summary: {
      databases: databases.length,
      readableDatabases: databases.filter((d) => d.status === 'ok').length,
      families: new Set(databases.map((d) => d.family)).size,
      profiles: new Set(databases.map((d) => d.profile)).size,
      tables: tables.length,
      columns: tables.reduce((n, t) => n + t.columns.length, 0),
      jsonSchemas: shapes.filter((s) => s.structuredJson).length,
      valueSchemas: shapes.length,
      foreignKeys: tables.reduce((n, t) => n + t.foreignKeys.length, 0),
      emptyTables: tables.filter((t) => !t.rowCount).length,
    },
    databases,
  };
}
export function schemaBundle(catalog: Catalog): JSONSchema {
  const defs: JSONSchema = Object.create(null);
  for (const d of catalog.databases) {
    for (const t of d.tables) defs[t.id] = t.rowJsonSchema;
    for (const s of d.jsonSchemas)
      if (s.hasShape)
        defs[s.id] = {
          $id: 'urn:dia-schema:' + s.id,
          title: s.label,
          'x-source': {
            database: d.path,
            table: s.table,
            column: s.column,
            key: s.key ?? null,
            encoding: s.encoding,
          },
          ...s.schema,
        };
  }
  return {
    $schema: DIALECT,
    $id: 'urn:dia-schema:bundle:1',
    title: 'Dia observed JSON schemas and SQL row projections',
    description:
      'Schema library: select a definition with a $ref. Inferred shapes are observational, not vendor-authored contracts.',
    'x-generatedAt': catalog.generatedAt,
    $defs: defs,
  };
}
export function sqlArchive(catalog: Catalog): string {
  return (
    '-- Separate databases follow. This is an archive, not a combined migration.\n\n' +
    catalog.databases
      .map(
        (d) =>
          '-- DATABASE: ' +
          d.path +
          '\n\n' +
          d.objects
            .filter((o) => o.sql)
            .map((o) => o.sql.replace(/;?$/, ';'))
            .join('\n\n'),
      )
      .join('\n\n')
  );
}
export function exportCatalog(catalog: Catalog, directory: string, html: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const files = {
    'dia-schema-catalog.json': jsonString(catalog),
    'dia-json-schemas.json': jsonString(schemaBundle(catalog)),
    'dia-sql-schema.sql': sqlArchive(catalog),
    'dia-schema-explorer.html': html,
  };
  for (const [name, data] of Object.entries(files))
    writeFileSync(join(directory, name), data, { mode: 0o600, flag: 'wx' });
}
