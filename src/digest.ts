import type { Env, Property } from './env';
import { listProperties } from './db';
import { insight } from './insights';
import { summary } from './reports';
import { getBranding } from './branding';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '-' : Number(n).toLocaleString('en-US'));
const signed = (n: number | null | undefined, suffix = '') => (n === null || n === undefined ? '' : `${n > 0 ? '+' : ''}${fmt(n)}${suffix}`);

const shortUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, '');

async function section(env: Env, p: Property) {
  const s = await summary(env, p, { days: 7, compare: 'previous' });
  const [down, up, striking] = await Promise.all([
    insight(env, p, 'page_decliners', { days: 7, limit: 5 }),
    insight(env, p, 'page_gainers', { days: 7, limit: 5 }),
    insight(env, p, 'striking_distance', { days: 28, limit: 5 }),
  ]);
  const changes = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM url_inspections WHERE property_id = ? AND changed_at >= datetime('now', '-7 days') AND verdict <> 'PASS'",
  )
    .bind(p.id)
    .first<{ n: number }>();
  const list = (rows: any[], f: (r: any) => string) =>
    rows.length ? `<ul style="margin:4px 0 12px;padding-left:18px">${rows.map((r) => `<li style="margin:2px 0">${f(r)}</li>`).join('')}</ul>` : '<p style="margin:4px 0 12px;color:#555">None this week.</p>';
  return `
  <h2 style="font-size:18px;margin:28px 0 6px">${esc(p.label)}</h2>
  <p style="margin:0 0 10px;color:#333">${esc(s.range.from)} to ${esc(s.range.to)}:
    <strong>${fmt(s.current.clicks)}</strong> clicks (${signed(s.delta?.clicks_pct, '%')}),
    ${fmt(s.current.impressions)} impressions (${signed(s.delta?.impressions_pct, '%')}),
    position ${s.current.position ?? '-'} (${signed(s.delta?.position)}).</p>
  <h3 style="font-size:15px;margin:12px 0 2px">Biggest drops</h3>
  ${list(down.rows as any[], (r) => `${esc(shortUrl(r.page))}: ${signed(r.delta_clicks)} clicks`)}
  <h3 style="font-size:15px;margin:12px 0 2px">Biggest gains</h3>
  ${list(up.rows as any[], (r) => `${esc(shortUrl(r.page))}: ${signed(r.delta_clicks)} clicks`)}
  <h3 style="font-size:15px;margin:12px 0 2px">Striking distance</h3>
  ${list(striking.rows as any[], (r) => `${esc(r.query)}: position ${r.position}, ~${fmt(r.est_extra_clicks)} extra clicks possible`)}
  ${changes?.n ? `<p style="margin:4px 0;color:#9a1f17">${changes.n} inspected pages changed to a non-indexed state this week.</p>` : ''}`;
}

export async function buildDigest(env: Env, origin = '') {
  const props = await listProperties(env, true);
  const parts = [];
  for (const p of props) {
    try {
      parts.push(await section(env, p));
    } catch (e) {
      parts.push(`<h2>${esc(p.label)}</h2><p>Could not build this section: ${esc((e as Error).message)}</p>`);
    }
  }
  const brand = await getBranding(env);
  const name = brand.name;
  const logo = origin && brand.assets['logo-light'] ? `<img src="${esc(origin)}/brand/logo-light?v=${esc(brand.version)}" alt="${esc(name)}" style="max-height:40px;max-width:200px;display:block;margin:0 0 12px">` : '';
  return {
    subject: `${name} weekly: Search Console digest`,
    html: `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;max-width:640px;margin:0 auto;padding:24px">
    ${logo}<h1 style="font-size:22px;margin:0 0 4px">${esc(name)} weekly digest</h1>
    <p style="margin:0;color:#555">Last 7 days of final data vs the 7 days before.</p>
    ${parts.join('')}
    ${origin ? `<p style="margin-top:28px"><a href="${esc(origin)}" style="color:#9a1f17">Open the dashboard</a></p>` : ''}
    </body></html>`,
  };
}

export async function sendDigest(env: Env, origin = '') {
  if (!env.EMAIL_API_URL || !env.EMAIL_API_KEY || !env.DIGEST_TO || !env.DIGEST_FROM) return { sent: false, reason: 'Email not configured' };
  const { subject, html } = await buildDigest(env, origin);
  const recipients = env.DIGEST_TO.split(',').map((s) => s.trim()).filter(Boolean);
  const res = await fetch(env.EMAIL_API_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.EMAIL_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.DIGEST_FROM,
      to: recipients.length === 1 ? recipients[0] : recipients,
      subject,
      html,
    }),
  });
  if (!res.ok) return { sent: false, reason: `Email API returned ${res.status}` };
  return { sent: true };
}
