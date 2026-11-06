import { HttpError, type Env, type Property, type SearchType } from './env';
import { brandTerms, SEARCH_TYPES } from './db';
import { searchAnalytics, type DimensionFilter, type SearchAnalyticsRequest, type SearchAnalyticsRow } from './google';
import { addDays, assertDate, daysBetween, isDate, likeContains, pageId, queryId, round, sha256Hex, todayUtc } from './util';
import { FINAL_LAG_DAYS } from './sync';
import { listAnnotations } from './annotations';
import { findContentGroup, groupRegexFilters, groupSql, type ContentGroup } from './contentgroups';

export type Compare = 'previous' | 'yoy' | 'none';

export interface ReportArgs {
  search_type?: SearchType;
  from?: string;
  to?: string;
  days?: number;
  compare?: Compare;
  country?: string;
  device?: string;
  brand?: 'branded' | 'nonbranded' | 'all';
  page?: string;
  query?: string;
  /** Content group name or id (page-level filter). */
  group?: string;
  /** Resolved content group (set by withGroup). */
  _group?: ContentGroup | null;
}

/** Resolves a.group once, so every report can filter by content group. */
export async function withGroup<T extends ReportArgs>(env: Env, p: Property, a: T): Promise<T> {
  if (a._group !== undefined || !a.group) return a;
  return { ...a, _group: await findContentGroup(env, p, a.group) };
}

export interface Range {
  searchType: SearchType;
  from: string;
  to: string;
  prevFrom: string | null;
  prevTo: string | null;
  days: number;
}

const NEVER = '0000-00-00';

export async function latestDate(env: Env, p: Property, type: SearchType, finalOnly: boolean): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT MAX(date) AS d FROM daily_totals WHERE property_id = ? AND search_type = ? ${finalOnly ? 'AND provisional = 0' : ''}`,
  )
    .bind(p.id, type)
    .first<{ d: string | null }>();
  return row?.d || addDays(todayUtc(), -FINAL_LAG_DAYS);
}

export async function resolveRange(env: Env, p: Property, a: ReportArgs, includeProvisional = false): Promise<Range> {
  const searchType = a.search_type || 'web';
  if (!SEARCH_TYPES.includes(searchType)) throw new HttpError(400, `search_type must be one of ${SEARCH_TYPES.join(', ')}`);
  let to = a.to ? assertDate(a.to, 'to') : await latestDate(env, p, searchType, !includeProvisional);
  let from: string;
  if (a.from) from = assertDate(a.from, 'from');
  else {
    const days = Math.min(Math.max(Number(a.days) || 28, 1), 486);
    from = addDays(to, -(days - 1));
  }
  if (from > to) [from, to] = [to, from];
  const days = daysBetween(from, to) + 1;
  const compare = a.compare || 'previous';
  let prevFrom: string | null = null;
  let prevTo: string | null = null;
  if (compare === 'previous') {
    prevTo = addDays(from, -1);
    prevFrom = addDays(prevTo, -(days - 1));
  } else if (compare === 'yoy') {
    prevFrom = addDays(from, -364);
    prevTo = addDays(to, -364);
  }
  return { searchType, from, to, prevFrom, prevTo, days };
}

export interface Metrics {
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}

export function metrics(clicks: number | null, impressions: number | null, posSum: number | null): Metrics {
  const c = Number(clicks || 0);
  const i = Number(impressions || 0);
  return {
    clicks: c,
    impressions: i,
    ctr: i ? round((c / i) * 100, 2) : null,
    position: i ? round(Number(posSum || 0) / i, 1) : null,
  };
}

function delta(cur: Metrics, prev: Metrics | null) {
  if (!prev) return null;
  const pct = (a: number, b: number) => (b ? round(((a - b) / b) * 100, 1) : null);
  return {
    clicks: cur.clicks - prev.clicks,
    clicks_pct: pct(cur.clicks, prev.clicks),
    impressions: cur.impressions - prev.impressions,
    impressions_pct: pct(cur.impressions, prev.impressions),
    ctr: cur.ctr !== null && prev.ctr !== null ? round(cur.ctr - prev.ctr, 2) : null,
    position: cur.position !== null && prev.position !== null ? round(cur.position - prev.position, 1) : null,
  };
}

function rangeInfo(r: Range) {
  return { search_type: r.searchType, from: r.from, to: r.to, compare_from: r.prevFrom, compare_to: r.prevTo, days: r.days };
}

// ---------- Live (filters the stored tables can't answer) ----------

const needsLive = (a: ReportArgs) => Boolean(a.country || a.device);

function reEscape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function liveFilters(p: Property, a: ReportArgs): DimensionFilter[] {
  const f: DimensionFilter[] = [];
  if (a.country) f.push({ dimension: 'country', operator: 'equals', expression: a.country.toLowerCase() });
  if (a.device) f.push({ dimension: 'device', operator: 'equals', expression: a.device.toUpperCase() });
  if (a.page) f.push({ dimension: 'page', operator: 'equals', expression: a.page });
  if (a.query) f.push({ dimension: 'query', operator: 'equals', expression: a.query });
  if (a._group) f.push(...groupRegexFilters(a._group));
  if (a.brand && a.brand !== 'all') {
    const terms = brandTerms(p);
    if (!terms.length) throw new HttpError(400, 'No brand terms set for this property. Add them with update_property.');
    f.push({
      dimension: 'query',
      operator: a.brand === 'branded' ? 'includingRegex' : 'excludingRegex',
      expression: '(?i)(' + terms.map(reEscape).join('|') + ')',
    });
  }
  return f;
}

export async function liveQuery(env: Env, p: Property, body: SearchAnalyticsRequest): Promise<SearchAnalyticsRow[]> {
  const key = 'live:' + (await sha256Hex(p.site_url + JSON.stringify(body)));
  const hit = await env.KV.get<SearchAnalyticsRow[]>(key, 'json');
  if (hit) return hit;
  const rows = await searchAnalytics(env, p.site_url, body);
  await env.KV.put(key, JSON.stringify(rows), { expirationTtl: 6 * 3600 });
  return rows;
}

async function liveRows(env: Env, p: Property, r: Range, a: ReportArgs, dimensions: SearchAnalyticsRequest['dimensions'], prev = false, extra: DimensionFilter[] = []) {
  const filters = [...liveFilters(p, a), ...extra];
  return liveQuery(env, p, {
    startDate: prev ? r.prevFrom! : r.from,
    endDate: prev ? r.prevTo! : r.to,
    dimensions,
    type: r.searchType,
    dataState: 'all',
    rowLimit: 25000,
    ...(filters.length ? { dimensionFilterGroups: [{ groupType: 'and', filters }] } : {}),
  });
}

const rowMetrics = (row?: SearchAnalyticsRow) =>
  row ? metrics(row.clicks, row.impressions, row.position * row.impressions) : metrics(0, 0, 0);

// ---------- Stored-data scoping ----------

interface Scope {
  from: string;
  where: string[];
  params: unknown[];
}

function brandClause(p: Property, a: ReportArgs, col: string): { sql: string; params: string[] } | null {
  if (!a.brand || a.brand === 'all') return null;
  const terms = brandTerms(p);
  if (!terms.length) throw new HttpError(400, 'No brand terms set for this property. Add them with update_property.');
  const ors = terms.map(() => `${col} LIKE ? ESCAPE '\\'`).join(' OR ');
  return { sql: a.brand === 'branded' ? `(${ors})` : `NOT (${ors})`, params: terms.map(likeContains) };
}

/** Picks the narrowest stored table that can answer a totals/timeseries question. */
function scopeFor(p: Property, r: Range, a: ReportArgs): Scope {
  const brand = brandClause(p, a, 'bq.text');
  const where = ['x.property_id = ?', 'x.search_type = ?'];
  const params: unknown[] = [p.id, r.searchType];
  let from: string;
  const pageLevel = a.page || a._group;
  if (pageLevel && (a.query || brand)) from = a.page ? 'query_page_daily x INDEXED BY qpd_page' : 'query_page_daily x';
  else if (pageLevel) from = a.page && !a._group ? 'page_daily x INDEXED BY page_daily_lookup' : 'page_daily x';
  else if (a.query || brand) from = a.query ? 'query_daily x INDEXED BY query_daily_lookup' : 'query_daily x';
  else from = 'daily_totals x';
  if (a._group) {
    from += ' JOIN pages gp ON gp.id = x.page_id';
    const g = groupSql(a._group, 'gp.url');
    where.push(g.sql);
    params.push(...g.params);
  }
  if (a.page) {
    where.push('x.page_id = ?');
    params.push(pageId(p.id, a.page));
  }
  if (a.query) {
    where.push('x.query_id = ?');
    params.push(queryId(p.id, a.query));
  }
  if (brand) {
    from += ' JOIN queries bq ON bq.id = x.query_id';
    where.push(brand.sql);
    params.push(...brand.params);
  }
  return { from, where, params };
}

/** Dates are validated YYYY-MM-DD strings, so inlining them is safe and keeps placeholder counts simple. */
function dateCond(from: string, to: string, col = 'x.date') {
  if (!isDate(from) && from !== NEVER) throw new HttpError(400, 'bad date');
  if (!isDate(to) && to !== NEVER) throw new HttpError(400, 'bad date');
  return `${col} >= '${from}' AND ${col} <= '${to}'`;
}

// ---------- Reports ----------

export { dateCond, NEVER };

/**
 * Date filter covering the current and comparison windows. A single range lets SQLite
 * use the (property, type, id, date) indexes; an OR of two ranges forces a scan.
 */
export function spanCond(r: { from: string; to: string; prevFrom: string | null; prevTo: string | null }, col = 'x.date') {
  if (!r.prevFrom || !r.prevTo) return dateCond(r.from, r.to, col);
  if (addDays(r.prevTo, 1) >= r.from) return dateCond(r.prevFrom < r.from ? r.prevFrom : r.from, r.to > r.prevTo ? r.to : r.prevTo, col);
  return `((${dateCond(r.from, r.to, col)}) OR (${dateCond(r.prevFrom, r.prevTo, col)}))`;
}

export async function summary(env: Env, p: Property, a: ReportArgs) {
  a = await withGroup(env, p, a);
  const r = await resolveRange(env, p, a);
  if (needsLive(a)) {
    const [cur, prev] = await Promise.all([
      liveRows(env, p, r, a, []),
      r.prevFrom ? liveRows(env, p, r, a, [], true) : Promise.resolve(null),
    ]);
    const c = rowMetrics(cur[0]);
    const pr = prev ? rowMetrics(prev[0]) : null;
    return { property: p.site_url, range: rangeInfo(r), current: c, previous: pr, delta: delta(c, pr), source: 'live' };
  }
  const s = scopeFor(p, r, a);
  const cur = dateCond(r.from, r.to);
  const prv = dateCond(r.prevFrom || NEVER, r.prevTo || NEVER);
  const sum = (col: string, cond: string) => `SUM(CASE WHEN ${cond} THEN x.${col} ELSE 0 END)`;
  const row = await env.DB.prepare(
    `SELECT ${sum('clicks', cur)} AS c, ${sum('impressions', cur)} AS i, ${sum('pos_sum', cur)} AS ps,
       ${sum('clicks', prv)} AS pc, ${sum('impressions', prv)} AS pi, ${sum('pos_sum', prv)} AS pps
     FROM ${s.from} WHERE ${s.where.join(' AND ')} AND ${spanCond(r)}`,
  )
    .bind(...s.params)
    .first<Record<string, number>>();
  const c = metrics(row?.c ?? 0, row?.i ?? 0, row?.ps ?? 0);
  const pr = r.prevFrom ? metrics(row?.pc ?? 0, row?.pi ?? 0, row?.pps ?? 0) : null;
  const note =
    s.from.startsWith('query_daily') || s.from.startsWith('query_page_daily')
      ? 'Query-level totals exclude anonymized queries, so they run lower than property totals.'
      : undefined;
  return { property: p.site_url, range: rangeInfo(r), current: c, previous: pr, delta: delta(c, pr), source: 'stored', note };
}

export async function timeseries(env: Env, p: Property, a: ReportArgs) {
  a = await withGroup(env, p, a);
  const r = await resolveRange(env, p, { ...a, compare: 'none' }, true);
  const annotations = await listAnnotations(env, p, r.from, r.to);
  if (needsLive(a)) {
    const rows = await liveRows(env, p, r, a, ['date']);
    return {
      property: p.site_url,
      range: rangeInfo(r),
      annotations,
      source: 'live',
      rows: rows.map((x) => ({ date: x.keys![0], ...rowMetrics(x), provisional: false })),
    };
  }
  const s = scopeFor(p, r, a);
  const prov = s.from.startsWith('daily_totals') ? 'MAX(x.provisional)' : '0';
  const { results } = await env.DB.prepare(
    `SELECT x.date AS date, SUM(x.clicks) AS c, SUM(x.impressions) AS i, SUM(x.pos_sum) AS ps, ${prov} AS prov
     FROM ${s.from} WHERE ${s.where.join(' AND ')} AND x.date >= ? AND x.date <= ? GROUP BY x.date ORDER BY x.date`,
  )
    .bind(...s.params, r.from, r.to)
    .all<{ date: string; c: number; i: number; ps: number; prov: number }>();
  const provDates = s.from.startsWith('daily_totals')
    ? null
    : new Set(
        (
          await env.DB.prepare('SELECT date FROM daily_totals WHERE property_id = ? AND search_type = ? AND provisional = 1')
            .bind(p.id, r.searchType)
            .all<{ date: string }>()
        ).results.map((x) => x.date),
      );
  return {
    property: p.site_url,
    range: rangeInfo(r),
      annotations,
    source: 'stored',
    rows: results.map((x) => ({ date: x.date, ...metrics(x.c, x.i, x.ps), provisional: Boolean(x.prov) || Boolean(provDates?.has(x.date)) })),
  };
}

export type TableKind = 'page' | 'query';

export interface TableArgs extends ReportArgs {
  sort?: 'clicks' | 'impressions' | 'ctr' | 'position' | 'delta_clicks' | 'delta_impressions' | 'delta_position';
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  contains?: string;
  min_impressions?: number;
}

const SORTS: Record<string, string> = {
  clicks: 'clicks',
  impressions: 'impressions',
  ctr: 'clicks * 1.0 / NULLIF(impressions, 0)',
  position: 'pos_sum / NULLIF(impressions, 0)',
  delta_clicks: 'clicks - p_clicks',
  delta_impressions: 'impressions - p_impressions',
  delta_position: '(pos_sum / NULLIF(impressions, 0)) - (p_pos_sum / NULLIF(p_impressions, 0))',
};

export interface TableRow {
  [k: string]: unknown;
}

function tableRow(kind: TableKind, label: string, cur: Metrics, prev: Metrics | null): TableRow {
  const d = delta(cur, prev);
  return {
    [kind]: label,
    ...cur,
    ...(prev
      ? {
          prev_clicks: prev.clicks,
          prev_impressions: prev.impressions,
          prev_ctr: prev.ctr,
          prev_position: prev.position,
          delta_clicks: d!.clicks,
          delta_impressions: d!.impressions,
          delta_position: d!.position,
        }
      : {}),
  };
}

export async function table(env: Env, p: Property, kind: TableKind, a: TableArgs) {
  a = await withGroup(env, p, a);
  const r = await resolveRange(env, p, a);
  const limit = Math.min(Math.max(Number(a.limit) || 100, 1), 5000);
  const offset = Math.max(Number(a.offset) || 0, 0);
  const sort = a.sort && SORTS[a.sort] ? a.sort : 'clicks';
  const order = (a.order || (sort === 'position' ? 'asc' : 'desc')).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const minImpr = Math.max(Number(a.min_impressions) || 1, 1);

  if (needsLive(a)) {
    const extra: DimensionFilter[] = a.contains ? [{ dimension: kind, operator: 'contains', expression: a.contains }] : [];
    const [cur, prev] = await Promise.all([
      liveRows(env, p, r, a, [kind], false, extra),
      r.prevFrom ? liveRows(env, p, r, a, [kind], true, extra) : Promise.resolve([]),
    ]);
    const prevMap = new Map(prev.map((x) => [x.keys![0], x]));
    let rows = cur
      .filter((x) => x.impressions >= minImpr)
      .map((x) => tableRow(kind, x.keys![0], rowMetrics(x), r.prevFrom ? rowMetrics(prevMap.get(x.keys![0])) : null));
    const key = sort === 'ctr' ? 'ctr' : sort === 'position' ? 'position' : sort;
    rows.sort((x, y) => {
      const xv = Number(x[key] ?? 0);
      const yv = Number(y[key] ?? 0);
      return order === 'ASC' ? xv - yv : yv - xv;
    });
    const slice = rows.slice(offset, offset + limit);
    return { property: p.site_url, range: rangeInfo(r), source: 'live', rows: slice, has_more: rows.length > offset + limit };
  }

  const idCol = kind === 'page' ? 'page_id' : 'query_id';
  const brand = brandClause(p, a, 'bq.text');
  const crossFilter = (kind === 'page' && (a.query || brand)) || (kind === 'query' && (a.page || a._group));
  // Name the index for single-page / single-query lookups; the planner otherwise picks
  // the GROUP BY column's index and scans every row of the property.
  const src = crossFilter
    ? kind === 'query' && a.page
      ? 'query_page_daily INDEXED BY qpd_page'
      : kind === 'page' && a.query
        ? 'query_page_daily INDEXED BY qpd_query'
        : 'query_page_daily'
    : kind === 'page'
      ? 'page_daily'
      : 'query_daily';
  const label = kind === 'page' ? 'JOIN pages L ON L.id = x.page_id' : 'JOIN queries L ON L.id = x.query_id';
  const labelCol = kind === 'page' ? 'L.url' : 'L.text';

  const where = ['x.property_id = ?', 'x.search_type = ?', spanCond(r)];
  const params: unknown[] = [p.id, r.searchType];
  let joins = label;
  if (a.page && kind === 'query') {
    where.push('x.page_id = ?');
    params.push(pageId(p.id, a.page));
  }
  if (a.query && kind === 'page') {
    where.push('x.query_id = ?');
    params.push(queryId(p.id, a.query));
  }
  if (brand) {
    if (kind === 'query') {
      where.push(brand.sql.replace(/bq\.text/g, 'L.text'));
    } else {
      joins += ' JOIN queries bq ON bq.id = x.query_id';
      where.push(brand.sql);
    }
    params.push(...brand.params);
  }
  if (a._group) {
    if (kind === 'page') {
      const g = groupSql(a._group, 'L.url');
      where.push(g.sql);
      params.push(...g.params);
    } else {
      joins += ' JOIN pages gp ON gp.id = x.page_id';
      const g = groupSql(a._group, 'gp.url');
      where.push(g.sql);
      params.push(...g.params);
    }
  }
  if (a.contains) {
    where.push(`${labelCol} LIKE ? ESCAPE '\\'`);
    params.push(likeContains(a.contains));
  }
  const cur = dateCond(r.from, r.to);
  const prv = dateCond(r.prevFrom || NEVER, r.prevTo || NEVER);
  // Aggregate in a subquery: in SQLite, a bare `clicks` inside ORDER BY/HAVING
  // expressions resolves to the raw column, not the SUM alias.
  const sql = `SELECT * FROM (
      SELECT x.${idCol} AS id, ${labelCol} AS label,
        SUM(CASE WHEN ${cur} THEN x.clicks ELSE 0 END) AS clicks,
        SUM(CASE WHEN ${cur} THEN x.impressions ELSE 0 END) AS impressions,
        SUM(CASE WHEN ${cur} THEN x.pos_sum ELSE 0 END) AS pos_sum,
        SUM(CASE WHEN ${prv} THEN x.clicks ELSE 0 END) AS p_clicks,
        SUM(CASE WHEN ${prv} THEN x.impressions ELSE 0 END) AS p_impressions,
        SUM(CASE WHEN ${prv} THEN x.pos_sum ELSE 0 END) AS p_pos_sum
      FROM ${src.includes(' INDEXED BY ') ? src.replace(' INDEXED BY ', ' x INDEXED BY ') : src + ' x'} ${joins}
      WHERE ${where.join(' AND ')}
      GROUP BY x.${idCol}
    ) WHERE impressions >= ${minImpr}
    ORDER BY ${SORTS[sort]} ${order} NULLS LAST, impressions DESC
    LIMIT ${limit + 1} OFFSET ${offset}`;
  const { results } = await env.DB.prepare(sql).bind(...params).all<Record<string, number | string>>();
  const rows = results.slice(0, limit).map((x) =>
    tableRow(
      kind,
      String(x.label),
      metrics(x.clicks as number, x.impressions as number, x.pos_sum as number),
      r.prevFrom ? metrics(x.p_clicks as number, x.p_impressions as number, x.p_pos_sum as number) : null,
    ),
  );
  return { property: p.site_url, range: rangeInfo(r), source: 'stored', rows, has_more: results.length > limit };
}

export type BreakdownDim = 'country' | 'device' | 'searchAppearance';

export async function breakdown(env: Env, p: Property, dim: BreakdownDim, a: ReportArgs) {
  a = await withGroup(env, p, a);
  if (!['country', 'device', 'searchAppearance'].includes(dim)) throw new HttpError(400, 'dimension must be country, device or searchAppearance');
  const r = await resolveRange(env, p, a);
  if (needsLive(a) || a.page || a.query || a._group || (a.brand && a.brand !== 'all')) {
    const [cur, prev] = await Promise.all([
      liveRows(env, p, r, a, [dim]),
      r.prevFrom ? liveRows(env, p, r, a, [dim], true) : Promise.resolve([]),
    ]);
    const pm = new Map(prev.map((x) => [x.keys![0], x]));
    return {
      property: p.site_url,
      range: rangeInfo(r),
      source: 'live',
      rows: cur.map((x) => tableRow(dim as TableKind, x.keys![0], rowMetrics(x), r.prevFrom ? rowMetrics(pm.get(x.keys![0])) : null)),
    };
  }
  const { results } = await env.DB.prepare(
    `SELECT value,
      SUM(CASE WHEN date >= ?1 AND date <= ?2 THEN clicks ELSE 0 END) AS c,
      SUM(CASE WHEN date >= ?1 AND date <= ?2 THEN impressions ELSE 0 END) AS i,
      SUM(CASE WHEN date >= ?1 AND date <= ?2 THEN pos_sum ELSE 0 END) AS ps,
      SUM(CASE WHEN date >= ?3 AND date <= ?4 THEN clicks ELSE 0 END) AS pc,
      SUM(CASE WHEN date >= ?3 AND date <= ?4 THEN impressions ELSE 0 END) AS pi,
      SUM(CASE WHEN date >= ?3 AND date <= ?4 THEN pos_sum ELSE 0 END) AS pps
     FROM dim_daily WHERE property_id = ?5 AND search_type = ?6 AND dim = ?7
       AND ((date >= ?1 AND date <= ?2) OR (date >= ?3 AND date <= ?4))
     GROUP BY value HAVING i > 0 ORDER BY c DESC, i DESC LIMIT 300`,
  )
    .bind(r.from, r.to, r.prevFrom || NEVER, r.prevTo || NEVER, p.id, r.searchType, dim)
    .all<Record<string, number | string>>();
  return {
    property: p.site_url,
    range: rangeInfo(r),
    source: 'stored',
    rows: results.map((x) =>
      tableRow(
        dim as TableKind,
        String(x.value),
        metrics(x.c as number, x.i as number, x.ps as number),
        r.prevFrom ? metrics(x.pc as number, x.pi as number, x.pps as number) : null,
      ),
    ),
  };
}

export async function pageDetail(env: Env, p: Property, url: string, a: ReportArgs) {
  if (!url) throw new HttpError(400, 'url is required');
  const id = pageId(p.id, url);
  const args = { ...a, page: url };
  const [sum, series, queries, firstSeen, inspection] = await Promise.all([
    summary(env, p, args),
    timeseries(env, p, { ...args, days: Math.max(Number(a.days) || 90, 28) }),
    table(env, p, 'query', { ...args, limit: 100 }),
    env.DB.prepare("SELECT MIN(date) AS d FROM page_daily INDEXED BY page_daily_lookup WHERE property_id = ? AND search_type = 'web' AND page_id = ?").bind(p.id, id).first<{ d: string | null }>(),
    env.DB.prepare('SELECT * FROM url_inspections WHERE property_id = ? AND page_id = ?').bind(p.id, id).first(),
  ]);
  const buckets = { top3: 0, top10: 0, top20: 0, beyond: 0 };
  for (const q of queries.rows) {
    const pos = Number(q.position);
    if (pos <= 3) buckets.top3++;
    else if (pos <= 10) buckets.top10++;
    else if (pos <= 20) buckets.top20++;
    else buckets.beyond++;
  }
  return {
    page: url,
    first_seen: firstSeen?.d ?? null,
    summary: sum,
    position_buckets: buckets,
    timeseries: series.rows,
    annotations: series.annotations,
    queries: queries.rows,
    inspection: inspection ?? null,
  };
}

export async function queryDetail(env: Env, p: Property, q: string, a: ReportArgs) {
  if (!q) throw new HttpError(400, 'query is required');
  const args = { ...a, query: q };
  const [sum, series, pages] = await Promise.all([
    summary(env, p, args),
    timeseries(env, p, { ...args, days: Math.max(Number(a.days) || 90, 28) }),
    table(env, p, 'page', { ...args, limit: 50, sort: 'impressions' }),
  ]);
  const total = pages.rows.reduce((s, x) => s + Number(x.impressions), 0);
  const competing = pages.rows.filter((x) => total && Number(x.impressions) / total >= 0.1);
  return {
    query: q,
    summary: sum,
    timeseries: series.rows,
    annotations: series.annotations,
    pages: pages.rows.map((x) => ({ ...x, impression_share: total ? round((Number(x.impressions) / total) * 100, 1) : null })),
    cannibalization: competing.length >= 2,
  };
}
