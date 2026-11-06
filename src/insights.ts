import { HttpError, type Env, type Property } from './env';
import { dateCond, metrics, NEVER, resolveRange, type Range, type ReportArgs } from './reports';
import { addDays, round, sqlNum } from './util';

export const INSIGHTS = {
  striking_distance: 'Queries at average position 4-20 with real impressions. Ranked by estimated extra clicks at position 3.',
  ctr_gaps: 'Queries in the top 10 whose CTR is under half the CTR this site normally gets at that position. Title/snippet candidates.',
  page_decliners: 'Pages that lost the most clicks vs the comparison period.',
  page_gainers: 'Pages that gained the most clicks vs the comparison period.',
  query_decliners: 'Queries that lost the most clicks vs the comparison period.',
  query_gainers: 'Queries that gained the most clicks vs the comparison period.',
  new_queries: 'Queries with impressions now and none in the comparison period.',
  lost_queries: 'Queries that had impressions in the comparison period and none now.',
  cannibalization: 'Queries where 2+ pages each take at least 10% of impressions.',
  content_decay: 'Pages whose clicks fell in each of the last four 28-day blocks, losing 20%+ overall.',
  zero_clicks: 'Pages with many impressions and no clicks.',
} as const;

export type InsightKind = keyof typeof INSIGHTS;

export interface InsightArgs extends ReportArgs {
  limit?: number;
  min_impressions?: number;
  min_clicks?: number;
}

const lim = (n: unknown, d = 50) => Math.min(Math.max(Number(n) || d, 1), 1000);

function base(p: Property, r: Range, alias = 'x') {
  return `${alias}.property_id = ${sqlNum(p.id)} AND ${alias}.search_type = '${r.searchType}'`;
}

/** Site's own CTR by rounded position (1-20), from query-level data in the range. */
async function ctrCurve(env: Env, p: Property, r: Range): Promise<Map<number, number>> {
  const { results } = await env.DB.prepare(
    `SELECT b, SUM(c) AS c, SUM(i) AS i FROM (
       SELECT MIN(20, MAX(1, CAST(ROUND(SUM(x.pos_sum) / SUM(x.impressions)) AS INTEGER))) AS b, SUM(x.clicks) AS c, SUM(x.impressions) AS i
       FROM query_daily x WHERE ${base(p, r)} AND ${dateCond(r.from, r.to)}
       GROUP BY x.query_id HAVING SUM(x.impressions) > 0
     ) GROUP BY b`,
  ).all<{ b: number; c: number; i: number }>();
  const m = new Map<number, number>();
  for (const x of results) if (x.i >= 100) m.set(x.b, x.c / x.i);
  // Fill gaps so lookups never fail: carry the nearest better position's rate downward.
  let last = 0.3;
  for (let b = 1; b <= 20; b++) {
    if (m.has(b)) last = m.get(b)!;
    else m.set(b, last);
  }
  return m;
}

async function compareAgg(
  env: Env,
  p: Property,
  r: Range,
  kind: 'page' | 'query',
  having: string,
  order: string,
  limit: number,
) {
  const idCol = kind === 'page' ? 'page_id' : 'query_id';
  const src = kind === 'page' ? 'page_daily' : 'query_daily';
  const label = kind === 'page' ? 'JOIN pages L ON L.id = t.id' : 'JOIN queries L ON L.id = t.id';
  const labelCol = kind === 'page' ? 'L.url' : 'L.text';
  const cur = dateCond(r.from, r.to);
  const prv = dateCond(r.prevFrom || NEVER, r.prevTo || NEVER);
  const { results } = await env.DB.prepare(
    `SELECT ${labelCol} AS label, t.* FROM (SELECT * FROM (
       SELECT x.${idCol} AS id,
         SUM(CASE WHEN ${cur} THEN x.clicks ELSE 0 END) AS clicks,
         SUM(CASE WHEN ${cur} THEN x.impressions ELSE 0 END) AS impressions,
         SUM(CASE WHEN ${cur} THEN x.pos_sum ELSE 0 END) AS pos_sum,
         SUM(CASE WHEN ${prv} THEN x.clicks ELSE 0 END) AS p_clicks,
         SUM(CASE WHEN ${prv} THEN x.impressions ELSE 0 END) AS p_impressions,
         SUM(CASE WHEN ${prv} THEN x.pos_sum ELSE 0 END) AS p_pos_sum
       FROM ${src} x WHERE ${base(p, r)} AND ((${cur}) OR (${prv}))
       GROUP BY x.${idCol}
     ) WHERE ${having} ORDER BY ${order} LIMIT ${limit}) t ${label}`,
  ).all<Record<string, number | string>>();
  return results.map((x) => {
    const c = metrics(x.clicks as number, x.impressions as number, x.pos_sum as number);
    const pr = metrics(x.p_clicks as number, x.p_impressions as number, x.p_pos_sum as number);
    return {
      [kind]: x.label,
      ...c,
      prev_clicks: pr.clicks,
      prev_impressions: pr.impressions,
      prev_position: pr.position,
      delta_clicks: c.clicks - pr.clicks,
      delta_position: c.position !== null && pr.position !== null ? round(c.position - pr.position, 1) : null,
    };
  });
}

export async function bestPages(env: Env, p: Property, r: Range, queryIds: number[]) {
  if (!queryIds.length) return new Map<number, string>();
  const { results } = await env.DB.prepare(
    `SELECT t.query_id AS q, pg.url AS url FROM (
       SELECT x.query_id, x.page_id, ROW_NUMBER() OVER (PARTITION BY x.query_id ORDER BY SUM(x.impressions) DESC) AS rn
       FROM query_page_daily x WHERE ${base(p, r)} AND ${dateCond(r.from, r.to)} AND x.query_id IN (${queryIds.map(sqlNum).join(',')})
       GROUP BY x.query_id, x.page_id
     ) t JOIN pages pg ON pg.id = t.page_id WHERE t.rn = 1`,
  ).all<{ q: number; url: string }>();
  return new Map(results.map((x) => [x.q, x.url]));
}

export async function insight(env: Env, p: Property, kind: InsightKind, a: InsightArgs) {
  if (!(kind in INSIGHTS)) throw new HttpError(400, `kind must be one of ${Object.keys(INSIGHTS).join(', ')}`);
  const r = await resolveRange(env, p, { ...a, compare: a.compare && a.compare !== 'none' ? a.compare : 'previous' });
  const limit = lim(a.limit);
  const minImpr = Number(a.min_impressions) || 0;
  const minClicks = Number(a.min_clicks) || 0;
  const meta = { kind, description: INSIGHTS[kind], property: p.site_url, range: { from: r.from, to: r.to, compare_from: r.prevFrom, compare_to: r.prevTo, search_type: r.searchType } };

  switch (kind) {
    case 'striking_distance':
    case 'ctr_gaps': {
      const curve = await ctrCurve(env, p, r);
      const striking = kind === 'striking_distance';
      const floor = minImpr || (striking ? 100 : 200);
      const { results } = await env.DB.prepare(
        `SELECT x.query_id AS id, L.text AS label, SUM(x.clicks) AS c, SUM(x.impressions) AS i, SUM(x.pos_sum) AS ps
         FROM query_daily x JOIN queries L ON L.id = x.query_id
         WHERE ${base(p, r)} AND ${dateCond(r.from, r.to)}
         GROUP BY x.query_id
         HAVING i >= ${floor} AND ps / i ${striking ? 'BETWEEN 4 AND 20' : '<= 10'}
         ORDER BY i DESC LIMIT 2000`,
      ).all<{ id: number; label: string; c: number; i: number; ps: number }>();
      let rows = results.map((x) => {
        const m = metrics(x.c, x.i, x.ps);
        const bucket = Math.min(20, Math.max(1, Math.round(m.position!)));
        const expected = curve.get(bucket)!;
        const target = striking ? curve.get(3)! : expected;
        const actual = x.c / x.i;
        return {
          id: x.id,
          query: x.label,
          ...m,
          expected_ctr: round(expected * 100, 2),
          est_extra_clicks: Math.max(0, Math.round(x.i * (target - actual))),
          ratio: expected ? actual / expected : 1,
        };
      });
      if (!striking) rows = rows.filter((x) => x.ratio < 0.5);
      rows.sort((a1, b1) => b1.est_extra_clicks - a1.est_extra_clicks);
      rows = rows.slice(0, limit);
      const best = await bestPages(env, p, r, rows.map((x) => x.id));
      return { ...meta, rows: rows.map(({ id, ratio, ...rest }) => ({ ...rest, top_page: best.get(id) ?? null })) };
    }
    case 'page_decliners':
    case 'query_decliners': {
      const k = kind === 'page_decliners' ? 'page' : 'query';
      const rows = await compareAgg(env, p, r, k, `p_clicks >= ${minClicks || 10} AND clicks < p_clicks`, 'clicks - p_clicks ASC', limit);
      return { ...meta, rows };
    }
    case 'page_gainers':
    case 'query_gainers': {
      const k = kind === 'page_gainers' ? 'page' : 'query';
      const rows = await compareAgg(env, p, r, k, `clicks >= ${minClicks || 10} AND clicks > p_clicks`, 'clicks - p_clicks DESC', limit);
      return { ...meta, rows };
    }
    case 'new_queries': {
      const rows = await compareAgg(env, p, r, 'query', `p_impressions = 0 AND impressions >= ${minImpr || 20}`, 'impressions DESC', limit);
      return { ...meta, rows };
    }
    case 'lost_queries': {
      const rows = await compareAgg(env, p, r, 'query', `impressions = 0 AND p_impressions >= ${minImpr || 50}`, 'p_impressions DESC', limit);
      return { ...meta, rows };
    }
    case 'zero_clicks': {
      const rows = await compareAgg(env, p, r, 'page', `clicks = 0 AND impressions >= ${minImpr || 500}`, 'impressions DESC', limit);
      return { ...meta, rows };
    }
    case 'cannibalization': {
      const floor = minImpr || 200;
      const { results } = await env.DB.prepare(
        `WITH qp AS (
           SELECT x.query_id, x.page_id, SUM(x.impressions) AS i, SUM(x.clicks) AS c, SUM(x.pos_sum) AS ps
           FROM query_page_daily x WHERE ${base(p, r)} AND ${dateCond(r.from, r.to)}
           GROUP BY x.query_id, x.page_id
         ),
         qt AS (SELECT query_id, SUM(i) AS ti, SUM(c) AS tc FROM qp GROUP BY query_id HAVING ti >= ${floor}),
         comp AS (SELECT qp.*, qt.ti, qt.tc FROM qp JOIN qt USING (query_id) WHERE qp.i * 1.0 / qt.ti >= 0.1),
         top AS (SELECT query_id, MAX(ti) AS ti FROM comp GROUP BY query_id HAVING COUNT(*) >= 2 ORDER BY ti DESC LIMIT ${limit})
         SELECT q.text AS query, pg.url AS page, comp.i, comp.c, comp.ps, comp.ti, comp.tc
         FROM comp JOIN top USING (query_id) JOIN queries q ON q.id = comp.query_id JOIN pages pg ON pg.id = comp.page_id
         ORDER BY comp.ti DESC, comp.i DESC`,
      ).all<{ query: string; page: string; i: number; c: number; ps: number; ti: number; tc: number }>();
      const groups = new Map<string, { query: string; impressions: number; clicks: number; pages: unknown[] }>();
      for (const x of results) {
        if (!groups.has(x.query)) groups.set(x.query, { query: x.query, impressions: x.ti, clicks: x.tc, pages: [] });
        groups.get(x.query)!.pages.push({ page: x.page, ...metrics(x.c, x.i, x.ps), impression_share: round((x.i / x.ti) * 100, 1) });
      }
      return { ...meta, rows: [...groups.values()] };
    }
    case 'content_decay': {
      const t = r.to;
      const b = (k: number) => dateCond(addDays(t, -(28 * k + 27)), addDays(t, -28 * k));
      const { results } = await env.DB.prepare(
        `SELECT pg.url AS page, t.* FROM (
           SELECT x.page_id,
             SUM(CASE WHEN ${b(0)} THEN x.clicks ELSE 0 END) AS b1,
             SUM(CASE WHEN ${b(1)} THEN x.clicks ELSE 0 END) AS b2,
             SUM(CASE WHEN ${b(2)} THEN x.clicks ELSE 0 END) AS b3,
             SUM(CASE WHEN ${b(3)} THEN x.clicks ELSE 0 END) AS b4
           FROM page_daily x WHERE ${base(p, r)} AND ${dateCond(addDays(t, -111), t)}
           GROUP BY x.page_id
           HAVING b4 >= ${minClicks || 50} AND b1 < b2 AND b2 < b3 AND b3 < b4 AND b1 <= b4 * 0.8
           ORDER BY (b4 - b1) DESC LIMIT ${limit}
         ) t JOIN pages pg ON pg.id = t.page_id`,
      ).all<{ page: string; b1: number; b2: number; b3: number; b4: number }>();
      return {
        ...meta,
        rows: results.map((x) => ({
          page: x.page,
          clicks_last_28d: x.b1,
          clicks_28_56d_ago: x.b2,
          clicks_56_84d_ago: x.b3,
          clicks_84_112d_ago: x.b4,
          change_pct: round(((x.b1 - x.b4) / x.b4) * 100, 1),
        })),
      };
    }
  }
}
