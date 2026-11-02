import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './fixtures';
export function profileFixture() {
  const f = fixture();
  f.settings();
  const s = f.database(
    'Default',
    'tabs',
    `
    CREATE TABLE nodes(id INTEGER PRIMARY KEY,kind TEXT,entity_id TEXT,parent_id INTEGER,"order" INTEGER,deleted_at TEXT,space_id TEXT);
    CREATE TABLE tab_groups(id TEXT PRIMARY KEY,node_id INTEGER UNIQUE,title TEXT,icon TEXT,icon_source TEXT);
    CREATE TABLE tabs(id TEXT PRIMARY KEY,node_id INTEGER UNIQUE);
    CREATE TABLE content_panes(id TEXT PRIMARY KEY,node_id INTEGER UNIQUE,custom_title TEXT,custom_icon TEXT);
    CREATE TABLE web_contents(id INTEGER PRIMARY KEY,content_pane_id TEXT,url TEXT,title TEXT);
    CREATE TABLE spaces(id TEXT PRIMARY KEY,title TEXT,theme TEXT);
  `,
  );
  const node = (
    id: number,
    kind: string,
    parent: number | null,
    order = 0,
    deleted: string | null = null,
    space = '',
  ) =>
    s.db
      .query('INSERT INTO nodes VALUES (?,?,?,?,?,?,?)')
      .run(id, kind, 'entity-' + id, parent, order, deleted, space);
  const group = (
    id: number,
    parent: number | null,
    title: string,
    order = 0,
    deleted: string | null = null,
  ) => {
    node(id, 'group', parent, order, deleted);
    s.db
      .query('INSERT INTO tab_groups VALUES (?,?,?,?,?)')
      .run('group-' + id, id, title, '{"symbol":"folder"}', 'userGenerated');
  };
  const tab = (id: number, parent: number, order: number, urls: [string, string][]) => {
    node(id, 'tab', parent, order);
    s.db.query('INSERT INTO tabs VALUES (?,?)').run('tab-' + id, id);
    urls.forEach(([url, title], i) => {
      const pid = id * 10 + i;
      node(pid, 'content_pane', id, i);
      s.db.query('INSERT INTO content_panes VALUES (?,?,?,?)').run('pane-' + pid, pid, null, null);
      s.db.query('INSERT INTO web_contents VALUES (?,?,?,?)').run(pid, 'pane-' + pid, url, title);
    });
  };
  node(1, 'window', null, 0, null, 'main');
  node(2, 'pinned_container', 1, 0);
  node(3, 'favorites', 1, 1);
  group(10, 2, 'Projects');
  group(11, 10, 'Nested research');
  group(12, 2, 'Removed folder', 1, '2025-01-01');
  tab(20, 10, 0, [
    ['https://example.test/a', 'First pane'],
    ['https://example.test/b', 'Second pane'],
  ]);
  tab(21, 11, 1, [['https://docs.example.test/research', 'Nested <script>alert(1)</script>']]);
  tab(22, 12, 0, [['https://removed.example.test/', 'Removed descendant']]);
  tab(23, 9999, 0, [['https://orphan.example.test/', 'Recovered orphan']]);
  tab(24, 10, 2, [['javascript:alert(1)', 'Unsafe link']]);
  group(40, 41, 'Cycle A');
  group(41, 40, 'Cycle B');
  for (let i = 0; i < 62; i++)
    tab(100 + i, 10, 10 + i, [[`https://example.test/page-${i}`, `Example ${i}`]]);
  s.db.query('INSERT INTO spaces VALUES (?,?,?)').run('main', 'Main', 'neutral');
  s.db.close();
  const auth = f.database('Default', 'mcp_auth', 'CREATE TABLE credentials(id TEXT,value TEXT)');
  auth.db
    .query('INSERT INTO credentials VALUES (?,?)')
    .run('credential', 'synthetic-secret-marker');
  auth.db.close();
  writeFileSync(
    join(f.directory, 'Local State'),
    JSON.stringify({
      profile: {
        info_cache: { Default: { name: 'Researcher', user_name: 'researcher@example.test' } },
      },
      os_crypt: { encrypted_key: 'NEVER_EXPORT_LOCAL_STATE_SECRET' },
    }),
  );
  return { ...f, store: s.store, key: s.key };
}
