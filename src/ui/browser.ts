import { createProfileView } from './profile-view';
import type { Catalog, JSONSchema, Table, Shape, StoreSchema } from '../types';
const catalog: Catalog = JSON.parse(document.getElementById('catalogData')!.textContent!);
const $ = (id: string): any => document.getElementById(id),
  esc = (s: any) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    );
const fmt = (n: any) => Number(n || 0).toLocaleString('en-US');
const friendly = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const profileOrder = ['Global', 'Default', 'Profile 2', 'Profile 3', 'Profile 4'];
const allProfiles = [...new Set(catalog.databases.map((d) => d.profile))].sort(
  (a, b) => profileOrder.indexOf(a) - profileOrder.indexOf(b),
);
const state: {
  db: string;
  tab: string;
  item: string | null | undefined;
  mode: string;
  jsonFilter: string;
  localQuery: string;
  globalQuery: string;
} = {
  db:
    catalog.databases.find((d) => d.path === 'global_key_value_store.db')?.id ||
    catalog.databases[0]?.id,
  tab: 'json',
  item: null,
  mode: 'tree',
  jsonFilter: 'structured',
  localQuery: '',
  globalQuery: '',
};
const db = () => catalog.databases.find((d) => d.id === state.db)!;
let toastTimer: ReturnType<typeof setTimeout>, searchTimer: ReturnType<typeof setTimeout>;
let appView = catalog.profiles ? 'profiles' : 'schema';
const profileView = createProfileView(catalog, {
  schema: (id, table) => {
    appView = 'schema';
    state.db = id;
    state.item = null;
    state.tab = 'sql';
    state.globalQuery = '';
    $('globalSearch').value = '';
    chooseDefault();
    if (table) state.item = db().tables.find((t) => t.name === table)?.id;
    render();
  },
  copy,
  download,
});

const schemaFields = (s: JSONSchema): string[] => [
  ...Object.keys(s.properties || {}),
  ...Object.values(s.properties || {}).flatMap((v) => schemaFields(v as JSONSchema)),
  ...(s.items ? schemaFields(s.items) : []),
  ...(typeof s.additionalProperties === 'object' ? schemaFields(s.additionalProperties) : []),
];
const searchIndex = catalog.databases.flatMap((d) => [
  ...d.tables.map((t) => ({
    db: d.id,
    tab: 'sql',
    id: t.id,
    label: t.name,
    kind: 'SQL table',
    path: d.path,
    text: [d.path, t.name, ...t.columns.map((c) => c.name)].join(' ').toLowerCase(),
  })),
  ...d.jsonSchemas.map((s) => ({
    db: d.id,
    tab: 'json',
    id: s.id,
    label: s.label,
    kind: s.structuredJson ? 'JSON shape' : 'Stored value',
    path: d.path,
    text: [d.path, s.label, s.table, s.column, ...schemaFields(s.schema)].join(' ').toLowerCase(),
  })),
]);
function init() {
  if (catalog.profiles) {
    $('about').textContent = 'About this snapshot';
    document.querySelector('[data-export="catalog"]')!.textContent =
      'Profile data & schemas · JSON';
    $('viewBar').hidden = false;
    $('brandTitle').textContent = 'Dia · Profile Explorer';
    document.body.classList.add('has-profile-data');
    $('aboutPrivacy').textContent =
      'This export contains local profile and browsing data. Credential fields are redacted, opaque bytes and oversized cells are represented by metadata. Re-export to refresh.';
  }

  $('metrics').innerHTML =
    [
      ['databases', `${catalog.summary.readableDatabases} / ${catalog.summary.databases}`],
      ['tables & views', fmt(catalog.summary.tables)],
      ['columns', fmt(catalog.summary.columns)],
      ['JSON shapes', fmt(catalog.summary.jsonSchemas)],
      ['foreign-key columns', fmt(catalog.summary.foreignKeys)],
    ]
      .map(([l, n]) => `<div class="metric"><strong>${n}</strong><span>${l}</span></div>`)
      .join('') +
    `<div class="snapshot"><span class="dot"></span>Dia ${esc(catalog.diaVersion)}<br>${new Date(catalog.generatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>`;
  $('profileFilter').innerHTML =
    '<option value="all">All profiles</option>' +
    allProfiles.map((p) => `<option>${esc(p)}</option>`).join('');
  $('aboutScope').textContent = catalog.scope.description;
  restoreHash();
  chooseDefault();
  render();
}
function chooseDefault() {
  const d = db();
  if (!d) return;
  if (state.tab === 'json' && !d.jsonSchemas.some((s) => s.id === state.item))
    state.item = (
      d.jsonSchemas.find((s) => s.key === 'window_layout.preferences') ||
      d.jsonSchemas.find((s) => s.structuredJson) ||
      d.jsonSchemas[0]
    )?.id;
  if (state.tab === 'sql' && !d.tables.some((t) => t.id === state.item))
    state.item = (
      d.tables.find((t) => t.name === 'values') ||
      d.tables.find((t) => !t.name.startsWith('sqlite_')) ||
      d.tables[0]
    )?.id;
}
function restoreHash() {
  try {
    const h = new URLSearchParams(location.hash.slice(1));
    if (catalog.profiles) appView = h.get('view') === 'schema' ? 'schema' : 'profiles';
    if (catalog.databases.some((d) => d.id === h.get('db'))) state.db = h.get('db')!;
    if (['json', 'sql', 'relationships', 'coverage'].includes(h.get('tab') || ''))
      state.tab = h.get('tab')!;
    state.item = h.get('item');
  } catch {}
}
function saveHash() {
  const h = new URLSearchParams({ view: 'schema', db: state.db, tab: state.tab });
  if (state.item) h.set('item', state.item);
  history.replaceState(null, '', '#' + h);
}
function visibleStores() {
  const p = $('profileFilter').value,
    q = $('storeFilter').value.toLowerCase();
  return catalog.databases.filter(
    (d) =>
      (p === 'all' || d.profile === p) &&
      [d.path, friendly(d.family)].join(' ').toLowerCase().includes(q),
  );
}
function renderStores() {
  const stores = visibleStores();
  $('storeList').innerHTML =
    allProfiles
      .map((p) => {
        const ds = stores.filter((d) => d.profile === p);
        if (!ds.length) return '';
        return (
          `<div class="profile-label">${esc(p)}</div>` +
          ds
            .map(
              (d) =>
                `<button class="store-button ${d.id === state.db ? 'active' : ''}" data-db="${d.id}" aria-current="${d.id === state.db ? 'true' : 'false'}"><span class="store-name">${esc(friendly(d.family))}</span><div class="store-meta">${d.status === 'ok' ? `${d.tables.length} tables · ${d.jsonSchemas.filter((s) => s.structuredJson).length} JSON shapes` : esc(d.status)}</div></button>`,
            )
            .join('')
        );
      })
      .join('') || '<div class="empty">No matching databases.</div>';
}
function render() {
  document.body.classList.toggle('profile-mode', appView === 'profiles');
  $('schemaNav').hidden = appView === 'profiles';
  $('profileNav').hidden = appView !== 'profiles';
  document
    .querySelectorAll<HTMLElement>('[data-view]')
    .forEach((e) => e.classList.toggle('active', e.dataset.view === appView));
  $('globalSearch').placeholder =
    appView === 'profiles'
      ? 'Search folders, tabs, and URLs…'
      : 'Search tables, keys, or JSON fields…';
  $('globalSearch').setAttribute(
    'aria-label',
    appView === 'profiles' ? 'Search all profiles' : 'Search all schemas',
  );
  $('mobileNav').textContent = appView === 'profiles' ? 'Profiles' : 'Databases';
  if (appView === 'profiles') {
    profileView.render(state.globalQuery);
    return;
  }
  renderStores();
  if (state.globalQuery) {
    renderSearch();
    return;
  }
  const d = db();
  if (!d) return;
  $('main').innerHTML =
    `<section class="db-head"><div><h1>${esc(friendly(d.family))}</h1><div class="db-path">${esc(d.path)}</div><div class="db-meta"><span class="pill">${esc(d.profile)}</span><span class="pill mono">${esc(d.storage)}</span><span class="pill ${d.status === 'ok' ? 'green' : 'amber'}">${d.status === 'ok' ? 'Integrity verified' : 'Unavailable'}</span></div></div><div class="db-info">Schema snapshot<br>${new Date(d.capturedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div></section><nav class="tabs" aria-label="Schema sections">${[
      ['sql', 'SQL schema', d.tables.length],
      ['json', 'JSON & values', d.jsonSchemas.length],
      ['relationships', 'Relationships', d.tables.reduce((n, t) => n + t.foreignKeys.length, 0)],
      ['coverage', 'Coverage', null],
    ]
      .map(
        ([id, l, n]) =>
          `<button class="tab ${state.tab === id ? 'active' : ''}" data-tab="${id}" aria-current="${state.tab === id ? 'page' : 'false'}">${l}${n !== null ? `<span class="count">${n}</span>` : ''}</button>`,
      )
      .join(
        '',
      )}</nav><div id="content"></div><div class="footer"><span>SQL metadata is extracted · JSON payload shapes are inferred</span><span>${catalog.dataCoverage ? 'Profile data included · Credentials redacted' : 'Read-only extraction · No stored values exported'}</span></div>`;
  if (d.status !== 'ok')
    $('content').innerHTML =
      `<div class="card"><h2>This database could not be read</h2><p>${esc(d.error)}</p></div>`;
  else if (state.tab === 'sql' || state.tab === 'json') renderWorkspace();
  else if (state.tab === 'relationships') renderRelationships();
  else renderCoverage();
  saveHash();
}
function renderWorkspace() {
  const d = db(),
    json = state.tab === 'json';
  $('content').innerHTML =
    `<div class="workspace"><section class="item-pane"><div class="item-heading"><div class="eyebrow">${json ? 'Stored shapes' : 'Tables & views'}</div><input id="localSearch" type="search" aria-label="Filter ${json ? 'JSON shapes' : 'tables'}" placeholder="${json ? 'Filter keys or fields…' : 'Filter tables…'}" value="${esc(state.localQuery)}">${json ? `<select id="jsonFilter" aria-label="Filter value types"><option value="structured">Structured JSON only</option><option value="shaped">All decoded shapes</option><option value="all">All stored values & JSON</option></select>` : ''}</div><div class="items" id="itemList"></div></section><section class="detail" id="detail"></section></div>`;
  if (json) $('jsonFilter').value = state.jsonFilter;
  renderItems();
  renderDetail();
}
function currentItems() {
  const d = db(),
    q = state.localQuery.toLowerCase();
  if (state.tab === 'sql')
    return d.tables.filter((t) =>
      [t.name, ...t.columns.map((c) => c.name)].join(' ').toLowerCase().includes(q),
    );
  return d.jsonSchemas.filter(
    (s) =>
      (state.jsonFilter === 'all' ||
        (state.jsonFilter === 'structured' && s.structuredJson) ||
        (state.jsonFilter === 'shaped' && s.hasShape)) &&
      [s.label, ...schemaFields(s.schema)].join(' ').toLowerCase().includes(q),
  );
}
function renderItems() {
  const items = currentItems(),
    json = state.tab === 'json';
  $('itemList').innerHTML =
    items
      .map(
        (x: any) =>
          `<button class="item-button ${state.item === x.id ? 'active' : ''}" data-item="${x.id}" aria-current="${state.item === x.id ? 'true' : 'false'}"><span class="item-name">${esc(json ? x.label : x.name)}</span><span class="item-meta">${json ? `${esc(x.encoding)} · ${fmt(x.samples)} observed` : `${x.columns.length} columns · ${fmt(x.rowCount)} rows`}</span></button>`,
      )
      .join('') ||
    `<div class="empty">${json ? 'No shapes match this filter. Choose “All stored values & JSON” to see opaque values.' : 'No matching tables.'}</div>`;
}
function renderDetail() {
  const d = db();
  if (state.tab === 'sql') {
    const t = d.tables.find((x) => x.id === state.item);
    if (!t) {
      $('detail').innerHTML =
        '<div class="empty"><h3>Select a table</h3>Inspect its columns, constraints, and SQL definition.</div>';
      return;
    }
    renderSQL(t);
    return;
  }
  const s = d.jsonSchemas.find((x) => x.id === state.item);
  if (!s) {
    $('detail').innerHTML =
      '<div class="empty"><h3>No observed JSON shape</h3>This database may be empty or store values in another format. Its SQL definitions are still available.</div>';
    return;
  }
  renderJSON(s);
}
function renderSQL(t: Table) {
  $('detail').innerHTML =
    `<div class="detail-header"><div><h2>${esc(t.name)}</h2><div class="detail-sub">${fmt(t.rowCount)} rows at extraction · ${t.columns.length} columns${t.strict ? ' · STRICT' : ''}${t.withoutRowid ? ' · WITHOUT ROWID' : ''}</div></div><div class="actions">${catalog.dataCoverage ? `<button class="btn small" data-record-table="${esc(t.name)}">Browse records ↗</button>` : ''}<button class="btn small" data-action="copy-sql">Copy SQL</button><button class="btn small" data-action="download-row">Row JSON Schema ↓</button></div></div><div class="segment" aria-label="SQL detail view">${[
      ['tree', 'Columns'],
      ['raw', 'SQL definition'],
      ['row', 'Row JSON Schema'],
    ]
      .map(
        ([v, l]) =>
          `<button class="${state.mode === v ? 'active' : ''}" data-mode="${v}">${l}</button>`,
      )
      .join('')}</div><div id="sqlBody"></div>`;
  const el = $('sqlBody');
  if (state.mode === 'raw') {
    el.innerHTML = '<pre class="codebox sqlcode" id="sqlCode"></pre>';
    $('sqlCode').textContent = [
      t.sql,
      ...t.indexes.filter((i) => i.sql).map((i) => i.sql),
      ...t.triggers.map((x) => x.sql),
    ]
      .filter(Boolean)
      .map((s) => s.replace(/;?$/, ';'))
      .join('\n\n');
    return;
  }
  if (state.mode === 'row') {
    el.innerHTML =
      '<div class="note">JSON projection of SQL affinity. BLOBs are represented as base64 strings. Non-STRICT SQLite may store other classes.</div><pre class="codebox" id="rowCode"></pre>';
    $('rowCode').textContent = JSON.stringify(t.rowJsonSchema, null, 2);
    return;
  }
  el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Column</th><th>Declared type</th><th>Nullable</th><th>Default / observed storage</th></tr></thead><tbody>${t.columns
    .map((c) => {
      const p = t.rowJsonSchema.properties[c.name],
        fk = t.foreignKeys.filter((f) => f.from === c.name);
      return `<tr><td class="code">${esc(c.name)}${c.pk ? '<span class="keymark">PK ' + c.pk + '</span>' : ''}${c.hidden === 2 || c.hidden === 3 ? '<span class="keymark">GENERATED</span>' : ''}${fk.map((f) => `<div class="smalltext"><button class="link-button" data-table-name="${esc(f.table)}">→ ${esc(f.table)}.${esc(f.to || '(primary key)')}</button></div>`).join('')}</td><td class="code">${esc(c.type || '(unspecified)')}</td><td class="nullable">${p['x-nullable'] ? 'Yes' : 'No'}</td><td>${c.dflt_value !== null ? `<div class="code">${esc(c.dflt_value)}</div>` : ''}<span class="muted">${c.storageClasses.map((x: any) => `${esc(x.type)} ${fmt(x.count)}`).join(' · ') || 'No rows observed'}</span></td></tr>`;
    })
    .join(
      '',
    )}</tbody></table></div><div class="section-label">Indexes <span class="count">${t.indexes.length}</span></div>${
    t.indexes.length
      ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Columns</th><th>Properties</th></tr></thead><tbody>${t.indexes
          .map(
            (i) =>
              `<tr><td class="code">${esc(i.name)}</td><td class="code">${i.columns
                .filter((c: any) => c.key)
                .map(
                  (c: any) =>
                    esc(c.name || (c.cid === -2 ? '(expression)' : '(rowid)')) +
                    (c.desc ? ' DESC' : ''),
                )
                .join(
                  ', ',
                )}</td><td>${i.unique ? 'Unique' : 'Non-unique'}${i.partial ? ' · Partial' : ''}</td></tr>`,
          )
          .join('')}</tbody></table></div>`
      : '<p class="smalltext muted">No indexes declared.</p>'
  }${t.triggers.length ? `<div class="section-label">Triggers</div>${t.triggers.map((x) => `<details><summary>${esc(x.name)}</summary><pre class="codebox sqlcode">${esc(x.sql)}</pre></details>`).join('')}` : ''}${t.jsonSchemaIds.length ? `<div class="section-label">Decoded shapes</div><button class="btn small" data-table-json="${t.id}">Explore ${t.jsonSchemaIds.length} JSON / value shapes →</button>` : ''}`;
}
function types(s: JSONSchema) {
  const t = s.type;
  return Array.isArray(t) ? t : t ? [t] : [];
}
function chips(s: JSONSchema) {
  return (
    types(s)
      .map((t) => `<span class="type-chip ${esc(t)}">${esc(t)}</span>`)
      .join('') || '<span class="type-chip null">unknown</span>'
  );
}
function schemaTree(s: JSONSchema, label = '$', depth = 0, parentN: number | null = null): string {
  const props = Object.entries(s.properties || {}),
    map = typeof s.additionalProperties === 'object',
    hasItems = s.items !== undefined,
    branch = props.length || map || hasItems;
  let countNote = s['x-observations']
    ? `<span class="observed" title="Observation counts do not establish required fields">${fmt(s['x-observations'])}${parentN ? ' / ' + fmt(parentN) : ''} observed</span>`
    : '';
  const head = `<span class="field-name">${esc(label)}</span>${chips(s)}${countNote}`;
  if (!branch)
    return `<div class="schema-node"><div class="leaf">${head}</div>${!s.type ? `<div class="unknown">${esc(s.description || 'No sample establishes this shape.')}</div>` : ''}</div>`;
  return `<details class="schema-node" ${depth < 2 ? 'open' : ''}><summary>${head}</summary>${props.map(([k, v]) => schemaTree(v as JSONSchema, k, depth + 1, s['x-observedObjectCount'] || null)).join('')}${hasItems ? schemaTree(s.items, '[] array items', depth + 1) : ''}${map ? schemaTree(s.additionalProperties, '{dynamic key}', depth + 1) : ''}${s['x-dynamicPropertyNamesOmitted'] ? '<div class="unknown">Identifier-like map keys are omitted; their value shapes are merged.</div>' : ''}</details>`;
}
function selectedSchema(s: Shape) {
  return { $schema: catalog.jsonSchemaDialect, title: s.label, ...s.schema };
}
function renderJSON(s: Shape) {
  const type = types(s.schema).join(' | ') || 'Unknown';
  $('detail').innerHTML =
    `<div class="detail-header"><div><h2>${esc(s.label)}</h2><div class="detail-sub">${esc(s.table)} → ${esc(s.column)} · ${esc(s.encoding)}${s.bytes != null ? ` · ${fmt(s.bytes)} bytes` : ''}</div></div><div class="actions"><button class="btn small" data-action="copy-json">Copy schema</button><button class="btn small" data-action="download-json">JSON ↓</button></div></div><div class="db-meta"><span class="pill amber">Inferred shape</span><span class="pill mono">${esc(type)}</span><span class="pill">${fmt(s.samples)} observed ${s.samples === 1 ? 'value' : 'values'}</span></div><div class="note inferred">${s.hasShape ? 'Observed types and properties, not a vendor-authored contract. Fields are not declared required. Values and enum choices are not exported.' : 'This value is opaque or empty. Its bytes do not establish a JSON shape; the SQL column declaration is available in the SQL schema tab.'}${s.encoding.includes('scalar') ? ' JSON-looking scalar syntax does not prove that the application treats it as JSON.' : ''}</div><div class="segment"><button data-mode="tree" class="${state.mode !== 'raw' ? 'active' : ''}">Field tree</button><button data-mode="raw" class="${state.mode === 'raw' ? 'active' : ''}">JSON Schema</button></div>${state.mode !== 'raw' && s.hasShape ? '<button class="btn small" style="float:right" data-action="expand-tree">Expand all</button>' : ''}<div id="jsonBody"></div>`;
  if (state.mode === 'raw') {
    $('jsonBody').innerHTML = '<pre class="codebox" id="jsonCode"></pre>';
    $('jsonCode').textContent = JSON.stringify(selectedSchema(s), null, 2);
  } else
    $('jsonBody').innerHTML =
      `<div class="schema-tree" id="schemaTree">${schemaTree(s.schema)}</div>`;
}
function foreignGroups(d: StoreSchema) {
  return d.tables.flatMap((t) => {
    const ids = [...new Set(t.foreignKeys.map((f) => f.id))];
    return ids.map((id) => {
      const rows = t.foreignKeys.filter((f) => f.id === id).sort((a, b) => a.seq - b.seq);
      return {
        from: t.name,
        to: rows[0].table,
        fromCols: rows.map((f) => f.from),
        toCols: rows.map((f) => f.to || '(primary key)'),
        onDelete: rows[0].on_delete,
        onUpdate: rows[0].on_update,
      };
    });
  });
}
function renderRelationships() {
  const d = db(),
    edges = foreignGroups(d);
  if (!edges.length) {
    $('content').innerHTML =
      '<section class="relationships"><div class="empty"><h3>No foreign keys declared</h3>Names that resemble IDs do not establish a relationship. The SQL schema remains available for inspection.</div></section>';
    return;
  }
  const names = [...new Set(edges.flatMap((e) => [e.from, e.to]))].sort(),
    positions = new Map(
      names.map((n, i) => [n, { x: 30 + (i % 3) * 260, y: 30 + Math.floor(i / 3) * 100 }]),
    ),
    height = Math.ceil(names.length / 3) * 100 + 20;
  const svg = `<svg viewBox="0 0 800 ${height}" width="800" height="${height}" role="img" aria-label="Declared table relationships"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8da995"/></marker></defs>${edges
    .map((e) => {
      const a = positions.get(e.from)!,
        b = positions.get(e.to)!;
      if (e.from === e.to)
        return `<path d="M${a.x + 180},${a.y + 12} C${a.x + 245},${a.y - 30} ${a.x + 245},${a.y + 85} ${a.x + 180},${a.y + 42}" fill="none" stroke="#b3c5b7" marker-end="url(#arrow)"/>`;
      const x1 = a.x + 190,
        y1 = a.y + 27,
        x2 = b.x,
        y2 = b.y + 27;
      return `<path d="M${x1},${y1} C${x1 + 50},${y1} ${x2 - 50},${y2} ${x2},${y2}" fill="none" stroke="#b3c5b7" stroke-width="1.2" marker-end="url(#arrow)"><title>${esc(e.from)} → ${esc(e.to)}</title></path>`;
    })
    .join('')}${names
    .map((n) => {
      const p = positions.get(n)!;
      return `<g class="graph-node" data-table-name="${esc(n)}" tabindex="0" role="button" aria-label="Inspect ${esc(n)}"><rect x="${p.x}" y="${p.y}" width="190" height="54" rx="8" fill="white" stroke="#cddbcf"/><text x="${p.x + 13}" y="${p.y + 22}" font-family="ui-monospace,monospace" font-size="11" fill="#314e3b">${esc(n)}</text><text x="${p.x + 13}" y="${p.y + 40}" font-family="sans-serif" font-size="10" fill="#768374">${d.tables.find((t) => t.name === n)?.columns.length || '?'} columns · inspect →</text></g>`;
    })
    .join('')}</svg>`;
  $('content').innerHTML =
    `<section class="relationships"><div class="detail-header"><div><h2>Declared foreign keys</h2><div class="detail-sub">${edges.length} relationships · arrows point to the referenced table</div></div><span class="pill green">Extracted from SQL</span></div><div class="graph">${svg}</div><div class="table-wrap"><table><thead><tr><th>Source</th><th>References</th><th>On delete</th><th>On update</th></tr></thead><tbody>${edges.map((e) => `<tr><td class="code"><button class="link-button" data-table-name="${esc(e.from)}">${esc(e.from)}</button><br>${esc(e.fromCols.join(', '))}</td><td class="code"><button class="link-button" data-table-name="${esc(e.to)}">${esc(e.to)}</button><br>${esc(e.toCols.join(', '))}</td><td>${esc(e.onDelete)}</td><td>${esc(e.onUpdate)}</td></tr>`).join('')}</tbody></table></div></section>`;
}
function renderCoverage() {
  const d = db(),
    opaque = d.jsonSchemas.filter((s) => !s.hasShape).length;
  const rows = [
    ['Database files read', `${catalog.summary.readableDatabases} / ${catalog.summary.databases}`],
    ['Store families', catalog.summary.families],
    ['Tables / views', catalog.summary.tables],
    ['Empty tables', catalog.summary.emptyTables],
    ['Parseable JSON examples validated', catalog.validation.jsonDocumentsValidated],
    ['Schemas checked during inference', catalog.validation.schemasChecked],
  ];
  $('content').innerHTML =
    `<div class="coverage-grid"><section class="card"><h2>Extraction coverage</h2><dl class="definition-list">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${typeof v === 'number' ? fmt(v) : esc(v)}</dd></div>`).join('')}</dl></section><section class="card"><h2>This database</h2><dl class="definition-list"><div><dt>Rows across tables</dt><dd>${fmt(d.tables.reduce((n, t) => n + t.rowCount, 0))}</dd></div><div><dt>Structured JSON shapes</dt><dd>${d.jsonSchemas.filter((s) => s.structuredJson).length}</dd></div><div><dt>Opaque / empty value entries</dt><dd>${opaque}</dd></div><div><dt>Integrity</dt><dd>${esc(d.integrity || d.status)}</dd></div></dl>${d.context ? `<p>Derivation context</p><pre class="codebox sqlcode">${esc(d.context)}</pre>` : ''}</section><section class="card"><h2>What is exact?</h2><p>SQL definitions, declared column types and defaults, primary keys, indexes, foreign keys, views, and triggers are extracted from database metadata.</p><p>SQLite’s non-STRICT tables can store classes that differ from their declared affinity. The row JSON Schemas are projections, not a complete model of every SQLite constraint.</p></section><section class="card"><h2>What is inferred?</h2><p>Payload shapes describe observed examples. Empty arrays cannot establish an element type; empty tables and opaque binary payloads cannot establish a JSON shape.</p><p>Identifier-like object keys are generalized into maps. Observed occurrence counts are annotations, not required-field constraints. No enums or example values are inferred.</p></section><section class="card" style="grid-column:1/-1"><h2>Scope & snapshot</h2><p>${esc(catalog.scope.description)}</p><p>Each database was copied with its WAL during an observed unchanged interval, then checked. The entire set is not one cross-database atomic snapshot. Source version: Dia ${esc(catalog.diaVersion)}. Read-only extraction; no preference changes.</p></section></div>`;
}
function renderSearch() {
  const q = state.globalQuery.toLowerCase(),
    terms = q.split(/\s+/).filter(Boolean),
    matches = searchIndex.filter((x) => terms.every((t) => x.text.includes(t)));
  $('main').innerHTML =
    `<div class="search-head"><div><h1>Search the full schema</h1><div class="muted smalltext">${fmt(matches.length)} matches across all profiles${matches.length > 150 ? ' · showing the first 150' : ''}</div></div><button class="btn" data-action="clear-search">Clear search</button></div><div class="search-results">${
      matches
        .slice(0, 150)
        .map(
          (x) =>
            `<button class="result" data-result-db="${x.db}" data-result-tab="${x.tab}" data-result-item="${x.id}"><span class="pill ${x.kind === 'JSON shape' ? 'amber' : ''}">${esc(x.kind)}</span><strong>${esc(x.label)}</strong><small>${esc(x.path)}</small></button>`,
        )
        .join('') ||
      '<div class="empty"><h3>No matching schema</h3>Try a column name, key namespace, or part of a JSON field name.</div>'
    }</div>`;
}
function notify(text: string) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 2200);
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify('Schema copied');
  } catch {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.append(el);
    el.select();
    const ok = document.execCommand('copy');
    el.remove();
    notify(ok ? 'Schema copied' : 'Clipboard unavailable — use Download instead');
  }
}
function download(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type })),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  notify('Export prepared');
}
function bundle() {
  const defs: Record<string, any> = {};
  for (const d of catalog.databases) {
    for (const t of d.tables) defs[t.id] = t.rowJsonSchema;
    for (const s of d.jsonSchemas)
      if (s.hasShape)
        defs[s.id] = {
          $id: 'urn:dia-schema:' + s.id,
          title: s.label,
          'x-source': {
            database: d.path,
            table: s.table,
            column: s.column,
            key: s.key ?? null,
            encoding: s.encoding,
          },
          ...s.schema,
        };
  }
  return {
    $schema: catalog.jsonSchemaDialect,
    $id: 'urn:dia-schema:bundle:1',
    title: 'Dia observed JSON schemas and SQL row projections',
    description:
      'Schema library: select a definition with a $ref. Inferred JSON shapes are observational, not vendor-authored contracts.',
    'x-generatedAt': catalog.generatedAt,
    $defs: defs,
  };
}
function sqlArchive() {
  return (
    '-- Dia SQL schema metadata. Extracted read-only; contains no table rows.\n-- Database names delimit separate databases; this is an archive, not a combined migration.\n\n' +
    catalog.databases
      .map(
        (d) =>
          '-- DATABASE: ' +
          d.path +
          '\n\n' +
          d.objects
            .filter((o) => o.sql)
            .map((o) => o.sql.replace(/;?$/, ';'))
            .join('\n\n'),
      )
      .join('\n\n')
  );
}
function selectDB(id: string) {
  state.db = id;
  state.item = null;
  state.localQuery = '';
  state.mode = 'tree';
  state.globalQuery = '';
  $('globalSearch').value = '';
  chooseDefault();
  $('sidebar').classList.remove('open');
  render();
}
function selectTable(name: string) {
  const t = db().tables.find((t) => t.name === name);
  if (t) {
    state.tab = 'sql';
    state.item = t.id;
    state.mode = 'tree';
    state.localQuery = '';
    render();
  }
}
document.addEventListener('click', (event) => {
  const target = (event.target as Element).closest<HTMLElement>('button,[data-table-name]');
  if (!target) return;
  if (target.dataset.view) {
    appView = target.dataset.view;
    state.globalQuery = '';
    $('globalSearch').value = '';
    render();
    return;
  }
  if (target.dataset.recordTable) {
    appView = 'profiles';
    state.globalQuery = '';
    render();
    profileView.openRecords(state.db, target.dataset.recordTable);
    return;
  }
  if (profileView.click(target)) {
    state.globalQuery = '';
    return;
  }

  if (target.dataset.db) {
    selectDB(target.dataset.db);
    return;
  }
  if (target.dataset.tab) {
    state.tab = target.dataset.tab;
    state.localQuery = '';
    state.mode = 'tree';
    chooseDefault();
    render();
    return;
  }
  if (target.dataset.item) {
    state.item = target.dataset.item;
    state.mode = 'tree';
    renderItems();
    renderDetail();
    saveHash();
    return;
  }
  if (target.dataset.mode) {
    state.mode = target.dataset.mode;
    renderDetail();
    return;
  }
  if (target.dataset.tableName) {
    selectTable(target.dataset.tableName);
    return;
  }
  if (target.dataset.tableJson) {
    const t = db().tables.find((t) => t.id === target.dataset.tableJson);
    state.tab = 'json';
    state.jsonFilter = 'all';
    state.localQuery = '';
    state.item = t?.jsonSchemaIds[0];
    state.mode = 'tree';
    render();
    return;
  }
  if (target.dataset.resultDb) {
    state.db = target.dataset.resultDb;
    state.tab = target.dataset.resultTab!;
    state.item = target.dataset.resultItem;
    state.mode = 'tree';
    state.jsonFilter = 'all';
    state.localQuery = '';
    state.globalQuery = '';
    $('globalSearch').value = '';
    $('profileFilter').value = 'all';
    $('storeFilter').value = '';
    render();
    return;
  }
  if (target.dataset.export) {
    const which = target.dataset.export;
    download(
      which === 'catalog'
        ? 'dia-schema-catalog.json'
        : which === 'json'
          ? 'dia-json-schemas.json'
          : 'dia-sql-schema.sql',
      which === 'catalog'
        ? JSON.stringify(catalog, null, 2)
        : which === 'json'
          ? JSON.stringify(bundle(), null, 2)
          : sqlArchive(),
      which === 'sql' ? 'text/plain' : 'application/json',
    );
    $('exportPanel').hidden = true;
    $('exportToggle').setAttribute('aria-expanded', 'false');
    return;
  }
  const action = target.dataset.action,
    s = db()?.jsonSchemas.find((s) => s.id === state.item),
    t = db()?.tables.find((t) => t.id === state.item);
  if (action === 'copy-json' && s) copy(JSON.stringify(selectedSchema(s), null, 2));
  if (action === 'download-json' && s)
    download(s.id + '.schema.json', JSON.stringify(selectedSchema(s), null, 2));
  if (action === 'copy-sql' && t) copy(t.sql || '');
  if (action === 'download-row' && t)
    download(t.name + '.row.schema.json', JSON.stringify(t.rowJsonSchema, null, 2));
  if (action === 'expand-tree')
    document
      .querySelectorAll<HTMLDetailsElement>('#schemaTree details')
      .forEach((d) => (d.open = true));
  if (action === 'clear-search') {
    state.globalQuery = '';
    $('globalSearch').value = '';
    render();
  }
});
$('profileFilter').addEventListener('change', () => {
  const visible = visibleStores();
  if (visible.length && !visible.some((d) => d.id === state.db))
    selectDB((visible.find((d) => d.family === 'key_value_store') || visible[0]).id);
  else renderStores();
});
$('storeFilter').addEventListener('input', renderStores);
$('globalSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.globalQuery = $('globalSearch').value.trim();
    render();
  }, 100);
});
document.addEventListener('input', (e) => {
  const target = e.target as HTMLInputElement;
  if (profileView.input(target)) return;
  if (target.id === 'localSearch') {
    state.localQuery = target.value;
    renderItems();
  }
});
document.addEventListener('change', (e) => {
  const target = e.target as HTMLSelectElement;
  if (profileView.change(target)) {
    state.globalQuery = '';
    return;
  }
  if (target.id === 'jsonFilter') {
    state.jsonFilter = target.value;
    renderItems();
  }
});
$('exportToggle').addEventListener('click', () => {
  $('exportPanel').hidden = !$('exportPanel').hidden;
  $('exportToggle').setAttribute('aria-expanded', String(!$('exportPanel').hidden));
});
document.addEventListener('click', (e) => {
  if (!(e.target as Element).closest('.export')) {
    $('exportPanel').hidden = true;
    $('exportToggle').setAttribute('aria-expanded', 'false');
  }
});
$('about').addEventListener('click', () => $('aboutDialog').showModal());
$('closeDialog').addEventListener('click', () => $('aboutDialog').close());
$('mobileNav').addEventListener('click', () => $('sidebar').classList.add('open'));
$('closeNav').addEventListener('click', () => $('sidebar').classList.remove('open'));
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    $('globalSearch').focus();
  }
  if (e.key === 'Escape' && document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') {
    state.globalQuery = '';
    $('globalSearch').value = '';
    $('sidebar').classList.remove('open');
    $('exportPanel').hidden = true;
    render();
  }
  if ((e.key === 'Enter' || e.key === ' ') && (e.target as Element).matches('.graph-node')) {
    e.preventDefault();
    selectTable((e.target as HTMLElement).dataset.tableName!);
  }
});
window.addEventListener('popstate', () => {
  restoreHash();
  profileView.restore();
  state.globalQuery = '';
  $('globalSearch').value = '';
  render();
});
init();
