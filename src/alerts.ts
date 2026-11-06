/**
 * Alerts: rules evaluated daily against stored data, de-duplicated by fingerprint,
 * and delivered to email, Slack, Discord, Microsoft Teams or a signed webhook.
 */
import { HttpError, type Env, type Property } from './env';
import { decryptText, encryptText } from './accounts';
import { getBranding } from './branding';
import { listProperties, resolveProperty } from './db';
import { groupReport } from './groups';
import { insight } from './insights';
import { summary } from './reports';
import { addDays, randomToken, todayUtc } from './util';

// ---------- rule catalogue ----------

export const RULE_KINDS = {
  clicks_drop: { label: 'Site clicks dropped', unit: '%', threshold: 20, help: 'Last 7 days of clicks vs the 7 before fell by at least this percentage.' },
  page_drop: { label: 'A page lost clicks', unit: '%', threshold: 50, help: 'A page with real traffic lost at least this percentage of its weekly clicks.' },
  keyword_group_drop: { label: 'Keyword group slipped', unit: 'positions', threshold: 2, help: 'The average position of a keyword group got worse by at least this many places week over week.' },
  deindexed: { label: 'Page dropped out of the index', unit: null, threshold: null, help: 'A page that was indexed is no longer indexed at its last inspection.' },
  sitemap_errors: { label: 'Sitemap has errors', unit: null, threshold: null, help: 'Google reports errors on a submitted sitemap.' },
  canonical_mismatch: { label: 'Google picked another canonical', unit: null, threshold: null, help: 'On a page with real traffic, Google chose a different canonical than the one declared.' },
} as const;
export type RuleKind = keyof typeof RULE_KINDS;
export const CHANNEL_KINDS = ['email', 'slack', 'discord', 'teams', 'webhook'] as const;
type ChannelKind = (typeof CHANNEL_KINDS)[number];

interface RuleRow {
  id: number;
  property_id: number | null;
  kind: RuleKind;
  threshold: number | null;
  params: string;
  channels: string;
  enabled: number;
}

interface NewAlert {
  rule_id: number;
  property: Property;
  kind: RuleKind;
  fingerprint: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: Record<string, unknown>;
  link: string;
}

// ---------- channels ----------

function hint(kind: ChannelKind, target: string) {
  if (kind === 'email') return target.replace(/(^.).*(@.*$)/, '$1…$2');
  try {
    const u = new URL(target);
    return `${u.host}/…${target.slice(-4)}`;
  } catch {
    return '…';
  }
}

function validateTarget(kind: ChannelKind, raw: string): string {
  const t = raw.trim();
  if (kind === 'email') {
    const list = t.split(',').map((s) => s.trim()).filter(Boolean);
    if (!list.length || list.some((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) throw new HttpError(400, 'Enter one or more email addresses, comma-separated.');
    return list.join(', ');
  }
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    throw new HttpError(400, 'Enter the full webhook URL.');
  }
  if (u.protocol !== 'https:') throw new HttpError(400, 'Webhook URLs must use https.');
  if (kind === 'slack' && u.host !== 'hooks.slack.com') throw new HttpError(400, 'Slack incoming webhooks start with https://hooks.slack.com/');
  if (kind === 'discord' && !/^(discord|discordapp)\.com$/.test(u.host)) throw new HttpError(400, 'Discord webhooks start with https://discord.com/api/webhooks/');
  return u.toString();
}

export async function createChannel(env: Env, input: { kind?: string; name?: string; target?: string }) {
  const kind = String(input.kind) as ChannelKind;
  if (!CHANNEL_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${CHANNEL_KINDS.join(', ')}`);
  const target = validateTarget(kind, String(input.target || ''));
  const name = String(input.name || '').trim().slice(0, 60) || kind;
  const enc = await encryptText(env, target);
  const secret = kind === 'webhook' ? 'whsec_' + randomToken(24) : null;
  const encSecret = secret ? await encryptText(env, secret) : null;
  const row = await env.DB.prepare(
    `INSERT INTO alert_channels (kind, name, target_ciphertext, target_iv, target_hint, secret_ciphertext, secret_iv, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(kind, name, enc.ciphertext, enc.iv, hint(kind, target), encSecret?.ciphertext ?? null, encSecret?.iv ?? null, new Date().toISOString())
    .first<{ id: number }>();
  return { id: row!.id, kind, name, target_hint: hint(kind, target), signing_secret: secret };
}

export async function listChannels(env: Env) {
  const { results } = await env.DB.prepare('SELECT id, kind, name, target_hint, created_at, last_sent_at, last_error FROM alert_channels ORDER BY id').all();
  return results;
}

export async function deleteChannel(env: Env, id: number) {
  await env.DB.prepare('DELETE FROM alert_channels WHERE id = ?').bind(id).run();
  const { results } = await env.DB.prepare('SELECT id, channels FROM alert_rules').all<{ id: number; channels: string }>();
  for (const r of results) {
    const ids = (JSON.parse(r.channels || '[]') as number[]).filter((c) => c !== id);
    await env.DB.prepare('UPDATE alert_rules SET channels = ? WHERE id = ?').bind(JSON.stringify(ids), r.id).run();
  }
  return { deleted: id };
}

// ---------- rules ----------

export async function listRules(env: Env) {
  const { results } = await env.DB.prepare('SELECT * FROM alert_rules ORDER BY id').all<RuleRow & { last_checked_at: string | null }>();
  return results.map((r) => ({
    ...r,
    enabled: Boolean(r.enabled),
    params: JSON.parse(r.params || '{}'),
    channels: JSON.parse(r.channels || '[]'),
    label: RULE_KINDS[r.kind]?.label ?? r.kind,
    unit: RULE_KINDS[r.kind]?.unit ?? null,
  }));
}

export async function saveRule(env: Env, a: Record<string, any>) {
  const kind = String(a.kind) as RuleKind;
  if (!(kind in RULE_KINDS)) throw new HttpError(400, `kind must be one of ${Object.keys(RULE_KINDS).join(', ')}`);
  const p = a.property ? await resolveProperty(env, a.property) : null;
  if (kind === 'keyword_group_drop' && !a.group) throw new HttpError(400, 'keyword_group_drop needs group (a keyword group name)');
  if (kind === 'keyword_group_drop' && !p) throw new HttpError(400, 'keyword_group_drop needs a property');
  const def = RULE_KINDS[kind];
  const threshold = def.threshold === null ? null : Number(a.threshold ?? def.threshold);
  if (threshold !== null && (!Number.isFinite(threshold) || threshold <= 0)) throw new HttpError(400, 'threshold must be a positive number');
  const params: Record<string, unknown> = {};
  if (a.min_clicks !== undefined) params.min_clicks = Math.max(0, Number(a.min_clicks));
  if (a.group) params.group = String(a.group);
  const channels = ((a.channels || []) as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const enabled = a.enabled === undefined ? 1 : a.enabled ? 1 : 0;
  if (a.id) {
    await env.DB.prepare('UPDATE alert_rules SET property_id = ?, kind = ?, threshold = ?, params = ?, channels = ?, enabled = ? WHERE id = ?')
      .bind(p?.id ?? null, kind, threshold, JSON.stringify(params), JSON.stringify(channels), enabled, Number(a.id))
      .run();
    return { id: Number(a.id), updated: true };
  }
  const row = await env.DB.prepare(
    'INSERT INTO alert_rules (property_id, kind, threshold, params, channels, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
  )
    .bind(p?.id ?? null, kind, threshold, JSON.stringify(params), JSON.stringify(channels), enabled, new Date().toISOString())
    .first<{ id: number }>();
  return { id: row!.id, kind, label: def.label, property: p?.site_url ?? 'all properties', threshold, channels };
}

export async function deleteRule(env: Env, id: number) {
  await env.DB.prepare('DELETE FROM alert_rules WHERE id = ?').bind(id).run();
  return { deleted: id };
}

// ---------- alerts ----------

export async function listAlerts(env: Env, status = 'open', propertyId?: number, limit = 100) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (status !== 'all') where.push('a.status = ?'), params.push(status);
  if (propertyId) where.push('a.property_id = ?'), params.push(propertyId);
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.kind, a.severity, a.title, a.detail, a.link, a.status, a.created_at, a.acknowledged_at, a.property_id, p.label AS property
     FROM alerts a LEFT JOIN properties p ON p.id = a.property_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY a.created_at DESC LIMIT ?`,
  )
    .bind(...params, Math.min(Math.max(limit, 1), 500))
    .all<Record<string, unknown>>();
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE status = 'open'").first<{ n: number }>();
  return { open_count: open?.n ?? 0, alerts: results.map((r) => ({ ...r, detail: JSON.parse(String(r.detail || '{}')) })) };
}

export async function acknowledgeAlerts(env: Env, ids: number[] | 'all') {
  const now = new Date().toISOString();
  if (ids === 'all') await env.DB.prepare("UPDATE alerts SET status = 'acknowledged', acknowledged_at = ? WHERE status = 'open'").bind(now).run();
  else for (const id of ids) await env.DB.prepare("UPDATE alerts SET status = 'acknowledged', acknowledged_at = ? WHERE id = ?").bind(now, id).run();
  return { acknowledged: ids === 'all' ? 'all' : ids.length };
}

/** Where links in alerts point. Remembered from the last signed-in visit. */
export async function appOrigin(env: Env) {
  return (await env.KV.get('app:origin')) || '';
}

const pct = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 1000) / 10 : 0);
const nf = new Intl.NumberFormat('en-US');

async function evaluate(env: Env, rule: RuleRow, p: Property, origin: string): Promise<NewAlert[]> {
  const params = JSON.parse(rule.params || '{}') as { min_clicks?: number; group?: string };
  const thr = rule.threshold ?? RULE_KINDS[rule.kind].threshold ?? 0;
  const base = `${origin}/#/p/${p.id}`;
  const out: NewAlert[] = [];
  const mk = (a: Omit<NewAlert, 'rule_id' | 'property' | 'kind'>) => out.push({ rule_id: rule.id, property: p, kind: rule.kind, ...a });

  switch (rule.kind) {
    case 'clicks_drop': {
      const s = await summary(env, p, { days: 7, compare: 'previous' });
      const prev = s.previous?.clicks ?? 0;
      const change = pct(s.current.clicks, prev);
      if (prev >= (params.min_clicks ?? 50) && change <= -thr) {
        mk({
          fingerprint: `clicks_drop:${p.id}:${s.range.to}`,
          severity: change <= -2 * thr ? 'critical' : 'warning',
          title: `${p.label}: clicks down ${Math.abs(change)}% week over week (${nf.format(prev)} → ${nf.format(s.current.clicks)})`,
          detail: { from: s.range.from, to: s.range.to, clicks: s.current.clicks, previous: prev, change_pct: change },
          link: base,
        });
      }
      break;
    }
    case 'page_drop': {
      const d = await insight(env, p, 'page_decliners', { days: 7, limit: 50, min_clicks: params.min_clicks ?? 30 });
      for (const r of (d.rows as Record<string, any>[]).slice(0, 50)) {
        const change = pct(r.clicks, r.prev_clicks);
        if (change > -thr) continue;
        mk({
          fingerprint: `page_drop:${p.id}:${r.page}:${d.range.to}`,
          severity: change <= -80 ? 'critical' : 'warning',
          title: `${p.label}: ${r.page.replace(/^https?:\/\/[^/]+/, '') || '/'} lost ${Math.abs(change)}% of clicks (${nf.format(r.prev_clicks)} → ${nf.format(r.clicks)})`,
          detail: { page: r.page, clicks: r.clicks, previous: r.prev_clicks, change_pct: change, position: r.position, previous_position: r.prev_position },
          link: `${base}/page?url=${encodeURIComponent(r.page)}`,
        });
        if (out.length >= 10) break;
      }
      break;
    }
    case 'keyword_group_drop': {
      const g = await groupReport(env, p, String(params.group), { days: 7, compare: 'previous' });
      const deltas = g.rows.map((r) => r.delta_position).filter((v): v is number => typeof v === 'number');
      if (!deltas.length) break;
      const avg = Math.round((deltas.reduce((a, b) => a + b, 0) / deltas.length) * 10) / 10;
      if (avg >= thr) {
        mk({
          fingerprint: `kg:${p.id}:${g.group}:${g.range.to}`,
          severity: avg >= 2 * thr ? 'critical' : 'warning',
          title: `${p.label}: keyword group "${g.group}" slipped ${avg} positions on average (${g.totals.declined} terms down)`,
          detail: { group: g.group, average_change: avg, declined: g.totals.declined, improved: g.totals.improved },
          link: `${base}/groups/${encodeURIComponent(g.group)}`,
        });
      }
      break;
    }
    case 'deindexed': {
      const since = new Date(Date.now() - 3 * 86400_000).toISOString();
      const { results } = await env.DB.prepare(
        `SELECT url, coverage_state, prev_coverage_state, changed_at FROM url_inspections
         WHERE property_id = ? AND changed_at >= ? AND prev_verdict = 'PASS' AND verdict IS NOT 'PASS' LIMIT 20`,
      )
        .bind(p.id, since)
        .all<{ url: string; coverage_state: string; prev_coverage_state: string; changed_at: string }>();
      for (const r of results) {
        mk({
          fingerprint: `deindexed:${p.id}:${r.url}:${r.changed_at}`,
          severity: 'critical',
          title: `${p.label}: ${r.url.replace(/^https?:\/\/[^/]+/, '') || '/'} is no longer indexed (${r.coverage_state})`,
          detail: { page: r.url, was: r.prev_coverage_state, now: r.coverage_state, changed_at: r.changed_at },
          link: `${base}/page?url=${encodeURIComponent(r.url)}`,
        });
      }
      break;
    }
    case 'sitemap_errors': {
      const { results } = await env.DB.prepare('SELECT path, errors, last_downloaded FROM sitemaps WHERE property_id = ? AND errors > 0').bind(p.id).all<{
        path: string;
        errors: number;
        last_downloaded: string | null;
      }>();
      for (const r of results) {
        mk({
          fingerprint: `sitemap:${p.id}:${r.path}:${r.last_downloaded ?? ''}:${r.errors}`,
          severity: 'warning',
          title: `${p.label}: sitemap ${r.path} has ${r.errors} error${r.errors === 1 ? '' : 's'}`,
          detail: { sitemap: r.path, errors: r.errors, last_downloaded: r.last_downloaded },
          link: `${base}/indexing`,
        });
      }
      break;
    }
    case 'canonical_mismatch': {
      const since = addDays(todayUtc(), -31);
      const { results } = await env.DB.prepare(
        `SELECT ui.url, ui.google_canonical, ui.user_canonical,
           (SELECT SUM(clicks) FROM page_daily d INDEXED BY page_daily_lookup WHERE d.property_id = ui.property_id AND d.search_type = 'web' AND d.page_id = ui.page_id AND d.date >= ?) AS clicks
         FROM url_inspections ui
         WHERE ui.property_id = ? AND ui.google_canonical IS NOT NULL AND ui.user_canonical IS NOT NULL AND ui.google_canonical <> ui.user_canonical
         ORDER BY clicks DESC LIMIT 20`,
      )
        .bind(since, p.id)
        .all<{ url: string; google_canonical: string; user_canonical: string; clicks: number | null }>();
      for (const r of results) {
        if ((r.clicks ?? 0) < (params.min_clicks ?? 20)) continue;
        mk({
          fingerprint: `canonical:${p.id}:${r.url}:${r.google_canonical}`,
          severity: 'warning',
          title: `${p.label}: Google uses ${r.google_canonical} as the canonical for ${r.url}`,
          detail: { page: r.url, google_canonical: r.google_canonical, declared_canonical: r.user_canonical, clicks_30d: r.clicks },
          link: `${base}/page?url=${encodeURIComponent(r.url)}`,
        });
      }
      break;
    }
  }
  return out;
}

/** Evaluates every enabled rule, stores new alerts and delivers them. */
export async function runAlertChecks(env: Env) {
  const origin = await appOrigin(env);
  const rules = (await env.DB.prepare('SELECT * FROM alert_rules WHERE enabled = 1').all<RuleRow>()).results;
  const props = await listProperties(env, true);
  const fresh: (NewAlert & { id: number; channels: number[] })[] = [];
  const errors: string[] = [];
  for (const rule of rules) {
    const targets = rule.property_id ? props.filter((p) => p.id === rule.property_id) : props;
    for (const p of targets) {
      let found: NewAlert[] = [];
      try {
        found = await evaluate(env, rule, p, origin);
      } catch (e) {
        errors.push(`rule ${rule.id} on ${p.label}: ${(e as Error).message}`);
        continue;
      }
      for (const a of found) {
        const row = await env.DB.prepare(
          `INSERT INTO alerts (rule_id, property_id, kind, fingerprint, severity, title, detail, link, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (fingerprint) DO NOTHING RETURNING id`,
        )
          .bind(a.rule_id, a.property.id, a.kind, a.fingerprint, a.severity, a.title, JSON.stringify(a.detail), a.link, new Date().toISOString())
          .first<{ id: number }>();
        if (row) fresh.push({ ...a, id: row.id, channels: JSON.parse(rule.channels || '[]') });
      }
    }
    await env.DB.prepare('UPDATE alert_rules SET last_checked_at = ? WHERE id = ?').bind(new Date().toISOString(), rule.id).run();
  }
  const delivered = await deliver(env, fresh);
  return { rules: rules.length, new_alerts: fresh.length, delivered, errors };
}

// ---------- delivery ----------

interface ChannelRow {
  id: number;
  kind: ChannelKind;
  name: string;
  target_ciphertext: string;
  target_iv: string;
  secret_ciphertext: string | null;
  secret_iv: string | null;
}

type Deliverable = { id?: number; title: string; link: string; severity: string; kind: string; property?: string; detail?: unknown };

const icon = (s: string) => (s === 'critical' ? '🔴' : s === 'warning' ? '🟠' : '🔵');
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

async function hmacHex(secret: string, body: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sendToChannel(env: Env, ch: ChannelRow, items: Deliverable[], heading?: string) {
  const name = (await getBranding(env)).name;
  const target = await decryptText(env, ch.target_ciphertext, ch.target_iv);
  const head = heading || `${name}: ${items.length} new alert${items.length === 1 ? '' : 's'}`;
  const shown = items.slice(0, 20);
  const more = items.length > shown.length ? items.length - shown.length : 0;
  let init: RequestInit;
  let url = target;
  switch (ch.kind) {
    case 'slack':
      init = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: head,
          blocks: [
            { type: 'header', text: { type: 'plain_text', text: head.slice(0, 150) } },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: shown.map((a) => `${icon(a.severity)} ${a.link ? `<${a.link}|${a.title.replace(/[<>|]/g, '')}>` : a.title}`).join('\n').slice(0, 2900) + (more ? `\n…and ${more} more` : '') },
            },
          ],
        }),
      };
      break;
    case 'discord':
      init = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: name.slice(0, 80),
          content: (`**${head}**\n` + shown.map((a) => `${icon(a.severity)} ${a.link ? `[${a.title.replace(/[[\]]/g, '')}](<${a.link}>)` : a.title}`).join('\n') + (more ? `\n…and ${more} more` : '')).slice(0, 1990),
          allowed_mentions: { parse: [] },
        }),
      };
      break;
    case 'teams':
      init = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'message',
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive',
              content: {
                $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                type: 'AdaptiveCard',
                version: '1.4',
                body: [
                  { type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: head, wrap: true },
                  ...shown.map((a) => ({ type: 'TextBlock', text: `${icon(a.severity)} ${a.link ? `[${a.title}](${a.link})` : a.title}`, wrap: true })),
                  ...(more ? [{ type: 'TextBlock', text: `…and ${more} more`, isSubtle: true }] : []),
                ],
              },
            },
          ],
        }),
      };
      break;
    case 'webhook': {
      const body = JSON.stringify({ source: 'scry', app: name, sent_at: new Date().toISOString(), alerts: items });
      const secret = ch.secret_ciphertext && ch.secret_iv ? await decryptText(env, ch.secret_ciphertext, ch.secret_iv) : '';
      const ts = String(Math.floor(Date.now() / 1000));
      init = {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Scry-Webhook/1',
          'x-scry-timestamp': ts,
          ...(secret ? { 'x-scry-signature': `sha256=${await hmacHex(secret, `${ts}.${body}`)}` } : {}),
        },
        body,
      };
      break;
    }
    case 'email': {
      if (!env.EMAIL_API_URL || !env.EMAIL_API_KEY || !env.DIGEST_FROM) throw new HttpError(400, 'Email needs EMAIL_API_URL, EMAIL_API_KEY and DIGEST_FROM to be configured.');
      url = env.EMAIL_API_URL;
      const to = target.split(',').map((s) => s.trim()).filter(Boolean);
      const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;max-width:640px;margin:0 auto;padding:24px">
        <h1 style="font-size:20px;margin:0 0 12px">${escHtml(head)}</h1><ul style="padding-left:18px">${shown
          .map((a) => `<li style="margin:6px 0">${icon(a.severity)} ${a.link ? `<a href="${escHtml(a.link)}" style="color:#8f281c">${escHtml(a.title)}</a>` : escHtml(a.title)}</li>`)
          .join('')}</ul>${more ? `<p>…and ${more} more.</p>` : ''}</body></html>`;
      init = {
        method: 'POST',
        headers: { authorization: `Bearer ${env.EMAIL_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: env.DIGEST_FROM, to: to.length === 1 ? to[0] : to, subject: head, html }),
      };
      break;
    }
  }
  const res = await fetch(url, init!);
  if (!res.ok) throw new Error(`${ch.kind} returned ${res.status}`);
}

async function deliver(env: Env, fresh: (NewAlert & { id: number; channels: number[] })[]) {
  if (!fresh.length) return 0;
  const byChannel = new Map<number, Deliverable[]>();
  for (const a of fresh) {
    for (const c of a.channels) {
      if (!byChannel.has(c)) byChannel.set(c, []);
      byChannel.get(c)!.push({ id: a.id, title: a.title, link: a.link, severity: a.severity, kind: a.kind, property: a.property.site_url, detail: a.detail });
    }
  }
  let sent = 0;
  for (const [id, items] of byChannel) {
    const ch = await env.DB.prepare('SELECT * FROM alert_channels WHERE id = ?').bind(id).first<ChannelRow>();
    if (!ch) continue;
    try {
      await sendToChannel(env, ch, items);
      await env.DB.prepare('UPDATE alert_channels SET last_sent_at = ?, last_error = NULL WHERE id = ?').bind(new Date().toISOString(), id).run();
      sent++;
    } catch (e) {
      await env.DB.prepare('UPDATE alert_channels SET last_error = ? WHERE id = ?').bind((e as Error).message.slice(0, 300), id).run();
    }
  }
  const now = new Date().toISOString();
  await env.DB.batch(fresh.map((a) => env.DB.prepare('UPDATE alerts SET delivered_at = ? WHERE id = ?').bind(now, a.id)));
  return sent;
}

export async function testChannel(env: Env, id: number) {
  const ch = await env.DB.prepare('SELECT * FROM alert_channels WHERE id = ?').bind(id).first<ChannelRow>();
  if (!ch) throw new HttpError(404, 'No such channel');
  const name = (await getBranding(env)).name;
  const origin = await appOrigin(env);
  try {
    await sendToChannel(env, ch, [{ title: `Test alert from ${name}. If you can read this, the channel works.`, link: origin ? `${origin}/#/alerts` : '', severity: 'info', kind: 'test' }], `${name}: test alert`);
    await env.DB.prepare('UPDATE alert_channels SET last_sent_at = ?, last_error = NULL WHERE id = ?').bind(new Date().toISOString(), id).run();
    return { sent: true };
  } catch (e) {
    const message = (e as Error).message;
    await env.DB.prepare('UPDATE alert_channels SET last_error = ? WHERE id = ?').bind(message.slice(0, 300), id).run();
    throw new HttpError(502, `Test failed: ${message}`);
  }
}
