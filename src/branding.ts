/**
 * White-label branding: name, logos, favicon, accent colour and login message.
 * Text settings live in D1 (settings table); image files live in KV.
 * The accent palette is derived so every text use clears 7:1 contrast in both themes.
 */
import { HttpError, type Env } from './env';

export const ASSETS = ['logo-light', 'logo-dark', 'favicon'] as const;
export type BrandAsset = (typeof ASSETS)[number];
export const MAX_ASSET_BYTES = 512 * 1024;
export const DEFAULT_ACCENT = '#c0392b';

export interface Branding {
  name: string;
  accent: string;
  login_message: string;
  show_name: boolean;
  version: string;
  assets: Partial<Record<BrandAsset, string>>; // asset -> content type
}

let memo: { at: number; value: Branding } | null = null;

export function forgetBranding() {
  memo = null;
}

export async function getBranding(env: Env): Promise<Branding> {
  if (memo && Date.now() - memo.at < 30_000) return memo.value;
  let rows: { key: string; value: string }[] = [];
  try {
    rows = (await env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'brand.%'").all<{ key: string; value: string }>()).results;
  } catch {
    // Settings table not created yet (first request before migrations): use defaults.
  }
  const m = new Map(rows.map((r) => [r.key, r.value]));
  const assets: Branding['assets'] = {};
  for (const a of ASSETS) {
    const t = m.get(`brand.asset.${a}`);
    if (t) assets[a] = t;
  }
  const value: Branding = {
    name: m.get('brand.name') || env.APP_NAME || 'Scry',
    accent: m.get('brand.accent') || DEFAULT_ACCENT,
    login_message: m.get('brand.login_message') || '',
    show_name: m.get('brand.show_name') !== '0',
    version: m.get('brand.version') || '0',
    assets,
  };
  memo = { at: Date.now(), value };
  return value;
}

async function setSettings(env: Env, entries: [string, string | null][]) {
  const now = new Date().toISOString();
  const stmts = entries.map(([k, v]) =>
    v === null
      ? env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(k)
      : env.DB.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind(k, v, now),
  );
  stmts.push(
    env.DB.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind(
      'brand.version',
      String(Date.now()),
      now,
    ),
  );
  await env.DB.batch(stmts);
  forgetBranding();
}

export async function saveBranding(env: Env, input: Record<string, unknown>) {
  const entries: [string, string | null][] = [];
  if (input.name !== undefined) {
    const name = String(input.name).trim().slice(0, 40);
    entries.push(['brand.name', name || null]);
  }
  if (input.accent !== undefined) {
    const accent = String(input.accent).trim().toLowerCase();
    if (accent && !/^#[0-9a-f]{6}$/.test(accent)) throw new HttpError(400, 'Accent must be a hex colour like #c0392b');
    entries.push(['brand.accent', accent || null]);
  }
  if (input.login_message !== undefined) entries.push(['brand.login_message', String(input.login_message).trim().slice(0, 280) || null]);
  if (input.show_name !== undefined) entries.push(['brand.show_name', input.show_name ? '1' : '0']);
  await setSettings(env, entries);
  return getBranding(env);
}

export async function resetBranding(env: Env) {
  await Promise.all(ASSETS.map((a) => env.KV.delete(`brand:asset:${a}`)));
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'brand.%'").run();
  await setSettings(env, []);
  return getBranding(env);
}

// ---------- image files ----------

const SVG_DANGER = /<script|<foreignobject|<iframe|<embed|<object|<use[^>]+href\s*=\s*["']?\s*https?:|\son[a-z]+\s*=|javascript:|(?:xlink:)?href\s*=\s*["']\s*(?!#|data:image\/)[^"'\s]/i;

/** Detects the real file type from its bytes. Never trusts the declared type. */
export function sniffImage(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp';
  if (b.length > 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon';
  const head = new TextDecoder().decode(b.slice(0, 2048)).replace(/^﻿/, '').trimStart().toLowerCase();
  if ((head.startsWith('<svg') || head.startsWith('<?xml')) && head.includes('<svg')) return 'image/svg+xml';
  return null;
}

export function validateImage(bytes: Uint8Array, asset: BrandAsset): string {
  if (!bytes.length) throw new HttpError(400, 'The file is empty.');
  if (bytes.length > MAX_ASSET_BYTES) throw new HttpError(413, 'Images must be 512 KB or smaller.');
  const type = sniffImage(bytes);
  if (!type) throw new HttpError(415, 'Use a PNG, JPEG, WebP or SVG file' + (asset === 'favicon' ? ', or an ICO' : '') + '.');
  if (type === 'image/x-icon' && asset !== 'favicon') throw new HttpError(415, 'ICO files are only accepted for the favicon.');
  if (type === 'image/svg+xml' && SVG_DANGER.test(new TextDecoder().decode(bytes))) {
    throw new HttpError(400, 'This SVG contains scripts, event handlers or external links. Export a plain SVG and try again.');
  }
  return type;
}

export async function saveAsset(env: Env, asset: BrandAsset, bytes: Uint8Array) {
  const type = validateImage(bytes, asset);
  await env.KV.put(`brand:asset:${asset}`, bytes, { metadata: { type } });
  await setSettings(env, [[`brand.asset.${asset}`, type]]);
  return getBranding(env);
}

export async function deleteAsset(env: Env, asset: BrandAsset) {
  await env.KV.delete(`brand:asset:${asset}`);
  await setSettings(env, [[`brand.asset.${asset}`, null]]);
  return getBranding(env);
}

const DEFAULT_FAVICON = (accent: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19l4-6 4 3 4-7 4 4"/></svg>`;

/** Serves a brand image. SVGs get a sandboxing CSP so they can never run script. */
export async function assetResponse(env: Env, asset: BrandAsset): Promise<Response> {
  const headers: Record<string, string> = {
    'cache-control': 'public, max-age=300',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  };
  const stored = await env.KV.getWithMetadata<{ type: string }>(`brand:asset:${asset}`, 'arrayBuffer');
  if (stored.value && stored.metadata?.type) return new Response(stored.value, { headers: { ...headers, 'content-type': stored.metadata.type } });
  if (asset === 'favicon') {
    const b = await getBranding(env);
    // Fall back to the uploaded light logo, then to the default mark.
    const logo = await env.KV.getWithMetadata<{ type: string }>('brand:asset:logo-light', 'arrayBuffer');
    if (logo.value && logo.metadata?.type) return new Response(logo.value, { headers: { ...headers, 'content-type': logo.metadata.type } });
    return new Response(DEFAULT_FAVICON(b.accent), { headers: { ...headers, 'content-type': 'image/svg+xml' } });
  }
  return new Response('Not found', { status: 404, headers });
}

// ---------- colour ----------

const hexToRgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgbToHex = (c: number[]) => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
const mix = (a: string, b: string, t: number) => {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex(x.map((v, i) => v + (y[i] - v) * t));
};
function luminance(h: string) {
  const [r, g, b] = hexToRgb(h).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

const LIGHT_SURFACES = ['#ffffff', '#fbfaf7', '#f3f0ea'];
const DARK_SURFACES = ['#1c1b19', '#141312', '#25231f'];

/** Moves a colour toward `target` until it meets `ratio` against every surface. */
function reach(hex: string, target: string, surfaces: string[], ratio: number) {
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const c = mix(hex, target, t);
    if (surfaces.every((s) => contrast(c, s) >= ratio)) return c;
  }
  return target;
}

export function palette(accent: string) {
  const a = /^#[0-9a-f]{6}$/i.test(accent) ? accent.toLowerCase() : DEFAULT_ACCENT;
  const light = {
    accent: reach(a, '#000000', ['#ffffff'], 3), // non-text: chart lines, focus rings
    ink: reach(a, '#000000', LIGHT_SURFACES, 7), // text and filled buttons
  };
  const dark = {
    accent: reach(a, '#ffffff', ['#141312'], 3),
    ink: reach(a, '#ffffff', DARK_SURFACES, 7),
  };
  return {
    light: { ...light, darken: mix(light.ink, '#000000', 0.15), lt: mix(light.ink, '#ffffff', 0.9), fg: '#ffffff' },
    dark: { ...dark, darken: mix(dark.ink, '#ffffff', 0.2), lt: mix(dark.ink, '#141312', 0.82), fg: '#141312' },
  };
}

export async function brandCss(env: Env) {
  const b = await getBranding(env);
  const p = palette(b.accent);
  const block = (x: ReturnType<typeof palette>['light']) => {
    const rgb = hexToRgb(x.ink).join(', ');
    return `--gt-accent:${x.accent};--gt-accent-ink:${x.ink};--tblr-primary:${x.ink};--tblr-primary-rgb:${rgb};--tblr-primary-fg:${x.fg};--tblr-primary-darken:${x.darken};--tblr-primary-lt:${x.lt};--tblr-link-color:${x.ink};--tblr-link-color-rgb:${rgb};--tblr-link-hover-color:${x.darken};`;
  };
  return `/* Generated from Settings → Branding (version ${b.version}). */\n:root,[data-bs-theme="light"]{${block(p.light)}}\n[data-bs-theme="dark"]{${block(p.dark)}}\n`;
}

export function isAsset(s: string): s is BrandAsset {
  return (ASSETS as readonly string[]).includes(s);
}
