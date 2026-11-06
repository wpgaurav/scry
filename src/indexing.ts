import { HttpError, type Env, type Job, type Property } from './env';
import { listProperties } from './db';
import { inspectUrl, listSitemaps, submitSitemap } from './google';
import { addDays, pageId, todayUtc } from './util';

/** Google allows 2,000 inspections per property per day. Keep headroom for manual checks. */
const DAILY_HARD_CAP = 1900;
const BATCH = 20;

async function quotaUsed(env: Env, propertyId: number): Promise<number> {
  return Number((await env.KV.get(`iq:${propertyId}:${todayUtc()}`)) || 0);
}

async function bumpQuota(env: Env, propertyId: number, n: number) {
  const key = `iq:${propertyId}:${todayUtc()}`;
  const used = Number((await env.KV.get(key)) || 0) + n;
  await env.KV.put(key, String(used), { expirationTtl: 2 * 86400 });
  return used;
}

export async function inspectAndStore(env: Env, p: Property, url: string) {
  if ((await quotaUsed(env, p.id)) >= DAILY_HARD_CAP) throw new HttpError(429, 'Daily URL Inspection quota reached for this property');
  const r = await inspectUrl(env, p.site_url, url);
  await bumpQuota(env, p.id, 1);
  const s = r.indexStatusResult || {};
  const id = pageId(p.id, url);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO pages (id, property_id, url) VALUES (?, ?, ?)').bind(id, p.id, url),
    env.DB.prepare(
      `INSERT INTO url_inspections (property_id, page_id, url, checked_at, verdict, coverage_state, indexing_state, page_fetch_state,
         robots_state, last_crawl_time, crawled_as, google_canonical, user_canonical, rich_results, inspection_link)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (property_id, page_id) DO UPDATE SET
         prev_verdict = CASE WHEN url_inspections.coverage_state IS NOT excluded.coverage_state THEN url_inspections.verdict ELSE url_inspections.prev_verdict END,
         prev_coverage_state = CASE WHEN url_inspections.coverage_state IS NOT excluded.coverage_state THEN url_inspections.coverage_state ELSE url_inspections.prev_coverage_state END,
         changed_at = CASE WHEN url_inspections.coverage_state IS NOT excluded.coverage_state THEN excluded.checked_at ELSE url_inspections.changed_at END,
         checked_at = excluded.checked_at, verdict = excluded.verdict, coverage_state = excluded.coverage_state,
         indexing_state = excluded.indexing_state, page_fetch_state = excluded.page_fetch_state, robots_state = excluded.robots_state,
         last_crawl_time = excluded.last_crawl_time, crawled_as = excluded.crawled_as, google_canonical = excluded.google_canonical,
         user_canonical = excluded.user_canonical, rich_results = excluded.rich_results, inspection_link = excluded.inspection_link`,
    ).bind(
      p.id,
      id,
      url,
      now,
      s.verdict ?? null,
      s.coverageState ?? null,
      s.indexingState ?? null,
      s.pageFetchState ?? null,
      s.robotsTxtState ?? null,
      s.lastCrawlTime ?? null,
      s.crawledAs ?? null,
      s.googleCanonical ?? null,
      s.userCanonical ?? null,
      r.richResultsResult ? JSON.stringify(r.richResultsResult) : null,
      r.inspectionResultLink ?? null,
    ),
  ]);
  return getInspection(env, p.id, url);
}

export async function getInspection(env: Env, propertyId: number, url: string) {
  return env.DB.prepare('SELECT * FROM url_inspections WHERE property_id = ? AND page_id = ?')
    .bind(propertyId, pageId(propertyId, url))
    .first();
}

/** Daily: queue the most valuable pages that haven't been inspected in 7 days. */
export async function planInspections(env: Env) {
  let queued = 0;
  for (const p of await listProperties(env, true)) {
    const budget = Math.min(p.inspection_budget, DAILY_HARD_CAP - (await quotaUsed(env, p.id)));
    if (budget <= 0) continue;
    const since = addDays(todayUtc(), -31);
    const stale = new Date(Date.now() - 7 * 86400_000).toISOString();
    const { results } = await env.DB.prepare(
      `SELECT pg.url, SUM(d.clicks) AS clicks
       FROM page_daily d JOIN pages pg ON pg.id = d.page_id
       LEFT JOIN url_inspections ui ON ui.property_id = d.property_id AND ui.page_id = d.page_id
       WHERE d.property_id = ? AND d.search_type = 'web' AND d.date >= ? AND (ui.checked_at IS NULL OR ui.checked_at < ?)
       GROUP BY d.page_id ORDER BY clicks DESC, SUM(d.impressions) DESC LIMIT ?`,
    )
      .bind(p.id, since, stale, budget)
      .all<{ url: string }>();
    const urls = results.map((r) => r.url);
    const msgs: { body: Job }[] = [];
    for (let i = 0; i < urls.length; i += BATCH) msgs.push({ body: { kind: 'inspect', propertyId: p.id, urls: urls.slice(i, i + BATCH) } });
    for (let i = 0; i < msgs.length; i += 100) await env.JOBS.sendBatch(msgs.slice(i, i + 100));
    await env.JOBS.send({ kind: 'sitemaps', propertyId: p.id });
    queued += urls.length;
  }
  return queued;
}

export async function runInspectJob(env: Env, j: Extract<Job, { kind: 'inspect' }>) {
  const p = await env.DB.prepare('SELECT * FROM properties WHERE id = ?').bind(j.propertyId).first<Property>();
  if (!p) return;
  for (const url of j.urls) {
    try {
      await inspectAndStore(env, p, url);
    } catch (e) {
      if (e instanceof HttpError && e.status === 429) return;
      console.warn('inspect failed', url, (e as Error).message);
    }
  }
}

export async function refreshSitemaps(env: Env, p: Property) {
  const maps = await listSitemaps(env, p.site_url);
  const now = new Date().toISOString();
  const stmts = [env.DB.prepare('DELETE FROM sitemaps WHERE property_id = ?').bind(p.id)];
  for (const m of maps) {
    const submitted = (m.contents || []).reduce((a, c) => a + Number(c.submitted || 0), 0);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO sitemaps (property_id, path, type, is_index, is_pending, last_submitted, last_downloaded, warnings, errors, submitted, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        p.id,
        m.path,
        m.type ?? null,
        m.isSitemapsIndex ? 1 : 0,
        m.isPending ? 1 : 0,
        m.lastSubmitted ?? null,
        m.lastDownloaded ?? null,
        Number(m.warnings || 0),
        Number(m.errors || 0),
        submitted,
        now,
      ),
    );
  }
  await env.DB.batch(stmts);
  return maps.length;
}

export async function submitAndRefresh(env: Env, p: Property, sitemapUrl: string) {
  await submitSitemap(env, p.site_url, sitemapUrl);
  await refreshSitemaps(env, p);
}

export async function indexingReport(env: Env, propertyId: number, limit = 200) {
  const states = await env.DB.prepare(
    `SELECT COALESCE(coverage_state, 'Unknown') AS coverage_state, verdict, COUNT(*) AS pages
     FROM url_inspections WHERE property_id = ? GROUP BY coverage_state, verdict ORDER BY pages DESC`,
  )
    .bind(propertyId)
    .all();
  const since = addDays(todayUtc(), -31);
  const problems = await env.DB.prepare(
    `SELECT ui.url, ui.verdict, ui.coverage_state, ui.indexing_state, ui.page_fetch_state, ui.robots_state,
            ui.last_crawl_time, ui.google_canonical, ui.user_canonical, ui.checked_at, ui.changed_at,
            ui.prev_coverage_state, ui.inspection_link,
            (SELECT SUM(clicks) FROM page_daily d WHERE d.property_id = ui.property_id AND d.page_id = ui.page_id AND d.date >= ?) AS clicks_30d
     FROM url_inspections ui
     WHERE ui.property_id = ? AND (ui.verdict IS NOT 'PASS'
        OR (ui.google_canonical IS NOT NULL AND ui.user_canonical IS NOT NULL AND ui.google_canonical <> ui.user_canonical))
     ORDER BY clicks_30d DESC NULLS LAST LIMIT ?`,
  )
    .bind(since, propertyId, limit)
    .all();
  const changes = await env.DB.prepare(
    `SELECT url, prev_coverage_state, coverage_state, changed_at FROM url_inspections
     WHERE property_id = ? AND changed_at IS NOT NULL AND prev_coverage_state IS NOT NULL ORDER BY changed_at DESC LIMIT 50`,
  )
    .bind(propertyId)
    .all();
  const totals = await env.DB.prepare(
    'SELECT COUNT(*) AS inspected, SUM(verdict = \'PASS\') AS passing, MAX(checked_at) AS last_checked FROM url_inspections WHERE property_id = ?',
  )
    .bind(propertyId)
    .first();
  const sitemaps = await env.DB.prepare('SELECT * FROM sitemaps WHERE property_id = ? ORDER BY path').bind(propertyId).all();
  return {
    totals,
    quota_used_today: await quotaUsed(env, propertyId),
    by_state: states.results,
    problems: problems.results,
    recent_changes: changes.results,
    sitemaps: sitemaps.results,
  };
}
