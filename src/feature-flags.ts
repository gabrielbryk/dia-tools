import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BACKUPS, requireClosed } from './store';

export const FLAG_DOMAIN = 'company.thebrowser.dia';
export const FLAG_KEY = 'transientFeatureFlagOverrides';
export type FlagPlan = {
  kind: 'dia-feature-flag';
  version: 1;
  flag: string;
  value: string | null;
  before: string | null;
  after: string | null;
};

export function parseOverrides(raw: string | null): Map<string, string> {
  const entries = new Map<string, string>();
  if (raw === null || raw === '') return entries;
  if (typeof raw !== 'string') throw new Error('Override preference must be a string.');
  for (const entry of raw.split('|')) {
    const parts = entry.split('=');
    if (parts.length !== 2 || !/^[a-zA-Z0-9_.-]+$/.test(parts[0]) || entries.has(parts[0]))
      throw new Error('Malformed or duplicate override; inspect before editing.');
    entries.set(parts[0], parts[1]);
  }
  return entries;
}

export function flagPlan(before: string | null, flag: string, value: string | null): FlagPlan {
  if (typeof flag !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(flag))
    throw new Error('Invalid flag name.');
  if (value !== null && (typeof value !== 'string' || /[|=\r\n\0]/.test(value)))
    throw new Error('Flag values must be strings without separators or newlines.');
  const entries = parseOverrides(before);
  if ((value === null && !entries.has(flag)) || entries.get(flag) === value)
    return { kind: 'dia-feature-flag', version: 1, flag, value, before, after: before };
  if (value === null) entries.delete(flag);
  else entries.set(flag, value);
  const after = entries.size ? [...entries].map(([k, v]) => `${k}=${v}`).join('|') : null;
  return { kind: 'dia-feature-flag', version: 1, flag, value, before, after };
}

export function validateFlagPlan(raw: unknown): FlagPlan {
  const p = raw as FlagPlan;
  if (
    !p ||
    p.kind !== 'dia-feature-flag' ||
    p.version !== 1 ||
    (p.before !== null && typeof p.before !== 'string')
  )
    throw new Error('Invalid flag plan.');
  const rebuilt = flagPlan(p.before, p.flag, p.value);
  if (p.after !== rebuilt.after) throw new Error('Flag plan changes unrelated overrides.');
  return rebuilt;
}

function run(args: string[], input?: Uint8Array): string {
  const r = Bun.spawnSync(args, { stdin: input, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`Preference command failed: ${args[0]} ${args[1]}`);
  return r.stdout.toString();
}

export function overridesFromPlist(plist: Uint8Array): string | null {
  // Validate first; unrelated date/data values cannot be converted wholesale to JSON.
  run(['/usr/bin/plutil', '-lint', '-'], plist);
  const type = Bun.spawnSync(['/usr/bin/plutil', '-type', FLAG_KEY, '-'], {
    stdin: plist,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (type.exitCode !== 0) {
    if (type.exitCode === 1 && type.stderr.toString().includes('No value at that key path'))
      return null;
    throw new Error('Cannot inspect the override preference type.');
  }
  if (type.stdout.toString().trim() !== 'string')
    throw new Error('Override preference must be a string.');
  const raw = run(
    ['/usr/bin/plutil', '-extract', FLAG_KEY, 'raw', '-expect', 'string', '-n', '-o', '-', '-'],
    plist,
  );
  parseOverrides(raw);
  return raw;
}

export function readOverrides(): string | null {
  if (process.platform !== 'darwin') throw new Error('Dia preferences require macOS.');
  // Export to distinguish an absent key from a preferences-service failure; never print the domain.
  return overridesFromPlist(Buffer.from(run(['/usr/bin/defaults', 'export', FLAG_DOMAIN, '-'])));
}

export function applyFlagPlan(raw: unknown, writeLive: boolean, backupDir = BACKUPS) {
  const plan = validateFlagPlan(raw);
  if (!writeLive) return { dryRun: true, plan };
  requireClosed();
  if (readOverrides() !== plan.before)
    throw new Error('Override preference changed; regenerate the plan.');
  if (plan.before === plan.after) return { changed: false, plan };
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backup = join(backupDir, `feature-flag-${randomUUID()}.json`);
  writeFileSync(backup, JSON.stringify({ domain: FLAG_DOMAIN, key: FLAG_KEY, ...plan }, null, 2), {
    flag: 'wx',
    mode: 0o600,
  });
  requireClosed();
  if (readOverrides() !== plan.before) throw new Error('Override preference changed after backup.');
  if (plan.after === null) run(['/usr/bin/defaults', 'delete', FLAG_DOMAIN, FLAG_KEY]);
  else run(['/usr/bin/defaults', 'write', FLAG_DOMAIN, FLAG_KEY, '-string', plan.after]);
  if (readOverrides() !== plan.after)
    throw new Error(`Override readback failed. Backup: ${backup}`);
  return { changed: true, backup, plan, persisted: true, uiVerified: false };
}
