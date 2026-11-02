import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fixture } from './fixtures';
import { changeSetting } from '../src/settings';
const cli = join(import.meta.dir, '../src/cli.ts');
test('CLI help and synthetic self-test need no user profile or Keychain', () => {
  const result = Bun.spawnSync([process.execPath, cli, 'self-test'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString()).passed).toBe(true);
  const help = Bun.spawnSync([process.execPath, cli, 'folders', 'plan', '--help'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain('--reference-id');
});
test('settings dry run computes a JSON patch without changing encrypted file', () => {
  const f = fixture();
  try {
    const s = f.settings();
    const before = readFileSync(s.store.path);
    const result = changeSetting(s.store, f.root, 'layout.preferences', '420', {
      type: 'json',
      field: 'width',
      userData: f.directory,
    });
    expect(result.mode).toBe('dry-run');
    expect(result.value).toEqual({ width: 420, nested: { mode: 'sidebar' }, list: [] });
    expect(readFileSync(s.store.path)).toEqual(before);
  } finally {
    f.cleanup();
  }
});
