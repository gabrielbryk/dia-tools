import './build-ui';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
const portable = process.argv.includes('--portable');
const project = resolve(import.meta.dir, '..');
process.chdir(project);
const run = (args: string[]) => {
  const r = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode) throw new Error(`${args[0]} failed: ${r.stderr}`);
  return r.stdout.toString();
};
mkdirSync('dist', { recursive: true });
let entry = 'src/cli.ts';
if (portable) {
  if (process.platform !== 'darwin')
    throw new Error('Portable builds currently support macOS only.');
  rmSync('.build', { recursive: true, force: true });
  mkdirSync('.build/native', { recursive: true });
  const prefix = run(['brew', '--prefix', 'sqlcipher']).trim();
  const first = join(prefix, 'lib/libsqlcipher.dylib');
  const libraries = new Map<string, string>();
  function collect(path: string): void {
    if (libraries.has(path)) return;
    const name = basename(path);
    if ([...libraries.values()].includes(name))
      throw new Error('Native dependency basename collision.');
    libraries.set(path, name);
    copyFileSync(path, join('.build/native', name));
    for (const dep of dependencies(path))
      if (dep !== path && !dep.startsWith('/usr/lib/') && !dep.startsWith('/System/')) {
        if (!dep.startsWith('/')) throw new Error('Unsupported native dependency: ' + dep);
        collect(dep);
      }
  }
  function dependencies(path: string): string[] {
    return run(['otool', '-L', path])
      .split('\n')
      .slice(1)
      .map((s) => s.trim().split(' (')[0])
      .filter(Boolean);
  }
  collect(first);
  for (const [original, name] of libraries) {
    const dest = join('.build/native', name);
    run(['install_name_tool', '-id', '@loader_path/' + name, dest]);
    for (const dep of dependencies(original))
      if (libraries.has(dep) && dep !== original)
        run(['install_name_tool', '-change', dep, '@loader_path/' + libraries.get(dep), dest]);
    run(['codesign', '--force', '--sign', '-', dest]);
  }
  const entries = [...libraries.entries()];
  const imports = entries
    .map(([, name], i) => `import asset${i} from './native/${name}' with { type: 'file' };`)
    .join('\n');
  writeFileSync(
    '.build/portable.ts',
    `${imports}\nimport { mkdtempSync, writeFileSync, rmSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nconst dir=mkdtempSync(join(tmpdir(),'dia-tools-native-'));\nprocess.on('exit',()=>rmSync(dir,{recursive:true,force:true}));\n${entries.map(([, name], i) => `writeFileSync(join(dir,${JSON.stringify(name)}),new Uint8Array(await Bun.file(asset${i}).arrayBuffer()),{mode:0o500});`).join('\n')}\nprocess.env.DIA_SQLCIPHER_LIBRARY=join(dir,'libsqlcipher.dylib');\nawait import('../src/cli.ts');\n`,
  );
  entry = '.build/portable.ts';
  const notices = [
    'Bun runtime source and license: https://github.com/oven-sh/bun/tree/bun-v' +
      Bun.version +
      '\n\n' +
      readFileSync('docs/BUN-LICENSE.md', 'utf8'),
    readFileSync(join(prefix, 'LICENSE.md'), 'utf8'),
    readFileSync(join(prefix, 'LICENSE.txt'), 'utf8'),
  ];
  for (const [original] of entries.slice(1)) {
    const license = join(dirname(dirname(original)), 'LICENSE.txt');
    notices.push(readFileSync(license, 'utf8'));
  }
  const visited = new Set<string>();
  function npmNotices(name: string): void {
    if (visited.has(name)) return;
    visited.add(name);
    const dir = join('node_modules', name);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const license = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md']
      .map((n) => join(dir, n))
      .find(existsSync);
    if (!license) throw new Error('Missing bundled package license: ' + name);
    notices.push(name + '@' + pkg.version + '\n\n' + readFileSync(license, 'utf8'));
    for (const dependency of Object.keys(pkg.dependencies ?? {})) npmNotices(dependency);
  }
  for (const name of Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).dependencies))
    npmNotices(name);
  writeFileSync('dist/THIRD-PARTY-NOTICES.txt', notices.join('\n\n-----\n\n'));
}
const name = `dia-tools-${process.platform}-${process.arch}${portable ? '-portable' : ''}`;
const result = await Bun.build({
  entrypoints: [entry],
  compile: { outfile: join('dist', name) },
  minify: true,
  sourcemap: 'none',
});
if (!result.success) throw new Error(result.logs.join('\n'));
console.log(join('dist', name));

if (portable) {
  const stage = join('.build', name);
  mkdirSync(stage, { recursive: true });
  copyFileSync(join('dist', name), join(stage, 'dia-tools'));
  for (const file of ['LICENSE', 'README.md']) copyFileSync(file, join(stage, file));
  copyFileSync('dist/THIRD-PARTY-NOTICES.txt', join(stage, 'THIRD-PARTY-NOTICES.txt'));
  cpSync('skills', join(stage, 'skills'), { recursive: true });
  cpSync('docs', join(stage, 'docs'), { recursive: true });
  writeFileSync(
    join(stage, 'build-info.json'),
    JSON.stringify(
      {
        version: JSON.parse(readFileSync('package.json', 'utf8')).version,
        bun: Bun.version,
        bunRevision: Bun.revision,
        platform: process.platform,
        architecture: process.arch,
      },
      null,
      2,
    ),
  );
  const archive = join('dist', name + '.tar.gz');
  run(['tar', '-czf', archive, '-C', '.build', name]);
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  writeFileSync(archive + '.sha256', digest + '  ' + basename(archive) + '\n');
  console.log(archive);
}
