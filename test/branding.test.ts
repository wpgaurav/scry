import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { contrast, forgetBranding, palette, saveAsset, saveBranding, sniffImage, validateImage } from '../src/branding';
import { makeKey } from './helpers';

const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const get = (path: string, init: RequestInit = {}) => worker.fetch(new Request('https://scry.test' + path, init));
const enc = (s: string) => new TextEncoder().encode(s);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'brand.%'").run();
  forgetBranding();
});

describe('images', () => {
  it('detects real file types from bytes', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(enc('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml');
    expect(sniffImage(enc('<html><script>alert(1)</script>'))).toBeNull();
  });

  it('rejects SVGs that could run code or call out', () => {
    for (const bad of [
      '<svg><script>alert(1)</script></svg>',
      '<svg onload="alert(1)"></svg>',
      '<svg><a href="javascript:alert(1)">x</a></svg>',
      '<svg><image href="https://tracker.example/p.png"/></svg>',
      '<svg><foreignObject><div>x</div></foreignObject></svg>',
    ]) {
      expect(() => validateImage(enc(bad), 'logo-light')).toThrow();
    }
    expect(validateImage(enc('<svg xmlns="http://www.w3.org/2000/svg"><use href="#a"/></svg>'), 'logo-light')).toBe('image/svg+xml');
  });

  it('enforces size and ICO rules', () => {
    expect(() => validateImage(new Uint8Array(600 * 1024).fill(0x89), 'logo-light')).toThrow(/512 KB/);
    expect(() => validateImage(new Uint8Array([0, 0, 1, 0, 1, 0]), 'logo-light')).toThrow(/favicon/);
    expect(validateImage(new Uint8Array([0, 0, 1, 0, 1, 0]), 'favicon')).toBe('image/x-icon');
  });
});

describe('accent palette', () => {
  it('keeps 7:1 text contrast for any accent in both themes', () => {
    for (const accent of ['#c0392b', '#ffd400', '#7fc8ff', '#00ff00', '#111111', '#ffffff']) {
      const p = palette(accent);
      for (const s of ['#ffffff', '#fbfaf7', '#f3f0ea']) expect(contrast(p.light.ink, s)).toBeGreaterThanOrEqual(7);
      for (const s of ['#1c1b19', '#141312', '#25231f']) expect(contrast(p.dark.ink, s)).toBeGreaterThanOrEqual(7);
      expect(contrast(p.light.fg, p.light.ink)).toBeGreaterThanOrEqual(7);
      expect(contrast(p.dark.fg, p.dark.ink)).toBeGreaterThanOrEqual(7);
    }
  });
});

describe('routes', () => {
  it('serves brand CSS, JSON and the default favicon publicly', async () => {
    await saveBranding(env as any, { name: 'Acme Search', accent: '#0a7d5a' });
    const css = await get('/brand.css');
    expect(css.status).toBe(200);
    expect(await css.text()).toContain('--tblr-primary:');
    const json = (await (await get('/brand.json')).json()) as any;
    expect(json.name).toBe('Acme Search');
    const fav = await get('/brand/favicon');
    expect(fav.headers.get('content-type')).toBe('image/svg+xml');
    expect(fav.headers.get('content-security-policy')).toContain('sandbox');
  });

  it('serves uploaded logos with their sniffed type', async () => {
    await saveAsset(env as any, 'logo-light', PNG);
    const res = await get('/brand/logo-light');
    expect(res.headers.get('content-type')).toBe('image/png');
    expect((await get('/brand/nope')).status).toBe(404);
  });

  it('keeps branding changes away from API keys', async () => {
    const key = await makeKey('write');
    const auth = { authorization: `Bearer ${key}` };
    expect((await get('/api/branding', { headers: auth })).status).toBe(403);
    expect((await get('/api/branding/logo-light', { method: 'PUT', headers: { ...auth, 'content-type': 'image/png' }, body: PNG })).status).toBe(403);
  });
});
