import type { DataState, Env, Job, Property, SearchType } from './env';
import { buildInserts, execMany, listProperties, propertySearchTypes, tuple } from './db';
import { searchAnalyticsAll, type Dimension, type SearchAnalyticsRow } from './google';
import { addDays, dateRange, pageId, queryId, sqlNum, sqlStr, todayUtc } from './util';

/** GSC keeps 16 months. */
export const HISTORY_DAYS = 485;
/** Final data usually lands 2-3 days after the day ends. */
export const FINAL_LAG_DAYS = 3;
/** Days older than this many days are backfill: they can wait when the write budget is spent. */
const RECENT_DAYS = FINAL_LAG_DAYS + 7;
const MAX_ENQUEUE_PER_TYPE = 500;
const STALE_MS = 6 * 3600_000;

const NO_QUERY_TYPES: SearchType[] = ['discover', 'googleNews'];

const int = (v: string | undefined, fallback: number) => {
  const n = Number.parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : fallback;
};

/** Sync settings from Worker vars, with defaults that stay inside the Workers Paid D1 allowance. */
export function syncConfig(env: Env) {
  return {
    historyDays: Math.min(HISTORY_DAYS, Math.max(7, int(env.HISTORY_DAYS, HISTORY_DAYS))),
    provisionalRefreshHours: Math.min(168, Math.max(1, int(env.PROVISIONAL_REFRESH_HOURS, 24))),
    dailyWriteBudget: Math.max(0, int(env.DAILY_WRITE_BUDGET, 1_500_000)),
  };
}

export async function writesOn(env: Env, date = todayUtc()): Promise<number> {
  const row = await env.DB.prepare('SELECT rows_written FROM usage_daily WHERE date = ?').bind(date).first<{ rows_written: number }>();
  return row?.rows_written ?? 0;
}

async function recordWrites(env: Env, rows: number) {
  if (rows <= 0) return;
  await env.DB.prepare(
    'INSERT INTO usage_daily (date, rows_written) VALUES (?, ?) ON CONFLICT (date) DO UPDATE SET rows_written = rows_written + excluded.rows_written',
  )
    .bind(todayUtc(), rows)
    .run();
}

async function overBudget(env: Env) {
  const { dailyWriteBudget } = syncConfig(env);
  return dailyWriteBudget > 0 && (await writesOn(env)) >= dailyWriteBudget;
}

const isBackfill = (date: string) => date < addDays(todayUtc(), -RECENT_DAYS);

interface JobRow {
  date: string;
  data_state: string;
  status: string;
  updated_at: string;
}

/** Enqueue every missing or stale day for a property. Covers backfill, gaps and provisional refresh. */
export async function planSync(env: Env, p: Property): Promise<number> {
  const cfg = syncConfig(env);
  const today = todayUtc();
  const lastFinal = addDays(today, -FINAL_LAG_DAYS);
  const first = addDays(today, -cfg.historyDays);
  const now = Date.now();
  const paused = await overBudget(env);
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
      // Out of write budget for today: keep recent days fresh, leave the backfill for tomorrow.
      if (paused && isBackfill(date)) break;
      if (due(final.get(date), -1)) jobs.push({ kind: 'sync', propertyId: p.id, date, searchType: type, dataState: 'final' });
    }
    // Provisional ("all") data for recent days that have no final data yet.
    for (const date of dateRange(addDays(today, -6), addDays(today, -1))) {
      if (final.get(date)?.status === 'ok') continue;
      if (due(prov.get(date), cfg.provisionalRefreshHours * 3600_000)) jobs.push({ kind: 'sync', propertyId: p.id, date, searchType: type, dataState: 'all' });
    }
    if (!jobs.length) continue;

    const stamp = new Date().toISOString();
    const sqls = buildInserts(
      'INSERT INTO sync_jobs (property_id, date, search_type, data_state, status, rows, error, updated_at) VALUES ',
      jobs.map((j) => j.kind === 'sync' ? tuple(sqlNum(p.id), sqlStr(j.date), sqlStr(type), sqlStr(j.dataState), "'queued'", '0', 'NULL', sqlStr(stamp)) : ''),
    ).map((s) => s + ' ON CONFLICT (property_id, search_type, data_state, date) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, error = NULL');
    await recordWrites(env, await execMany(env, sqls));
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

type Key = (string | number)[];
interface FactRow {
  key: Key;
  vals: number[];
}
interface FactTable {
  name: string;
  keys: string[];
  vals: string[];
  rows: FactRow[];
}

const literal = (v: string | number) => (typeof v === 'number' ? sqlNum(v) : sqlStr(v));

/**
 * Diffs one day of fetched rows against what D1 already holds and returns SQL that writes
 * only the difference: new or changed rows are upserted, rows Google no longer returns are
 * deleted, unchanged rows are left alone. D1 bills every written row and index entry, so a
 * re-fetched day that barely moved costs a handful of writes instead of a full rewrite.
 */
async function diffDay(env: Env, t: FactTable, P: string, T: string, D: string, pid: number, type: string, date: string) {
  const cols = [...t.keys, ...t.vals];
  const existing = await env.DB.prepare(`SELECT ${cols.join(', ')} FROM ${t.name} WHERE property_id = ? AND search_type = ? AND date = ?`)
    .bind(pid, type, date)
    .raw<(string | number)[]>();
  const old = new Map<string, string>();
  for (const r of existing) old.set(JSON.stringify(r.slice(0, t.keys.length)), r.slice(t.keys.length).join('|'));

  const changed: FactRow[] = [];
  for (const row of t.rows) {
    const k = JSON.stringify(row.key);
    const prev = old.get(k);
    old.delete(k);
    if (prev !== row.vals.join('|')) changed.push(row);
  }
  const gone = [...old.keys()].map((k) => JSON.parse(k) as Key);

  const where = `property_id = ${P} AND search_type = ${T} AND date = ${D}`;
  const sqls: string[] = [];
  if (gone.length) {
    if (!t.keys.length) sqls.push(`DELETE FROM ${t.name} WHERE ${where}`);
    else
      sqls.push(
        ...buildInserts(`DELETE FROM ${t.name} WHERE ${where} AND (${t.keys.join(', ')}) IN (VALUES `, gone.map((k) => tuple(...k.map(literal)))).map((s) => s + ')'),
      );
  }
  if (changed.length) {
    const pk = ['property_id', 'search_type', 'date', ...t.keys].join(', ');
    const set = t.vals.map((v) => `${v} = excluded.${v}`).join(', ');
    sqls.push(
      ...buildInserts(
        `INSERT INTO ${t.name} (property_id, search_type, date, ${cols.join(', ')}) VALUES `,
        changed.map((r) => tuple(P, T, D, ...r.key.map(literal), ...r.vals.map(sqlNum))),
      ).map((s) => s + ` ON CONFLICT (${pk}) DO UPDATE SET ${set}`),
    );
  }
  return { sqls, changed };
}

/** Fetch one day for one search type and bring its stored rows in line, writing only what changed. */
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

  if (isBackfill(j.date) && (await overBudget(env))) {
    return setJob(env, j, 'deferred', 0, 'Daily write budget reached. The backfill resumes after 00:00 UTC.');
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

  const vals = (r: SearchAnalyticsRow) => [Math.round(r.clicks), Math.round(r.impressions), pos(r)];
  const facts = ['clicks', 'impressions', 'pos_sum'];
  const tables: FactTable[] = [
    {
      name: 'daily_totals',
      keys: [],
      vals: [...facts, 'provisional'],
      rows: [{ key: [], vals: [...(t ? vals(t) : [0, 0, 0]), j.dataState === 'final' ? 0 : 1] }],
    },
    { name: 'page_daily', keys: ['page_id'], vals: facts, rows: pages.map((r) => ({ key: [pid_(r.keys![0])], vals: vals(r) })) },
    { name: 'query_daily', keys: ['query_id'], vals: facts, rows: queries.map((r) => ({ key: [qid_(r.keys![0])], vals: vals(r) })) },
    {
      name: 'query_page_daily',
      keys: ['query_id', 'page_id'],
      vals: facts,
      rows: pairs.map((r) => ({ key: [qid_(r.keys![0]), pid_(r.keys![1])], vals: vals(r) })),
    },
    {
      name: 'dim_daily',
      keys: ['dim', 'value'],
      vals: facts,
      rows: [
        ...countries.map((r) => ({ key: ['country', r.keys![0]], vals: vals(r) })),
        ...devices.map((r) => ({ key: ['device', r.keys![0]], vals: vals(r) })),
        ...appearances.map((r) => ({ key: ['searchAppearance', r.keys![0]], vals: vals(r) })),
      ],
    },
  ];

  const writes: string[] = [];
  const newPages = new Set<number>();
  const newQueries = new Set<number>();
  for (const table of tables) {
    const { sqls, changed } = await diffDay(env, table, P, T, D, pid, j.searchType, j.date);
    writes.push(...sqls);
    // Only rows being written can introduce a page or query id that isn't stored yet.
    for (const r of changed) {
      if (table.keys.includes('page_id')) newPages.add(r.key[table.keys.indexOf('page_id')] as number);
      if (table.keys.includes('query_id')) newQueries.add(r.key[table.keys.indexOf('query_id')] as number);
    }
  }

  const sqls = [
    ...buildInserts('INSERT OR IGNORE INTO pages (id, property_id, url) VALUES ', [...newPages].map((id) => tuple(sqlNum(id), P, sqlStr(pageTexts.get(id)!)))),
    ...buildInserts('INSERT OR IGNORE INTO queries (id, property_id, text) VALUES ', [...newQueries].map((id) => tuple(sqlNum(id), P, sqlStr(queryTexts.get(id)!)))),
    ...writes,
  ];
  if (sqls.length) await recordWrites(env, await execMany(env, sqls, 4, 300));
  await setJob(env, j, 'ok', tables[1].rows.length + tables[2].rows.length + tables[3].rows.length, null);
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
  const cfg = syncConfig(env);
  const month = await env.DB.prepare('SELECT COALESCE(SUM(rows_written), 0) AS n FROM usage_daily WHERE date > ?')
    .bind(addDays(todayUtc(), -30))
    .first<{ n: number }>();
  return {
    summary: results,
    recent_errors: errors.results,
    writes: {
      today: await writesOn(env),
      last_30_days: month?.n ?? 0,
      daily_budget: cfg.dailyWriteBudget || null,
      history_days: cfg.historyDays,
      provisional_refresh_hours: cfg.provisionalRefreshHours,
    },
  };
}

export type { DataState };
