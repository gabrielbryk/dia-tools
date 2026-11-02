#!/usr/bin/env bun
import { Command } from 'commander';
import packageInfo from '../package.json';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { keychainRoot } from './crypto';
import {
  all,
  BACKUPS,
  backupStore,
  diaRunning,
  discover,
  jsonString,
  readStore,
  resolveStore,
  USER_DATA,
} from './store';
import { changeSetting, decode, getValue, listSettings, type Encoding } from './settings';
import { applyFolders, listFolders, parsePlan, planFolders, verifyFolders } from './folders';
import { extract, exportCatalog } from './schema';
import { explorerHTML } from './explorer';
import { loadSQLCipher } from './native';
import { selfTest } from './self-test';
import {
  applyFlagPlan,
  flagPlan,
  parseOverrides,
  readOverrides,
  validateFlagPlan,
} from './feature-flags';
import { applyRules, listSpaces, planRules, readRules, verifyRules } from './link-rules';
import type { Store } from './types';
import { registerUsageCommand } from './usage-command';
const print = (value: unknown) => console.log(jsonString(value));
const cli = new Command()
  .name('dia-tools')
  .description(
    'Inspect and edit local Dia stores. Reads use encrypted snapshots; writes require Dia closed and --write-live.',
  )
  .version(packageInfo.version)
  .option('--user-data <path>', 'Dia User Data root', USER_DATA)
  .option(
    '--backup-dir <path>',
    'Backup directory (encrypted stores or feature-preference JSON)',
    BACKUPS,
  );
const rootOptions = () => cli.opts<{ userData: string; backupDir: string }>();
function withRoot<T>(fn: (root: Buffer) => T): T {
  const key = keychainRoot();
  try {
    return fn(key);
  } finally {
    key.fill(0);
  }
}
function selection(options: any, defaultFamily?: string): Store {
  if (options.db) {
    if (!options.context)
      throw new Error(
        '--db requires the original --context (global/FAMILY or profile/PROFILE/FAMILY).',
      );
    return {
      path: resolve(options.db),
      relativePath: options.db,
      profile: 'Copy',
      family: 'copy',
      context: options.context,
    };
  }
  if (options.context) throw new Error('--context is only used with --db.');
  return resolveStore(
    rootOptions().userData,
    options.profile,
    options.family ??
      defaultFamily ??
      (options.profile === 'Global' ? 'global_key_value_store' : 'key_value_store'),
  );
}
function target(c: Command) {
  return c
    .option('--profile <name>', 'Global, Default, or Profile N', 'Global')
    .option('--family <name>', 'Database filename without .db')
    .option('--db <path>', 'Read an encrypted copy')
    .option('--context <context>', 'Original derivation context for --db');
}
function version(): string {
  const p = '/Applications/Dia.app/Contents/Info.plist';
  if (!existsSync(p)) return 'unknown';
  const r = Bun.spawnSync(
    ['/usr/libexec/PlistBuddy', '-c', 'Print :CFBundleShortVersionString', p],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  return r.exitCode === 0 ? r.stdout.toString().trim() : 'unknown';
}
cli
  .command('doctor')
  .description('Check runtime and SQLCipher without reading Keychain')
  .action(() => {
    loadSQLCipher();
    print({
      platform: process.platform,
      architecture: process.arch,
      diaVersion: version(),
      userDataExists: existsSync(rootOptions().userData),
      diaRunning: process.platform === 'darwin' ? diaRunning() : null,
      sqlcipher: 'available',
    });
  });
cli
  .command('self-test')
  .description('Test encryption and copy editing with synthetic data; no Keychain access')
  .action(() => print(selfTest()));
cli
  .command('stores')
  .description('List database files and derivation contexts; no stored values')
  .action(() => print(discover(rootOptions().userData).map(({ path, ...s }) => s)));
target(cli.command('check').description('Validate one database through a snapshot')).action(
  (options) =>
    withRoot((root) => {
      readStore(selection(options), root, () => {});
      print({ integrity: 'ok' });
    }),
);
target(cli.command('sql-schema').description('Print one database’s SQL definitions')).action(
  (options) =>
    withRoot((root) =>
      print(
        readStore(selection(options), root, (db) =>
          all(db, 'SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name'),
        ),
      ),
    ),
);
const settings = cli.command('settings').description('Read, replace, or patch key/value settings');
target(settings.command('list').description('List keys and encodings without values')).action(
  (options) => withRoot((root) => print(readStore(selection(options), root, listSettings))),
);
target(settings.command('get <key>').description('Read one explicitly selected value'))
  .requiredOption('--type <encoding>', 'bool, string, json, hex, int64, float64')
  .action((key, options) =>
    withRoot((root) => {
      const value = readStore(selection(options), root, (db) => getValue(db, key));
      if (value === null) throw new Error('Unknown key.');
      print(decode(value, options.type as Encoding));
    }),
  );
for (const patch of [false, true]) {
  const command = target(
    settings
      .command(patch ? 'patch <key> <field> <value>' : 'set <key> <value>')
      .description(
        patch
          ? 'Patch an existing JSON object field; dry run unless --write-live'
          : 'Replace an explicitly encoded value; dry run unless --write-live',
      ),
  ).option('--write-live', 'Apply with encrypted backup; Dia must be closed');
  if (!patch)
    command
      .requiredOption('--type <encoding>', 'bool, string, json, hex, int64, float64')
      .option('--create', 'Allow a new key');
  command.action((...args: any[]) => {
    const [key, a, b, c] = args;
    const options = patch ? c : b;
    if (options.db) throw new Error('Settings edits select --profile/--family; --db is read-only.');
    withRoot((root) =>
      print(
        changeSetting(selection(options), root, key, patch ? b : a, {
          ...rootOptions(),
          ...options,
          type: patch ? 'json' : options.type,
          field: patch ? a : undefined,
        }),
      ),
    );
  });
}
const folders = cli.command('folders').description('Plan, apply, and verify folder icons');
folders
  .command('list')
  .option('--profile <name>', 'Profile or all', 'all')
  .action((options) =>
    withRoot((root) => print(listFolders(rootOptions().userData, root, options.profile))),
  );
folders
  .command('plan')
  .description('Generate a reviewable icon plan; default selection is active 📁 folders')
  .option('--profile <name>', 'Profile or all', 'all')
  .option('--symbol <name>', 'Dia symbol identifier, e.g. folder')
  .option('--emoji <text>', 'Emoji icon')
  .option('--from-emoji <text>', 'Only replace this emoji', '📁')
  .option('--id <id>', 'Select one exact folder ID instead of emoji matching')
  .option('--reference-id <id>', 'Copy a known-good folder icon')
  .option('--reference-profile <name>', 'Profile containing reference')
  .requiredOption('--out <path>', 'New plan JSON file')
  .action((options) =>
    withRoot((root) => {
      if (options.referenceId && (options.symbol || options.emoji))
        throw new Error('Use a reference or an explicit icon, not both.');
      const plan = planFolders(rootOptions().userData, root, options);
      writeFileSync(options.out, jsonString(plan), { mode: 0o600, flag: 'wx' });
      print({ plan: resolve(options.out), changes: plan.changes.length });
    }),
  );
folders
  .command('apply <plan>')
  .option('--write-live', 'Apply the plan; Dia must be closed')
  .requiredOption('--receipt <path>', 'New progress receipt with encrypted backup paths')
  .action((path, options) => {
    const plan = parsePlan(JSON.parse(readFileSync(path, 'utf8')));
    withRoot((root) => print(applyFolders(plan, root, { ...rootOptions(), ...options })));
  });
folders
  .command('verify <plan>')
  .description('Verify planned icons, including after a browser restart')
  .action((path) => {
    const plan = parsePlan(JSON.parse(readFileSync(path, 'utf8')));
    withRoot((root) => print(verifyFolders(plan, rootOptions().userData, root)));
  });
cli
  .command('explore')
  .description('Export an offline profile explorer with folders, pages, records, and schemas')
  .requiredOption('--out <directory>', 'Fresh local output directory')
  .option('--row-limit <number>', 'Maximum rows per table; 0 exports all rows', '0')
  .option('--open', 'Open the offline profile explorer')
  .action((options) =>
    withRoot((root) => {
      const catalog = extract(
        rootOptions().userData,
        root,
        version(),
        (message) => console.error(message),
        { includeData: true, rowLimit: Number(options.rowLimit) },
      );
      exportCatalog(catalog, resolve(options.out), explorerHTML(catalog));
      print({
        output: resolve(options.out),
        ...catalog.summary,
        dataCoverage: catalog.dataCoverage,
      });
      if (options.open && process.platform === 'darwin')
        Bun.spawnSync(['/usr/bin/open', join(resolve(options.out), 'dia-schema-explorer.html')]);
      if (catalog.summary.readableDatabases !== catalog.summary.databases) process.exitCode = 1;
    }),
  );
const schemas = cli.command('schema').description('Extract SQL metadata and inferred JSON schemas');
schemas
  .command('extract')
  .requiredOption('--out <directory>', 'Fresh output directory')
  .option('--open', 'Open the offline explorer in the default browser')
  .action((options) =>
    withRoot((root) => {
      const catalog = extract(rootOptions().userData, root, version(), (message) =>
        console.error(message),
      );
      exportCatalog(catalog, resolve(options.out), explorerHTML(catalog));
      print({ output: resolve(options.out), ...catalog.summary });
      if (options.open && process.platform === 'darwin')
        Bun.spawnSync(['/usr/bin/open', join(resolve(options.out), 'dia-schema-explorer.html')]);
      if (catalog.summary.readableDatabases !== catalog.summary.databases) process.exitCode = 1;
    }),
  );
const flags = cli
  .command('feature-flags')
  .description('Plan and edit local hidden-feature overrides');
flags.command('list').action(() => print(Object.fromEntries(parseOverrides(readOverrides()))));
flags
  .command('plan <flag> [value]')
  .option('--remove', 'Remove this override instead of setting a value')
  .requiredOption('--out <file>', 'New plan file')
  .action((flag, value, options) => {
    if (Boolean(options.remove) === (value !== undefined))
      throw new Error('Supply a value OR --remove.');
    const plan = flagPlan(readOverrides(), flag, options.remove ? null : value);
    writeFileSync(resolve(options.out), jsonString(plan), { flag: 'wx', mode: 0o600 });
    print(plan);
  });
flags
  .command('apply <plan>')
  .option('--write-live', 'Apply the reviewed plan; Dia must be closed')
  .action((path, options) =>
    print(
      applyFlagPlan(
        JSON.parse(readFileSync(path, 'utf8')),
        Boolean(options.writeLive),
        rootOptions().backupDir,
      ),
    ),
  );
flags.command('verify <plan>').action((path) => {
  const plan = validateFlagPlan(JSON.parse(readFileSync(path, 'utf8')));
  if (readOverrides() !== plan.after) throw new Error('Current overrides differ from plan.');
  print({ persisted: true, uiVerified: false });
});

const links = cli
  .command('link-rules')
  .description('Inspect, plan, apply, and verify incoming-link rules');
links.command('list').action(() =>
  withRoot((root) =>
    print({
      spaces: listSpaces(rootOptions().userData, root),
      rules: readStore(
        resolveStore(rootOptions().userData, 'Global', 'external_link_rules'),
        root,
        readRules,
      ),
    }),
  ),
);
links
  .command('plan <changes>')
  .requiredOption('--out <file>', 'New plan file')
  .action((path, options) =>
    withRoot((root) => {
      const plan = planRules(rootOptions().userData, root, JSON.parse(readFileSync(path, 'utf8')));
      writeFileSync(resolve(options.out), jsonString(plan), { flag: 'wx', mode: 0o600 });
      print(plan);
    }),
  );
links
  .command('apply <plan>')
  .option('--write-live', 'Apply with encrypted backup; Dia must be closed')
  .action((path, options) =>
    withRoot((root) =>
      print(
        applyRules(
          JSON.parse(readFileSync(path, 'utf8')),
          rootOptions().userData,
          root,
          Boolean(options.writeLive),
          rootOptions().backupDir,
        ),
      ),
    ),
  );
links
  .command('verify <plan>')
  .action((path) =>
    withRoot((root) =>
      print(verifyRules(JSON.parse(readFileSync(path, 'utf8')), rootOptions().userData, root)),
    ),
  );

target(
  cli.command('backup').description('Create a validated encrypted snapshot and context manifest'),
).action((options) =>
  withRoot((root) =>
    print({ backup: backupStore(selection(options), root, rootOptions().backupDir) }),
  ),
);
registerUsageCommand(cli);
try {
  await cli.parseAsync();
} catch (e) {
  console.error('Error: ' + (e instanceof Error ? e.message : 'Operation failed'));
  process.exitCode = 1;
}
