import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildInserts } from '../src/db';
import { runSyncJob } from '../src/sync';
import { hashId, sqlStr } from '../src/util';
import { makeKey, PAGE_A, PAGE_B, PID, seed } from './helpers';

const ORIGIN = 'https://serp.test';
const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };

function call(path: string, key?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (key) headers.set('authorization', `Bearer ${key}`);
  return worker.fetch(new Request(ORIGIN + path, { ...init, headers }));
}

const RANGE = 'from=2026-01-08&to=2026-01-14&compare=previous';

beforeEach(seed);

describe('auth', () => {
  it('serves health and OpenAPI without auth', async () => {
    expect((await call('/healthz')).status).toBe(200);
    const spec = (await (await call('/api/openapi.json')).json()) as any;
    expect(spec.paths['/api/p/{property}/summary'].get.operationId).toBe('get_summary');
  });

  it('fails closed with no Access config and no key', async () => {
    expect((await call('/api/properties')).status).toBe(403);
    expect((await call('/')).status).toBe(403);
  });

  it('rejects an unknown key', async () => {
    expect((await call('/api/properties', 'gsk_nope')).status).toBe(401);
  });

  it('accepts a read key and blocks write tools for it', async () => {
    const key = await makeKey('read');
    expect((await call('/api/properties', key)).status).toBe(200);
    const res = await call('/api/sync', key, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(403);
  });

  it('keeps key management for signed-in humans', async () => {
    const key = await makeKey('write');
    expect((await call('/api/keys', key)).status).toBe(403);
  });
});

describe('reports', () => {
  it('summarises totals with weighted position and deltas', async () => {
    const key = await makeKey('read');
    const s = (await (await call(`/api/p/example.com/summary?${RANGE}`, key)).json()) as any;
    expect(s.current.clicks).toBe(140);
    expect(s.previous.clicks).toBe(161);
    expect(s.delta.clicks).toBe(-21);
    expect(s.current.impressions).toBe(1260);
    expect(s.current.position).toBe(5.7);
  });

  it('applies the brand filter from query data', async () => {
    const key = await makeKey('read');
    const b = (await (await call(`/api/p/1/summary?${RANGE}&brand=branded`, key)).json()) as any;
    const n = (await (await call(`/api/p/1/summary?${RANGE}&brand=nonbranded`, key)).json()) as any;
    expect(b.current.clicks).toBe(70);
    expect(n.current.clicks).toBe(63);
  });

  it('sorts the pages table and reports deltas', async () => {
    const key = await makeKey('read');
    const t = (await (await call(`/api/p/1/pages?${RANGE}&sort=delta_clicks&order=asc`, key)).json()) as any;
    expect(t.rows.map((r: any) => r.page)).toEqual([PAGE_B, PAGE_A]);
    expect(t.rows[0].delta_clicks).toBe(-35);
    expect(t.rows[1].delta_clicks).toBe(14);
  });

  it('exports CSV', async () => {
    const key = await makeKey('read');
    const res = await call(`/api/p/1/queries?${RANGE}&format=csv`, key);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect((await res.text()).split('\n')[0]).toContain('query,clicks');
  });

  it('returns page detail with the queries for that page', async () => {
    const key = await makeKey('read');
    const d = (await (await call(`/api/p/1/page?url=${encodeURIComponent(PAGE_A)}&${RANGE}`, key)).json()) as any;
    expect(d.queries.map((q: any) => q.query).sort()).toEqual(['alpha tool', 'example brand']);
    expect(d.first_seen).toBe('2026-01-01');
  });
});

describe('insights', () => {
  it('finds striking-distance queries with their top page', async () => {
    const key = await makeKey('read');
    const d = (await (await call(`/api/p/1/insights/striking_distance?${RANGE}`, key)).json()) as any;
    expect(d.rows).toHaveLength(1);
    expect(d.rows[0].query).toBe('alpha tool');
    expect(d.rows[0].top_page).toBe(PAGE_A);
    expect(d.rows[0].est_extra_clicks).toBe(42);
  });

  it('finds page decliners', async () => {
    const key = await makeKey('read');
    const d = (await (await call(`/api/p/1/insights/page_decliners?${RANGE}`, key)).json()) as any;
    expect(d.rows[0].page).toBe(PAGE_B);
    expect(d.rows[0].delta_clicks).toBe(-35);
  });

  it('tracks keyword groups', async () => {
    const key = await makeKey('write');
    const post = await call('/api/p/1/groups', key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Core', terms: ['Alpha Tool', 'missing term'] }),
    });
    expect(post.status).toBe(200);
    const g = (await (await call(`/api/p/1/groups/Core?${RANGE}`, key)).json()) as any;
    const alpha = g.rows.find((r: any) => r.term === 'alpha tool');
    expect(alpha.position).toBe(8);
    expect(alpha.top_page).toBe(PAGE_A);
    expect(g.totals.terms).toBe(2);
    expect(g.totals.ranking).toBe(1);
  });
});

describe('mcp', () => {
  const rpc = (key: string, body: unknown) =>
    call('/mcp', key, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });

  it('initializes and negotiates the protocol version', async () => {
    const key = await makeKey('read');
    const r = (await (await rpc(key, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })).json()) as any;
    expect(r.result.protocolVersion).toBe('2025-06-18');
    expect(r.result.capabilities.tools).toBeDefined();
    expect((await rpc(key, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
  });

  it('hides write tools from read keys', async () => {
    const read = await makeKey('read');
    const write = await makeKey('write');
    const list = async (k: string) => ((await (await rpc(k, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as any).result.tools.map((t: any) => t.name);
    expect(await list(read)).not.toContain('run_sync');
    expect(await list(write)).toContain('run_sync');
  });

  it('calls a tool and returns structured content', async () => {
    const key = await makeKey('read');
    const r = (await (
      await rpc(key, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_summary', arguments: { property: 'example.com', from: '2026-01-08', to: '2026-01-14' } } })
    ).json()) as any;
    expect(r.result.isError).toBeUndefined();
    expect(r.result.structuredContent.current.clicks).toBe(140);
    expect(JSON.parse(r.result.content[0].text).current.clicks).toBe(140);
  });

  it('reports tool errors as isError results', async () => {
    const key = await makeKey('read');
    const r = (await (await rpc(key, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_summary', arguments: { property: 'nope.com' } } })).json()) as any;
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain('Unknown property');
  });

  it('requires auth', async () => {
    const res = await worker.fetch(new Request(ORIGIN + '/mcp', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(403);
  });
});

describe('sync', () => {
  let saKey: string;

  beforeEach(async () => {
    const kp = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const pkcs8 = (await crypto.subtle.exportKey('pkcs8', kp.privateKey)) as ArrayBuffer;
    const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8))).replace(/(.{64})/g, '$1\n');
    saKey = JSON.stringify({ client_email: 'sa@test.iam.gserviceaccount.com', private_key: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n` });
  });

  afterEach(() => vi.restoreAllMocks());

  it('fetches one day and replaces its rows', async () => {
    const bodies: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('oauth2')) return Response.json({ access_token: 'tok', expires_in: 3600 });
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const dims: string[] = body.dimensions;
      const row = (keys: string[], c: number, i: number, p: number) => ({ keys, clicks: c, impressions: i, ctr: c / i, position: p });
      const rows: Record<string, unknown[]> = {
        date: [row(['2026-02-01'], 30, 300, 4)],
        page: [row(["https://example.com/it's/"], 20, 200, 3)],
        query: [row(['new query'], 20, 200, 3)],
        'query,page': [row(['new query', "https://example.com/it's/"], 20, 200, 3)],
        country: [row(['usa'], 30, 300, 4)],
        device: [row(['MOBILE'], 30, 300, 4)],
        searchAppearance: [],
      };
      return Response.json({ rows: rows[dims.join(',')] ?? [] });
    });
    const job = { kind: 'sync' as const, propertyId: PID, date: '2026-02-01', searchType: 'web' as const, dataState: 'final' as const };
    await runSyncJob({ ...env, GSC_SA_KEY: saKey } as any, job);
    await runSyncJob({ ...env, GSC_SA_KEY: saKey } as any, job); // idempotent re-run

    const t = await env.DB.prepare("SELECT clicks, impressions, pos_sum FROM daily_totals WHERE date = '2026-02-01'").first<any>();
    expect(t).toEqual({ clicks: 30, impressions: 300, pos_sum: 1200 });
    const pages = await env.DB.prepare("SELECT COUNT(*) AS n FROM page_daily WHERE date = '2026-02-01'").first<any>();
    expect(pages.n).toBe(1);
    const url = await env.DB.prepare("SELECT url FROM pages WHERE url LIKE '%it''s%'").first<any>();
    expect(url.url).toBe("https://example.com/it's/");
    const status = await env.DB.prepare("SELECT status FROM sync_jobs WHERE date = '2026-02-01'").first<any>();
    expect(status.status).toBe('ok');
    expect(bodies.every((b) => b.dataState === 'final' && b.startDate === '2026-02-01')).toBe(true);
  });
});

describe('helpers', () => {
  it('splits inserts under the statement size limit', () => {
    const tuples = Array.from({ length: 5000 }, (_, i) => `(${i}, ${sqlStr('x'.repeat(50))})`);
    const stmts = buildInserts('INSERT INTO t VALUES ', tuples);
    expect(stmts.length).toBeGreaterThan(1);
    for (const s of stmts) expect(new TextEncoder().encode(s).length).toBeLessThan(100_000);
    expect(stmts.join('').match(/\(\d+, /g)!.length).toBe(5000);
  });

  it('hashes deterministically within safe integer range', () => {
    expect(hashId('abc', 3)).toBe(hashId('abc', 3));
    expect(hashId('abc', 3)).not.toBe(hashId('abc', 5));
    expect(Number.isSafeInteger(hashId('a long string '.repeat(20)))).toBe(true);
  });

  it('escapes SQL strings', () => {
    expect(sqlStr("it's")).toBe("'it''s'");
  });
});
