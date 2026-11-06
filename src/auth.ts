import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { HttpError, type Env, type Scope, type Session } from './env';
import { randomToken, sha256Hex } from './util';
import { withD1Retry } from './db';

type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

const jwksCache = new Map<string, JWTVerifyGetKey>();

function teamDomain(env: Env): string {
  return (env.ACCESS_TEAM_DOMAIN || '').replace(/\/+$/, '');
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

async function verifyAccess(req: Request, env: Env): Promise<Session | null> {
  const token = req.headers.get('cf-access-jwt-assertion') || readCookie(req.headers.get('cookie'), 'CF_Authorization');
  const domain = teamDomain(env);
  if (!token || !domain || !env.ACCESS_AUD) return null;
  let jwks = jwksCache.get(domain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${domain}/cdn-cgi/access/certs`));
    jwksCache.set(domain, jwks);
  }
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: domain, audience: env.ACCESS_AUD });
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : undefined;
    const allowed = (env.ALLOWED_EMAILS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (email && allowed.length && !allowed.includes(email)) return null;
    // Service-token JWTs carry common_name instead of email; Access already approved them.
    return { kind: 'human', scope: 'write', email: email || String(payload.common_name || 'service-token') };
  } catch {
    return null;
  }
}

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization');
  if (h && /^bearer\s+/i.test(h)) return h.replace(/^bearer\s+/i, '').trim();
  return req.headers.get('x-api-key');
}

async function verifyApiKey(req: Request, env: Env, ctx: WaitUntil): Promise<Session | null> {
  const key = bearer(req);
  if (!key || !key.startsWith('gsk_')) return null;
  const hash = await sha256Hex(key);
  // Key checks are cached in KV so a busy D1 (backfill) never locks API clients out.
  // Revoking a key deletes this entry, so revocation is immediate.
  const cacheKey = `apikey:${hash}`;
  let row = await env.KV.get<{ id: number; scope: Scope; last_used_at: string | null }>(cacheKey, 'json');
  if (!row) {
    row = await withD1Retry(() =>
      env.DB.prepare('SELECT id, scope, last_used_at FROM api_keys WHERE hash = ? AND revoked_at IS NULL')
        .bind(hash)
        .first<{ id: number; scope: Scope; last_used_at: string | null }>(),
    );
    if (!row) return null;
    await env.KV.put(cacheKey, JSON.stringify(row), { expirationTtl: 300 });
  }
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  if (!row.last_used_at || row.last_used_at < hourAgo) {
    const now = new Date().toISOString();
    ctx.waitUntil(
      env.DB.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
        .bind(now, row.id)
        .run()
        .then(() => env.KV.put(cacheKey, JSON.stringify({ ...row, last_used_at: now }), { expirationTtl: 300 }))
        .catch(() => {}),
    );
  }
  return { kind: 'key', scope: row.scope, keyId: row.id };
}

export async function revokeApiKey(env: Env, id: number) {
  const row = await env.DB.prepare('SELECT hash FROM api_keys WHERE id = ?').bind(id).first<{ hash: string }>();
  await env.DB.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(new Date().toISOString(), id).run();
  if (row) await env.KV.delete(`apikey:${row.hash}`);
}

function isLocal(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/** Returns a session or throws 401/403. Fails closed when nothing is configured. */
export const SESSION_COOKIE = 'scry_session';
const SESSION_DAYS = 30;
export const MIN_PASSWORD_LENGTH = 12;

export function passwordConfigured(env: Env): boolean {
  return Boolean(env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length >= MIN_PASSWORD_LENGTH && env.SA_ENCRYPTION_KEY);
}

export function accessConfigured(env: Env): boolean {
  return Boolean(teamDomain(env) && env.ACCESS_AUD);
}

/** HMAC key for session cookies. Changing ADMIN_PASSWORD or SA_ENCRYPTION_KEY signs everyone out. */
async function sessionKey(env: Env): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`scry-session|${env.ADMIN_PASSWORD}|${env.SA_ENCRYPTION_KEY}`));
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export async function createSessionCookie(env: Env, secure: boolean): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const sig = await crypto.subtle.sign('HMAC', await sessionKey(env), new TextEncoder().encode(`v1.${exp}`));
  return `${SESSION_COOKIE}=v1.${exp}.${b64url(sig)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

async function verifyPasswordSession(req: Request, env: Env): Promise<Session | null> {
  if (!passwordConfigured(env)) return null;
  const v = readCookie(req.headers.get('cookie'), SESSION_COOKIE);
  const m = v?.match(/^v1\.(\d+)\.([A-Za-z0-9_-]+)$/);
  if (!m || Number(m[1]) < Date.now() / 1000) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await sessionKey(env), unb64url(m[2]), new TextEncoder().encode(`v1.${m[1]}`));
    return ok ? { kind: 'human', scope: 'write', email: 'admin' } : null;
  } catch {
    return null;
  }
}

/** Constant-time password check with a per-IP attempt limit. */
export async function checkPassword(req: Request, env: Env, password: string): Promise<boolean> {
  if (!passwordConfigured(env)) throw new HttpError(403, 'Password sign-in is not enabled on this deployment.');
  const ip = req.headers.get('cf-connecting-ip') || 'unknown';
  const key = `login:${await sha256Hex(ip)}`;
  const tries = Number((await env.KV.get(key)) || 0);
  if (tries >= 10) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(password)),
    crypto.subtle.digest('SHA-256', enc.encode(env.ADMIN_PASSWORD!)),
  ]);
  const ok = (crypto.subtle as SubtleCrypto & { timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean }).timingSafeEqual(a, b);
  if (!ok) await env.KV.put(key, String(tries + 1), { expirationTtl: 900 });
  else await env.KV.delete(key);
  return ok;
}

/** Returns a session or throws 401/403. Fails closed when nothing is configured. */
export async function authenticate(req: Request, env: Env, ctx: WaitUntil): Promise<Session> {
  const url = new URL(req.url);
  const keySession = await verifyApiKey(req, env, ctx);
  if (keySession) return keySession;
  if (bearer(req)) throw new HttpError(401, 'Invalid or revoked API key');

  const mode = (env.AUTH_MODE || '').toLowerCase();
  if (mode === 'none') {
    if (isLocal(url)) return { kind: 'human', scope: 'write', email: 'local' };
    throw new HttpError(403, 'AUTH_MODE=none is only allowed on localhost');
  }
  const human = (await verifyAccess(req, env)) || (await verifyPasswordSession(req, env));
  if (human) {
    // CSRF guard for cookie sessions: state-changing requests must come from this origin.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.get('origin');
      if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-origin request refused');
    }
    return human;
  }
  if (!accessConfigured(env) && !passwordConfigured(env)) {
    throw new HttpError(403, 'Sign-in is not configured. Set the ADMIN_PASSWORD secret, or set up Cloudflare Access (ACCESS_TEAM_DOMAIN + ACCESS_AUD).');
  }
  throw new HttpError(401, 'Sign in, or send an API key');
}

export function requireScope(session: Session, scope: Scope) {
  if (scope === 'write' && session.scope !== 'write') throw new HttpError(403, 'This action needs a write-scope key');
}

export function requireHuman(session: Session) {
  if (session.kind !== 'human') throw new HttpError(403, 'Only a signed-in user can manage API keys');
}

export async function createApiKey(env: Env, name: string, scope: Scope) {
  const key = 'gsk_' + randomToken(32);
  const hash = await sha256Hex(key);
  const res = await env.DB.prepare(
    'INSERT INTO api_keys (name, prefix, hash, scope, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
  )
    .bind(name, key.slice(0, 10), hash, scope, new Date().toISOString())
    .first<{ id: number }>();
  return { id: res!.id, key, name, scope };
}
