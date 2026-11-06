import type { DataState, Env, Job, Property, SearchType } from './env';
import { buildInserts, execMany, listProperties, propertySearchTypes, tuple } from './db';
import { searchAnalyticsAll, type Dimension, type SearchAnalyticsRow } from './google';
import { addDays, dateRange, pageId, queryId, sqlNum, sqlStr, todayUtc } from './util';

/** GSC keeps 16 months. */
export const HISTORY_DAYS = 485;
/** Final data usually lands 2-3 days after the day ends. */
export const FINAL_LAG_DAYS = 3;
const MAX_ENQUEUE_PER_TYPE = 500;
const STALE_MS = 6 * 3600_000;

const NO_QUERY_TYPES: SearchType[] = ['discover', 'googleNews'];

interface JobRow {
  date: string;
  data_state: string;
  status: string;
  updated_at: string;
}

/** Enqueue every missing or stale day for a property. Covers backfill, gaps and provisional refresh. */
export async function planSync(env: Env, p: Property): Promise<number> {
  const today = todayUtc();
  const lastFinal = addDays(today, -FINAL_LAG_DAYS);
  const first = addDays(today, -HISTORY_DAYS);
  const now = Date.now();
  let total = 0;

  for (const type of propertySearchTypes(p)) {
    const { results } = await env.DB.prepare(
      'SELECT date, data_state, status, updated_at FROM sync_jobs WHERE property_id = ? AND search_type = ? AND date >= ?',
    )
      .bind(p.id, type, first)
      .all<JobRow>();
    const final = new Map<string, JobRow>();
    const prov = new Map<string, JobRow>();
    for (const r of results) (r.data_state === 'final' ? final : prov).set(r.date, r);

    const due = (r: JobRow | undefined, refreshMs: number) =>
      !r || (r.status !== 'ok' && now - Date.parse(r.updated_at) > STALE_MS) || (r.status === 'ok' && refreshMs >= 0 && now - Date.parse(r.updated_at) > refreshMs);

    const jobs: Job[] = [];
    // Newest first so recent data shows up before the deep backfill.
    for (const date of dateRange(first, lastFinal).reverse()) {
      if (jobs.length >= MAX_ENQUEUE_PER_TYPE) break;
      if (due(final.get(date), -1)) jobs.push({ kind: 'sync', propertyId: p.id, date, searchType: type, dataState: 'final' });
    }
    // Provisional ("all") data for recent days that have no final data yet.
    for (const date of dateRange(addDays(today, -6), addDays(today, -1))) {
      if (final.get(date)?.status === 'ok') continue;
      if (due(prov.get(date), 5 * 3600_000)) jobs.push({ kind: 'sync', propertyId: p.id, date, searchType: type, dataState: 'all' });
    }
    if (!jobs.length) continue;

    const stamp = new Date().toISOString();
    const sqls = buildInserts(
      'INSERT INTO sync_jobs (property_id, date, search_type, data_state, status, rows, error, updated_at) VALUES ',
      jobs.map((j) => j.kind === 'sync' ? tuple(sqlNum(p.id), sqlStr(j.date), sqlStr(type), sqlStr(j.dataState), "'queued'", '0', 'NULL', sqlStr(stamp)) : ''),
    ).map((s) => s + ' ON CONFLICT (property_id, search_type, data_state, date) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, error = NULL');
    await execMany(env, sqls);
    for (let i = 0; i < jobs.length; i += 100) {
      await env.JOBS.sendBatch(jobs.slice(i, i + 100).map((body) => ({ body })));
    }
    total += jobs.length;
  }
  return total;
}

export async function planAllSyncs(env: Env) {
  let n = 0;
  for (const p of await listProperties(env, true)) n += await planSync(env, p);
  return n;
}

async function setJob(env: Env, j: Extract<Job, { kind: 'sync' }>, status: string, rows: number, error: string | null) {
  await env.DB.prepare(
    `INSERT INTO sync_jobs (property_id, date, search_type, data_state, status, rows, error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (property_id, search_type, data_state, date) DO UPDATE SET status = excluded.status, rows = excluded.rows, error = excluded.error, updated_at = excluded.updated_at`,
  )
    .bind(j.propertyId, j.date, j.searchType, j.dataState, status, rows, error, new Date().toISOString())
    .run();
}

const pos = (r: SearchAnalyticsRow) => r.position * r.impressions;

/** Fetch one day for one search type and replace its rows. */
export async function runSyncJob(env: Env, j: Extract<Job, { kind: 'sync' }>) {
  const p = await env.DB.prepare('SELECT * FROM properties WHERE id = ?').bind(j.propertyId).first<Property>();
  if (!p || !p.active) return;

  if (j.dataState === 'all') {
    const fin = await env.DB.prepare(
      "SELECT status FROM sync_jobs WHERE property_id = ? AND search_type = ? AND data_state = 'final' AND date = ?",
    )
      .bind(p.id, j.searchType, j.date)
      .first<{ status: string }>();
    if (fin?.status === 'ok') return setJob(env, j, 'skipped', 0, null);
  }

  const q = (dimensions: Dimension[]) =>
    searchAnalyticsAll(env, p.site_url, {
      startDate: j.date,
      endDate: j.date,
      dimensions,
      type: j.searchType,
      dataState: j.dataState,
    });

  const totals = await q(['date']);
  const t = totals[0];
  if (!t) {
    const old = j.date < addDays(todayUtc(), -8);
    if (j.dataState === 'final' && !old) return setJob(env, j, 'pending', 0, 'No final data yet');
  }

  const withQueries = !NO_QUERY_TYPES.includes(j.searchType);
  const [pages, queries, pairs, countries, devices, appearances] = await Promise.all([
    q(['page']),
    withQueries ? q(['query']) : Promise.resolve([]),
    withQueries ? q(['query', 'page']) : Promise.resolve([]),
    q(['country']),
    q(['device']),
    withQueries ? q(['searchAppearance']).catch(() => []) : Promise.resolve([]),
  ]);

  const pid = p.id;
  const P = sqlNum(pid);
  const D = sqlStr(j.date);
  const T = sqlStr(j.searchType);

  const pageTexts = new Map<number, string>();
  const queryTexts = new Map<number, string>();
  const pid_ = (url: string) => {
    const id = pageId(pid, url);
    pageTexts.set(id, url);
    return id;
  };
  const qid_ = (text: string) => {
    const id = queryId(pid, text);
    queryTexts.set(id, text);
    return id;
  };

  const fact = (r: SearchAnalyticsRow, ...ids: number[]) =>
    tuple(P, T, D, ...ids.map(sqlNum), sqlNum(Math.round(r.clicks)), sqlNum(Math.round(r.impressions)), sqlNum(pos(r)));

  const pageRows = pages.map((r) => fact(r, pid_(r.keys![0])));
  const queryRows = queries.map((r) => fact(r, qid_(r.keys![0])));
  const pairRows = pairs.map((r) => fact(r, qid_(r.keys![0]), pid_(r.keys![1])));
  const dimRows = [
    ...countries.map((r) => ['country', r]),
    ...devices.map((r) => ['device', r]),
    ...appearances.map((r) => ['searchAppearance', r]),
  ].map(([dim, r]) => {
    const row = r as SearchAnalyticsRow;
    return tuple(P, T, D, sqlStr(dim as string), sqlStr(row.keys![0]), sqlNum(Math.round(row.clicks)), sqlNum(Math.round(row.impressions)), sqlNum(pos(row)));
  });

  const sqls: string[] = [];
  sqls.push(
    ...buildInserts('INSERT OR IGNORE INTO pages (id, property_id, url) VALUES ', [...pageTexts].map(([id, url]) => tuple(sqlNum(id), P, sqlStr(url)))),
    ...buildInserts('INSERT OR IGNORE INTO queries (id, property_id, text) VALUES ', [...queryTexts].map(([id, text]) => tuple(sqlNum(id), P, sqlStr(text)))),
  );
  const where = `WHERE property_id = ${P} AND search_type = ${T} AND date = ${D}`;
  sqls.push(
    `DELETE FROM daily_totals ${where}`,
    `DELETE FROM page_daily ${where}`,
    `DELETE FROM query_daily ${where}`,
    `DELETE FROM query_page_daily ${where}`,
    `DELETE FROM dim_daily ${where}`,
    `INSERT INTO daily_totals (property_id, search_type, date, clicks, impressions, pos_sum, provisional) VALUES ${tuple(
      P,
      T,
      D,
      sqlNum(Math.round(t?.clicks ?? 0)),
      sqlNum(Math.round(t?.impressions ?? 0)),
      sqlNum(t ? pos(t) : 0),
      j.dataState === 'final' ? '0' : '1',
    )}`,
    ...buildInserts('INSERT INTO page_daily (property_id, search_type, date, page_id, clicks, impressions, pos_sum) VALUES ', pageRows),
    ...buildInserts('INSERT INTO query_daily (property_id, search_type, date, query_id, clicks, impressions, pos_sum) VALUES ', queryRows),
    ...buildInserts('INSERT INTO query_page_daily (property_id, search_type, date, query_id, page_id, clicks, impressions, pos_sum) VALUES ', pairRows),
    ...buildInserts('INSERT INTO dim_daily (property_id, search_type, date, dim, value, clicks, impressions, pos_sum) VALUES ', dimRows),
  );
  await execMany(env, sqls, 4, 300);
  await setJob(env, j, 'ok', pageRows.length + queryRows.length + pairRows.length, null);
}

export async function syncStatus(env: Env, propertyId?: number) {
  const filter = propertyId ? 'WHERE property_id = ?' : '';
  const stmt = env.DB.prepare(
    `SELECT property_id, search_type, data_state, status, COUNT(*) AS days, MIN(date) AS first_date, MAX(date) AS last_date, MAX(updated_at) AS last_update
     FROM sync_jobs ${filter} GROUP BY property_id, search_type, data_state, status ORDER BY property_id, search_type, data_state, status`,
  );
  const { results } = await (propertyId ? stmt.bind(propertyId) : stmt).all();
  const errors = await env.DB.prepare(
    `SELECT property_id, search_type, data_state, date, error, updated_at FROM sync_jobs WHERE status = 'error' ${propertyId ? 'AND property_id = ?' : ''} ORDER BY updated_at DESC LIMIT 20`,
  )
    .bind(...(propertyId ? [propertyId] : []))
    .all();
  return { summary: results, recent_errors: errors.results };
}

export type { DataState };
