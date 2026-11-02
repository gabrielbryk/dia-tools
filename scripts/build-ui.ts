import { writeFileSync } from 'node:fs';
const result = await Bun.build({
  entrypoints: [new URL('../src/ui/browser.ts', import.meta.url).pathname],
  target: 'browser',
  minify: true,
});
if (!result.success) throw new Error(result.logs.join('\n'));
writeFileSync(
  new URL('../src/ui-bundle.ts', import.meta.url),
  '// Generated from src/ui/browser.ts by scripts/build-ui.ts.\nexport default ' +
    JSON.stringify(await result.outputs[0].text()) +
    ';\n',
);
