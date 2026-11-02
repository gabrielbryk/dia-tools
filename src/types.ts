export type SQLRow = Record<string, any>;
export type JSONSchema = Record<string, any>;
export interface Store {
  path: string;
  relativePath: string;
  profile: string;
  family: string;
  context: string;
}
export interface Shape {
  id: string;
  table: string;
  column: string;
  key?: string;
  label: string;
  kind: string;
  encoding: string;
  samples: number;
  bytes?: number;
  inferred: boolean;
  structuredJson?: boolean;
  hasShape: boolean;
  schema: JSONSchema;
}
export interface Table {
  id: string;
  name: string;
  kind: string;
  sql: string | null;
  columns: SQLRow[];
  foreignKeys: SQLRow[];
  indexes: SQLRow[];
  triggers: SQLRow[];
  withoutRowid: boolean;
  strict: boolean;
  rowCount: number;
  jsonSchemaIds: string[];
  rowJsonSchema: JSONSchema;
}
export interface StoreSchema {
  data?: TableData[];
  id: string;
  path: string;
  profile: string;
  family: string;
  storage: string;
  context: string | null;
  capturedAt: string;
  status: string;
  integrity?: string;
  error?: string;
  objects: SQLRow[];
  tables: Table[];
  jsonSchemas: Shape[];
}
export interface Catalog {
  profiles?: BrowserProfile[];
  dataCoverage?: {
    rowLimit: number;
    rows: number;
    redactedCells: number;
    binaryCells: number;
    truncatedTables: number;
    description: string;
  };
  formatVersion: number;
  generatedAt: string;
  diaVersion: string;
  jsonSchemaDialect: string;
  scope: Record<string, any>;
  inference: Record<string, any>;
  validation: Record<string, number>;
  summary: Record<string, number>;
  databases: StoreSchema[];
}

export interface DataCell {
  kind: 'value' | 'json' | 'binary' | 'redacted' | 'truncated';
  value?: any;
  encoding?: string;
  bytes?: number;
  reason?: string;
}
export interface TableData {
  table: string;
  rows: Record<string, DataCell>[];
  totalRows: number;
  truncated: boolean;
  redactedCells: number;
  binaryCells: number;
}
export interface BrowserPage {
  id: string;
  title: string;
  url: string;
}
export interface BrowserNode {
  id: string;
  entityId: string;
  kind: string;
  parentId: string | null;
  order: number;
  spaceId: string;
  deletedAt: string | null;
  effectiveDeleted: boolean;
  title: string;
  icon: { emoji?: string; symbol?: string } | null;
  pages: BrowserPage[];
  children: string[];
  metadata: Record<string, any>;
}
export interface BrowserProfile {
  id: string;
  name: string;
  email?: string;
  dbId: string;
  capturedAt: string;
  status: string;
  roots: string[];
  nodes: BrowserNode[];
  spaces: { id: string; title: string; theme: string }[];
  folderCount: number;
  tabCount: number;
  urlCount: number;
  issues: string[];
}
