import type { Command } from 'commander';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { analyzeUsage } from './usage';
import { exportUsage } from './usage-view';
import { jsonString } from './store';

export function registerUsageCommand(cli: Command): void {
  cli
    .command('usage')
    .description('Rank saved Dia tabs with deduplicated Dia and Arc visit history; read-only')
    .requiredOption('--out <directory>', 'Fresh local output directory')
    .option('--arc-user-data <path>', 'Arc User Data root; defaults to the local Arc installation')
    .option('--no-arc', 'Analyze Dia history only')
    .option(
      '--arc-profile-map <file>',
      'JSON object mapping Dia profile directories to Arc profiles',
    )
    .option(
      '--timezone <zone>',
      'IANA timezone for visited calendar dates',
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    )
    .option('--open', 'Open the offline usage report')
    .action((options) => {
      const directory = resolve(options.out);
      if (existsSync(directory) && readdirSync(directory).length)
        throw new Error('Usage output directory must be new or empty.');
      if (!options.arc && (options.arcUserData || options.arcProfileMap))
        throw new Error('--no-arc cannot be combined with Arc input options.');
      let arcProfileMap: Record<string, string> | undefined;
      if (options.arcProfileMap) {
        const value: unknown = JSON.parse(readFileSync(options.arcProfileMap, 'utf8'));
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          !Object.values(value).every((v) => typeof v === 'string')
        )
          throw new Error(
            'Arc profile map must be a JSON object of Dia-to-Arc profile directories.',
          );
        arcProfileMap = value as Record<string, string>;
      }
      const report = analyzeUsage({
        userData: cli.opts().userData,
        arcUserData: options.arc ? options.arcUserData : null,
        arcProfileMap,
        timezone: options.timezone,
      });
      exportUsage(report, directory);
      console.log(
        jsonString({
          output: directory,
          report: join(directory, 'dia-usage.html'),
          status: report.status,
          profiles: report.profiles.length,
          savedTabs: report.profiles.reduce((n, p) => n + p.savedTabs.length, 0),
        }),
      );
      if (report.status === 'partial') process.exitCode = 1;
      if (options.open && process.platform === 'darwin')
        Bun.spawnSync(['/usr/bin/open', join(directory, 'dia-usage.html')]);
    });
}
