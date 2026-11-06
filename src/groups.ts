import { HttpError, type Env, type Property } from './env';
import { bestPages } from './insights';
import { dateCond, metrics, NEVER, resolveRange, type ReportArgs } from './reports';
import { queryId, round } from './util';

export async function listGroups(env: Env, p: Property) {
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.name, COUNT(t.term) AS terms FROM keyword_groups g LEFT JOIN keyword_group_terms t ON t.group_id = g.id
     WHERE g.property_id = ? GROUP BY g.id ORDER BY g.name`,
  )
    .bind(p.id)
    .all();
  return { property: p.site_url, groups: results };
}

async function findGroup(env: Env, p: Property, ref: string) {
  const g = await env.DB.prepare('SELECT id, name FROM keyword_groups WHERE property_id = ? AND (name = ? OR CAST(id AS TEXT) = ?)')
    .bind(p.id, ref, ref)
    .first<{ id: number; name: string }>();
  if (!g) throw new HttpError(404, `No keyword group "${ref}"`);
  return g;
}

export async function saveGroup(env: Env, p: Property, name: string, terms: string[], match: 'exact' | 'contains' = 'exact', replace = false) {
  if (!name?.trim()) throw new HttpError(400, 'name is required');
  const clean = [...new Set((terms || []).map((t) => t.trim().toLowerCase()).filter(Boolean))];
  if (clean.length > 20000) throw new HttpError(400, 'Max 20,000 terms per call');
  await env.DB.prepare('INSERT OR IGNORE INTO keyword_groups (property_id, name) VALUES (?, ?)').bind(p.id, name.trim()).run();
  const g = await findGroup(env, p, name.trim());
  const stmts = [];
  if (replace) stmts.push(env.DB.prepare('DELETE FROM keyword_group_terms WHERE group_id = ?').bind(g.id));
  for (const t of clean) {
    stmts.push(
      env.DB.prepare('INSERT OR IGNORE INTO keyword_group_terms (group_id, term, match, query_id) VALUES (?, ?, ?, ?)').bind(
        g.id,
        t,
        match,
        match === 'exact' ? queryId(p.id, t) : null,
      ),
    );
  }
  for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));
  return { group: g.name, id: g.id, added: clean.length, replaced: replace };
}

export async function deleteGroup(env: Env, p: Property, ref: string) {
  const g = await findGroup(env, p, ref);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM keyword_group_terms WHERE group_id = ?').bind(g.id),
    env.DB.prepare('DELETE FROM keyword_groups WHERE id = ?').bind(g.id),
  ]);
  return { deleted: g.name };
}

/** Rank-tracker view: one row per term with current and previous position. */
export async function groupReport(env: Env, p: Property, ref: string, a: ReportArgs & { limit?: number }) {
  const g = await findGroup(env, p, ref);
  const r = await resolveRange(env, p, a);
  const cur = dateCond(r.from, r.to);
  const prv = dateCond(r.prevFrom || NEVER, r.prevTo || NEVER);
  const sums = `
    SUM(CASE WHEN ${cur} THEN x.clicks ELSE 0 END) AS c, SUM(CASE WHEN ${cur} THEN x.impressions ELSE 0 END) AS i,
    SUM(CASE WHEN ${cur} THEN x.pos_sum ELSE 0 END) AS ps, SUM(CASE WHEN ${prv} THEN x.clicks ELSE 0 END) AS pc,
    SUM(CASE WHEN ${prv} THEN x.impressions ELSE 0 END) AS pi, SUM(CASE WHEN ${prv} THEN x.pos_sum ELSE 0 END) AS pps`;
  const xjoin = `x.property_id = ?1 AND x.search_type = ?2 AND ((${cur}) OR (${prv}))`;
  const [exact, contains] = await Promise.all([
    env.DB.prepare(
      `SELECT t.term, t.match, t.query_id, ${sums} FROM keyword_group_terms t
       LEFT JOIN query_daily x ON x.query_id = t.query_id AND ${xjoin}
       WHERE t.group_id = ?3 AND t.match = 'exact' GROUP BY t.term`,
    )
      .bind(p.id, r.searchType, g.id)
      .all<Record<string, number | string>>(),
    env.DB.prepare(
      `SELECT t.term, t.match, NULL AS query_id, ${sums} FROM keyword_group_terms t
       JOIN queries q ON q.property_id = ?1 AND q.text LIKE '%' || t.term || '%'
       LEFT JOIN query_daily x ON x.query_id = q.id AND ${xjoin}
       WHERE t.group_id = ?3 AND t.match = 'contains' GROUP BY t.term`,
    )
      .bind(p.id, r.searchType, g.id)
      .all<Record<string, number | string>>(),
  ]);
  const all = [...exact.results, ...contains.results];
  const ids = all.filter((x) => x.query_id && Number(x.i) > 0).map((x) => Number(x.query_id));
  const best = await bestPages(env, p, r, ids.slice(0, 900));
  let tc = 0;
  let ti = 0;
  let tps = 0;
  const rows = all.map((x) => {
    const c = metrics(x.c as number, x.i as number, x.ps as number);
    const pr = metrics(x.pc as number, x.pi as number, x.pps as number);
    tc += c.clicks;
    ti += c.impressions;
    tps += Number(x.ps || 0);
    return {
      term: x.term,
      match: x.match,
      ...c,
      prev_position: pr.position,
      delta_position: c.position !== null && pr.position !== null ? round(c.position - pr.position, 1) : null,
      prev_clicks: pr.clicks,
      top_page: x.query_id ? best.get(Number(x.query_id)) ?? null : null,
    };
  });
  rows.sort((a1, b1) => b1.impressions - a1.impressions);
  const limit = Math.min(Math.max(Number(a.limit) || 1000, 1), 20000);
  const ranked = rows.filter((x) => x.position !== null);
  return {
    group: g.name,
    property: p.site_url,
    range: { from: r.from, to: r.to, compare_from: r.prevFrom, compare_to: r.prevTo },
    totals: {
      ...metrics(tc, ti, tps),
      terms: rows.length,
      ranking: ranked.length,
      top3: ranked.filter((x) => x.position! <= 3).length,
      top10: ranked.filter((x) => x.position! <= 10).length,
      improved: rows.filter((x) => (x.delta_position ?? 0) < 0).length,
      declined: rows.filter((x) => (x.delta_position ?? 0) > 0).length,
    },
    rows: rows.slice(0, limit),
  };
}
