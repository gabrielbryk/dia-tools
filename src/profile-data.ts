import type { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classify, parseJSON } from './infer';
import { all, quoteIdentifier as q } from './store';
import type { BrowserNode, BrowserProfile, DataCell, StoreSchema, Table, TableData } from './types';
const SECRET =
  /password|passwd|secret|token|api[_ .-]?key|access[_ .-]?key|credential|authorization|auth[_ .-]?state|(?:encryption|signing|private|session)[_ .-]?key|cookie/i;
const URL_SECRET =
  /^(?:access_token|refresh_token|id_token|token|api_key|apikey|key|password|secret|code|signature|sig|auth)$/i;
const MAX_CELL_BYTES = 256 * 1024;
export function redactURL(text: string): string {
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return text;
    let changed = false;
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      changed = true;
    }
    for (const key of [...url.searchParams.keys()])
      if (URL_SECRET.test(key)) {
        url.searchParams.set(key, '[redacted]');
        changed = true;
      }
    if (url.hash.includes('=')) {
      const hash = new URLSearchParams(url.hash.slice(1));
      let sanitized = false;
      for (const key of [...hash.keys()])
        if (URL_SECRET.test(key)) {
          hash.set(key, '[redacted]');
          sanitized = true;
        }
      if (sanitized) {
        url.hash = hash.toString();
        changed = true;
      }
    }
    return changed ? url.href : text;
  } catch {
    return text;
  }
}
function safeJSON(value: any, depth = 0): { value: any; redacted: number } {
  if (depth > 64) return { value: '[depth limit]', redacted: 0 };
  if (typeof value === 'string') {
    if (
      /-----BEGIN [\w ]*PRIVATE KEY-----/.test(value) ||
      /^Bearer\s+\S+/i.test(value) ||
      /^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+$/.test(value)
    )
      return { value: '[redacted credential]', redacted: 1 };
    const clean = redactURL(value);
    return { value: clean, redacted: clean === value ? 0 : 1 };
  }
  if (value === null || typeof value !== 'object')
    return {
      value:
        typeof value === 'bigint'
          ? value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
            ? Number(value)
            : value.toString()
          : value,
      redacted: 0,
    };
  let redacted = 0;
  if (Array.isArray(value))
    return {
      value: value.map((v) => {
        const x = safeJSON(v, depth + 1);
        redacted += x.redacted;
        return x.value;
      }),
      get redacted() {
        return redacted;
      },
    };
  const entries = Object.entries(value).map(([k, v]) => {
    if (SECRET.test(k)) {
      redacted++;
      return [k, '[redacted credential]'];
    }
    const x = safeJSON(v, depth + 1);
    redacted += x.redacted;
    return [k, x.value];
  });
  return { value: Object.fromEntries(entries), redacted };
}
export function dataCell(
  value: any,
  key: string,
  family: string,
): { cell: DataCell; redacted: boolean } {
  const bytes =
    value instanceof Uint8Array
      ? value.byteLength
      : typeof value === 'string'
        ? Buffer.byteLength(value)
        : undefined;
  if (SECRET.test(key) || /(?:^|_)auth(?:_|$)/i.test(family))
    return {
      cell: { kind: 'redacted', reason: 'Credential or authentication material', bytes },
      redacted: true,
    };
  if (bytes !== undefined && bytes > MAX_CELL_BYTES)
    return {
      cell: {
        kind: 'truncated',
        bytes,
        reason: 'Value exceeds the 256 KiB per-cell display limit',
      },
      redacted: false,
    };
  let parsed: any = value,
    encoding: string | undefined;
  if (value instanceof Uint8Array) {
    const c = classify(value);
    encoding = c.encoding;
    if (!c.hasShape)
      return {
        cell: {
          kind: 'binary',
          bytes,
          encoding,
          reason: 'Opaque bytes; raw binary is not embedded',
        },
        redacted: false,
      };
    parsed = c.value;
  } else if (typeof value === 'string') {
    const j = parseJSON(value);
    if (j.ok && j.value !== null && typeof j.value === 'object') {
      parsed = j.value;
      encoding = 'json';
    }
  }
  const sanitized = safeJSON(parsed);
  return {
    cell: {
      kind: parsed !== null && typeof parsed === 'object' ? 'json' : 'value',
      value: sanitized.value,
      bytes,
      encoding,
      ...(sanitized.redacted ? { reason: 'Credential fields redacted' } : {}),
    },
    redacted: sanitized.redacted > 0,
  };
}
export function extractTableData(
  db: Database,
  table: Table,
  family: string,
  rowLimit: number,
): TableData {
  const out: TableData = {
    table: table.name,
    rows: [],
    totalRows: table.rowCount,
    truncated: false,
    redactedCells: 0,
    binaryCells: 0,
  };
  const order = table.columns
    .filter((c) => c.pk)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => q(c.name));
  const statement = `SELECT * FROM ${q(table.name)}${order.length ? ' ORDER BY ' + order.join(',') : ''}${rowLimit > 0 ? ' LIMIT ' + rowLimit : ''}`;
  for (const raw of db.query(statement).iterate() as Iterable<Record<string, any>>) {
    const row: Record<string, DataCell> = Object.create(null);
    for (const [name, value] of Object.entries(raw)) {
      const key =
        table.name === 'values' && name === 'value' && typeof raw.key === 'string' ? raw.key : name;
      const { cell, redacted } = dataCell(value, key, family);
      row[name] = cell;
      if (redacted) out.redactedCells++;
      if (cell.kind === 'binary') out.binaryCells++;
    }
    out.rows.push(row);
  }
  out.truncated = out.rows.length < out.totalRows;
  return out;
}
function records(store: StoreSchema, table: string): Record<string, any>[] {
  return (store.data?.find((t) => t.table === table)?.rows ?? []).map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, c]) => [k, c.value ?? null])),
  );
}
export function profileNames(userData: string): Record<string, { name?: string; email?: string }> {
  try {
    const source = JSON.parse(readFileSync(join(userData, 'Local State'), 'utf8'))?.profile
      ?.info_cache;
    if (!source || typeof source !== 'object') return {};
    return Object.fromEntries(
      Object.entries(source).map(([id, raw]: [string, any]) => [
        id,
        {
          name: typeof raw.name === 'string' ? raw.name : undefined,
          email: typeof raw.user_name === 'string' ? raw.user_name : undefined,
        },
      ]),
    );
  } catch {
    return {};
  }
}
export function buildProfile(
  store: StoreSchema,
  identity: { name?: string; email?: string } = {},
): BrowserProfile {
  const groups = new Map(records(store, 'tab_groups').map((r) => [String(r.node_id), r]));
  const tabs = new Map(records(store, 'tabs').map((r) => [String(r.node_id), r]));
  const panes = new Map(records(store, 'content_panes').map((r) => [String(r.node_id), r]));
  const web = records(store, 'web_contents');
  const supertabs = records(store, 'supertabs');
  const issues: string[] = [];
  const nodes: BrowserNode[] = records(store, 'nodes').map((r) => {
    const id = String(r.id),
      group = groups.get(id),
      tab = tabs.get(id),
      pane = panes.get(id);
    const pages = pane
      ? web
          .filter((w) => String(w.content_pane_id) === String(pane.id))
          .map((w) => ({
            id: String(w.id),
            title: String(w.title ?? pane.custom_title ?? ''),
            url: String(w.url ?? ''),
          }))
      : [];
    const icon = group?.icon ?? pane?.custom_icon ?? null;
    return {
      id,
      entityId: String(r.entity_id ?? group?.id ?? tab?.id ?? pane?.id ?? ''),
      kind: String(r.kind ?? (group ? 'group' : 'unknown')),
      parentId: r.parent_id === null || r.parent_id === undefined ? null : String(r.parent_id),
      order: Number(r.order ?? 0),
      spaceId: String(r.space_id ?? ''),
      deletedAt: r.deleted_at ?? null,
      effectiveDeleted: Boolean(r.deleted_at),
      title: String(
        group?.title ??
          pane?.custom_title ??
          supertabs.find((s) => s.content_pane_id === pane?.id)?.title ??
          '',
      ),
      icon: icon && typeof icon === 'object' ? icon : null,
      pages,
      children: [],
      metadata: { ...r, ...(group ?? tab ?? pane ?? {}) },
    };
  });
  const map = new Map(nodes.map((n) => [n.id, n]));
  // Break a cycle before rendering; retain original relationships in database rows.
  for (const node of nodes) {
    const seen = new Set<string>([node.id]);
    let current = node;
    while (current.parentId !== null && map.has(current.parentId)) {
      if (seen.has(current.parentId)) {
        issues.push('Cycle broken at node ' + current.id);
        current.parentId = null;
        break;
      }
      seen.add(current.parentId);
      current = map.get(current.parentId)!;
    }
  }
  const roots: string[] = [];
  for (const n of nodes) {
    if (n.parentId !== null && map.has(n.parentId)) map.get(n.parentId)!.children.push(n.id);
    else {
      roots.push(n.id);
      if (n.parentId !== null) issues.push('Missing parent for node ' + n.id);
    }
    let parent = n.parentId === null ? undefined : map.get(n.parentId);
    while (parent) {
      if (!n.spaceId && parent.spaceId) n.spaceId = parent.spaceId;
      n.effectiveDeleted ||= Boolean(parent.deletedAt);
      parent = parent.parentId === null ? undefined : map.get(parent.parentId);
    }
  }
  const sort = (a: string, b: string) =>
    map.get(a)!.order - map.get(b)!.order || a.localeCompare(b, undefined, { numeric: true });
  roots.sort(sort);
  nodes.forEach((n) => n.children.sort(sort));
  const fallback: Record<string, string> = {
    favorites: 'Favorites',
    pinned_container: 'Pinned',
    window: 'Window',
    group: 'Untitled folder',
    tab: 'Untitled tab',
    content_pane: 'Content pane',
  };
  function title(n: BrowserNode, depth = 0): string {
    if (n.title) return n.title;
    if (depth > 64) return fallback[n.kind] ?? n.kind;
    n.title =
      n.pages.find((p) => p.title)?.title ||
      n.pages.find((p) => p.url)?.url ||
      (n.kind === 'tab'
        ? n.children.map((id) => title(map.get(id)!, depth + 1)).find(Boolean)
        : '') ||
      fallback[n.kind] ||
      n.kind;
    return n.title;
  }
  const spaceTitles = new Map(
    records(store, 'spaces').map((s) => [String(s.id), String(s.title ?? '')]),
  );
  nodes.forEach((n) => {
    title(n);
    if (['window', 'pinned_container', 'favorites'].includes(n.kind) && spaceTitles.get(n.spaceId))
      n.title += ' · ' + spaceTitles.get(n.spaceId);
  });
  const active = nodes.filter((n) => !n.effectiveDeleted);
  return {
    id: store.profile,
    name: identity.name || store.profile,
    email: identity.email,
    dbId: store.id,
    capturedAt: store.capturedAt,
    status: store.status,
    roots,
    nodes,
    spaces: records(store, 'spaces').map((s) => ({
      id: String(s.id),
      title: String(s.title ?? 'Untitled space'),
      theme: String(s.theme ?? 'neutral'),
    })),
    folderCount: active.filter((n) => n.kind === 'group').length,
    tabCount: active.filter((n) => n.kind === 'tab').length,
    urlCount: active.reduce((n, x) => n + x.pages.length, 0),
    issues,
  };
}
