// Dashboard SPA on Tabler + ApexCharts. No framework: hash routes and fetch.
import I from './icons.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = new Intl.NumberFormat('en-US');
const fmt = (n) => (n === null || n === undefined ? '–' : nf.format(n));
const pct = (n) => (n === null || n === undefined ? '–' : `${n}%`);
const shortUrl = (u) => String(u || '').replace(/^https?:\/\/(www\.)?[^/]+/, '') || '/';

/** Coloured delta. invert=true when lower is better (position). */
function delta(n, { invert = false, suffix = '', icon = false } = {}) {
  if (n === null || n === undefined) return '<span class="text-secondary">–</span>';
  if (n === 0) return `<span class="text-secondary">0${suffix}</span>`;
  const good = invert ? n < 0 : n > 0;
  const ic = icon ? (n > 0 ? I['trending-up'] : I['trending-down']) : '';
  return `<span class="${good ? 't-good' : 't-bad'} d-inline-flex align-items-center gap-1 lh-1">${n > 0 ? '+' : ''}${nf.format(n)}${suffix}${ic}</span>`;
}

// ---------- API ----------

async function api(path, params = {}, opts = {}, attempt = 0) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const res = await fetch('/api' + path + (qs.toString() ? '?' + qs : ''), {
    method: opts.method || 'GET',
    credentials: 'same-origin',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 503 && attempt < 4 && (!opts.method || opts.method === 'GET')) {
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    return api(path, params, opts, attempt + 1);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- routing ----------

const state = { properties: [], me: null };
const FILTER_KEYS = ['days', 'compare', 'search_type', 'device', 'country', 'brand'];

function parseHash() {
  const raw = location.hash.slice(1) || '/';
  const [path, query = ''] = raw.split('?');
  return { parts: path.split('/').filter(Boolean), q: new URLSearchParams(query) };
}

function filtersFrom(q) {
  const f = {};
  for (const k of FILTER_KEYS) if (q.get(k)) f[k] = q.get(k);
  return f;
}

function href(path, extra = {}, keepFilters = true) {
  const all = new URLSearchParams({ ...(keepFilters ? filtersFrom(parseHash().q) : {}), ...extra });
  for (const [k, v] of [...all]) if (!v) all.delete(k);
  const s = all.toString();
  return '#' + path + (s ? '?' + s : '');
}

function setQuery(updates) {
  const { parts, q } = parseHash();
  for (const [k, v] of Object.entries(updates)) v === '' || v === undefined || v === null ? q.delete(k) : q.set(k, v);
  const s = q.toString();
  location.hash = '/' + parts.join('/') + (s ? '?' + s : '');
}

const propLabel = (id) => state.properties.find((p) => String(p.id) === String(id))?.label || id;

function renderSidebar(pid, section) {
  $('#prop').innerHTML =
    '<option value="">All properties</option>' +
    state.properties.map((p) => `<option value="${p.id}" ${String(p.id) === String(pid) ? 'selected' : ''}>${esc(p.label)}</option>`).join('');
  const item = (url, icon, label, active) =>
    `<li class="nav-item"><a class="nav-link ${active ? 'active' : ''}" href="${url}" ${active ? 'aria-current="page"' : ''}><span class="nav-link-icon d-md-none d-lg-inline-block">${I[icon]}</span><span class="nav-link-title">${label}</span></a></li>`;
  let nav = item('#/', 'home', 'All properties', !pid && section === 'home');
  if (pid) {
    nav += [
      ['', 'chart-line', 'Overview'],
      ['pages', 'file-text', 'Pages'],
      ['queries', 'search', 'Queries'],
      ['insights', 'bulb', 'Insights'],
      ['groups', 'target-arrow', 'Keywords'],
      ['indexing', 'world-search', 'Indexing'],
    ]
      .map(([s, icon, label]) => item(href(`/p/${pid}${s ? '/' + s : ''}`), icon, label, section === s))
      .join('');
  }
  $('#nav').innerHTML = nav;
  const dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
  $('#nav-end').innerHTML =
    item('#/settings', 'settings', 'Settings', section === 'settings') +
    (state.me?.password_session
      ? `<li class="nav-item"><button class="nav-link border-0 bg-transparent w-100 text-start" type="button" id="signout"><span class="nav-link-icon">${I['arrow-left']}</span><span class="nav-link-title">Sign out</span></button></li>`
      : '') +
    `<li class="nav-item d-none d-lg-block"><button class="nav-link border-0 bg-transparent w-100 text-start" type="button" data-theme-toggle><span class="nav-link-icon">${dark ? I.sun : I.moon}</span><span class="nav-link-title">${dark ? 'Light mode' : 'Dark mode'}</span></button></li>`;
  document.querySelectorAll('[data-theme-toggle]').forEach((b) => {
    if (!b.innerHTML.trim()) b.innerHTML = dark ? I.sun : I.moon;
  });
}

function filterBar() {
  const f = filtersFrom(parseHash().q);
  const opt = (vals, cur) => vals.map(([v, l]) => `<option value="${v}" ${String(cur ?? '') === v ? 'selected' : ''}>${l}</option>`).join('');
  const sel = (name, label, vals) =>
    `<div class="col-6 col-sm-auto"><label class="form-label mb-1" for="f-${name}">${label}</label><select class="form-select" id="f-${name}" name="${name}">${opt(vals, f[name])}</select></div>`;
  return `<form class="row g-2 mt-2 filters" id="ff">
    ${sel('days', 'Range', [['7', '7 days'], ['', '28 days'], ['90', '3 months'], ['180', '6 months'], ['365', '12 months'], ['486', '16 months']])}
    ${sel('compare', 'Compare', [['', 'Previous period'], ['yoy', 'Year over year'], ['none', 'No comparison']])}
    ${sel('search_type', 'Search type', [['', 'Web'], ['image', 'Image'], ['video', 'Video'], ['news', 'News'], ['discover', 'Discover'], ['googleNews', 'Google News']])}
    ${sel('device', 'Device', [['', 'All devices'], ['DESKTOP', 'Desktop'], ['MOBILE', 'Mobile'], ['TABLET', 'Tablet']])}
    <div class="col-6 col-sm-auto"><label class="form-label mb-1" for="f-country">Country</label><input class="form-control" id="f-country" name="country" size="6" placeholder="usa" value="${esc(f.country || '')}" pattern="[a-zA-Z]{3}" title="3-letter code, e.g. usa, ind"></div>
    ${sel('brand', 'Queries', [['', 'All queries'], ['branded', 'Branded'], ['nonbranded', 'Non-branded']])}
  </form>`;
}

function bindFilters() {
  const form = $('#ff');
  if (!form) return;
  form.addEventListener('change', () => setQuery({ ...Object.fromEntries(new FormData(form)), offset: '' }));
  form.addEventListener('submit', (e) => e.preventDefault());
}

/** Tabler page: header (title, subtitle, actions, filters) + body. */
function page({ title, subtitle = '', actions = '', filters = false, back = '' }, body) {
  return `<div class="page-header d-print-none"><div class="container-xl">
      ${back ? `<a href="${back}" class="d-inline-flex align-items-center gap-1 mb-2">${I['arrow-left']} Back</a>` : ''}
      <div class="row g-2 align-items-center">
        <div class="col"><h1 class="page-title">${title}</h1>${subtitle ? `<div class="text-secondary mt-1">${subtitle}</div>` : ''}</div>
        ${actions ? `<div class="col-auto ms-auto"><div class="btn-list">${actions}</div></div>` : ''}
      </div>
      ${filters ? filterBar() : ''}
    </div></div>
    <div class="page-body"><div class="container-xl">${body}</div></div>`;
}

function card(title, body, { actions = '', flush = false, subtitle = '' } = {}) {
  return `<div class="card">
    ${title ? `<div class="card-header"><div><h2 class="card-title">${title}</h2>${subtitle ? `<div class="text-secondary small mt-1">${subtitle}</div>` : ''}</div>${actions ? `<div class="card-actions btn-list">${actions}</div>` : ''}</div>` : ''}
    ${flush ? body : `<div class="card-body">${body}</div>`}
  </div>`;
}

const empty = (title = 'Nothing to show yet', sub = 'Try a longer range or remove a filter.') =>
  `<div class="empty py-4"><p class="empty-title">${title}</p><p class="empty-subtitle">${sub}</p></div>`;

const alertBox = (kind, text) =>
  `<div class="alert alert-${kind}" role="alert"><div class="d-flex gap-2"><div>${kind === 'danger' || kind === 'warning' ? I['alert-triangle'] : I['info-circle']}</div><div>${text}</div></div></div>`;

async function route() {
  const { parts, q } = parseHash();
  destroyCharts();
  view.innerHTML = `<div class="page-body"><div class="container-xl"><div class="text-secondary py-5 text-center">Loading…</div></div></div>`;
  try {
    if (parts[0] === 'settings') {
      renderSidebar('', 'settings');
      return await settingsView();
    }
    if (parts[0] === 'p' && parts[1]) {
      const pid = parts[1];
      const section = parts[2] || '';
      renderSidebar(pid, section === 'page' ? 'pages' : section === 'query' ? 'queries' : section);
      const f = { property: pid, ...filtersFrom(q) };
      switch (section) {
        case '':
          await overviewView(pid, f);
          break;
        case 'pages':
          await tableView(pid, 'page', f, q);
          break;
        case 'queries':
          await tableView(pid, 'query', f, q);
          break;
        case 'page':
          await pageView(pid, q.get('url'), f);
          break;
        case 'query':
          await queryView(pid, q.get('q'), f);
          break;
        case 'insights':
          await insightsView(pid, parts[3] || 'striking_distance', f);
          break;
        case 'groups':
          await (parts[3] ? groupView(pid, decodeURIComponent(parts[3]), f) : groupsView(pid));
          break;
        case 'indexing':
          await indexingView(pid);
          break;
      }
      bindFilters();
      return;
    }
    renderSidebar('', 'home');
    await portfolioView();
  } catch (e) {
    view.innerHTML = page({ title: 'Something went wrong' }, alertBox('danger', esc(e.message)));
  }
  $('#sidebar-menu')?.classList.remove('show');
}

// ---------- charts ----------

const charts = [];
function destroyCharts() {
  while (charts.length) charts.pop().destroy();
}
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const isDark = () => document.documentElement.getAttribute('data-bs-theme') === 'dark';

function trendChart(el, rows) {
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = empty('No daily data yet', 'The first sync can take a few minutes after a property is added.');
    return;
  }
  const accent = cssVar('--gt-accent');
  const s2 = cssVar('--gt-series-2');
  const muted = cssVar('--gt-muted');
  const line = cssVar('--gt-line');
  const chart = new ApexCharts(el, {
    chart: { type: 'line', height: 300, fontFamily: 'inherit', toolbar: { show: false }, zoom: { enabled: false }, animations: { enabled: false }, background: 'transparent' },
    theme: { mode: isDark() ? 'dark' : 'light' },
    series: [
      { name: 'Clicks', type: 'area', data: rows.map((r) => [Date.parse(r.date), r.clicks]) },
      { name: 'Impressions', type: 'line', data: rows.map((r) => [Date.parse(r.date), r.impressions]) },
    ],
    colors: [accent, s2],
    stroke: { width: [2, 1.5], curve: 'straight' },
    fill: { type: ['gradient', 'solid'], gradient: { shadeIntensity: 0, opacityFrom: 0.22, opacityTo: 0.02 } },
    dataLabels: { enabled: false },
    grid: { borderColor: line, strokeDashArray: 3, padding: { left: 8, right: 8 } },
    xaxis: { type: 'datetime', labels: { style: { colors: muted, fontSize: '13px' }, datetimeUTC: true }, axisBorder: { color: line }, axisTicks: { color: line } },
    yaxis: [
      { title: { text: 'Clicks', style: { color: muted, fontWeight: 400 } }, labels: { style: { colors: muted, fontSize: '13px' }, formatter: (v) => nf.format(Math.round(v)) } },
      { opposite: true, title: { text: 'Impressions', style: { color: muted, fontWeight: 400 } }, labels: { style: { colors: muted, fontSize: '13px' }, formatter: (v) => nf.format(Math.round(v)) } },
    ],
    legend: { position: 'top', horizontalAlign: 'left', labels: { colors: cssVar('--gt-ink') }, fontSize: '14px' },
    tooltip: { shared: true, x: { format: 'ddd d MMM yyyy' }, theme: isDark() ? 'dark' : 'light' },
  });
  chart.render();
  charts.push(chart);
  const prov = rows.filter((r) => r.provisional).length;
  if (prov) el.insertAdjacentHTML('afterend', `<div class="text-secondary small px-3 pb-3">The last ${prov} day${prov > 1 ? 's are' : ' is'} provisional and may still change.</div>`);
}

function sparkChart(el, series) {
  if (!el || series.length < 2) return;
  const c = new ApexCharts(el, {
    chart: { type: 'area', height: 48, sparkline: { enabled: true }, animations: { enabled: false } },
    series: [{ name: 'Clicks', data: series.map((x) => x.clicks) }],
    colors: [cssVar('--gt-accent')],
    stroke: { width: 1.5, curve: 'straight' },
    fill: { type: 'gradient', gradient: { shadeIntensity: 0, opacityFrom: 0.25, opacityTo: 0 } },
    tooltip: { enabled: false },
  });
  c.render();
  charts.push(c);
}

// ---------- tables ----------

/** cols: [{key, label, num, fmt(v,row), link(row), sort}] */
function table(cols, rows, sortState, emptyText) {
  if (!rows.length) return emptyText ? empty(...emptyText) : empty();
  const head = cols
    .map((c) => {
      const active = sortState && sortState.sort === c.sort;
      const inner =
        c.sort && sortState
          ? `<button type="button" class="table-sort ${active ? (sortState.order === 'asc' ? 'asc' : 'desc') : ''}" data-sort="${c.sort}">${c.label}</button>`
          : c.label;
      return `<th class="${c.num ? 'text-end' : ''}" ${active ? `aria-sort="${sortState.order === 'asc' ? 'ascending' : 'descending'}"` : ''} scope="col">${inner}</th>`;
    })
    .join('');
  const body = rows
    .map(
      (r) =>
        '<tr>' +
        cols
          .map((c) => {
            const content = c.fmt ? c.fmt(r[c.key], r) : esc(r[c.key] ?? '–');
            return `<td class="${c.num ? 'num' : 'cell-label'}">${c.link ? `<a href="${c.link(r)}">${content}</a>` : content}</td>`;
          })
          .join('') +
        '</tr>',
    )
    .join('');
  return `<div class="table-responsive"><table class="table table-vcenter card-table table-hover"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const metricCols = (hasPrev, keep) =>
  [
    { key: 'clicks', label: 'Clicks', num: true, fmt, sort: 'clicks' },
    ...(hasPrev ? [{ key: 'delta_clicks', label: 'Change', num: true, fmt: (v) => delta(v), sort: 'delta_clicks' }] : []),
    { key: 'impressions', label: 'Impressions', num: true, fmt, sort: 'impressions' },
    { key: 'ctr', label: 'CTR', num: true, fmt: pct, sort: 'ctr' },
    { key: 'position', label: 'Position', num: true, sort: 'position' },
    ...(hasPrev ? [{ key: 'delta_position', label: 'Pos. change', num: true, fmt: (v) => delta(v, { invert: true }), sort: 'delta_position' }] : []),
  ].filter((c) => !keep || keep.includes(c.key));

const pageCol = (pid) => ({ key: 'page', label: 'Page', fmt: (v) => `<span class="url">${esc(shortUrl(v))}</span>`, link: (r) => href(`/p/${pid}/page`, { url: r.page }) });
const queryCol = (pid) => ({ key: 'query', label: 'Query', link: (r) => href(`/p/${pid}/query`, { q: r.query }) });

function csvButton(path, params) {
  const qs = new URLSearchParams({ ...params, format: 'csv', limit: 5000 });
  return `<a class="btn" href="/api${path}?${qs}" download>${I.download} Export CSV</a>`;
}

function rangeText(r) {
  if (!r) return '';
  return `${esc(r.from)} to ${esc(r.to)}${r.compare_from ? ` vs ${esc(r.compare_from)} to ${esc(r.compare_to)}` : ''}`;
}

function kpis(s) {
  const c = s.current;
  const d = s.delta;
  const k = (label, value, dl) =>
    `<div class="col-sm-6 col-lg-3"><div class="card card-sm"><div class="card-body">
      <div class="subheader">${label}</div>
      <div class="kpi-value mt-1">${value}</div>
      ${d ? `<div class="mt-1 small">${dl} <span class="text-secondary">vs before</span></div>` : ''}
    </div></div></div>`;
  return `<div class="row row-cards mb-3">
    ${k('Clicks', fmt(c.clicks), d ? delta(d.clicks_pct, { suffix: '%', icon: true }) : '')}
    ${k('Impressions', fmt(c.impressions), d ? delta(d.impressions_pct, { suffix: '%', icon: true }) : '')}
    ${k('Average CTR', pct(c.ctr), d ? delta(d.ctr, { suffix: ' pp' }) : '')}
    ${k('Average position', c.position ?? '–', d ? delta(d.position, { invert: true }) : '')}
  </div>`;
}

const sourceNote = (s) => `${rangeText(s.range)} · ${s.source === 'live' ? 'live from Google' : 'stored data'}${s.note ? ' · ' + esc(s.note) : ''}`;

// ---------- views ----------

async function portfolioView() {
  const data = await api('/portfolio', { days: 28 });
  if (!data.properties.length) {
    view.innerHTML = page(
      { title: 'All properties' },
      card('', empty('No properties yet', 'Add a Search Console property in Settings to start the 16-month backfill.') + '<div class="text-center pb-4"><a class="btn btn-primary" href="#/settings">Open Settings</a></div>', { flush: true }),
    );
    return;
  }
  view.innerHTML = page(
    { title: 'All properties', subtitle: 'Last 28 days of final data vs the 28 days before.' },
    `<div class="row row-cards">${data.properties
      .map((p) => {
        const c = p.current;
        const d = p.delta || {};
        const m = (label, v, dl) => `<div class="col-6 col-md-3"><div class="subheader">${label}</div><div class="h2 mb-0 mt-1">${v}</div><div class="small">${dl}</div></div>`;
        return `<div class="col-12"><div class="card">
          <div class="card-header"><div><h2 class="card-title"><a href="#/p/${p.id}">${esc(p.label)}</a></h2><div class="text-secondary small mt-1">${esc(p.site_url)}</div></div>
            <div class="card-actions"><a class="btn" href="#/p/${p.id}">${I['chart-line']} Open</a></div></div>
          <div class="card-body"><div class="row g-3 align-items-end">
            <div class="col-lg-8"><div class="row g-3">
              ${m('Clicks', fmt(c.clicks), delta(d.clicks_pct, { suffix: '%', icon: true }))}
              ${m('Impressions', fmt(c.impressions), delta(d.impressions_pct, { suffix: '%', icon: true }))}
              ${m('CTR', pct(c.ctr), delta(d.ctr, { suffix: ' pp' }))}
              ${m('Position', c.position ?? '–', delta(d.position, { invert: true }))}
            </div></div>
            <div class="col-lg-4"><div id="spark-${p.id}" aria-label="Daily clicks, last 28 days" role="img"></div></div>
          </div></div></div></div>`;
      })
      .join('')}</div>`,
  );
  for (const p of data.properties) sparkChart($(`#spark-${p.id}`), p.series);
}

async function overviewView(pid, f) {
  const [s, t, pages, queries, devices, countries] = await Promise.all([
    api(`/p/${pid}/summary`, f),
    api(`/p/${pid}/timeseries`, { ...f, compare: undefined }),
    api(`/p/${pid}/pages`, { ...f, limit: 10 }),
    api(`/p/${pid}/queries`, { ...f, limit: 10 }),
    api(`/p/${pid}/breakdown/device`, f).catch(() => ({ rows: [] })),
    api(`/p/${pid}/breakdown/country`, f).catch(() => ({ rows: [] })),
  ]);
  const hp = Boolean(s.range.compare_from);
  const short = ['clicks', 'delta_clicks', 'position'];
  view.innerHTML = page(
    { title: esc(propLabel(pid)), subtitle: sourceNote(s), filters: true, actions: `<a class="btn" href="${href(`/p/${pid}/insights`)}">${I.bulb} Insights</a>` },
    `${kpis(s)}
    <div class="row row-cards">
      <div class="col-12">${card('Performance', '<div id="chart" class="chart-box"></div>')}</div>
      <div class="col-lg-6">${card('Top pages', table([pageCol(pid), ...metricCols(hp, short)], pages.rows), { flush: true, actions: `<a href="${href(`/p/${pid}/pages`)}">All pages</a>` })}</div>
      <div class="col-lg-6">${card('Top queries', table([queryCol(pid), ...metricCols(hp, short)], queries.rows), { flush: true, actions: `<a href="${href(`/p/${pid}/queries`)}">All queries</a>` })}</div>
      <div class="col-lg-6">${card('Devices', table([{ key: 'device', label: 'Device', fmt: (v) => esc(String(v).charAt(0) + String(v).slice(1).toLowerCase()) }, ...metricCols(hp, ['clicks', 'delta_clicks', 'impressions', 'ctr', 'position'])], devices.rows), { flush: true })}</div>
      <div class="col-lg-6">${card('Countries', table([{ key: 'country', label: 'Country', fmt: (v) => esc(String(v).toUpperCase()) }, ...metricCols(hp, ['clicks', 'delta_clicks', 'impressions', 'position'])], countries.rows.slice(0, 10)), { flush: true })}</div>
    </div>`,
  );
  trendChart($('#chart'), t.rows);
}

async function tableView(pid, kind, f, q) {
  const sort = q.get('sort') || 'clicks';
  const order = q.get('order') || (sort === 'position' ? 'asc' : 'desc');
  const offset = Number(q.get('offset') || 0);
  const contains = q.get('contains') || '';
  const limit = 100;
  const path = `/p/${pid}/${kind === 'page' ? 'pages' : 'queries'}`;
  const data = await api(path, { ...f, sort, order, offset, limit, contains });
  const hp = Boolean(data.range.compare_from);
  const search = `<form class="d-flex gap-2" id="tf" role="search">
      <div class="input-icon"><span class="input-icon-addon">${I.search}</span>
      <input class="form-control" id="contains" name="contains" aria-label="Filter rows" placeholder="${kind === 'page' ? 'URL contains…' : 'Query contains…'}" value="${esc(contains)}"></div>
      <button class="btn" type="submit">Filter</button></form>`;
  const pager = `<div class="card-footer d-flex align-items-center">
      <p class="m-0 text-secondary">Showing ${fmt(offset + (data.rows.length ? 1 : 0))} to ${fmt(offset + data.rows.length)}</p>
      <ul class="pagination m-0 ms-auto">
        <li class="page-item ${offset > 0 ? '' : 'disabled'}"><button class="page-link" data-page="${Math.max(0, offset - limit)}" ${offset > 0 ? '' : 'disabled'}>Previous</button></li>
        <li class="page-item ${data.has_more ? '' : 'disabled'}"><button class="page-link" data-page="${offset + limit}" ${data.has_more ? '' : 'disabled'}>Next</button></li>
      </ul></div>`;
  view.innerHTML = page(
    { title: kind === 'page' ? 'Pages' : 'Queries', subtitle: `${rangeText(data.range)} · ${data.source === 'live' ? 'live from Google' : 'stored data'}`, filters: true, actions: csvButton(path, { ...f, sort, order, contains }) },
    `<div class="card"><div class="card-header">${search}</div>${table([kind === 'page' ? pageCol(pid) : queryCol(pid), ...metricCols(hp)], data.rows, { sort, order })}${pager}</div>`,
  );
  $('#tf').addEventListener('submit', (e) => {
    e.preventDefault();
    setQuery({ contains: $('#contains').value.trim(), offset: '' });
  });
  view.querySelectorAll('[data-sort]').forEach((b) =>
    b.addEventListener('click', () => {
      const s = b.dataset.sort;
      setQuery({ sort: s, order: s === sort ? (order === 'asc' ? 'desc' : 'asc') : s === 'position' ? 'asc' : 'desc', offset: '' });
    }),
  );
  view.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => setQuery({ offset: b.dataset.page })));
}

function coverageBadge(ins) {
  if (!ins) return '<span class="badge badge-soft">Not inspected</span>';
  const cls = ins.verdict === 'PASS' ? 'badge-soft-good' : ins.verdict === 'FAIL' ? 'badge-soft-bad' : 'badge-soft';
  return `<span class="badge ${cls}">${esc(ins.coverage_state || ins.verdict || 'Unknown')}</span>`;
}

function inspectionGrid(ins) {
  if (!ins) return empty('Not inspected yet', 'Run an inspection to see index status, last crawl and canonicals.');
  const items = [
    ['Coverage', coverageBadge(ins)],
    ['Verdict', esc(ins.verdict)],
    ['Indexing allowed', esc(ins.indexing_state)],
    ['Page fetch', esc(ins.page_fetch_state)],
    ['robots.txt', esc(ins.robots_state)],
    ['Last crawl', esc(ins.last_crawl_time ? ins.last_crawl_time.slice(0, 10) : '–')],
    ['Crawled as', esc(ins.crawled_as)],
    ['Checked', esc(ins.checked_at ? ins.checked_at.slice(0, 10) : '–')],
    ['Google canonical', `<span class="url">${esc(ins.google_canonical)}</span>`],
    ['Declared canonical', `<span class="url">${esc(ins.user_canonical)}</span>`],
  ];
  return `<div class="datagrid">${items
    .filter(([, v]) => v && v !== 'null' && v !== '<span class="url"></span>')
    .map(([k, v]) => `<div class="datagrid-item"><div class="datagrid-title">${k}</div><div class="datagrid-content">${v}</div></div>`)
    .join('')}</div>${ins.inspection_link ? `<a class="btn mt-3" href="${esc(ins.inspection_link)}" target="_blank" rel="noopener">${I['external-link']} Open in Search Console</a>` : ''}`;
}

async function pageView(pid, url, f) {
  const d = await api(`/p/${pid}/page`, { ...f, url });
  const hp = Boolean(d.summary.range.compare_from);
  const b = d.position_buckets;
  const bucket = (label, n) => `<div class="col-6 col-md-3"><div class="subheader">${label}</div><div class="h2 mb-0">${fmt(n)}</div></div>`;
  view.innerHTML = page(
    {
      title: `<span class="url">${esc(shortUrl(url))}</span>`,
      subtitle: `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a> · first seen ${esc(d.first_seen || '–')}`,
      filters: true,
      back: href(`/p/${pid}/pages`),
      actions: `<button class="btn" id="inspect">${I.refresh} Inspect now</button>`,
    },
    `${kpis(d.summary)}
    <div class="row row-cards">
      <div class="col-12">${card('Performance', '<div id="chart" class="chart-box"></div>')}</div>
      <div class="col-lg-8">${card('Queries for this page', `<div class="card-body border-bottom"><div class="row g-3">${bucket('Top 3', b.top3)}${bucket('Positions 4–10', b.top10)}${bucket('11–20', b.top20)}${bucket('21+', b.beyond)}</div></div>${table([queryCol(pid), ...metricCols(hp).filter((c) => c.key !== 'delta_position')], d.queries)}`, { flush: true, actions: csvButton(`/p/${pid}/queries`, { ...f, page: url }) })}</div>
      <div class="col-lg-4">${card('Index status', `<div id="ins">${inspectionGrid(d.inspection)}</div>`)}</div>
    </div>`,
  );
  trendChart($('#chart'), d.timeseries);
  $('#inspect').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.classList.add('btn-loading');
    try {
      $('#ins').innerHTML = inspectionGrid((await api(`/p/${pid}/inspection`, { url, refresh: 'true' })).inspection);
    } catch (err) {
      $('#ins').insertAdjacentHTML('afterbegin', alertBox('danger', esc(err.message)));
    } finally {
      btn.disabled = false;
      btn.classList.remove('btn-loading');
    }
  });
}

const shareCol = { key: 'impression_share', label: 'Impression share', fmt: (v) => `<div class="d-flex align-items-center gap-2"><span class="num" style="min-width:3.5em">${pct(v)}</span><div class="progress progress-sm flex-fill" style="min-width:60px"><div class="progress-bar" style="width:${Number(v) || 0}%" role="progressbar" aria-label="${pct(v)}"></div></div></div>` };

async function queryView(pid, query, f) {
  const d = await api(`/p/${pid}/query`, { ...f, query });
  view.innerHTML = page(
    { title: esc(query), subtitle: sourceNote(d.summary), filters: true, back: href(`/p/${pid}/queries`) },
    `${kpis(d.summary)}
    <div class="row row-cards">
      <div class="col-12">${card('Performance', '<div id="chart" class="chart-box"></div>')}</div>
      <div class="col-12">${d.cannibalization ? alertBox('warning', 'Two or more pages split this query’s impressions. Consider merging them or making each one target a different intent.') : ''}
        ${card('Ranking pages', table([pageCol(pid), shareCol, ...metricCols(false)], d.pages), { flush: true })}</div>
    </div>`,
  );
  trendChart($('#chart'), d.timeseries);
}

const INSIGHT_TABS = [
  ['striking_distance', 'Striking distance'],
  ['ctr_gaps', 'CTR gaps'],
  ['page_decliners', 'Page drops'],
  ['page_gainers', 'Page gains'],
  ['query_decliners', 'Query drops'],
  ['query_gainers', 'Query gains'],
  ['new_queries', 'New queries'],
  ['lost_queries', 'Lost queries'],
  ['cannibalization', 'Cannibalization'],
  ['content_decay', 'Content decay'],
  ['zero_clicks', 'Zero clicks'],
];

async function insightsView(pid, kind, f) {
  const d = await api(`/p/${pid}/insights/${kind}`, { ...f, limit: 100 });
  const qc = queryCol(pid);
  const pc = pageCol(pid);
  let body;
  if (kind === 'striking_distance' || kind === 'ctr_gaps') {
    body = table(
      [
        qc,
        { key: 'impressions', label: 'Impressions', num: true, fmt },
        { key: 'clicks', label: 'Clicks', num: true, fmt },
        { key: 'position', label: 'Position', num: true },
        { key: 'ctr', label: 'CTR', num: true, fmt: pct },
        { key: 'expected_ctr', label: 'Usual CTR', num: true, fmt: pct },
        { key: 'est_extra_clicks', label: 'Extra clicks', num: true, fmt: (v) => `<strong>${fmt(v)}</strong>` },
        { key: 'top_page', label: 'Top page', fmt: (v) => (v ? `<span class="url">${esc(shortUrl(v))}</span>` : '–'), link: (r) => href(`/p/${pid}/page`, { url: r.top_page }) },
      ],
      d.rows,
    );
  } else if (kind === 'cannibalization') {
    body = d.rows.length
      ? d.rows
          .map(
            (g) => `<div class="card-body border-bottom pb-2"><h3 class="mb-0"><a href="${href(`/p/${pid}/query`, { q: g.query })}">${esc(g.query)}</a> <span class="text-secondary fw-normal small">${fmt(g.impressions)} impressions</span></h3></div>
            ${table([pc, shareCol, { key: 'clicks', label: 'Clicks', num: true, fmt }, { key: 'position', label: 'Position', num: true }], g.pages)}`,
          )
          .join('')
      : empty('No cannibalization found', 'No query has two pages each taking 10% or more of its impressions.');
  } else if (kind === 'content_decay') {
    body = table(
      [
        pc,
        { key: 'clicks_84_112d_ago', label: '84–112 days ago', num: true, fmt },
        { key: 'clicks_56_84d_ago', label: '56–84', num: true, fmt },
        { key: 'clicks_28_56d_ago', label: '28–56', num: true, fmt },
        { key: 'clicks_last_28d', label: 'Last 28', num: true, fmt },
        { key: 'change_pct', label: 'Change', num: true, fmt: (v) => delta(v, { suffix: '%' }) },
      ],
      d.rows,
    );
  } else {
    const isPage = kind.startsWith('page') || kind === 'zero_clicks';
    body = table(
      [
        isPage ? pc : qc,
        { key: 'clicks', label: 'Clicks', num: true, fmt },
        { key: 'prev_clicks', label: 'Before', num: true, fmt },
        { key: 'delta_clicks', label: 'Change', num: true, fmt: (v) => delta(v) },
        { key: 'impressions', label: 'Impressions', num: true, fmt },
        { key: 'prev_impressions', label: 'Before', num: true, fmt },
        { key: 'position', label: 'Position', num: true },
        { key: 'delta_position', label: 'Pos. change', num: true, fmt: (v) => delta(v, { invert: true }) },
      ],
      d.rows,
    );
  }
  const tabs = `<ul class="nav nav-tabs card-header-tabs flex-wrap" role="tablist">${INSIGHT_TABS.map(
    ([k, l]) => `<li class="nav-item"><a href="${href(`/p/${pid}/insights/${k}`)}" class="nav-link ${k === kind ? 'active' : ''}" ${k === kind ? 'aria-current="page"' : ''}>${l}</a></li>`,
  ).join('')}</ul>`;
  view.innerHTML = page(
    { title: 'Insights', subtitle: rangeText(d.range), filters: true, actions: csvButton(`/p/${pid}/insights/${kind}`, { ...f, limit: 1000 }) },
    `<div class="card"><div class="card-header">${tabs}</div><div class="card-body border-bottom"><p class="m-0">${esc(d.description)}</p></div>${body}</div>`,
  );
}

async function groupsView(pid) {
  const d = await api(`/p/${pid}/groups`);
  view.innerHTML = page(
    { title: 'Keyword groups', subtitle: 'Rank tracking from your own Search Console data. No keyword cap.' },
    `<div class="row row-cards">
      <div class="col-lg-7">${card('Groups', table([{ key: 'name', label: 'Group', link: (r) => href(`/p/${pid}/groups/${encodeURIComponent(r.name)}`) }, { key: 'terms', label: 'Terms', num: true, fmt }], d.groups, null, ['No groups yet', 'Create one with the form.']), { flush: true })}</div>
      <div class="col-lg-5">${card(
        'New group or add terms',
        `<form id="gf">
          <div class="mb-3"><label class="form-label" for="g-name">Group name</label><input class="form-control" id="g-name" name="name" required></div>
          <div class="mb-3"><label class="form-label" for="g-match">Match</label><select class="form-select" id="g-match" name="match"><option value="exact">Exact query</option><option value="contains">Query contains the term</option></select></div>
          <div class="mb-3"><label class="form-label" for="g-terms">Terms, one per line</label><textarea class="form-control" id="g-terms" name="terms" rows="6" required></textarea></div>
          <button class="btn btn-primary" type="submit">Save group</button> <span id="gmsg" class="ms-2"></span>
        </form>`,
      )}</div>
    </div>`,
  );
  $('#gf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const r = await api(`/p/${pid}/groups`, {}, { method: 'POST', body: { name: fd.name, match: fd.match, terms: fd.terms.split('\n') } });
      $('#gmsg').textContent = `Saved ${r.added} terms to ${r.group}.`;
      setTimeout(route, 600);
    } catch (err) {
      $('#gmsg').innerHTML = `<span class="t-bad">${esc(err.message)}</span>`;
    }
  });
}

async function groupView(pid, group, f) {
  const d = await api(`/p/${pid}/groups/${encodeURIComponent(group)}`, f);
  const t = d.totals;
  const stat = (label, v) => `<div class="col-6 col-md-2"><div class="card card-sm"><div class="card-body"><div class="subheader">${label}</div><div class="h2 mb-0 mt-1">${v}</div></div></div></div>`;
  view.innerHTML = page(
    {
      title: esc(d.group),
      subtitle: rangeText(d.range),
      filters: true,
      back: href(`/p/${pid}/groups`),
      actions: `${csvButton(`/p/${pid}/groups/${encodeURIComponent(group)}`, f)}<button class="btn" id="del">${I.trash} Delete group</button>`,
    },
    `<div class="row row-cards mb-3">${stat('Terms', fmt(t.terms))}${stat('Ranking', fmt(t.ranking))}${stat('Top 3', fmt(t.top3))}${stat('Top 10', fmt(t.top10))}${stat('Improved', `<span class="t-good">${fmt(t.improved)}</span>`)}${stat('Declined', `<span class="t-bad">${fmt(t.declined)}</span>`)}</div>
    ${card(
      '',
      table(
        [
          { key: 'term', label: 'Term', link: (r) => href(`/p/${pid}/query`, { q: r.term }) },
          { key: 'position', label: 'Position', num: true },
          { key: 'delta_position', label: 'Change', num: true, fmt: (v) => delta(v, { invert: true }) },
          { key: 'clicks', label: 'Clicks', num: true, fmt },
          { key: 'impressions', label: 'Impressions', num: true, fmt },
          { key: 'ctr', label: 'CTR', num: true, fmt: pct },
          { key: 'top_page', label: 'Top page', fmt: (v) => (v ? `<span class="url">${esc(shortUrl(v))}</span>` : '–') },
        ],
        d.rows,
      ),
      { flush: true },
    )}`,
  );
  $('#del').addEventListener('click', async () => {
    if (!confirm(`Delete the group "${d.group}"? Search data stays.`)) return;
    await api(`/p/${pid}/groups/${encodeURIComponent(group)}`, {}, { method: 'DELETE' });
    location.hash = href(`/p/${pid}/groups`);
  });
}

async function indexingView(pid) {
  const d = await api(`/p/${pid}/indexing`);
  const t = d.totals || {};
  const stat = (label, v) => `<div class="col-6 col-lg-3"><div class="card card-sm"><div class="card-body"><div class="subheader">${label}</div><div class="kpi-value mt-1">${v}</div></div></div></div>`;
  const pageLink = (r) => href(`/p/${pid}/page`, { url: r.url });
  const urlFmt = (v) => `<span class="url">${esc(shortUrl(v))}</span>`;
  const day = (v) => esc(v ? String(v).slice(0, 10) : '–');
  view.innerHTML = page(
    { title: 'Indexing', subtitle: `Last check ${day(t.last_checked)}`, actions: `<button class="btn" id="smr">${I.refresh} Refresh sitemaps</button>` },
    `<div class="row row-cards mb-3">${stat('Pages inspected', fmt(t.inspected))}${stat('Indexed', fmt(t.passing))}${stat('Not indexed', fmt((t.inspected || 0) - (t.passing || 0)))}${stat('Inspections today', fmt(d.quota_used_today))}</div>
    <div class="row row-cards">
      <div class="col-lg-6">${card('By coverage state', table([{ key: 'coverage_state', label: 'State' }, { key: 'verdict', label: 'Verdict', fmt: (v) => coverageBadge({ verdict: v, coverage_state: v }) }, { key: 'pages', label: 'Pages', num: true, fmt }], d.by_state, null, ['No inspections yet', 'The daily job inspects your top pages first.']), { flush: true })}</div>
      <div class="col-lg-6">${card('Recent changes', table([{ key: 'url', label: 'Page', fmt: urlFmt, link: pageLink }, { key: 'prev_coverage_state', label: 'Was' }, { key: 'coverage_state', label: 'Now' }, { key: 'changed_at', label: 'When', fmt: day }], d.recent_changes, null, ['No changes yet', 'Coverage changes show up here after a re-inspection.']), { flush: true })}</div>
      <div class="col-12">${card('Pages to fix', table([{ key: 'url', label: 'Page', fmt: urlFmt, link: pageLink }, { key: 'coverage_state', label: 'Coverage', fmt: (v, r) => coverageBadge(r) }, { key: 'google_canonical', label: 'Google canonical', fmt: (v, r) => (v && v !== r.user_canonical ? urlFmt(v) : '–') }, { key: 'clicks_30d', label: 'Clicks (30 days)', num: true, fmt }, { key: 'last_crawl_time', label: 'Last crawl', fmt: day }], d.problems, null, ['Nothing to fix', 'Every inspected page is indexed with the canonical you declared.']), { flush: true, subtitle: 'Not indexed, or Google chose a different canonical. Sorted by clicks.' })}</div>
      <div class="col-12">${card(
        'Sitemaps',
        table([{ key: 'path', label: 'Sitemap', fmt: (v) => `<span class="url">${esc(v)}</span>` }, { key: 'last_downloaded', label: 'Last read', fmt: day }, { key: 'submitted', label: 'URLs', num: true, fmt }, { key: 'errors', label: 'Errors', num: true, fmt: (v) => (v ? `<span class="t-bad">${fmt(v)}</span>` : '0') }, { key: 'warnings', label: 'Warnings', num: true, fmt }], d.sitemaps, null, ['No sitemaps yet', 'Submit one below, or refresh to read them from Search Console.']) +
          `<div class="card-footer"><form class="row g-2 align-items-end" id="smf"><div class="col-sm"><label class="form-label" for="sm-url">Submit a sitemap</label><input class="form-control" id="sm-url" name="u" type="url" required placeholder="https://example.com/sitemap_index.xml"></div><div class="col-sm-auto"><button class="btn btn-primary" type="submit">${I.sitemap} Submit</button></div></form><div id="smmsg" class="mt-2"></div></div>`,
        { flush: true },
      )}</div>
    </div>`,
  );
  $('#smr').addEventListener('click', async () => {
    await api(`/p/${pid}/sitemaps`, { refresh: 'true' });
    route();
  });
  $('#smf').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/p/${pid}/sitemaps`, {}, { method: 'POST', body: { sitemap_url: new FormData(e.currentTarget).get('u') } });
      route();
    } catch (err) {
      $('#smmsg').innerHTML = alertBox('danger', esc(err.message));
    }
  });
}

async function settingsView() {
  const [props, keys, sync, sites, sas] = await Promise.all([
    api('/properties'),
    api('/keys').catch(() => ({ keys: [] })),
    api('/sync'),
    api('/gsc/sites').catch((e) => ({ error: e.message, sites: [], service_accounts: [] })),
    api('/service-accounts').catch(() => ({ accounts: [], encryption_configured: false })),
  ]);
  const siteCounts = new Map((sites.service_accounts || []).map((a) => [String(a.id), a]));
  const origin = location.origin;
  const untracked = sites.sites.filter((s) => !s.tracked);
  const copyBtn = (id) => `<button class="btn btn-sm" type="button" data-copy="${id}">${I.copy} Copy</button>`;
  const codeBlock = (id, text) => `<div class="d-flex justify-content-end mb-1">${copyBtn(id)}</div><pre class="code" id="${id}">${esc(text)}</pre>`;
  view.innerHTML = page(
    { title: 'Settings' },
    `<div class="row row-cards">
      <div class="col-12">${card(
        'Properties',
        table(
          [
            { key: 'label', label: 'Label' },
            { key: 'site_url', label: 'Search Console property' },
            { key: 'search_types', label: 'Search types', fmt: (v) => v.map((x) => `<span class="badge badge-soft me-1">${esc(x)}</span>`).join('') },
            { key: 'brand_terms', label: 'Brand terms', fmt: (v) => esc(v.join(', ') || '–') },
            { key: 'data', label: 'Stored data', fmt: (v) => esc(v.first_date ? `${v.first_date} to ${v.latest_date} (${v.days_stored} days)` : 'Syncing…') },
            { key: 'id', label: '<span class="visually-hidden">Actions</span>', num: true, fmt: (v) => `<button class="btn btn-sm" data-edit="${v}">Edit</button>` },
          ],
          props.properties,
          null,
          ['No properties yet', 'Add one below.'],
        ) +
          `<div class="card-body border-top" id="editbox" hidden></div>
          <div class="card-footer">
            ${sites.error ? alertBox('warning', esc(sites.error)) : ''}
            ${untracked.length ? '' : '<p class="text-secondary m-0">Every site your service accounts can read is already tracked. To add another, give one of the accounts below access to it in Search Console.</p>'}
            ${
              untracked.length
                ? `<form class="row g-2 align-items-end" id="addf">
                    <div class="col-md"><label class="form-label" for="a-site">Add a property</label><select class="form-select" id="a-site" name="site_url">${untracked.map((s) => `<option value="${esc(s.siteUrl)}">${esc(s.siteUrl)} (via ${esc(s.service_account)})</option>`).join('')}</select></div>
                    <div class="col-md-3"><label class="form-label" for="a-label">Label</label><input class="form-control" id="a-label" name="label"></div>
                    <div class="col-md-auto"><button class="btn btn-primary" type="submit">Add and backfill</button></div>
                  </form><div id="addmsg" class="mt-2"></div>`
                : ''
            }
          </div>`,
        { flush: true },
      )}</div>

      <div class="col-12">${card(
        'Service accounts',
        `<div class="card-body border-bottom"><p class="m-0 text-secondary">Each property is read by a Google service account. Upload a JSON key, then add the account's email as a user in Search Console (Settings → Users and permissions). Full access lets the dashboard submit sitemaps.</p></div>` +
          table(
            [
              { key: 'client_email', label: 'Account', fmt: (v, r) => `<div class="d-flex align-items-center gap-2"><code class="url">${esc(v)}</code><button class="btn btn-sm btn-icon" type="button" data-copy-text="${esc(v)}" aria-label="Copy email">${I.copy}</button></div>${r.project_id ? `<div class="text-secondary small mt-1">Project ${esc(r.project_id)}${r.key_id ? ` · key ${esc(r.key_id)}…` : ''}</div>` : ''}` },
              { key: 'source', label: 'Source', fmt: (v) => `<span class="badge badge-soft">${v === 'secret' ? 'Worker secret' : 'Uploaded'}</span>` },
              { key: 'id', label: 'Sites it can read', num: true, fmt: (v) => { const x = siteCounts.get(String(v)); return x ? (x.error ? `<span class="t-bad">Error</span>` : fmt(x.sites)) : '–'; } },
              { key: 'properties', label: 'Used by', fmt: (v) => (v.length ? v.map((p) => `<span class="badge badge-soft me-1">${esc(p.label)}</span>`).join('') : '<span class="text-secondary">None</span>') },
              { key: 'last_error', label: 'Status', fmt: (v, r) => { const x = siteCounts.get(String(r.id)); const err = x?.error || v; return err ? `<span class="badge badge-soft-bad" title="${esc(err)}">Failing</span>` : '<span class="badge badge-soft-good">Working</span>'; } },
              { key: 'removable', label: '<span class="visually-hidden">Actions</span>', num: true, fmt: (v, r) => (v ? `<button class="btn btn-sm" data-remove-sa="${r.id}" data-email="${esc(r.client_email)}">${I.trash} Remove</button>` : '<span class="text-secondary small">Set via secret</span>') },
            ],
            sas.accounts,
            null,
            ['No service accounts yet', 'Upload a JSON key to connect Search Console.'],
          ) +
          `<div class="card-footer">
            ${sas.encryption_configured ? '' : alertBox('warning', 'Uploads are off until the <code>SA_ENCRYPTION_KEY</code> secret is set. Run <code>npx wrangler secret put SA_ENCRYPTION_KEY</code> with any long random string.')}
            <form class="row g-2 align-items-end" id="saf">
              <div class="col-md"><label class="form-label" for="sa-file">Add a service account</label>
                <input class="form-control" type="file" id="sa-file" name="file" accept=".json,application/json" required ${sas.encryption_configured ? '' : 'disabled'}>
                <div class="form-hint">JSON key file only. In Google Cloud: IAM → Service accounts → Keys → Add key → JSON. Uploading a key for an existing account replaces it.</div></div>
              <div class="col-md-auto"><button class="btn btn-primary" type="submit" ${sas.encryption_configured ? '' : 'disabled'}>${I.key} Upload key</button></div>
            </form><div id="samsg" class="mt-2"></div></div>`,
        { flush: true },
      )}</div>

      <div class="col-lg-6">${card(
        'API keys',
        `<div class="card-body border-bottom"><p class="m-0 text-secondary">Keys let AI tools and scripts use the REST API and MCP server. Read keys see data. Write keys can also change settings, keyword groups and sitemaps.</p></div>` +
          table(
            [
              { key: 'name', label: 'Name' },
              { key: 'prefix', label: 'Key', fmt: (v) => `<code>${esc(v)}…</code>` },
              { key: 'scope', label: 'Scope', fmt: (v) => `<span class="badge ${v === 'write' ? 'badge-soft-bad' : 'badge-soft'}">${esc(v)}</span>` },
              { key: 'last_used_at', label: 'Last used', fmt: (v) => esc(v ? v.slice(0, 16).replace('T', ' ') : 'Never') },
              { key: 'id', label: '<span class="visually-hidden">Actions</span>', num: true, fmt: (v, r) => (r.revoked_at ? '<span class="text-secondary">Revoked</span>' : `<button class="btn btn-sm" data-revoke="${v}">Revoke</button>`) },
            ],
            keys.keys,
            null,
            ['No keys yet', 'Create one to connect Claude, ChatGPT, Codex or a script.'],
          ) +
          `<div class="card-footer"><form class="row g-2 align-items-end" id="keyf">
            <div class="col-sm"><label class="form-label" for="k-name">Name</label><input class="form-control" id="k-name" name="name" required placeholder="Claude Code"></div>
            <div class="col-sm-auto"><label class="form-label" for="k-scope">Scope</label><select class="form-select" id="k-scope" name="scope"><option value="read">Read</option><option value="write">Read and write</option></select></div>
            <div class="col-sm-auto"><button class="btn btn-primary" type="submit">${I.key} Create key</button></div>
          </form><div id="newkey" class="mt-3"></div></div>`,
        { flush: true },
      )}</div>

      <div class="col-lg-6">${card(
        'Connect AI tools',
        `<div class="datagrid mb-3">
          <div class="datagrid-item"><div class="datagrid-title">MCP endpoint</div><div class="datagrid-content"><code>${esc(origin)}/mcp</code></div></div>
          <div class="datagrid-item"><div class="datagrid-title">REST API</div><div class="datagrid-content"><code>${esc(origin)}/api</code></div></div>
          <div class="datagrid-item"><div class="datagrid-title">OpenAPI</div><div class="datagrid-content"><a href="/api/openapi.json">/api/openapi.json</a></div></div>
        </div>
        <ul class="nav nav-tabs mb-3" role="tablist">
          <li class="nav-item"><a class="nav-link active" data-bs-toggle="tab" href="#ai-claude" role="tab">Claude Code</a></li>
          <li class="nav-item"><a class="nav-link" data-bs-toggle="tab" href="#ai-json" role="tab">mcp.json</a></li>
          <li class="nav-item"><a class="nav-link" data-bs-toggle="tab" href="#ai-codex" role="tab">Codex</a></li>
        </ul>
        <div class="tab-content">
          <div class="tab-pane active show" id="ai-claude" role="tabpanel">${codeBlock('c-claude', `claude mcp add --transport http scry ${origin}/mcp --header "Authorization: Bearer gsk_YOUR_KEY"`)}</div>
          <div class="tab-pane" id="ai-json" role="tabpanel">${codeBlock('c-json', JSON.stringify({ mcpServers: { scry: { type: 'http', url: origin + '/mcp', headers: { Authorization: 'Bearer gsk_YOUR_KEY' } } } }, null, 2))}</div>
          <div class="tab-pane" id="ai-codex" role="tabpanel">${codeBlock('c-codex', `[mcp_servers.scry]\nurl = "${origin}/mcp"\nbearer_token_env_var = "SCRY_API_KEY"`)}</div>
        </div>`,
      )}</div>

      <div class="col-12">${card(
        'Sync',
        table(
          [
            { key: 'property_id', label: 'Property', fmt: (v) => esc(propLabel(v)) },
            { key: 'search_type', label: 'Search type' },
            { key: 'data_state', label: 'Data' },
            { key: 'status', label: 'Status', fmt: (v) => `<span class="badge ${v === 'ok' ? 'badge-soft-good' : v === 'error' ? 'badge-soft-bad' : 'badge-soft'}">${esc(v)}</span>` },
            { key: 'days', label: 'Days', num: true, fmt },
            { key: 'last_date', label: 'Latest day' },
          ],
          sync.summary,
          null,
          ['Nothing synced yet', 'Add a property to start.'],
        ) +
          (sync.recent_errors.length
            ? `<div class="card-body border-top"><h3 class="card-title">Recent errors</h3></div>${table([{ key: 'property_id', label: 'Property', fmt: (v) => esc(propLabel(v)) }, { key: 'date', label: 'Day' }, { key: 'error', label: 'Error' }], sync.recent_errors)}`
            : '') +
          `<div class="card-footer"><div class="btn-list"><button class="btn" id="syncnow">${I.refresh} Sync now</button>
            <a class="btn" href="/api/digest/preview" target="_blank" rel="noopener">${I['external-link']} Preview weekly digest</a>
            <button class="btn" id="digest">Send digest now</button></div><div id="syncmsg" class="mt-2"></div></div>`,
        { flush: true },
      )}</div>
    </div>`,
  );

  view.querySelectorAll('[data-copy-text]').forEach((b) =>
    b.addEventListener('click', () => navigator.clipboard.writeText(b.dataset.copyText).then(() => (b.innerHTML = I.copy + ' Copied'))),
  );

  $('#saf')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = $('#sa-file').files[0];
    const msg = $('#samsg');
    if (!file) return;
    if (!/\.json$/i.test(file.name) && file.type !== 'application/json') {
      msg.innerHTML = alertBox('danger', 'Choose a .json key file.');
      return;
    }
    if (file.size > 20000) {
      msg.innerHTML = alertBox('danger', 'That file is too large to be a service account key.');
      return;
    }
    let text;
    try {
      text = await file.text();
      JSON.parse(text);
    } catch {
      msg.innerHTML = alertBox('danger', 'That file is not valid JSON.');
      return;
    }
    const btn = e.currentTarget.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.classList.add('btn-loading');
    try {
      const res = await fetch('/api/service-accounts', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: text });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
      msg.innerHTML = alertBox('success', `Added <code>${esc(data.client_email)}</code>. It can read ${fmt(data.sites.length)} Search Console site${data.sites.length === 1 ? '' : 's'}${data.sites.length ? '' : '. Add its email as a user in Search Console, then reload this page'}.`);
      e.currentTarget.reset();
      setTimeout(route, 1500);
    } catch (err) {
      msg.innerHTML = alertBox('danger', esc(err.message));
    } finally {
      btn.disabled = false;
      btn.classList.remove('btn-loading');
    }
  });

  view.querySelectorAll('[data-remove-sa]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm(`Remove ${b.dataset.email}? Properties it reads move to another account that has access.`)) return;
      try {
        const r = await api(`/service-accounts/${b.dataset.removeSa}`, {}, { method: 'DELETE' });
        $('#samsg').innerHTML = alertBox('success', `Removed ${esc(r.removed)}.${r.moved.length ? ' Moved: ' + r.moved.map((m) => `${esc(m.property)} → ${esc(m.to)}`).join(', ') : ''}`);
        setTimeout(route, 1200);
      } catch (err) {
        $('#samsg').innerHTML = alertBox('danger', esc(err.message));
      }
    }),
  );

  view.querySelectorAll('[data-copy]').forEach((b) =>
    b.addEventListener('click', () => navigator.clipboard.writeText($('#' + b.dataset.copy).textContent).then(() => (b.innerHTML = `${I.copy} Copied`))),
  );

  view.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => {
      const p = props.properties.find((x) => String(x.id) === b.dataset.edit);
      const box = $('#editbox');
      box.hidden = false;
      box.innerHTML = `<form id="editf"><h3 class="card-title mb-3">Edit ${esc(p.label)}</h3>
        <div class="row g-3">
          <div class="col-md-3"><label class="form-label" for="e-label">Label</label><input class="form-control" id="e-label" name="label" value="${esc(p.label)}"></div>
          <div class="col-md-3"><label class="form-label" for="e-types">Search types</label><input class="form-control" id="e-types" name="search_types" value="${esc(p.search_types.join(', '))}"><div class="form-hint">web, image, video, news, discover, googleNews</div></div>
          <div class="col-md-3"><label class="form-label" for="e-budget">Inspections per day</label><input class="form-control" id="e-budget" name="inspection_budget" type="number" min="0" max="1900" value="${p.inspection_budget}"></div>
          <div class="col-md-3"><label class="form-label" for="e-active">Status</label><select class="form-select" id="e-active" name="active"><option value="true" ${p.active ? 'selected' : ''}>Active</option><option value="false" ${p.active ? '' : 'selected'}>Paused</option></select></div>
          <div class="col-12"><label class="form-label" for="e-brand">Brand terms</label><input class="form-control" id="e-brand" name="brand_terms" value="${esc(p.brand_terms.join(', '))}"><div class="form-hint">Comma-separated. A query that contains any of them counts as branded.</div></div>
        </div>
        <div class="mt-3"><button class="btn btn-primary" type="submit">Save</button> <span id="editmsg" class="ms-2"></span></div></form>`;
      box.scrollIntoView({ block: 'nearest' });
      $('#editf').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(e.currentTarget));
        try {
          await api(`/p/${p.id}/settings`, {}, {
            method: 'POST',
            body: {
              label: fd.label,
              search_types: fd.search_types.split(',').map((s) => s.trim()).filter(Boolean),
              brand_terms: fd.brand_terms.split(',').map((s) => s.trim()).filter(Boolean),
              inspection_budget: Number(fd.inspection_budget),
              active: fd.active === 'true',
            },
          });
          await loadProperties();
          route();
        } catch (err) {
          $('#editmsg').innerHTML = `<span class="t-bad">${esc(err.message)}</span>`;
        }
      });
    }),
  );

  $('#addf')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('/properties', {}, { method: 'POST', body: Object.fromEntries(new FormData(e.currentTarget)) });
      $('#addmsg').innerHTML = alertBox('success', `Added. ${fmt(r.queued_days)} days queued for backfill.`);
      await loadProperties();
      setTimeout(route, 900);
    } catch (err) {
      $('#addmsg').innerHTML = alertBox('danger', esc(err.message));
    }
  });

  $('#keyf').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const k = await api('/keys', {}, { method: 'POST', body: Object.fromEntries(new FormData(e.currentTarget)) });
      $('#newkey').innerHTML = `${alertBox('warning', '<strong>Copy this key now.</strong> It is shown only once.')}<div class="input-group"><input class="form-control font-monospace" id="kv" readonly value="${esc(k.key)}" aria-label="New API key"><button class="btn" type="button" id="kc">${I.copy} Copy</button></div>`;
      $('#kc').addEventListener('click', () => navigator.clipboard.writeText(k.key).then(() => ($('#kc').innerHTML = `${I.copy} Copied`)));
    } catch (err) {
      $('#newkey').innerHTML = alertBox('danger', esc(err.message));
    }
  });

  view.querySelectorAll('[data-revoke]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Revoke this key? Tools using it stop working immediately.')) return;
      await api(`/keys/${b.dataset.revoke}`, {}, { method: 'DELETE' });
      route();
    }),
  );

  $('#syncnow').addEventListener('click', async () => {
    const r = await api('/sync', {}, { method: 'POST', body: {} });
    $('#syncmsg').innerHTML = alertBox('info', `${fmt(r.queued_days)} days queued.`);
  });
  $('#digest').addEventListener('click', async () => {
    const r = await api('/digest/send', {}, { method: 'POST', body: {} });
    $('#syncmsg').innerHTML = alertBox(r.sent ? 'success' : 'warning', r.sent ? 'Digest sent.' : `Not sent: ${esc(r.reason)}`);
  });
}

// ---------- boot ----------

async function loadProperties() {
  state.properties = (await api('/properties')).properties;
}

document.addEventListener('click', async (e) => {
  if (e.target.closest('#signout')) {
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
    location.replace('/login');
    return;
  }
  if (!e.target.closest('[data-theme-toggle]')) return;
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.setAttribute('data-bs-theme', next);
  try {
    localStorage.setItem('theme', next);
  } catch {}
  document.querySelectorAll('.d-lg-none [data-theme-toggle]').forEach((b) => (b.innerHTML = next === 'dark' ? I.sun : I.moon));
  route();
});

async function boot() {
  try {
    state.me = await api('/me');
    document.title = state.me.app;
    $('#brand').textContent = state.me.app;
    await loadProperties();
  } catch (e) {
    view.innerHTML = page({ title: 'Can’t load the dashboard' }, alertBox('danger', esc(e.message)));
    return;
  }
  $('#prop').addEventListener('change', (e) => (location.hash = e.target.value ? href(`/p/${e.target.value}`) : '#/'));
  window.addEventListener('hashchange', route);
  route();
}

boot();
