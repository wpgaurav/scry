#!/usr/bin/env node
// Seeds the LOCAL D1 database with a synthetic demo property for development and screenshots.
// No real Search Console data is involved.  node scripts/seed-demo.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

function hashId(text, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
const PID = 1;
const pageId = (u) => hashId(u, PID * 2 + 1);
const queryId = (t) => hashId(t, PID * 2 + 2);
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

const topics = ['wordpress hosting', 'seo plugin', 'page speed', 'email marketing', 'contact form', 'backup plugin', 'cdn setup', 'core web vitals', 'schema markup', 'affiliate links'];
const mods = ['best', 'free', 'how to', 'vs', 'review', 'alternatives', 'guide', 'tutorial', 'pricing', '2026'];
const pages = topics.map((t) => `https://example.com/${t.replace(/ /g, '-')}/`).concat(['https://example.com/', 'https://example.com/about/']);
const queries = [];
topics.forEach((t, ti) => mods.forEach((m) => queries.push({ text: `${m} ${t}`, page: pages[ti], base: 5 + rand() * 120, pos: 1 + rand() * 25 })));
queries.push({ text: 'example', page: pages[10], base: 300, pos: 1.1 }, { text: 'example blog', page: pages[10], base: 80, pos: 1.4 });
// A cannibalized query: two pages share it.
queries.push({ text: 'best wordpress seo plugin hosting', page: pages[1], base: 90, pos: 8, alt: pages[0] });

const days = 120;
const today = new Date();
const dates = [];
for (let i = days + 2; i >= 3; i--) dates.push(new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10));

const out = [
  'DELETE FROM properties; DELETE FROM pages; DELETE FROM queries; DELETE FROM daily_totals; DELETE FROM page_daily; DELETE FROM query_daily; DELETE FROM query_page_daily; DELETE FROM dim_daily; DELETE FROM sync_jobs; DELETE FROM url_inspections; DELETE FROM keyword_groups; DELETE FROM keyword_group_terms;',
  `INSERT INTO properties (id, site_url, label, brand_terms) VALUES (${PID}, 'sc-domain:example.com', 'Example (demo)', '["example"]');`,
];
for (const p of pages) out.push(`INSERT INTO pages (id, property_id, url) VALUES (${pageId(p)}, ${PID}, ${q(p)});`);
for (const x of queries) out.push(`INSERT INTO queries (id, property_id, text) VALUES (${queryId(x.text)}, ${PID}, ${q(x.text)});`);

dates.forEach((date, di) => {
  const trend = 0.7 + (di / dates.length) * 0.6;
  const weekday = [0.75, 1, 1.05, 1.05, 1, 0.95, 0.8][new Date(date).getUTCDay()];
  const pageAgg = new Map();
  let tc = 0, ti = 0, tps = 0;
  const qrows = [], qprows = [];
  for (const x of queries) {
    const decay = x.page === pages[3] ? Math.max(0.2, 1 - di / dates.length) : 1;
    const impr = Math.max(0, Math.round(x.base * trend * weekday * decay * (0.6 + rand() * 0.8)));
    if (!impr) continue;
    const pos = Math.max(1, x.pos + (rand() - 0.5) * 2);
    const ctr = Math.max(0.002, 0.32 / Math.pow(pos, 1.1));
    const clicks = Math.round(impr * ctr * (0.7 + rand() * 0.6));
    qrows.push(`(${PID},'web','${date}',${queryId(x.text)},${clicks},${impr},${(pos * impr).toFixed(2)})`);
    const split = x.alt ? [[x.page, 0.55], [x.alt, 0.45]] : [[x.page, 1]];
    for (const [pg, share] of split) {
      const i2 = Math.round(impr * share), c2 = Math.round(clicks * share);
      qprows.push(`(${PID},'web','${date}',${queryId(x.text)},${pageId(pg)},${c2},${i2},${(pos * i2).toFixed(2)})`);
      const a = pageAgg.get(pg) || [0, 0, 0];
      pageAgg.set(pg, [a[0] + c2, a[1] + i2, a[2] + pos * i2]);
    }
    tc += clicks; ti += impr; tps += pos * impr;
  }
  // Anonymized queries make property totals larger than the sum of rows.
  const anon = 1.12;
  out.push(`INSERT INTO daily_totals VALUES (${PID},'web','${date}',${Math.round(tc * anon)},${Math.round(ti * anon)},${(tps * anon).toFixed(2)},0);`);
  if (qrows.length) out.push(`INSERT INTO query_daily VALUES ${qrows.join(',')};`);
  if (qprows.length) out.push(`INSERT INTO query_page_daily VALUES ${qprows.join(',')};`);
  const prows = [...pageAgg].map(([pg, [c, i, ps]]) => `(${PID},'web','${date}',${pageId(pg)},${c},${i},${ps.toFixed(2)})`);
  if (prows.length) out.push(`INSERT INTO page_daily VALUES ${prows.join(',')};`);
  const dims = [['device', 'MOBILE', 0.62], ['device', 'DESKTOP', 0.35], ['device', 'TABLET', 0.03], ['country', 'usa', 0.4], ['country', 'ind', 0.3], ['country', 'gbr', 0.1], ['country', 'deu', 0.05]];
  out.push(`INSERT INTO dim_daily VALUES ${dims.map(([d, v, s]) => `(${PID},'web','${date}','${d}','${v}',${Math.round(tc * s)},${Math.round(ti * s)},${(tps * s).toFixed(2)})`).join(',')};`);
  out.push(`INSERT INTO sync_jobs VALUES (${PID},'${date}','web','final','ok',${qrows.length},NULL,'${new Date().toISOString()}');`);
});

out.push(`INSERT INTO url_inspections (property_id, page_id, url, checked_at, verdict, coverage_state, indexing_state, page_fetch_state, robots_state, last_crawl_time, google_canonical, user_canonical)
  VALUES (${PID}, ${pageId(pages[0])}, ${q(pages[0])}, '${new Date().toISOString()}', 'PASS', 'Submitted and indexed', 'INDEXING_ALLOWED', 'SUCCESSFUL', 'ALLOWED', '${dates.at(-1)}T08:00:00Z', ${q(pages[0])}, ${q(pages[0])}),
         (${PID}, ${pageId(pages[3])}, ${q(pages[3])}, '${new Date().toISOString()}', 'NEUTRAL', 'Crawled - currently not indexed', 'INDEXING_ALLOWED', 'SUCCESSFUL', 'ALLOWED', '${dates.at(-5)}T08:00:00Z', ${q(pages[3])}, ${q(pages[3])});`);
out.push(`INSERT INTO keyword_groups (id, property_id, name) VALUES (1, ${PID}, 'Money terms');`);
for (const t of ['best wordpress hosting', 'best seo plugin', 'review backup plugin']) out.push(`INSERT INTO keyword_group_terms VALUES (1, ${q(t)}, 'exact', ${queryId(t)});`);

mkdirSync('.wrangler', { recursive: true });
writeFileSync('.wrangler/seed-demo.sql', out.join('\n'));
execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--file', '.wrangler/seed-demo.sql'], { stdio: ['inherit', 'ignore', 'inherit'] });
console.log(`Seeded demo property with ${dates.length} days, ${pages.length} pages, ${queries.length} queries.`);
