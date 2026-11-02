import { expect, test } from 'bun:test';
import { ajv, ShapeNode } from '../src/infer';
import { extract, schemaBundle, sqlArchive } from '../src/schema';
import { explorerHTML } from '../src/explorer';
import { fixture } from './fixtures';
test('inferred schemas merge unions, preserve nullable shapes, generalize identifiers, omit values', () => {
  const samples = [
    {
      title: 'DO_NOT_EXPORT_THIS_VALUE',
      count: 1,
      map: { 'a@example.org': { enabled: true } },
      list: [],
    },
    {
      count: null,
      map: { 'b@example.org': { enabled: false } },
      list: [{ x: 1 }, { x: 'different' }],
    },
  ];
  const node = new ShapeNode();
  samples.forEach((s) => node.add(s));
  const schema = node.schema();
  const validator = ajv.compile(schema);
  for (const s of samples) expect(validator(s)).toBe(true);
  const text = JSON.stringify(schema);
  expect(text).not.toContain('DO_NOT_EXPORT');
  expect(text).not.toContain('a@example.org');
  expect(text).not.toContain('required');
  expect(schema.properties.count.type).toEqual(['integer', 'null']);
  expect(schema.properties.map.additionalProperties.type).toBe('object');
});
test('full fixture extraction includes exact SQL and validated JSON without raw data', () => {
  const f = fixture();
  try {
    f.settings();
    f.folders();
    const catalog = extract(f.directory, f.root, 'synthetic');
    expect(catalog.summary.readableDatabases).toBe(2);
    expect(catalog.summary.tables).toBe(3);
    expect(catalog.validation.jsonDocumentsValidated).toBe(5);
    const bundle = schemaBundle(catalog);
    expect(ajv.validateSchema(bundle)).toBe(true);
    expect(Object.keys(bundle.$defs)).toHaveLength(6);
    const raw = JSON.stringify(catalog);
    expect(raw).not.toContain('Projects');
    expect(raw).not.toContain('Research');
    expect(raw).not.toContain('synthetic-fixture-secret');
    expect(sqlArchive(catalog)).toContain('CREATE TABLE tab_groups');
    expect(
      catalog.databases
        .flatMap((d) => d.jsonSchemas)
        .some((s) => s.encoding === 'opaque-binary' && !s.hasShape),
    ).toBe(true);
    const html = explorerHTML(catalog);
    expect(html).not.toContain('__CATALOG_DATA__');
    expect(html).not.toContain('__BROWSER_CODE__');
    const attack = structuredClone(catalog);
    attack.diaVersion = '</script><script>alert(1)</script>';
    expect(explorerHTML(attack)).not.toContain('</script><script>alert(1)</script>');
  } finally {
    f.cleanup();
  }
});
