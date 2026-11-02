import type {
  BrowserNode,
  BrowserPage,
  BrowserProfile,
  Catalog,
  DataCell,
  TableData,
} from '../types';
const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const fmt = (n: number) => n.toLocaleString();
const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const folderIcon = svg('<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/>');
const pageIcon = svg(
  '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h4"/>',
);
const containerIcon = svg(
  '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M8 9v11"/>',
);
const starIcon = svg(
  '<path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3-5.7-3-5.7 3 1.1-6.3-4.6-4.5 6.4-.9Z"/>',
);
function icon(node: BrowserNode): string {
  if (node.icon?.emoji) return `<span class="p-emoji">${esc(node.icon.emoji)}</span>`;
  const symbol = node.icon?.symbol;
  return `<span class="p-icon" title="${esc(symbol ?? node.kind)}">${symbol === 'checkmarkOnStack' ? svg('<path d="M5 6h14v4H5zM4 13h16M4 17h8M16 18l2 2 4-4"/>') : symbol && symbol !== 'folder' ? svg('<rect x="5" y="5" width="14" height="14" rx="4"/><path d="M9 12h6"/>') : node.kind === 'group' || symbol === 'folder' ? folderIcon : node.kind === 'favorites' ? starIcon : node.kind === 'tab' || node.kind === 'content_pane' ? pageIcon : containerIcon}</span>`;
}
export function safePageURL(url: string): string | null {
  try {
    const u = new URL(url);
    return ['https:', 'http:'].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !url.includes('[redacted]') &&
      !url.includes('%5Bredacted%5D')
      ? u.href
      : null;
  } catch {
    return null;
  }
}
function domain(url: string): string {
  try {
    return new URL(url).hostname || new URL(url).protocol;
  } catch {
    return 'No URL';
  }
}
function prettyCell(c: DataCell | undefined): string {
  if (!c) return '';
  if (['redacted', 'binary', 'truncated'].includes(c.kind))
    return `[${c.kind}${c.bytes !== undefined ? ' · ' + fmt(c.bytes) + ' bytes' : ''}]`;
  return c.value === null
    ? 'null'
    : typeof c.value === 'object'
      ? JSON.stringify(c.value)
      : String(c.value ?? '');
}
export function createProfileView(
  catalog: Catalog,
  hooks: {
    schema: (db: string, table?: string) => void;
    copy: (text: string) => void;
    download: (name: string, text: string, type?: string) => void;
  },
) {
  const profiles = catalog.profiles ?? [];
  const state = {
    profile: profiles[0]?.id ?? '',
    section: 'overview',
    node: '',
    space: '',
    includeDeleted: false,
    recursive: true,
    domain: '',
    layout: 'cards',
    page: 0,
    db: '',
    table: '',
    recordQuery: '',
    sort: '',
    descending: false,
    rowPage: 0,
  };
  const maps = new Map(profiles.map((p) => [p.id, new Map(p.nodes.map((n) => [n.id, n]))]));
  let query = '';
  const expanded = new Map(
    profiles.map((p) => [
      p.id,
      new Set(
        p.nodes
          .filter((n) => ['window', 'pinned_container', 'favorites'].includes(n.kind))
          .map((n) => n.id),
      ),
    ]),
  );
  document.addEventListener(
    'toggle',
    (e) => {
      const element = e.target as HTMLDetailsElement;
      if (element.dataset.pBranch !== undefined) {
        const set = expanded.get(state.profile)!;
        if (element.open) set.add(element.dataset.pBranch);
        else set.delete(element.dataset.pBranch);
      }
    },
    true,
  );
  const $ = (id: string) => document.getElementById(id)!;
  const profile = () => profiles.find((p) => p.id === state.profile) ?? profiles[0];
  const nodeMap = () => maps.get(profile()?.id) ?? new Map<string, BrowserNode>();
  const node = () => nodeMap().get(state.node);
  const availableDBs = () =>
    catalog.databases.filter((d) => d.profile === state.profile || d.profile === 'Global');
  const database = () =>
    catalog.databases.find((d) => d.id === state.db) ??
    availableDBs().find((d) => d.family === 'tabs') ??
    availableDBs()[0];
  const table = () =>
    database()?.data?.find((t) => t.table === state.table) ?? database()?.data?.[0];
  function descendants(root: BrowserNode): BrowserNode[] {
    const out: BrowserNode[] = [],
      todo = [root],
      seen = new Set<string>();
    while (todo.length) {
      const n = todo.pop()!;
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n);
      todo.push(
        ...[...n.children]
          .reverse()
          .map((id) => nodeMap().get(id))
          .filter((n): n is BrowserNode => Boolean(n)),
      );
    }
    return out;
  }
  const visible = (n: BrowserNode) =>
    (state.includeDeleted || !n.effectiveDeleted) &&
    (!state.space ||
      n.spaceId === state.space ||
      descendants(n).some((x) => x.spaceId === state.space));
  const pages = (n: BrowserNode) =>
    descendants(n)
      .filter(visible)
      .flatMap((x) => x.pages);
  function breadcrumbs(n: BrowserNode): BrowserNode[] {
    const path = [n];
    let parent = n.parentId;
    const seen = new Set([n.id]);
    while (parent !== null && nodeMap().has(parent) && !seen.has(parent)) {
      seen.add(parent);
      const p = nodeMap().get(parent)!;
      path.unshift(p);
      parent = p.parentId;
    }
    return path;
  }
  function setURL(push = false) {
    const params = new URLSearchParams({
      view: 'profiles',
      profile: state.profile,
      section: state.section,
    });
    if (state.node) params.set('node', state.node);
    if (state.section === 'records') {
      params.set('db', database()?.id ?? '');
      params.set('table', table()?.table ?? '');
    }
    const hash = '#' + params;
    if (hash === location.hash) return;
    history[push ? 'pushState' : 'replaceState'](null, '', hash);
  }
  function restore() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (profiles.some((x) => x.id === p.get('profile'))) state.profile = p.get('profile')!;
    if (['overview', 'library', 'records'].includes(p.get('section') ?? ''))
      state.section = p.get('section')!;
    state.node = p.get('node') ?? '';
    state.db = p.get('db') ?? '';
    state.table = p.get('table') ?? '';
  }
  restore();
  function navigation() {
    const p = profile();
    if (!p) {
      $('profileNav').innerHTML = '<div class="empty">No profile data found.</div>';
      return;
    }
    const branch = (n: BrowserNode, depth = 0): string => {
      if (depth > 64 || !visible(n)) return '';
      const children = n.children
        .map((id) => nodeMap().get(id)!)
        .filter((x) => x && ['group', 'favorites', 'pinned_container', 'window'].includes(x.kind));
      const button = `<button class="p-tree-button ${state.node === n.id && state.section === 'library' ? 'active' : ''}" data-p-node="${esc(n.id)}">${icon(n)}<span>${esc(n.title)}</span><small>${pages(n).length}</small></button>`;
      if (!children.length) return button;
      return `<details class="p-tree-branch" data-p-branch="${esc(n.id)}" ${expanded.get(state.profile)?.has(n.id) ? 'open' : ''}><summary aria-label="Expand ${esc(n.title)}">${button}</summary><div>${children.map((x) => branch(x, depth + 1)).join('')}</div></details>`;
    };
    $('profileNav').innerHTML =
      `<div class="p-side-header"><div class="eyebrow">Your workspace</div><label class="sr-only" for="pProfile">Profile</label><select id="pProfile">${profiles.map((x) => `<option value="${esc(x.id)}" ${x.id === state.profile ? 'selected' : ''}>${esc(x.name)} · ${esc(x.id)}</option>`).join('')}</select>${p.email ? `<div class="p-email">${esc(p.email)}</div>` : ''}</div><div class="p-nav-sections">${[
        ['overview', 'Overview', '◫'],
        ['library', 'Folders & tabs', '▱'],
        ['records', 'Database records', '▤'],
      ]
        .map(
          ([s, l, i]) =>
            `<button data-p-section="${s}" class="${state.section === s ? 'active' : ''}"><span>${i}</span>${l}</button>`,
        )
        .join(
          '',
        )}</div><div class="p-tree-title"><span class="eyebrow">Folder tree</span><button class="link-button" data-p-action="expand-tree">Expand</button></div><div class="p-tree">${
        p.roots
          .map((id) => nodeMap().get(id)!)
          .filter((n) => ['group', 'favorites', 'pinned_container', 'window'].includes(n.kind))
          .map((n) => branch(n))
          .join('') || '<div class="empty">No folder containers.</div>'
      }</div><div class="p-side-footer"><span class="dot"></span>Local snapshot · Read only</div>`;
  }
  function header(title: string, subtitle: string, action = '') {
    return `<section class="p-page-head"><div><div class="eyebrow">${esc(profile()?.name ?? 'Profiles')} <span class="p-head-separator">/</span> ${esc(state.section === 'records' ? 'Data explorer' : 'Profile explorer')}</div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${action}</section>`;
  }
  function stats() {
    const p = profile();
    const current = p.nodes.filter((n) => !n.effectiveDeleted);
    return `<div class="p-stats">${[
      [p.folderCount, 'Folders', folderIcon],
      [p.tabCount, 'Tabs', pageIcon],
      [p.urlCount, 'Saved URLs', containerIcon],
      [p.spaces.length, 'Spaces', starIcon],
    ]
      .map(
        ([count, label, svg]) =>
          `<div class="p-stat"><span class="p-stat-icon">${svg}</span><strong>${fmt(Number(count))}</strong><span>${label}</span></div>`,
      )
      .join('')}</div>`;
  }
  function folderCard(n: BrowserNode) {
    const count = pages(n).length;
    return `<button class="p-folder-card" data-p-node="${esc(n.id)}">${icon(n)}<span class="p-folder-title">${esc(n.title)}</span><span class="p-folder-meta">${count} ${count === 1 ? 'URL' : 'URLs'}${n.children.some((id) => nodeMap().get(id)?.kind === 'group') ? ' · nested folders' : ''}</span><span class="p-card-arrow" title="${esc(n.icon?.symbol ?? '')}">↗</span>${n.effectiveDeleted ? '<span class="pill amber">Removed</span>' : ''}</button>`;
  }
  function profileCards() {
    return `<div class="p-profiles">${profiles.map((p, i) => `<button data-p-profile="${esc(p.id)}" class="p-profile ${p.id === state.profile ? 'active' : ''}"><span class="p-avatar" style="--avatar-hue:${[150, 215, 30, 275][i % 4]}">${esc(p.name.slice(0, 1).toUpperCase())}</span><span><strong>${esc(p.name)}</strong><small>${esc(p.id)} · ${p.folderCount} folders</small></span>${p.id === state.profile ? '<span class="p-selected-dot"></span>' : ''}</button>`).join('')}</div>`;
  }
  function overview() {
    const p = profile(),
      folders = p.nodes.filter((n) => n.kind === 'group' && !n.effectiveDeleted),
      allPages = p.nodes.filter((n) => !n.effectiveDeleted).flatMap((n) => n.pages);
    const domains = new Map<string, number>();
    for (const page of allPages)
      domains.set(domain(page.url), (domains.get(domain(page.url)) ?? 0) + 1);
    const top = [...domains].sort((a, b) => b[1] - a[1]).slice(0, 8);
    $('main').innerHTML =
      header(
        'A clearer view of your browser',
        'Browse your profiles, open a folder, or inspect the records behind it.',
        `<button class="btn" data-p-schema="${p.dbId}">Inspect schema ↗</button>`,
      ) +
      profileCards() +
      stats() +
      `<div class="p-overview-grid"><section><div class="p-section-heading"><h2>Your folders <span>${folders.length}</span></h2><button class="link-button" data-p-section="library">View all →</button></div><div class="p-folder-grid">${folders.slice(0, 12).map(folderCard).join('') || '<div class="empty">No active folders in this profile.</div>'}</div></section><aside class="p-insights"><section class="p-panel"><h3>Spaces</h3>${p.spaces.map((s) => `<button class="p-space-row" data-p-space="${esc(s.id)}"><span class="p-space-dot"></span><strong>${esc(s.title)}</strong><span>→</span></button>`).join('') || '<p class="muted">No spaces stored.</p>'}</section><section class="p-panel"><h3>Most saved domains</h3>${top.map(([d, n]) => `<button class="p-domain-row" data-p-domain="${esc(d)}"><span>${esc(d)}</span><strong>${n}</strong></button>`).join('') || '<p class="muted">No saved URLs.</p>'}</section><section class="p-panel p-snapshot"><div class="eyebrow">Snapshot</div><p>${esc(new Date(p.capturedAt).toLocaleString())}</p><span class="pill ${p.status === 'ok' ? 'green' : 'amber'}">${p.status === 'ok' ? 'Integrity verified' : 'Extraction incomplete'}</span><p class="smalltext muted">A local view of saved browser state. Re-export to refresh.</p>${p.issues.length ? `<p class="smalltext">${p.issues.length} tree issues recovered; inspect database records for original relationships.</p>` : ''}</section></aside></div>`;
  }
  function selectedNodes(): BrowserNode[] {
    const p = profile(),
      selected = node();
    let candidates = selected ? descendants(selected) : p.nodes;
    if (selected && !state.recursive)
      candidates = [selected, ...selected.children.map((id) => nodeMap().get(id)!).filter(Boolean)];
    return candidates.filter(visible);
  }
  function tabPages(n: BrowserNode): BrowserPage[] {
    return descendants(n)
      .filter((x) => state.includeDeleted || !x.effectiveDeleted)
      .flatMap((x) => x.pages);
  }
  function tabCard(n: BrowserNode) {
    const ps = tabPages(n),
      path = breadcrumbs(n)
        .filter((x) => x.kind === 'group')
        .map((x) => x.title)
        .join(' / ');
    const first = ps[0],
      host = first ? domain(first.url) : 'No URL';
    return `<article class="p-tab-card"><div class="p-tab-title"><span class="p-domain-icon">${esc(host.slice(0, 1).toUpperCase())}</span><div><strong>${esc(n.title)}</strong><small>${esc(path || host)}</small></div><button class="p-icon-button" aria-label="Inspect ${esc(n.title)}" data-p-inspect="${esc(n.id)}">⋯</button></div><div class="p-tab-pages">${
      ps
        .map((page) => {
          const href = safePageURL(page.url);
          return `<div class="p-page-link">${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="${esc(page.url)}">${ps.length > 1 ? `<span class="p-pane-label">${esc(page.title || 'Pane')}</span>` : ''}<span>${esc(page.url)}</span><b>↗</b></a>` : `<span class="p-nonlink" title="Internal, unavailable, or redacted URL">${esc(page.url || 'No stored URL')}</span>`}<button data-p-copy-page="${esc(n.id)}" data-p-page-id="${esc(page.id)}" aria-label="Copy URL">⧉</button></div>`;
        })
        .join('') || '<div class="p-no-url">No web page URL stored for this tab.</div>'
    }</div><div class="p-tab-foot"><span>${ps.length > 1 ? ps.length + ' panes' : esc(host)}</span>${n.effectiveDeleted ? '<span class="pill amber">Removed</span>' : ''}<button class="link-button" data-p-inspect="${esc(n.id)}">Details</button></div></article>`;
  }
  function library() {
    const p = profile(),
      selected = node();
    const candidates = selectedNodes();
    const folders = candidates.filter(
      (n) =>
        n.kind === 'group' && n.id !== selected?.id && (!selected || n.parentId === selected.id),
    );
    let tabs = candidates.filter((n) => n.kind === 'tab');
    if (selected?.kind === 'tab') tabs = [selected];
    const hosts = [...new Set(tabs.flatMap((n) => tabPages(n).map((p) => domain(p.url))))].sort();
    if (state.domain)
      tabs = tabs.filter((n) => tabPages(n).some((p) => domain(p.url) === state.domain));
    const pageSize = 30,
      count = tabs.length;
    state.page = Math.min(state.page, Math.max(0, Math.ceil(count / pageSize) - 1));
    const crumbs = selected
      ? `<div class="p-breadcrumbs"><button data-p-node="">All folders</button>${breadcrumbs(
          selected,
        )
          .map((n) => `<span>/</span><button data-p-node="${esc(n.id)}">${esc(n.title)}</button>`)
          .join('')}</div>`
      : '';
    $('main').innerHTML =
      header(
        selected?.title || 'Folders & tabs',
        `${fmt(count)} tabs${state.space ? ' in selected space' : ''} · ${state.recursive ? 'Including nested folders' : 'Direct contents'}`,
        `<div class="actions"><button class="btn" data-p-action="export-urls">Export URLs ↓</button>${selected ? `<button class="btn" data-p-inspect="${esc(selected.id)}">Folder details</button>` : ''}</div>`,
      ) +
      crumbs +
      `<div class="p-library-toolbar"><div class="p-filter-group"><label>Space <select id="pSpace"><option value="">All spaces</option>${p.spaces.map((s) => `<option value="${esc(s.id)}" ${state.space === s.id ? 'selected' : ''}>${esc(s.title)}</option>`).join('')}</select></label><label>Domain <select id="pDomain"><option value="">All domains</option>${hosts.map((h) => `<option ${h === state.domain ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select></label></div><div class="p-filter-group"><label class="p-check"><input type="checkbox" id="pRecursive" ${state.recursive ? 'checked' : ''}>Nested contents</label><label class="p-check"><input type="checkbox" id="pDeleted" ${state.includeDeleted ? 'checked' : ''}>Include removed</label><div class="segment"><button data-p-layout="cards" class="${state.layout === 'cards' ? 'active' : ''}" aria-label="Card view">▦</button><button data-p-layout="list" class="${state.layout === 'list' ? 'active' : ''}" aria-label="List view">☰</button></div></div></div>${folders.length ? `<div class="p-folder-grid compact">${folders.map(folderCard).join('')}</div>` : ''}<div class="p-section-heading"><h2>${selected?.kind === 'tab' ? 'Tab contents' : 'Tabs'} <span>${fmt(count)}</span></h2><span class="smalltext muted">Links open only when clicked</span></div><div class="p-tabs-grid ${state.layout === 'list' ? 'list' : ''}">${
        tabs
          .slice(state.page * pageSize, (state.page + 1) * pageSize)
          .map(tabCard)
          .join('') ||
        '<div class="empty"><h3>No tabs match</h3>Try another folder, space, or domain.</div>'
      }</div><div class="p-pagination"><span>${count ? state.page * pageSize + 1 : 0}–${Math.min((state.page + 1) * pageSize, count)} of ${fmt(count)} tabs</span><div><button class="btn small" data-p-page="${state.page - 1}" ${state.page === 0 ? 'disabled' : ''}>Previous</button><button class="btn small" data-p-page="${state.page + 1}" ${(state.page + 1) * pageSize >= count ? 'disabled' : ''}>Next</button></div></div>`;
  }
  function filteredRows() {
    let rows = (table()?.rows ?? []).map((row, index) => ({ row, index }));
    const q = state.recordQuery.toLowerCase();
    if (q)
      rows = rows.filter((x) =>
        Object.values(x.row).some((c) => prettyCell(c).toLowerCase().includes(q)),
      );
    if (state.sort)
      rows.sort((a, b) => {
        const av = a.row[state.sort]?.value,
          bv = b.row[state.sort]?.value;
        const cmp =
          typeof av === 'number' && typeof bv === 'number'
            ? av - bv
            : prettyCell(a.row[state.sort]).localeCompare(
                prettyCell(b.row[state.sort]),
                undefined,
                { numeric: true },
              );
        return state.descending ? -cmp : cmp;
      });
    return rows;
  }
  function records() {
    const d = database();
    if (!d) {
      $('main').innerHTML = header('Database records', 'No stores in this profile.');
      return;
    }
    state.db = d.id;
    const t = table();
    if (t) state.table = t.table;
    $('main').innerHTML =
      header(
        'Database records',
        'Browse stored values, inspect JSON, and jump to the matching SQL schema.',
        `<button class="btn" data-p-schema="${d.id}" data-p-schema-table="${esc(t?.table ?? '')}">View schema ↗</button>`,
      ) +
      `<div class="p-record-controls"><label>Database<select id="pDatabase">${availableDBs()
        .map(
          (x) =>
            `<option value="${x.id}" ${x.id === state.db ? 'selected' : ''}>${esc(x.path)}</option>`,
        )
        .join(
          '',
        )}</select></label><label>Table<select id="pTable">${(d.data ?? []).map((x) => `<option value="${esc(x.table)}" ${x.table === state.table ? 'selected' : ''}>${esc(x.table)} · ${fmt(x.totalRows)} rows</option>`).join('')}</select></label><label>Filter rows<input type="search" id="pRecordSearch" placeholder="Search values in this table…" value="${esc(state.recordQuery)}"></label></div><div id="pRecordsBody"></div>`;
    recordsBody();
  }
  function recordsBody() {
    const d = database(),
      t = table();
    if (!t) {
      $('pRecordsBody').innerHTML =
        '<div class="empty">No records exported for this database.</div>';
      return;
    }
    const columns =
        d.tables.find((x) => x.name === t.table)?.columns.map((c) => String(c.name)) ??
        Object.keys(t.rows[0] ?? {}),
      rows = filteredRows(),
      pageSize = 50;
    state.rowPage = Math.min(state.rowPage, Math.max(0, Math.ceil(rows.length / pageSize) - 1));
    $('pRecordsBody').innerHTML =
      `<div class="p-record-caption"><span>${fmt(rows.length)} matching / ${fmt(t.totalRows)} stored rows</span><div>${t.redactedCells ? `<span class="pill amber">${fmt(t.redactedCells)} cells redacted</span>` : ''}${t.truncated ? '<span class="pill amber">Export row limit reached</span>' : ''}<button class="btn small" data-p-action="export-rows">Export filtered rows ↓</button></div></div><div class="p-record-table table-wrap"><table><thead><tr><th>Inspect</th>${columns.map((c) => `<th><button data-p-sort="${esc(c)}">${esc(c)} ${state.sort === c ? (state.descending ? '↓' : '↑') : ''}</button></th>`).join('')}</tr></thead><tbody>${rows
        .slice(state.rowPage * pageSize, (state.rowPage + 1) * pageSize)
        .map(
          ({ row, index }) =>
            `<tr><td><button class="link-button" data-p-row="${index}">#${index + 1} ↗</button></td>${columns
              .map((c) => {
                const cell = row[c];
                const text = prettyCell(cell);
                return `<td><button class="p-cell ${cell?.kind === 'redacted' ? 'redacted' : ''}" data-p-row="${index}" title="Inspect full row">${esc(text.length > 180 ? text.slice(0, 180) + '…' : text)}</button></td>`;
              })
              .join('')}</tr>`,
        )
        .join(
          '',
        )}</tbody></table>${!rows.length ? '<div class="empty">No matching records.</div>' : ''}</div><div class="p-pagination"><span>${rows.length ? state.rowPage * pageSize + 1 : 0}–${Math.min((state.rowPage + 1) * pageSize, rows.length)} of ${fmt(rows.length)} rows</span><div><button class="btn small" data-p-row-page="${state.rowPage - 1}" ${state.rowPage === 0 ? 'disabled' : ''}>Previous</button><button class="btn small" data-p-row-page="${state.rowPage + 1}" ${(state.rowPage + 1) * pageSize >= rows.length ? 'disabled' : ''}>Next</button></div></div><p class="smalltext muted">Credential fields are redacted. Opaque binary and oversized cells show metadata. Values are a snapshot, not a live connection.</p>`;
  }
  function search() {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const results = profiles.flatMap((p) =>
      p.nodes
        .filter(
          (n) =>
            (state.includeDeleted || !n.effectiveDeleted) &&
            ['group', 'tab', 'content_pane'].includes(n.kind),
        )
        .filter((n) =>
          terms.every((t) =>
            [p.name, n.title, ...n.pages.flatMap((x) => [x.title, x.url])]
              .join(' ')
              .toLowerCase()
              .includes(t),
          ),
        )
        .map((n) => ({ p, n })),
    );
    $('main').innerHTML =
      header(
        'Search your profiles',
        `${fmt(results.length)} matches for “${query}” across all profiles`,
      ) +
      `<div class="p-search-results">${
        results
          .slice(0, 150)
          .map(
            ({ p, n }) =>
              `<button class="p-search-result" data-p-result-profile="${esc(p.id)}" data-p-result-node="${esc(n.id)}">${icon(n)}<span><strong>${esc(n.title)}</strong><small>${esc(p.name)} · ${esc(n.kind)}${n.pages[0] ? ' · ' + esc(n.pages[0].url) : ''}</small></span><b>→</b></button>`,
          )
          .join('') ||
        '<div class="empty">No matching folders or pages. Use Database records to search stored values.</div>'
      }</div>${results.length > 150 ? '<p class="muted">Showing the first 150 results. Refine your search to narrow the list.</p>' : ''}`;
  }
  function details(title: string, content: any) {
    const el = $('profileDetails') as HTMLDialogElement;
    $('pDetailTitle').textContent = title;
    $('pDetailCode').textContent = JSON.stringify(content, null, 2);
    el.showModal();
  }
  function render(nextQuery = '') {
    query = nextQuery;
    navigation();
    const p = profile();
    if (!p) {
      $('main').innerHTML = '<div class="empty">No profile snapshots available.</div>';
      return;
    }
    if (query) search();
    else if (state.section === 'library') library();
    else if (state.section === 'records') records();
    else overview();
    if (catalog.dataCoverage?.truncatedTables)
      $('main').insertAdjacentHTML(
        'afterbegin',
        `<div class="note inferred">Partial data export: ${catalog.dataCoverage.truncatedTables} tables reached the row limit. Folder contents may be incomplete. Re-export with --row-limit 0 for all rows.</div>`,
      );
    if (!query) setURL();
  }
  function go() {
    query = '';
    ($('globalSearch') as HTMLInputElement).value = '';
    state.page = 0;
    state.rowPage = 0;
    setURL(true);
    $('sidebar').classList.remove('open');
    render();
  }
  function click(target: HTMLElement): boolean {
    const d = target.dataset;
    if (d.pProfile !== undefined) {
      state.profile = d.pProfile;
      state.node = '';
      state.space = '';
      state.domain = '';
      state.db = '';
      state.table = '';
      state.section = 'overview';
      go();
      return true;
    }
    if (d.pSection) {
      state.section = d.pSection;
      state.node = '';
      state.domain = '';
      state.space = '';
      go();
      return true;
    }
    if (d.pNode !== undefined) {
      state.node = d.pNode;
      state.section = 'library';
      state.domain = '';
      go();
      return true;
    }
    if (d.pResultProfile) {
      state.profile = d.pResultProfile;
      const n = maps.get(state.profile)?.get(d.pResultNode!);
      state.node = n?.kind === 'content_pane' ? (n.parentId ?? n.id) : (n?.id ?? '');
      state.section = 'library';
      state.space = '';
      state.domain = '';
      go();
      return true;
    }
    if (d.pSpace !== undefined) {
      state.section = 'library';
      state.space = d.pSpace;
      state.node = '';
      go();
      return true;
    }
    if (d.pDomain !== undefined) {
      state.section = 'library';
      state.domain = d.pDomain;
      state.node = '';
      state.space = '';
      go();
      return true;
    }
    if (d.pSchema) {
      hooks.schema(d.pSchema, d.pSchemaTable);
      return true;
    }
    if (d.pLayout) {
      state.layout = d.pLayout;
      render();
      return true;
    }
    if (d.pPage !== undefined) {
      state.page = Number(d.pPage);
      render();
      return true;
    }
    if (d.pRowPage !== undefined) {
      state.rowPage = Number(d.pRowPage);
      recordsBody();
      return true;
    }
    if (d.pSort) {
      if (state.sort === d.pSort) state.descending = !state.descending;
      else {
        state.sort = d.pSort;
        state.descending = false;
      }
      recordsBody();
      return true;
    }
    if (d.pRow !== undefined) {
      details(`${table()?.table} · row ${Number(d.pRow) + 1}`, table()?.rows[Number(d.pRow)]);
      return true;
    }
    if (d.pInspect) {
      const n = nodeMap().get(d.pInspect);
      if (n) details(n.title, { ...n, pages: pages(n) });
      return true;
    }
    if (d.pCopyPage) {
      const n = nodeMap().get(d.pCopyPage);
      const page = n ? tabPages(n).find((p) => p.id === d.pPageId) : undefined;
      if (page) hooks.copy(page.url);
      return true;
    }
    if (d.pAction === 'close-details') {
      ($('profileDetails') as HTMLDialogElement).close();
      return true;
    }
    if (d.pAction === 'copy-details') {
      hooks.copy($('pDetailCode').textContent ?? '');
      return true;
    }
    if (d.pAction === 'expand-tree') {
      document
        .querySelectorAll<HTMLDetailsElement>('.p-tree details')
        .forEach((e) => (e.open = true));
      return true;
    }
    if (d.pAction === 'export-rows') {
      hooks.download(
        `${database()?.profile}-${table()?.table}.json`,
        JSON.stringify(
          filteredRows().map((r) => r.row),
          null,
          2,
        ),
      );
      return true;
    }
    if (d.pAction === 'export-urls') {
      const selected = selectedNodes().filter((n) => n.kind === 'tab');
      const exported = selected.flatMap((n) =>
        tabPages(n)
          .filter((p) => !state.domain || domain(p.url) === state.domain)
          .map((p) => ({
            profile: profile().id,
            folder: breadcrumbs(n)
              .filter((x) => x.kind === 'group')
              .map((x) => x.title)
              .join(' / '),
            tab: n.title,
            title: p.title,
            url: p.url,
          })),
      );
      hooks.download('dia-folder-urls.json', JSON.stringify(exported, null, 2));
      return true;
    }
    return false;
  }
  function change(target: HTMLInputElement | HTMLSelectElement): boolean {
    if (target.id === 'pProfile') {
      state.profile = target.value;
      state.node = '';
      state.db = '';
      state.table = '';
      state.space = '';
      state.domain = '';
      state.section = 'overview';
      go();
    } else if (target.id === 'pSpace') {
      state.space = target.value;
      state.page = 0;
      render();
    } else if (target.id === 'pDomain') {
      state.domain = target.value;
      state.page = 0;
      render();
    } else if (target.id === 'pRecursive') {
      state.recursive = (target as HTMLInputElement).checked;
      state.page = 0;
      render();
    } else if (target.id === 'pDeleted') {
      state.includeDeleted = (target as HTMLInputElement).checked;
      state.page = 0;
      render();
    } else if (target.id === 'pDatabase') {
      state.db = target.value;
      state.table = '';
      state.recordQuery = '';
      state.sort = '';
      state.rowPage = 0;
      render();
    } else if (target.id === 'pTable') {
      state.table = target.value;
      state.recordQuery = '';
      state.sort = '';
      state.rowPage = 0;
      render();
    } else return false;
    return true;
  }
  function input(target: HTMLInputElement): boolean {
    if (target.id !== 'pRecordSearch') return false;
    state.recordQuery = target.value;
    state.rowPage = 0;
    recordsBody();
    return true;
  }
  function openRecords(db: string, tableName: string) {
    const d = catalog.databases.find((d) => d.id === db);
    if (d && d.profile !== 'Global') state.profile = d.profile;
    state.section = 'records';
    state.db = db;
    state.table = tableName;
    state.recordQuery = '';
    state.sort = '';
    go();
  }
  return { render, click, change, input, restore, openRecords };
}
