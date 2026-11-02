import type { Database } from 'bun:sqlite';
import { writeFileSync } from 'node:fs';
import {
  all,
  discover,
  jsonString,
  profileName,
  readStore,
  requireClosed,
  resolveStore,
  writeStore,
} from './store';
export type Icon = { symbol: string } | { emoji: string };
export interface Folder {
  id: string;
  title: string | null;
  icon: string | null;
  icon_source: string | null;
  deleted_at: string | null;
}
export interface Change {
  profile: string;
  id: string;
  title: string | null;
  before: { icon: string | null; icon_source: string | null };
  after: { icon: string; icon_source: string | null };
}
export interface FolderPlan {
  version: 1;
  operation: 'folder-icons';
  createdAt: string;
  changes: Change[];
}
export function iconJSON(icon: unknown): string {
  if (!icon || typeof icon !== 'object' || Array.isArray(icon))
    throw new Error('Icon must be an object.');
  const keys = Object.keys(icon);
  const k = keys[0];
  const value = (icon as any)[k];
  if (
    keys.length !== 1 ||
    !['symbol', 'emoji'].includes(k) ||
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 200
  )
    throw new Error('Use exactly one symbol or emoji string.');
  return JSON.stringify({ [k]: value });
}
export function folderRows(db: Database): Folder[] {
  return all(
    db,
    'SELECT g.id,g.title,g.icon,g.icon_source,n.deleted_at FROM tab_groups g JOIN nodes n ON n.id=g.node_id ORDER BY g.title,g.id',
  ) as Folder[];
}
export function listFolders(userData: string, root: Uint8Array, profile = 'all') {
  if (profile !== 'all') profileName(profile);
  return discover(userData)
    .filter((s) => s.family === 'tabs' && (profile === 'all' || s.profile === profile))
    .flatMap((s) =>
      readStore(s, root, (db) => folderRows(db)).map((f) => ({ profile: s.profile, ...f })),
    );
}
export function planFolders(
  userData: string,
  root: Uint8Array,
  options: {
    profile: string;
    symbol?: string;
    emoji?: string;
    fromEmoji?: string;
    id?: string;
    referenceId?: string;
    referenceProfile?: string;
  },
): FolderPlan {
  let icon: string;
  if (options.referenceId) {
    const matches = listFolders(userData, root, options.referenceProfile ?? options.profile).filter(
      (f) => f.id === options.referenceId && !f.deleted_at,
    );
    if (matches.length !== 1 || !matches[0].icon)
      throw new Error('Reference ID must identify one active folder.');
    icon = iconJSON(JSON.parse(matches[0].icon));
  } else {
    if (Boolean(options.symbol) === Boolean(options.emoji))
      throw new Error('Choose one --symbol, --emoji, or --reference-id.');
    icon = iconJSON(options.symbol ? { symbol: options.symbol } : { emoji: options.emoji });
  }
  const folders = listFolders(userData, root, options.profile);
  if (options.id && folders.filter((f) => f.id === options.id && !f.deleted_at).length !== 1)
    throw new Error('Folder ID must identify one active folder.');
  const changes = folders
    .filter((f) => {
      if (f.deleted_at || (options.id && f.id !== options.id)) return false;
      if (options.id) return f.icon !== icon || f.icon_source !== 'userGenerated';
      try {
        return JSON.parse(f.icon ?? '{}').emoji === (options.fromEmoji ?? '📁') && f.icon !== icon;
      } catch {
        return false;
      }
    })
    .map((f) => ({
      profile: f.profile,
      id: f.id,
      title: f.title,
      before: { icon: f.icon, icon_source: f.icon_source },
      after: { icon, icon_source: 'userGenerated' },
    }));
  return { version: 1, operation: 'folder-icons', createdAt: new Date().toISOString(), changes };
}
export function parsePlan(input: unknown): FolderPlan {
  const p = input as FolderPlan;
  if (!p || p.version !== 1 || p.operation !== 'folder-icons' || !Array.isArray(p.changes))
    throw new Error('Invalid folder plan.');
  const ids = new Set<string>();
  for (const c of p.changes) {
    if (
      !c ||
      typeof c.profile !== 'string' ||
      typeof c.id !== 'string' ||
      !c.id ||
      !(c.title === null || typeof c.title === 'string') ||
      !c.before ||
      !c.after
    )
      throw new Error('Invalid folder change.');
    resolveStore('.', c.profile, 'tabs');
    const id = c.profile + '/' + c.id;
    if (ids.has(id)) throw new Error('Duplicate folder change.');
    ids.add(id);
    if (
      !(c.before.icon === null || typeof c.before.icon === 'string') ||
      !(c.before.icon_source === null || typeof c.before.icon_source === 'string') ||
      !(c.after.icon_source === null || typeof c.after.icon_source === 'string')
    )
      throw new Error('Invalid icon metadata.');
    iconJSON(JSON.parse(c.after.icon));
  }
  return p;
}
function assertBefore(db: Database, changes: Change[]) {
  const current = new Map(folderRows(db).map((f) => [f.id, f]));
  for (const c of changes) {
    const f = current.get(c.id);
    if (
      !f ||
      f.deleted_at ||
      f.title !== c.title ||
      f.icon !== c.before.icon ||
      f.icon_source !== c.before.icon_source
    )
      throw new Error(`Folder ${c.id} changed since planning. Regenerate the plan.`);
  }
}
export function updateFolders(db: Database, changes: Change[]) {
  assertBefore(db, changes);
  for (const c of changes) {
    const r = db
      .query(
        'UPDATE tab_groups SET icon=?,icon_source=? WHERE id=? AND icon IS ? AND icon_source IS ?',
      )
      .run(c.after.icon, c.after.icon_source, c.id, c.before.icon, c.before.icon_source);
    if (r.changes !== 1) throw new Error('Folder update conflict.');
  }
  verifyRows(db, changes);
}
function verifyRows(db: Database, changes: Change[]) {
  const current = new Map(folderRows(db).map((f) => [f.id, f]));
  for (const c of changes) {
    const f = current.get(c.id);
    if (!f || f.icon !== c.after.icon || f.icon_source !== c.after.icon_source)
      throw new Error(`Folder ${c.id} does not match the planned icon.`);
  }
}
export function applyFolders(
  plan: FolderPlan,
  root: Uint8Array,
  options: { userData: string; writeLive?: boolean; backupDir?: string; receipt: string },
) {
  parsePlan(plan);
  if (!options.writeLive) throw new Error('Applying a folder plan requires --write-live.');
  requireClosed();
  const profiles = [...new Set(plan.changes.map((c) => c.profile))];
  for (const p of profiles)
    readStore(resolveStore(options.userData, p, 'tabs'), root, (db) =>
      assertBefore(
        db,
        plan.changes.filter((c) => c.profile === p),
      ),
    );
  const receipt: { operation: string; completed: boolean; profiles: unknown[] } = {
    operation: 'folder-icons',
    completed: false,
    profiles: [],
  };
  writeFileSync(options.receipt, jsonString(receipt), { mode: 0o600, flag: 'wx' });
  for (const p of profiles) {
    const changes = plan.changes.filter((c) => c.profile === p);
    const r = writeStore(resolveStore(options.userData, p, 'tabs'), root, options, (db) => {
      updateFolders(db, changes);
      return { count: changes.length };
    });
    receipt.profiles.push({ profile: p, ...r });
    writeFileSync(options.receipt, jsonString(receipt), { mode: 0o600 });
  }
  receipt.completed = true;
  writeFileSync(options.receipt, jsonString(receipt), { mode: 0o600 });
  return receipt;
}
export function verifyFolders(plan: FolderPlan, userData: string, root: Uint8Array) {
  parsePlan(plan);
  for (const p of new Set(plan.changes.map((c) => c.profile)))
    readStore(resolveStore(userData, p, 'tabs'), root, (db) =>
      verifyRows(
        db,
        plan.changes.filter((c) => c.profile === p),
      ),
    );
  return { verified: plan.changes.length };
}
