import type { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import { deriveDatabaseKey } from './crypto';
import {
  all,
  discover,
  openDB,
  readStore,
  resolveStore,
  validate,
  withSnapshot,
  writeStore,
} from './store';

export type LinkRule = {
  host: string;
  matchScope: 'exact_host' | 'host_and_subdomains';
  spaceID: string;
};
export type RuleKey = Pick<LinkRule, 'host' | 'matchScope'>;
export type RuleChanges = { upsert: LinkRule[]; remove: RuleKey[] };
export type RulePlan = {
  kind: 'dia-link-rules';
  version: 1;
  userData: string;
  changes: RuleChanges;
  before: LinkRule[];
  after: LinkRule[];
  destinations: { id: string; title: string; profile: string }[];
};
const key = (r: RuleKey) => `${r.host}|${r.matchScope}`;
const canonical = (rules: LinkRule[]) => [...rules].sort((a, b) => key(a).localeCompare(key(b)));
const same = (a: LinkRule[], b: LinkRule[]) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function validateRule(raw: unknown, destination = true): LinkRule {
  const r = raw as LinkRule;
  if (
    !r ||
    typeof r.host !== 'string' ||
    r.host.length > 253 ||
    !r.host.split('.').every((s) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s)) ||
    !['exact_host', 'host_and_subdomains'].includes(r.matchScope) ||
    (destination && (typeof r.spaceID !== 'string' || !r.spaceID.trim()))
  )
    throw new Error(
      'Invalid rule: use a lowercase hostname, supported scope, and current space ID.',
    );
  if (new URL('https://' + r.host).hostname !== r.host)
    throw new Error('Host is not canonical. Do not include a URL, path, wildcard, or port.');
  if (/^[\d.]+$/.test(r.host) && r.matchScope !== 'exact_host')
    throw new Error('IP addresses require exact_host.');
  return { host: r.host, matchScope: r.matchScope, spaceID: r.spaceID };
}

function ruleSet(raw: unknown): LinkRule[] {
  if (!Array.isArray(raw)) throw new Error('Rules must be an array.');
  const rules = raw.map((r) => validateRule(r));
  if (new Set(rules.map(key)).size !== rules.length) throw new Error('Duplicate rule keys.');
  return canonical(rules);
}

export function changeRules(
  before: LinkRule[],
  raw: unknown,
): { changes: RuleChanges; after: LinkRule[] } {
  const c = raw as RuleChanges;
  if (
    !c ||
    typeof c !== 'object' ||
    Object.keys(c).some((k) => !['upsert', 'remove'].includes(k)) ||
    (c.upsert !== undefined && !Array.isArray(c.upsert)) ||
    (c.remove !== undefined && !Array.isArray(c.remove))
  )
    throw new Error('Use {upsert: [], remove: []}.');
  const changes: RuleChanges = {
    upsert: (c.upsert ?? []).map((r) => validateRule(r)),
    remove: (c.remove ?? []).map((r) => {
      const v = validateRule(r, false);
      return { host: v.host, matchScope: v.matchScope };
    }),
  };
  const touched = [...changes.upsert, ...changes.remove].map(key);
  if (!touched.length || new Set(touched).size !== touched.length)
    throw new Error('Empty or conflicting changes.');
  const next = new Map(ruleSet(before).map((r) => [key(r), r]));
  for (const r of changes.remove)
    if (!next.delete(key(r))) throw new Error(`Cannot remove missing rule: ${key(r)}`);
  for (const r of changes.upsert) next.set(key(r), r);
  const after = canonical([...next.values()]);
  for (const a of after)
    for (const b of after) {
      if (
        a.spaceID !== b.spaceID &&
        (a.host === b.host ||
          (b.matchScope === 'host_and_subdomains' && a.host.endsWith('.' + b.host)))
      )
        throw new Error(
          `Cross-space overlap: ${a.host} and ${b.host}. Use nonoverlapping exact hosts.`,
        );
    }
  return { changes, after };
}

export function readRules(db: Database): LinkRule[] {
  const columns = all(db, 'PRAGMA table_info(external_link_destination_rules)');
  if (
    columns.length !== 3 ||
    !['host', 'match_scope', 'space_id'].every((n) =>
      columns.some((c) => c.name === n && c.type === 'TEXT' && c.notnull === 1),
    ) ||
    columns.find((c) => c.name === 'host')?.pk !== 1 ||
    columns.find((c) => c.name === 'match_scope')?.pk !== 2
  )
    throw new Error('Unsupported link-rule schema; inspect this Dia version before editing.');
  return ruleSet(
    all(db, 'SELECT host,match_scope,space_id FROM external_link_destination_rules').map((r) => ({
      host: r.host,
      matchScope: r.match_scope,
      spaceID: r.space_id,
    })),
  );
}

export function listSpaces(userData: string, root: Uint8Array) {
  return discover(userData)
    .filter((s) => s.family === 'tabs')
    .flatMap((s) =>
      readStore(s, root, (db) =>
        all(db, 'SELECT id,title FROM spaces').map((r) => ({
          id: String(r.id),
          title: String(r.title),
          profile: s.profile,
        })),
      ),
    );
}

function checkSpaces(plan: RulePlan, spaces: RulePlan['destinations']) {
  for (const r of plan.after) {
    const current = spaces.find((s) => s.id === r.spaceID),
      approved = plan.destinations.find((s) => s.id === r.spaceID);
    if (
      !current ||
      !approved ||
      current.title !== approved.title ||
      current.profile !== approved.profile
    )
      throw new Error('Destination space changed; regenerate the plan.');
  }
}

export function planRules(userData: string, root: Uint8Array, changes: unknown): RulePlan {
  const before = readStore(
    resolveStore(userData, 'Global', 'external_link_rules'),
    root,
    readRules,
  );
  const updated = changeRules(before, changes);
  const plan: RulePlan = {
    kind: 'dia-link-rules',
    version: 1,
    userData: resolve(userData),
    before,
    ...updated,
    destinations: listSpaces(userData, root),
  };
  checkSpaces(plan, plan.destinations);
  return plan;
}

export function validateRulePlan(raw: unknown, userData: string): RulePlan {
  const p = raw as RulePlan;
  if (
    !p ||
    p.kind !== 'dia-link-rules' ||
    p.version !== 1 ||
    p.userData !== resolve(userData) ||
    !Array.isArray(p.destinations)
  )
    throw new Error('Invalid plan or different User Data root.');
  const before = ruleSet(p.before),
    after = ruleSet(p.after),
    rebuilt = changeRules(before, p.changes);
  if (!same(after, rebuilt.after)) throw new Error('Plan does not match its scoped changes.');
  return { ...p, before, after, changes: rebuilt.changes };
}

export function updateRules(db: Database, plan: RulePlan) {
  if (!same(readRules(db), plan.before)) throw new Error('Rules changed; regenerate the plan.');
  for (const r of plan.changes.remove)
    db.query('DELETE FROM external_link_destination_rules WHERE host=? AND match_scope=?').run(
      r.host,
      r.matchScope,
    );
  for (const r of plan.changes.upsert)
    db.query(
      'INSERT INTO external_link_destination_rules(host,match_scope,space_id) VALUES (?,?,?) ON CONFLICT(host,match_scope) DO UPDATE SET space_id=excluded.space_id',
    ).run(r.host, r.matchScope, r.spaceID);
  if (!same(readRules(db), plan.after)) throw new Error('Rule readback mismatch.');
  validate(db);
  return { ruleCount: plan.after.length };
}

export function applyRules(
  raw: unknown,
  userData: string,
  root: Uint8Array,
  writeLive: boolean,
  backupDir?: string,
) {
  const plan = validateRulePlan(raw, userData),
    store = resolveStore(userData, 'Global', 'external_link_rules');
  checkSpaces(plan, listSpaces(userData, root));
  withSnapshot(store.path, (copy) => {
    const key = deriveDatabaseKey(root, store.context),
      db = openDB(copy, key, false);
    try {
      db.transaction(() => updateRules(db, plan)).immediate();
    } finally {
      db.close();
      key.fill(0);
    }
  });
  if (!writeLive) return { dryRun: true, copyValidated: true, ruleCount: plan.after.length };
  const result = writeStore(store, root, { writeLive, userData, backupDir }, (db) => {
    checkSpaces(plan, listSpaces(userData, root));
    return updateRules(db, plan);
  });
  return { ...result, plan, persisted: true, uiVerified: false };
}

export function verifyRules(raw: unknown, userData: string, root: Uint8Array) {
  const plan = validateRulePlan(raw, userData);
  checkSpaces(plan, listSpaces(userData, root));
  const rules = readStore(resolveStore(userData, 'Global', 'external_link_rules'), root, readRules);
  if (!same(rules, plan.after)) throw new Error('Current rules differ from plan.');
  return { persisted: true, ruleCount: rules.length, uiVerified: false };
}
