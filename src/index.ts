import { Hono } from 'hono';
import {
  accessConfigured,
  authenticate,
  checkPassword,
  clearSessionCookie,
  createApiKey,
  createSessionCookie,
  passwordConfigured,
  requireHuman,
  revokeApiKey,
} from './auth';
import { ensureSchema } from './migrate';
import { HttpError, type Env, type Job, type Session } from './env';
import { accessToken, GoogleError, listSites } from './google';
import { encryptKey, forgetSiteAccounts, parseKeyFile, secretCredential } from './accounts';
import { discoverSites } from './sites';
import { isOverloaded } from './db';
import { handleMcp } from './mcp';
import { openapi } from './openapi';
import { callTool, TOOLS } from './tools';
import { planAllSyncs, runSyncJob } from './sync';
import { planInspections, refreshSitemaps, runInspectJob } from './indexing';
import { buildDigest, sendDigest } from './digest';
import { toCsv } from './util';

type App = { Bindings: Env; Variables: { session: Session } };
const app = new Hono<App>();

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-api-key, mcp-protocol-version, mcp-session-id',
  'access-control-max-age': '86400',
};

const isApi = (path: string) => path.startsWith('/api/') || path === '/mcp' || path.startsWith('/mcp/');

app.onError((err, c) => {
  const cors = isApi(c.req.path) ? CORS : {};
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400, cors);
  if (err instanceof GoogleError) return c.json({ error: err.message }, (err.status === 403 ? 403 : 502) as 502, cors);
  if (isOverloaded(err)) {
    return c.json({ error: 'The database is busy while a sync writes data. Try again in a few seconds.' }, 503, { ...cors, 'retry-after': '3' });
  }
  console.error(err);
  return c.json({ error: 'Internal error' }, 500, cors);
});

app.use('*', async (c, next) => {
  await next();
  // Asset responses have immutable headers; re-wrap before adding ours.
  c.res = new Response(c.res.body, c.res);
  if (isApi(c.req.path)) for (const [k, v] of Object.entries(CORS)) c.res.headers.set(k, v);
  c.res.headers.set('x-content-type-options', 'nosniff');
  c.res.headers.set('referrer-policy', 'same-origin');
});

app.options('*', (c) => (isApi(c.req.path) ? new Response(null, { status: 204, headers: CORS }) : c.text('', 404)));

// Public, data-free endpoints.
app.get('/healthz', (c) => c.json({ ok: true }));
app.get('/api/openapi.json', (c) => c.json(openapi(new URL(c.req.url).origin, c.env.APP_NAME)));

// Password sign-in (when ADMIN_PASSWORD is set). The login page and its stylesheet
// hold no data, so they are the only files served before authentication.
const PUBLIC_ASSETS = new Set(['/vendor/tabler.min.css', '/theme.css']);
// Assets serve public/login.html at /login (and redirect /login.html there).
app.get('/login', (c) => c.env.ASSETS.fetch(c.req.raw));
for (const path of PUBLIC_ASSETS) app.get(path, (c) => c.env.ASSETS.fetch(c.req.raw));

app.post('/auth/login', async (c) => {
  const origin = c.req.header('origin');
  if (origin && origin !== new URL(c.req.url).origin) throw new HttpError(403, 'Cross-origin request refused');
  const body = await c.req.json<{ password?: string }>().catch(() => ({}) as { password?: string });
  if (!(await checkPassword(c.req.raw, c.env, String(body.password || '')))) throw new HttpError(401, 'Wrong password');
  return c.json({ ok: true }, 200, { 'set-cookie': await createSessionCookie(c.env, new URL(c.req.url).protocol === 'https:') });
});

app.post('/auth/logout', (c) => c.json({ ok: true }, 200, { 'set-cookie': clearSessionCookie(new URL(c.req.url).protocol === 'https:') }));

// Everything else is authenticated, including static files.
app.use('*', async (c, next) => {
  try {
    c.set('session', await authenticate(c.req.raw, c.env, c.executionCtx));
  } catch (e) {
    // Browsers asking for a page get the login screen or setup instructions instead of JSON.
    const wantsHtml = c.req.method === 'GET' && !isApi(c.req.path) && (c.req.header('accept') || '').includes('text/html');
    if (wantsHtml && e instanceof HttpError) {
      if (passwordConfigured(c.env) && e.status === 401) return c.redirect('/login');
      if (!accessConfigured(c.env) && !passwordConfigured(c.env)) return c.html(setupPage(c.env.APP_NAME || 'Scry'), 403);
    }
    throw e;
  }
  await next();
});

app.get('/api/me', (c) => {
  const s = c.get('session');
  return c.json({ kind: s.kind, scope: s.scope, email: s.email ?? null, app: c.env.APP_NAME || 'Scry', password_session: s.email === 'admin' });
});

// API key management: signed-in humans only.
app.get('/api/keys', async (c) => {
  requireHuman(c.get('session'));
  const { results } = await c.env.DB.prepare(
    'SELECT id, name, prefix, scope, created_at, last_used_at, revoked_at FROM api_keys ORDER BY id DESC',
  ).all();
  return c.json({ keys: results });
});

app.post('/api/keys', async (c) => {
  requireHuman(c.get('session'));
  const body = await c.req.json<{ name?: string; scope?: string }>().catch(() => ({}) as { name?: string; scope?: string });
  const name = (body.name || '').trim().slice(0, 80);
  if (!name) throw new HttpError(400, 'name is required');
  const scope = body.scope === 'write' ? 'write' : 'read';
  return c.json(await createApiKey(c.env, name, scope), 201);
});

app.delete('/api/keys/:id', async (c) => {
  requireHuman(c.get('session'));
  await revokeApiKey(c.env, Number(c.req.param('id')));
  return c.json({ revoked: true });
});

// Service accounts: signed-in humans only. Key material never leaves the Worker.
app.get('/api/service-accounts', async (c) => {
  requireHuman(c.get('session'));
  const secret = secretCredential(c.env);
  const { results } = await c.env.DB.prepare(
    'SELECT id, client_email, project_id, private_key_id, created_at, last_ok_at, last_error FROM service_accounts ORDER BY id',
  ).all<Record<string, string | number | null>>();
  const props = (await c.env.DB.prepare('SELECT id, label, site_url, service_account_id FROM properties ORDER BY id').all<Record<string, unknown>>()).results;
  const usedBy = (id: number | null) => props.filter((p) => (p.service_account_id ?? null) === id).map((p) => ({ id: p.id, label: p.label }));
  return c.json({
    encryption_configured: Boolean(c.env.SA_ENCRYPTION_KEY && c.env.SA_ENCRYPTION_KEY.length >= 16),
    accounts: [
      ...(secret ? [{ id: null, client_email: secret.client_email, project_id: secret.project_id ?? null, key_id: (secret.private_key_id || '').slice(0, 8) || null, source: 'secret', removable: false, properties: usedBy(null) }] : []),
      ...results.map((r) => ({
        id: r.id,
        client_email: r.client_email,
        project_id: r.project_id,
        key_id: String(r.private_key_id || '').slice(0, 8) || null,
        source: 'uploaded',
        removable: true,
        created_at: r.created_at,
        last_ok_at: r.last_ok_at,
        last_error: r.last_error,
        properties: usedBy(Number(r.id)),
      })),
    ],
  });
});

app.post('/api/service-accounts', async (c) => {
  requireHuman(c.get('session'));
  if (!(c.req.header('content-type') || '').includes('application/json')) throw new HttpError(415, 'Upload the service account JSON key file.');
  if (Number(c.req.header('content-length') || 0) > 20_000) throw new HttpError(413, 'That file is too large to be a service account key.');
  const raw = await c.req.text();
  const key = parseKeyFile(raw);
  const cred = { id: null, client_email: key.email, ...JSON.parse(key.json) };
  // Prove the key works before storing it.
  await c.env.KV.delete(`google:token:${key.email}`);
  let sites: { siteUrl: string; permissionLevel: string }[];
  try {
    await accessToken(c.env, cred);
    sites = await listSites(c.env, cred);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const enc = await encryptKey(c.env, key.json);
  const now = new Date().toISOString();
  const row = await c.env.DB.prepare(
    `INSERT INTO service_accounts (client_email, project_id, private_key_id, key_ciphertext, key_iv, created_at, last_ok_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (client_email) DO UPDATE SET project_id = excluded.project_id, private_key_id = excluded.private_key_id,
       key_ciphertext = excluded.key_ciphertext, key_iv = excluded.key_iv, last_ok_at = excluded.last_ok_at, last_error = NULL
     RETURNING id`,
  )
    .bind(key.email, key.projectId, key.keyId, enc.ciphertext, enc.iv, now, now)
    .first<{ id: number }>();
  forgetSiteAccounts();
  await c.env.KV.put('cache:epoch', String(Date.now()));
  return c.json({ id: row!.id, client_email: key.email, sites }, 201);
});

app.delete('/api/service-accounts/:id', async (c) => {
  requireHuman(c.get('session'));
  const id = Number(c.req.param('id'));
  const acct = await c.env.DB.prepare('SELECT client_email FROM service_accounts WHERE id = ?').bind(id).first<{ client_email: string }>();
  if (!acct) throw new HttpError(404, 'No such service account');
  const users = (await c.env.DB.prepare('SELECT id, label, site_url FROM properties WHERE service_account_id = ?').bind(id).all<{ id: number; label: string; site_url: string }>()).results;
  const moves: { property: string; to: string }[] = [];
  if (users.length) {
    // Move each property to another account that can read it, or refuse.
    const { accounts } = await discoverSites(c.env);
    const others = accounts.filter((a) => a.id !== id && !a.error);
    const stuck: string[] = [];
    for (const p of users) {
      const alt = others.find((a) => a.sites.some((s) => s.siteUrl === p.site_url));
      if (alt) moves.push({ property: p.label, to: alt.client_email }), await c.env.DB.prepare('UPDATE properties SET service_account_id = ? WHERE id = ?').bind(alt.id, p.id).run();
      else stuck.push(p.label);
    }
    if (stuck.length) {
      throw new HttpError(409, `Can't remove ${acct.client_email}: no other service account can read ${stuck.join(', ')}. Add another account with access first, or delete those properties.`);
    }
  }
  await c.env.DB.prepare('DELETE FROM service_accounts WHERE id = ?').bind(id).run();
  await c.env.KV.delete(`google:token:${acct.client_email}`);
  forgetSiteAccounts();
  return c.json({ removed: acct.client_email, moved: moves });
});

app.get('/api/digest/preview', async (c) => {
  requireHuman(c.get('session'));
  const { html } = await buildDigest(c.env, new URL(c.req.url).origin);
  return c.html(html);
});

app.post('/api/digest/send', async (c) => {
  requireHuman(c.get('session'));
  return c.json(await sendDigest(c.env, new URL(c.req.url).origin));
});

// REST endpoints generated from the tool registry.
for (const tool of TOOLS) {
  app.on(tool.http.method, '/api' + tool.http.path, async (c) => {
    const url = new URL(c.req.url);
    const args: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(tool.input.properties)) {
      const all = url.searchParams.getAll(key);
      if (all.length) args[key] = schema.type === 'array' ? all.join(',') : all[0];
    }
    if (tool.http.method !== 'GET') {
      const ct = c.req.header('content-type') || '';
      if (ct.includes('application/json')) {
        const body = await c.req.json().catch(() => {
          throw new HttpError(400, 'Body must be valid JSON');
        });
        if (body && typeof body === 'object') Object.assign(args, body);
      }
    }
    Object.assign(args, c.req.param());
    const result = (await callTool(c.env, c.get('session'), tool.name, args)) as Record<string, unknown>;
    if (url.searchParams.get('format') === 'csv' && Array.isArray(result?.rows)) {
      return new Response(toCsv(result.rows as Record<string, unknown>[]), {
        headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${tool.name}.csv"` },
      });
    }
    return c.json(result);
  });
}

app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

app.all('/mcp', (c) => handleMcp(c.req.raw, c.env, c.get('session')));

// Dashboard (static assets, SPA fallback).
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

function setupPage(name: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}: finish setup</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:10vh auto;padding:0 20px;color:#1a1816;background:#fbfaf7}code{background:#f0ece4;padding:2px 6px;border-radius:4px}h1{font-size:1.6rem}</style></head>
<body><h1>${name} is deployed. One step left.</h1>
<p>Nobody can sign in yet, so the dashboard stays locked. Pick one:</p>
<ol><li><strong>Password:</strong> in the Cloudflare dashboard open this Worker → Settings → Variables and Secrets, and add secrets <code>ADMIN_PASSWORD</code> (12+ characters) and <code>SA_ENCRYPTION_KEY</code> (any long random string).</li>
<li><strong>Cloudflare Access:</strong> enable Access for this hostname, then set <code>ACCESS_TEAM_DOMAIN</code> and the <code>ACCESS_AUD</code> secret.</li></ol>
<p>Reload this page when you're done. The README has the full walkthrough.</p></body></html>`;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    if (!new URL(req.url).pathname.startsWith('/healthz')) await ensureSchema(env);
    return app.fetch(req, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    await ensureSchema(env);
    switch (controller.cron) {
      case '30 5 * * *':
        ctx.waitUntil(planInspections(env));
        break;
      case '0 7 * * 1':
        ctx.waitUntil(sendDigest(env).then((r) => console.log('digest', JSON.stringify(r))));
        break;
      default:
        ctx.waitUntil(planAllSyncs(env).then((n) => console.log('sync queued', n)));
    }
  },

  async queue(batch: MessageBatch<Job>, env: Env) {
    await ensureSchema(env);
    for (const msg of batch.messages) {
      const job = msg.body;
      try {
        if (job.kind === 'sync') await runSyncJob(env, job);
        else if (job.kind === 'inspect') await runInspectJob(env, job);
        else if (job.kind === 'sitemaps') {
          const p = await env.DB.prepare('SELECT * FROM properties WHERE id = ?').bind(job.propertyId).first();
          if (p) await refreshSitemaps(env, p as any);
        }
        msg.ack();
      } catch (e) {
        const message = (e as Error).message || String(e);
        console.error('job failed', JSON.stringify(job).slice(0, 200), message);
        if (job.kind === 'sync') {
          await env.DB.prepare(
            'UPDATE sync_jobs SET status = ?, error = ?, updated_at = ? WHERE property_id = ? AND search_type = ? AND data_state = ? AND date = ?',
          )
            .bind('error', message.slice(0, 500), new Date().toISOString(), job.propertyId, job.searchType, job.dataState, job.date)
            .run()
            .catch(() => {});
        }
        const rateLimited = e instanceof GoogleError && e.status === 429;
        if (e instanceof GoogleError && (e.status === 403 || e.status === 400)) msg.ack();
        else msg.retry({ delaySeconds: rateLimited ? 120 : 30 * (msg.attempts || 1) });
      }
    }
  },
};
