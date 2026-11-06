import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupRegexFilters, groupSql, saveContentGroup } from '../src/contentgroups';
import { addAnnotation, importGoogleUpdates, listAnnotations } from '../src/annotations';
import { acknowledgeAlerts, createChannel, listAlerts, runAlertChecks, saveRule } from '../src/alerts';
import { resolveProperty } from '../src/db';
import { makeKey, PAGE_A, PAGE_B, seed } from './helpers';

const E = { ...env, SA_ENCRYPTION_KEY: 'feature-test-encryption-key-1234' } as any;
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const RANGE = 'from=2026-01-08&to=2026-01-14&compare=previous';
const get = async (path: string, key: string) => (await worker.fetch(new Request('https://scry.test' + path, { headers: { authorization: `Bearer ${key}` } }))).json() as any;

beforeEach(async () => {
  await seed();
  await env.DB.batch(['DELETE FROM content_groups', "DELETE FROM annotations WHERE source <> 'google' OR external_id LIKE 'google:%'", 'DELETE FROM alerts', 'DELETE FROM alert_rules', 'DELETE FROM alert_channels'].map((s) => env.DB.prepare(s)));
});
afterEach(() => vi.restoreAllMocks());

describe('content groups', () => {
  it('turns path patterns into SQL and RE2 filters', () => {
    const g = { id: 1, property_id: 1, name: 'x', include: ['/blog/', '/docs/*/api', 'pricing'], exclude: ['/blog/tag/'] };
    const sql = groupSql(g, 'u');
    expect(sql.params).toEqual(['/blog/%', '/docs/%/api', '%pricing%', '/blog/tag/%']);
    const re = groupRegexFilters(g);
    expect(re[0].expression).toContain('^https?://[^/]+/blog/.*$');
    expect(new RegExp(re[0].expression.split('|')[0]).test('https://ex.com/blog/post')).toBe(true);
    expect(new RegExp(re[0].expression.split('|')[0]).test('https://ex.com/about/')).toBe(false);
  });

  it('filters reports and insights to the group', async () => {
    const p = await resolveProperty(env as any, 1);
    const saved = await saveContentGroup(env as any, p, 'Section A', ['/a/'], []);
    expect(saved.matching_pages).toBe(1);
    const key = await makeKey('write');
    const pages = await get(`/api/p/1/pages?${RANGE}&group=Section%20A`, key);
    expect(pages.rows.map((r: any) => r.page)).toEqual([PAGE_A]);
    const s = await get(`/api/p/1/summary?${RANGE}&group=Section%20A`, key);
    expect(s.current.clicks).toBe(98);
    const dec = await get(`/api/p/1/insights/page_decliners?${RANGE}&group=Section%20A`, key);
    expect(dec.rows).toHaveLength(0); // only page B declined, and it is outside the group
    const all = await get(`/api/p/1/content-groups?${RANGE}`, key);
    expect(all.groups[0]).toMatchObject({ name: 'Section A', pages: 1, clicks: 98 });
  });

  it('rejects groups without include patterns', async () => {
    const p = await resolveProperty(env as any, 1);
    await expect(saveContentGroup(env as any, p, 'Empty', [], [])).rejects.toThrow(/include pattern/);
  });
});

describe('annotations', () => {
  it('returns property and global notes with the time series', async () => {
    const p = await resolveProperty(env as any, 1);
    await addAnnotation(env as any, p, { date: '2026-01-10', title: 'Redesign', category: 'release' });
    await addAnnotation(env as any, null, { date: '2026-01-12', title: 'CDN outage', category: 'incident' });
    const key = await makeKey('read');
    const t = await get(`/api/p/1/timeseries?${RANGE}`, key);
    expect(t.annotations.map((a: any) => a.title)).toEqual(['Redesign', 'CDN outage']);
  });

  it('validates input and reserves the google category', async () => {
    await expect(addAnnotation(env as any, null, { date: '10/01/2026', title: 'x' })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(addAnnotation(env as any, null, { date: '2026-01-10', title: 'x', category: 'google' })).rejects.toThrow(/reserved/);
  });

  it('imports Google ranking updates idempotently and hides them per property', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json([
        { id: 'abc', begin: '2026-01-09T10:00:00Z', end: '2026-01-13T10:00:00Z', external_desc: 'January 2026 core update', service_name: 'Ranking', uri: 'incidents/abc' },
        { id: 'zzz', begin: '2026-01-09T10:00:00Z', external_desc: 'Crawling issue', service_name: 'Crawling' },
      ]),
    );
    expect(await importGoogleUpdates(env as any)).toBe(1);
    expect(await importGoogleUpdates(env as any)).toBe(1);
    const p = await resolveProperty(env as any, 1);
    const shown = await listAnnotations(env as any, p, '2026-01-01', '2026-01-14');
    expect(shown.filter((a) => a.category === 'google').map((a) => a.title)).toEqual(['January 2026 core update']);
    const hidden = await listAnnotations(env as any, { ...p, show_google_updates: 0 }, '2026-01-01', '2026-01-14');
    expect(hidden.some((a) => a.category === 'google')).toBe(false);
  });
});

describe('alerts', () => {
  it('fires once per problem and delivers to Slack', async () => {
    const sent: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response('ok');
    });
    const ch = await createChannel(E, { kind: 'slack', name: 'seo', target: 'https://hooks.slack.com/services/T/B/x' });
    await saveRule(E, { kind: 'page_drop', threshold: 40, min_clicks: 10, channels: [ch.id], property: '1' });
    // Make the latest final day 2026-01-14 so a 7-day window matches the seeded data.
    const first = await runAlertChecks(E);
    expect(first.new_alerts).toBe(1);
    expect(first.delivered).toBe(1);
    expect(sent[0].url).toContain('hooks.slack.com');
    expect(JSON.stringify(sent[0].body)).toContain('/b/');
    const second = await runAlertChecks(E);
    expect(second.new_alerts).toBe(0);
    const list = await listAlerts(E);
    expect(list.open_count).toBe(1);
    expect(list.alerts[0].detail.page).toBe(PAGE_B);
    await acknowledgeAlerts(E, 'all');
    expect((await listAlerts(E)).open_count).toBe(0);
  });

  it('signs webhook deliveries', async () => {
    let headers: Headers | null = null;
    let body = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_i: RequestInfo | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      body = String(init?.body);
      return new Response('ok');
    });
    const ch = await createChannel(E, { kind: 'webhook', name: 'hook', target: 'https://example.com/hook' });
    expect(ch.signing_secret).toMatch(/^whsec_/);
    await saveRule(E, { kind: 'page_drop', threshold: 40, min_clicks: 10, channels: [ch.id] });
    await runAlertChecks(E);
    const ts = headers!.get('x-scry-timestamp')!;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(ch.signing_secret!), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${body}`));
    const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(headers!.get('x-scry-signature')).toBe(`sha256=${hex}`);
    expect(JSON.parse(body).alerts[0].kind).toBe('page_drop');
  });

  it('validates rules and channels', async () => {
    await expect(saveRule(E, { kind: 'nope' })).rejects.toThrow(/kind must be/);
    await expect(createChannel(E, { kind: 'discord', target: 'https://evil.example/x' })).rejects.toThrow(/discord\.com/);
    await expect(createChannel(E, { kind: 'webhook', target: 'http://plain.example/x' })).rejects.toThrow(/https/);
  });

  it('keeps channel management away from API keys', async () => {
    const key = await makeKey('write');
    const res = await worker.fetch(new Request('https://scry.test/api/alert-channels', { headers: { authorization: `Bearer ${key}` } }));
    expect(res.status).toBe(403);
  });
});
