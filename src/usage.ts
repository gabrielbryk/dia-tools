import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { keychainRoot } from './crypto';
import { buildProfile, extractTableData, profileNames, redactURL } from './profile-data';
import {
  all,
  openDB,
  quoteIdentifier,
  readStore,
  resolveStore,
  withSnapshot,
  USER_DATA,
} from './store';
import type { BrowserNode, BrowserPage, BrowserProfile, StoreSchema, Table } from './types';

export interface UsageMetrics {
  days30: number;
  visits30: number;
  days90: number;
  visits90: number;
  lastVisit: string | null;
}
export interface SavedUsageTab {
  id: string;
  nodeId: string;
  title: string;
  spaceId: string;
  spaceName: string;
  placement: 'folder' | 'pin' | 'favorite';
  containerKind: 'pinned_container' | 'favorites';
  folderId: string | null;
  folderPath: string[];
  pages: BrowserPage[];
  recordedLastActive: string | null;
  matchablePages: number;
  exact: UsageMetrics;
  siteContext: UsageMetrics;
  rank: number;
}
export interface SavedUsageFolder {
  id: string;
  nodeId: string;
  title: string;
  spaceId: string;
  spaceName: string;
  path: string[];
  parentFolderId: string | null;
  dynamic: boolean;
  icon: BrowserNode['icon'];
  tabIds: string[];
  descendantTabIds: string[];
}
export interface SavedInventory {
  savedFolders: SavedUsageFolder[];
  savedTabs: SavedUsageTab[];
  excluded: {
    windowTabs: number;
    windowGroups: number;
    deletedTabs: number;
    unclassifiedTabs: number;
  };
  issues: string[];
}
export interface ProfileIdentity {
  id: string;
  name: string;
  nameKnown?: boolean;
}
export interface ArcProfileMapping {
  diaProfileId: string;
  arcProfileId: string | null;
  arcProfileName: string | null;
  method: 'unique-name' | 'explicit' | 'unmatched' | 'ambiguous' | 'disabled';
  candidates: string[];
  reason: string;
}
export interface HistoryCoverage {
  browser: 'Dia' | 'Arc';
  profileId: string;
  profileName: string;
  status: 'ok' | 'missing' | 'error';
  retainedVisits: number;
  earliestVisit: string | null;
  latestVisit: string | null;
  visits90: number;
  message?: string;
  readMethod?: 'read-only-transaction' | 'bounded-stable-snapshot';
}
export interface UsageProfile extends SavedInventory {
  id: string;
  name: string;
  capturedAt: string;
  spaces: BrowserProfile['spaces'];
  arcMapping: ArcProfileMapping;
  sourceCoverage: HistoryCoverage[];
  overlap: {
    diaVisits90: number;
    arcVisits90: number;
    sharedVisits90: number;
    exactSharedVisits90: number;
    roundedSharedVisits90: number;
    ambiguousBuckets90: number;
    ambiguousVisits90: number;
    exactOnlyCombinedVisits90: number;
    combinedVisits90: number;
  };
}
export interface UsageReport {
  formatVersion: 1;
  generatedAt: string;
  timezone: string;
  status: 'complete' | 'partial';
  scope: string;
  method: string;
  limitations: string[];
  diagnostics: string[];
  profiles: UsageProfile[];
  arcProfiles: ProfileIdentity[];
  unmatchedArcProfiles: ProfileIdentity[];
}
export interface AnalyzeUsageOptions {
  userData?: string;
  arcUserData?: string | null;
  now?: Date;
  timezone?: string;
  root?: Uint8Array;
  arcProfileMap?: Record<string, string>;
}
// Chromium timestamps are microseconds since 1601: keep them as bigint until converting to ms.
export interface VisitEvent {
  url: string;
  time: bigint;
  source: 'Dia' | 'Arc';
}
export interface MergedVisitEvent {
  url: string;
  time: bigint;
  count: number;
  diaCount: number;
  arcCount: number;
}
const EPOCH_MICROSECONDS = 11644473600000000n;
const DAY = 86400000;
const emptyMetrics = (): UsageMetrics => ({
  days30: 0,
  visits30: 0,
  days90: 0,
  visits90: 0,
  lastVisit: null,
});
const toMilliseconds = (time: bigint) => Number((time - EPOCH_MICROSECONDS) / 1000n);
const toChromium = (milliseconds: number) =>
  BigInt(Math.trunc(milliseconds)) * 1000n + EPOCH_MICROSECONDS;
function timestamp(time: unknown): string | null {
  if (time === null || time === undefined) return null;
  const date = new Date(toMilliseconds(BigInt(String(time))));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function matchable(url: string): boolean {
  try {
    return (
      ['http:', 'https:'].includes(new URL(url).protocol) &&
      !/(?:\[redacted\]|%5Bredacted%5D)/i.test(url) &&
      redactURL(url) === url
    );
  } catch {
    return false;
  }
}
function origin(url: string): string | null {
  try {
    const u = new URL(url);
    return ['http:', 'https:'].includes(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

/** Nearest container determines placement; ancestors are still checked for deletion or damage. */
export function classifySavedProfile(
  profile: BrowserProfile,
  dynamicGroupIds: string[] = [],
): SavedInventory {
  const map = new Map(profile.nodes.map((n) => [n.id, n]));
  const issues = [...profile.issues];
  function ancestry(node: BrowserNode) {
    const chain: BrowserNode[] = [],
      seen = new Set<string>();
    let current: BrowserNode | undefined = node;
    let damaged = false;
    while (current) {
      if (seen.has(current.id)) {
        damaged = true;
        break;
      }
      seen.add(current.id);
      chain.push(current);
      if (current.parentId !== null && !map.has(current.parentId)) {
        damaged = true;
        break;
      }
      current = current.parentId === null ? undefined : map.get(current.parentId);
    }
    const deleted = chain.some((n) => n.effectiveDeleted || Boolean(n.deletedAt));
    const container = chain.find((n) =>
      ['window', 'pinned_container', 'favorites'].includes(n.kind),
    );
    return {
      chain,
      kind: deleted ? 'deleted' : damaged ? 'unknown' : (container?.kind ?? 'unknown'),
    };
  }
  const classification = new Map(profile.nodes.map((n) => [n.id, ancestry(n)]));
  const saved = (n: BrowserNode) =>
    ['pinned_container', 'favorites'].includes(classification.get(n.id)!.kind);
  const spaceName = (n: BrowserNode) => profile.spaces.find((s) => s.id === n.spaceId)?.title ?? '';
  const pages = (node: BrowserNode) => {
    const result: BrowserPage[] = [],
      todo = [node],
      seen = new Set<string>();
    while (todo.length) {
      const n = todo.pop()!;
      if (seen.has(n.id) || classification.get(n.id)?.kind === 'deleted') continue;
      seen.add(n.id);
      result.push(...n.pages.map((p) => ({ ...p, url: redactURL(p.url) })));
      todo.push(...n.children.map((id) => map.get(id)).filter((n): n is BrowserNode => Boolean(n)));
    }
    return result;
  };
  const savedTabs: SavedUsageTab[] = profile.nodes
    .filter((n) => n.kind === 'tab' && saved(n))
    .map((n) => {
      const a = classification.get(n.id)!;
      const groups = a.chain.filter((n) => n.kind === 'group').reverse();
      const tabPages = pages(n);
      return {
        id: n.entityId,
        nodeId: n.id,
        title: n.title,
        spaceId: n.spaceId,
        spaceName: spaceName(n),
        placement: groups.length ? 'folder' : a.kind === 'favorites' ? 'favorite' : 'pin',
        containerKind: a.kind as 'favorites' | 'pinned_container',
        folderId: groups.at(-1)?.entityId ?? null,
        folderPath: groups.map((n) => n.title),
        pages: tabPages,
        recordedLastActive:
          typeof n.metadata.last_active_date === 'string' ? n.metadata.last_active_date : null,
        matchablePages: tabPages.filter((p) => matchable(p.url)).length,
        exact: emptyMetrics(),
        siteContext: emptyMetrics(),
        rank: 0,
      };
    });
  const savedFolders = profile.nodes
    .filter((n) => n.kind === 'group' && saved(n))
    .map((n) => {
      const groups = classification
        .get(n.id)!
        .chain.filter((n) => n.kind === 'group')
        .reverse();
      return {
        id: n.entityId,
        nodeId: n.id,
        title: n.title,
        spaceId: n.spaceId,
        spaceName: spaceName(n),
        path: groups.map((g) => g.title),
        parentFolderId: groups.at(-2)?.entityId ?? null,
        dynamic: dynamicGroupIds.includes(n.entityId),
        icon: n.icon,
        tabIds: savedTabs.filter((t) => t.folderId === n.entityId).map((t) => t.id),
        descendantTabIds: savedTabs
          .filter((t) => classification.get(t.nodeId)!.chain.some((a) => a.id === n.id))
          .map((t) => t.id),
      };
    });
  const count = (kind: string, category: string) =>
    profile.nodes.filter((n) => n.kind === kind && classification.get(n.id)!.kind === category)
      .length;
  const excluded = {
    windowTabs: count('tab', 'window'),
    windowGroups: count('group', 'window'),
    deletedTabs: count('tab', 'deleted'),
    unclassifiedTabs: count('tab', 'unknown'),
  };
  if (excluded.unclassifiedTabs)
    issues.push(
      `${excluded.unclassifiedTabs} tabs have no trustworthy saved/window container and were excluded.`,
    );
  return { savedTabs, savedFolders, excluded, issues };
}

export function matchArcProfiles(
  dia: ProfileIdentity[],
  arc: ProfileIdentity[],
  explicit: Record<string, string> = {},
): ArcProfileMapping[] {
  for (const id of Object.keys(explicit))
    if (!dia.some((p) => p.id === id)) throw new Error(`Unknown Dia profile in Arc mapping: ${id}`);
  const reserved = new Set<string>();
  for (const [diaId, arcId] of Object.entries(explicit)) {
    if (!arc.some((a) => a.id === arcId))
      throw new Error(`Unknown Arc profile in mapping for ${diaId}`);
    if (reserved.has(arcId))
      throw new Error('An Arc profile cannot be assigned to multiple Dia profiles.');
    reserved.add(arcId);
  }
  const normalized = (s: string) => s.trim().toLocaleLowerCase('en-US');
  return dia.map((p) => {
    if (explicit[p.id] !== undefined) {
      const target = arc.find((a) => a.id === explicit[p.id])!;
      return {
        diaProfileId: p.id,
        arcProfileId: target.id,
        arcProfileName: target.name,
        method: 'explicit',
        candidates: [target.id],
        reason: 'Explicit profile mapping supplied.',
      };
    }
    const candidates =
      p.nameKnown === false
        ? []
        : arc.filter((a) => a.nameKnown !== false && normalized(a.name) === normalized(p.name));
    const uniqueDia =
      dia.filter((d) => d.nameKnown !== false && normalized(d.name) === normalized(p.name))
        .length === 1;
    const target =
      uniqueDia && candidates.length === 1 && !reserved.has(candidates[0].id)
        ? candidates[0]
        : undefined;
    return {
      diaProfileId: p.id,
      arcProfileId: target?.id ?? null,
      arcProfileName: target?.name ?? null,
      method: target ? 'unique-name' : candidates.length ? 'ambiguous' : 'unmatched',
      candidates: candidates.map((c) => c.id),
      reason: target
        ? 'Unique display-name match; profile directory numbers were not used.'
        : candidates.length
          ? 'Profile names are ambiguous or reserved by an explicit mapping; no automatic Arc merge.'
          : 'No unique known Arc display name matches this Dia profile.',
    };
  });
}

/** Cross-browser multiset union: preserve repeated events within a source and subtract only overlap. */
export function mergeVisitEvents(events: Iterable<VisitEvent>): MergedVisitEvent[] {
  const map = new Map<string, MergedVisitEvent>();
  for (const e of events) {
    const key = JSON.stringify([e.url, e.time.toString()]);
    const value = map.get(key) ?? { url: e.url, time: e.time, count: 0, diaCount: 0, arcCount: 0 };
    if (e.source === 'Dia') value.diaCount++;
    else value.arcCount++;
    value.count = Math.max(value.diaCount, value.arcCount);
    map.set(key, value);
  }
  return [...map.values()];
}
export interface VisitDeduplication {
  events: MergedVisitEvent[];
  exactShared: number;
  probableRoundedShared: number;
  ambiguousBuckets: number;
  ambiguousVisits: number;
  exactOnlyCombined: number;
}
/** Secondary matches are an explicit inference about imported second-rounded timestamps. */
export function deduplicateVisitEvents(events: Iterable<VisitEvent>): VisitDeduplication {
  const exact = mergeVisitEvents(events),
    result: MergedVisitEvent[] = [];
  const buckets = new Map<string, { dia: MergedVisitEvent[]; arc: MergedVisitEvent[] }>();
  let exactShared = 0,
    probableRoundedShared = 0,
    ambiguousBuckets = 0,
    ambiguousVisits = 0;
  const exactOnlyCombined = exact.reduce((n, e) => n + e.count, 0);
  for (const e of exact) {
    const shared = Math.min(e.diaCount, e.arcCount);
    exactShared += shared;
    if (shared) result.push({ ...e, count: shared, diaCount: shared, arcCount: shared });
    const key = JSON.stringify([e.url, (e.time / 1000000n).toString()]);
    const bucket = buckets.get(key) ?? { dia: [], arc: [] };
    if (e.diaCount > shared)
      bucket.dia.push({
        ...e,
        count: e.diaCount - shared,
        diaCount: e.diaCount - shared,
        arcCount: 0,
      });
    if (e.arcCount > shared)
      bucket.arc.push({
        ...e,
        count: e.arcCount - shared,
        diaCount: 0,
        arcCount: e.arcCount - shared,
      });
    buckets.set(key, bucket);
  }
  for (const { dia, arc } of buckets.values()) {
    const isRounded = (e: MergedVisitEvent) => e.time % 1000000n === 0n;
    const plausible =
      (dia.some(isRounded) && arc.some((e) => !isRounded(e))) ||
      (arc.some(isRounded) && dia.some((e) => !isRounded(e)));
    if (plausible && dia.length === 1 && arc.length === 1) {
      const d = dia[0],
        a = arc[0];
      probableRoundedShared += Math.min(d.count, a.count);
      result.push({
        url: d.url,
        time: isRounded(d) ? a.time : d.time,
        count: Math.max(d.count, a.count),
        diaCount: d.count,
        arcCount: a.count,
      });
    } else {
      if (plausible) {
        ambiguousBuckets++;
        ambiguousVisits += [...dia, ...arc].reduce((n, e) => n + e.count, 0);
      }
      result.push(...dia, ...arc);
    }
  }
  return {
    events: result,
    exactShared,
    probableRoundedShared,
    ambiguousBuckets,
    ambiguousVisits,
    exactOnlyCombined,
  };
}

export function usageMetrics(
  events: Iterable<MergedVisitEvent>,
  now: Date,
  timezone: string,
): UsageMetrics {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const cutoff30 = toChromium(now.getTime() - 30 * DAY),
    cutoff90 = toChromium(now.getTime() - 90 * DAY),
    end = toChromium(now.getTime());
  const days30 = new Set<string>(),
    days90 = new Set<string>();
  let visits30 = 0,
    visits90 = 0,
    latest: bigint | null = null;
  for (const e of events) {
    if (e.time < cutoff90 || e.time > end) continue;
    const day = formatter.format(new Date(toMilliseconds(e.time)));
    days90.add(day);
    visits90 += e.count;
    if (latest === null || e.time > latest) latest = e.time;
    if (e.time >= cutoff30) {
      days30.add(day);
      visits30 += e.count;
    }
  }
  return {
    days30: days30.size,
    visits30,
    days90: days90.size,
    visits90,
    lastVisit: timestamp(latest),
  };
}

function identities(root: string): ProfileIdentity[] {
  if (!existsSync(root)) return [];
  const names = profileNames(root);
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (d.name === 'Default' || /^Profile \d+$/.test(d.name)))
    .map((d) => ({
      id: d.name,
      name: names[d.name]?.name ?? d.name,
      nameKnown: Boolean(names[d.name]?.name),
    }));
}
function readSavedProfile(
  userData: string,
  identity: ProfileIdentity,
  root: Uint8Array,
): { profile: BrowserProfile; dynamic: string[] } {
  const store = resolveStore(userData, identity.id, 'tabs');
  return readStore(store, root, (db) => {
    const relevant = new Set([
      'nodes',
      'tabs',
      'tab_groups',
      'content_panes',
      'web_contents',
      'supertabs',
      'spaces',
      'live_folders',
    ]);
    const objects = all(
      db,
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type='table'",
    ).filter((r) => relevant.has(r.name));
    for (const required of [
      'nodes',
      'tabs',
      'tab_groups',
      'content_panes',
      'web_contents',
      'spaces',
    ])
      if (!objects.some((o) => o.name === required))
        throw new Error(`Missing required saved-tab table ${required} in ${identity.id}.`);
    const tables = objects.map(
      (object) =>
        ({
          name: object.name,
          columns: all(db, 'SELECT * FROM pragma_table_xinfo(?)', object.name),
          rowCount: Number(
            all(db, `SELECT count(*) AS n FROM ${quoteIdentifier(object.name)}`)[0].n,
          ),
        }) as Table,
    );
    const schema: StoreSchema = {
      id: identity.id,
      path: store.relativePath,
      profile: identity.id,
      family: 'tabs',
      storage: 'SQLCipher',
      context: store.context,
      capturedAt: new Date().toISOString(),
      status: 'ok',
      objects,
      tables,
      jsonSchemas: [],
      data: tables.map((t) => extractTableData(db, t, 'tabs', 0)),
    };
    const dynamic =
      schema
        .data!.find((t) => t.table === 'live_folders')
        ?.rows.map((r) => String(r.group_id?.value ?? '')) ?? [];
    return { profile: buildProfile(schema, identity), dynamic };
  });
}
// Chromium may hold an exclusive connection even while its rollback journal is cold.
// A database+WAL copy is usable only while the journal stays unchanged and has no hot header.
function journalState(path: string): string {
  const journal = path + '-journal';
  if (!existsSync(journal)) return 'absent';
  const stat = statSync(journal, { bigint: true }),
    fd = openSync(journal, 'r');
  const header = Buffer.alloc(8);
  try {
    readSync(fd, header, 0, 8, 0);
  } finally {
    closeSync(fd);
  }
  if (header.some((byte) => byte !== 0))
    throw new Error('History has a nonempty rollback journal header.');
  return [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}
function withHistorySnapshot<T>(path: string, fn: (copy: string) => T): T {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const before = journalState(path);
      return withSnapshot(path, (copy) => {
        if (journalState(path) !== before)
          throw new Error('History journal changed during capture.');
        return fn(copy);
      });
    } catch (error) {
      if (attempt === 4) throw error;
      Bun.sleepSync(50);
    }
  }
  throw new Error('Could not capture History.');
}
function readHistory(
  root: string,
  identity: ProfileIdentity,
  browser: 'Dia' | 'Arc',
  now: Date,
): { coverage: HistoryCoverage; events: VisitEvent[] } {
  const coverage: HistoryCoverage = {
    browser,
    profileId: identity.id,
    profileName: identity.name,
    status: 'missing',
    retainedVisits: 0,
    earliestVisit: null,
    latestVisit: null,
    visits90: 0,
  };
  const path = join(root, identity.id, 'History');
  if (!existsSync(path)) return { coverage, events: [] };
  function read(pathToRead: string): VisitEvent[] {
    const db = openDB(pathToRead, undefined, true);
    try {
      db.exec('BEGIN'); // Schema, coverage and events share a read-only SQLite snapshot.
      const visitColumns = all(db, 'PRAGMA table_info(visits)').map((r) => r.name);
      const urlColumns = all(db, 'PRAGMA table_info(urls)').map((r) => r.name);
      if (
        !['url', 'visit_time'].every((c) => visitColumns.includes(c)) ||
        !['id', 'url'].every((c) => urlColumns.includes(c))
      )
        throw new Error('Unsupported History schema.');
      const retained = all(db, 'SELECT count(*) AS n FROM visits')[0].n;
      const bounds = all(
        db,
        'SELECT min(visit_time) AS earliest,max(visit_time) AS latest FROM visits WHERE visit_time>0',
      )[0];
      const rows = db
        .query(
          'SELECT u.url AS url,v.visit_time AS time FROM visits v JOIN urls u ON u.id=v.url WHERE v.visit_time>=? AND v.visit_time<=?',
        )
        .all(toChromium(now.getTime() - 90 * DAY), toChromium(now.getTime())) as {
        url: string;
        time: bigint;
      }[];
      coverage.status = 'ok';
      coverage.retainedVisits = Number(retained);
      coverage.earliestVisit = timestamp(bounds.earliest);
      coverage.latestVisit = timestamp(bounds.latest);
      coverage.visits90 = rows.length;
      return rows.map((r) => ({ url: r.url, time: BigInt(r.time), source: browser }));
    } finally {
      try {
        db.exec('ROLLBACK');
      } catch {}
      db.close();
    }
  }
  try {
    const events = read(path);
    coverage.readMethod = 'read-only-transaction';
    return { coverage, events };
  } catch (error: any) {
    if (/SQLITE_(BUSY|LOCKED)/.test(String(error?.code))) {
      try {
        const bytes = [path, path + '-wal'].reduce(
          (n, p) => n + (existsSync(p) ? statSync(p).size : 0),
          0,
        );
        if (bytes > 256 * 1024 * 1024) throw new Error('History exceeds bounded snapshot size.');
        const events = withHistorySnapshot(path, (copy) => read(copy));
        coverage.readMethod = 'bounded-stable-snapshot';
        coverage.message =
          'Live History was locked; read a stable database+WAL copy with unchanged cold rollback journal below the 256 MiB fallback limit, then removed it.';
        return { coverage, events };
      } catch {
        coverage.message =
          'History was locked and a bounded stable snapshot could not be read. Quit the browser normally and retry.';
      }
    } else
      coverage.message =
        'History could not be read with the expected schema in a consistent read-only transaction.';
    coverage.status = 'error';
    return { coverage, events: [] };
  }
}

export function analyzeUsage(options: AnalyzeUsageOptions = {}): UsageReport {
  const userData = options.userData ?? USER_DATA;
  const arcUserData =
    options.arcUserData === undefined
      ? join(homedir(), 'Library/Application Support/Arc/User Data')
      : options.arcUserData;
  const now = options.now ?? new Date(),
    timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid analysis date.');
  new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(now);
  if (arcUserData === null && Object.keys(options.arcProfileMap ?? {}).length)
    throw new Error('An Arc profile mapping cannot be supplied when Arc history is disabled.');
  const allDia = identities(userData),
    allArc = arcUserData === null ? [] : identities(arcUserData);
  const diagnostics: string[] = [];
  for (const p of allDia.filter((p) => !existsSync(join(userData, p.id, 'tabs.db'))))
    diagnostics.push(`Dia profile ${p.id} (${p.name}) has no tabs.db and is not included.`);
  for (const p of allArc.filter((p) => !existsSync(join(arcUserData!, p.id, 'History'))))
    diagnostics.push(`Arc profile ${p.id} (${p.name}) has no History file and cannot be merged.`);
  if (arcUserData !== null && !existsSync(arcUserData))
    diagnostics.push('Arc User Data directory is absent; no Arc history was merged.');
  const dia = allDia.filter((p) => existsSync(join(userData, p.id, 'tabs.db')));
  if (!dia.length) throw new Error('No Dia tab stores found.');
  const arc =
    arcUserData === null
      ? []
      : allArc.filter((p) => existsSync(join(arcUserData, p.id, 'History')));
  const mapping =
    arcUserData === null
      ? dia.map(
          (p) =>
            ({
              diaProfileId: p.id,
              arcProfileId: null,
              arcProfileName: null,
              method: 'disabled',
              candidates: [],
              reason: 'Arc history disabled.',
            }) as ArcProfileMapping,
        )
      : matchArcProfiles(dia, arc, options.arcProfileMap);
  const ownRoot = options.root ? null : keychainRoot(),
    root = options.root ?? ownRoot!;
  const profiles: UsageProfile[] = [];
  try {
    for (const identity of dia) {
      const fresh = readSavedProfile(userData, identity, root),
        saved = classifySavedProfile(fresh.profile, fresh.dynamic);
      const arcMapping = mapping.find((m) => m.diaProfileId === identity.id)!;
      const sources = [readHistory(userData, identity, 'Dia', now)];
      if (arcUserData && arcMapping.arcProfileId)
        sources.push(
          readHistory(arcUserData, arc.find((a) => a.id === arcMapping.arcProfileId)!, 'Arc', now),
        );
      const dedup = deduplicateVisitEvents(sources.flatMap((s) => s.events)),
        merged = dedup.events;
      const byURL = new Map<string, MergedVisitEvent[]>(),
        byOrigin = new Map<string, MergedVisitEvent[]>();
      for (const event of merged) {
        if (matchable(event.url)) {
          const a = byURL.get(event.url) ?? [];
          a.push(event);
          byURL.set(event.url, a);
        }
        const o = origin(event.url);
        if (o) {
          const a = byOrigin.get(o) ?? [];
          a.push(event);
          byOrigin.set(o, a);
        }
      }
      for (const tab of saved.savedTabs) {
        const urls = [...new Set(tab.pages.filter((p) => matchable(p.url)).map((p) => p.url))];
        const origins = [...new Set(urls.map(origin).filter((o): o is string => o !== null))];
        tab.exact = usageMetrics(
          urls.flatMap((url) => byURL.get(url) ?? []),
          now,
          timezone,
        );
        tab.siteContext = usageMetrics(
          origins.flatMap((o) => byOrigin.get(o) ?? []),
          now,
          timezone,
        );
      }
      saved.savedTabs.sort(
        (a, b) =>
          b.exact.days30 - a.exact.days30 ||
          b.exact.visits30 - a.exact.visits30 ||
          (b.exact.lastVisit ?? '').localeCompare(a.exact.lastVisit ?? '') ||
          b.exact.days90 - a.exact.days90 ||
          a.id.localeCompare(b.id),
      );
      saved.savedTabs.forEach((t, i) => (t.rank = i + 1));
      profiles.push({
        id: identity.id,
        name: identity.name,
        capturedAt: fresh.profile.capturedAt,
        spaces: fresh.profile.spaces,
        ...saved,
        arcMapping,
        sourceCoverage: sources.map((s) => s.coverage),
        overlap: {
          diaVisits90: merged.reduce((n, e) => n + e.diaCount, 0),
          arcVisits90: merged.reduce((n, e) => n + e.arcCount, 0),
          sharedVisits90: dedup.exactShared + dedup.probableRoundedShared,
          exactSharedVisits90: dedup.exactShared,
          roundedSharedVisits90: dedup.probableRoundedShared,
          ambiguousBuckets90: dedup.ambiguousBuckets,
          ambiguousVisits90: dedup.ambiguousVisits,
          exactOnlyCombinedVisits90: dedup.exactOnlyCombined,
          combinedVisits90: merged.reduce((n, e) => n + e.count, 0),
        },
      });
    }
  } finally {
    ownRoot?.fill(0);
  }
  const assigned = new Set(mapping.map((m) => m.arcProfileId).filter(Boolean));
  return {
    formatVersion: 1,
    generatedAt: now.toISOString(),
    timezone,
    status:
      allDia.length !== dia.length ||
      profiles.some(
        (p) =>
          p.issues.length ||
          p.sourceCoverage.some((s) => s.status !== 'ok') ||
          p.arcMapping.method === 'ambiguous',
      )
        ? 'partial'
        : 'complete',
    scope:
      'Non-deleted saved tabs beneath pinned_container or favorites, including saved folders. Ordinary window tabs and window groups are excluded. Saved tabs count even if currently open.',
    method:
      'Each Arc profile is matched by unique display name or explicit mapping. Exact URL plus exact Chromium microsecond timestamp deduplicates cross-browser events using a multiset union; same-source multiplicity is preserved. A secondary probable-import match merges a unique remaining timestamp per browser at the same URL/second only when one timestamp is whole-second aligned and the other fractional; ambiguous buckets remain separate. Both exact-only and adjusted totals are reported. Rank by distinct local calendar days visited in rolling 30 days, then visits, recency, and 90-day days. Site context uses matching URL origins and is not attributed to the saved tab.',
    limitations: [
      'History records URL visits, not tab-focus switches, reading time, or which duplicate tab instance was used.',
      'Visits can include reloads, redirects, and synced/imported history. Secondary rounded-import matches are an inference, not proof; exact-only totals show the alternate count. Other differing timestamps cannot be deduplicated reliably.',
      'No exact URL match does not mean unused; saved landing links may differ from visited app routes. Credential-redacted and non-HTTP URLs are not exact-matched.',
      'Matching-origin site context can include unrelated pages and must not be treated as exact-tab usage.',
      'Rolling 30/90-day intervals can intersect 31/91 local calendar dates. Retained history does not guarantee continuous coverage.',
      'Saved tab stores and each History database are read consistently but different sources are not captured atomically. Locked History files can use a stable database+WAL copy capped at 256 MiB; read method is reported and temporary copies are removed. No live data is modified.',
    ],
    diagnostics,
    profiles,
    arcProfiles: arc,
    unmatchedArcProfiles: arc.filter((a) => !assigned.has(a.id)),
  };
}
