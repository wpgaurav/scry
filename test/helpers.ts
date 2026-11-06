import { env } from 'cloudflare:test';
import { pageId, queryId, sha256Hex } from '../src/util';

export const PID = 1;
export const PAGE_A = 'https://example.com/a/';
export const PAGE_B = 'https://example.com/b/';

/** Two 7-day windows of synthetic data ending 2026-01-14. */
export async function seed() {
  const stmts = [
    `DELETE FROM properties`, `DELETE FROM pages`, `DELETE FROM queries`, `DELETE FROM daily_totals`, `DELETE FROM page_daily`,
    `DELETE FROM query_daily`, `DELETE FROM query_page_daily`, `DELETE FROM dim_daily`, `DELETE FROM api_keys`,
    `INSERT INTO properties (id, site_url, label, brand_terms) VALUES (${PID}, 'sc-domain:example.com', 'Example', '["example"]')`,
    `INSERT INTO pages VALUES (${pageId(PID, PAGE_A)}, ${PID}, '${PAGE_A}'), (${pageId(PID, PAGE_B)}, ${PID}, '${PAGE_B}')`,
    `INSERT INTO queries VALUES (${queryId(PID, 'alpha tool')}, ${PID}, 'alpha tool'), (${queryId(PID, 'example brand')}, ${PID}, 'example brand'), (${queryId(PID, 'beta guide')}, ${PID}, 'beta guide')`,
  ];
  for (let d = 1; d <= 14; d++) {
    const date = `2026-01-${String(d).padStart(2, '0')}`;
    const recent = d > 7;
    // alpha tool: page A, position 8, 100 impressions/day, clicks 2 (old) -> 4 (recent)
    // beta guide: page B, position 3, 50 impressions/day, clicks 10 (old) -> 5 (recent)
    // example brand: page A, position 1, 20 impressions/day, 10 clicks/day
    const a = { c: recent ? 4 : 2, i: 100, p: 8 };
    const b = { c: recent ? 5 : 10, i: 50, p: 3 };
    const e = { c: 10, i: 20, p: 1 };
    const qa = queryId(PID, 'alpha tool'), qb = queryId(PID, 'beta guide'), qe = queryId(PID, 'example brand');
    const pa = pageId(PID, PAGE_A), pb = pageId(PID, PAGE_B);
    stmts.push(
      `INSERT INTO daily_totals VALUES (${PID}, 'web', '${date}', ${a.c + b.c + e.c + 1}, ${a.i + b.i + e.i + 10}, ${a.p * a.i + b.p * b.i + e.p * e.i + 50}, 0)`,
      `INSERT INTO query_daily VALUES (${PID},'web','${date}',${qa},${a.c},${a.i},${a.p * a.i}), (${PID},'web','${date}',${qb},${b.c},${b.i},${b.p * b.i}), (${PID},'web','${date}',${qe},${e.c},${e.i},${e.p * e.i})`,
      `INSERT INTO page_daily VALUES (${PID},'web','${date}',${pa},${a.c + e.c},${a.i + e.i},${a.p * a.i + e.p * e.i}), (${PID},'web','${date}',${pb},${b.c},${b.i},${b.p * b.i})`,
      `INSERT INTO query_page_daily VALUES (${PID},'web','${date}',${qa},${pa},${a.c},${a.i},${a.p * a.i}), (${PID},'web','${date}',${qb},${pb},${b.c},${b.i},${b.p * b.i}), (${PID},'web','${date}',${qe},${pa},${e.c},${e.i},${e.p * e.i})`,
      `INSERT INTO dim_daily VALUES (${PID},'web','${date}','device','MOBILE',${a.c},${a.i},${a.p * a.i})`,
    );
  }
  await env.DB.batch(stmts.map((s) => env.DB.prepare(s)));
}

export async function makeKey(scope: 'read' | 'write') {
  const key = `gsk_test_${scope}_${Math.random().toString(36).slice(2)}`;
  await env.DB.prepare('INSERT INTO api_keys (name, prefix, hash, scope, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('test', key.slice(0, 10), await sha256Hex(key), scope, new Date().toISOString())
    .run();
  return key;
}
