import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { ensureSchema } from '../src/migrate';

const PW = 'correct horse battery staple';
const base = { ...env, ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', AUTH_MODE: '' } as any;
const withPw = { ...base, ADMIN_PASSWORD: PW, SA_ENCRYPTION_KEY: 'unit-test-encryption-key-123' };

async function call(e: any, path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request('https://scry.test' + path, init), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe('first run', () => {
  it('shows setup instructions when no sign-in method is configured', async () => {
    const res = await call(base, '/', { headers: { accept: 'text/html' } });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('One step left');
  });

  it('applies migrations idempotently', async () => {
    await ensureSchema(env as any);
    await ensureSchema(env as any);
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM d1_migrations WHERE name LIKE '000%'").first<{ n: number }>();
    expect(r!.n).toBeGreaterThanOrEqual(2);
  });
});

describe('password sign-in', () => {
  it('redirects browsers to the login page', async () => {
    const res = await call(withPw, '/', { headers: { accept: 'text/html' }, redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('serves the login page without a session', async () => {
    expect((await call(withPw, '/login')).status).toBe(200);
  });

  it('rejects a wrong password and cross-origin attempts', async () => {
    const bad = await call(withPw, '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) });
    expect(bad.status).toBe(401);
    const xo = await call(withPw, '/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.test' },
      body: JSON.stringify({ password: PW }),
    });
    expect(xo.status).toBe(403);
  });

  it('issues a session cookie that unlocks the API', async () => {
    const ok = await call(withPw, '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW }) });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    const me = await call(withPw, '/api/me', { headers: { cookie: cookie.split(';')[0] } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as any).password_session).toBe(true);
    // Changing the password invalidates existing sessions.
    const after = await call({ ...withPw, ADMIN_PASSWORD: 'a different long password' }, '/api/me', { headers: { cookie: cookie.split(';')[0] } });
    expect(after.status).toBe(401);
  });

  it('ignores passwords shorter than 12 characters', async () => {
    const res = await call({ ...withPw, ADMIN_PASSWORD: 'short' }, '/', { headers: { accept: 'text/html' } });
    expect(res.status).toBe(403);
  });
});
