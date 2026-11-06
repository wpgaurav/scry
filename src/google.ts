import { importPKCS8, SignJWT } from 'jose';
import { HttpError, type DataState, type Env, type SearchType } from './env';
import { credentialForSite, secretCredential, type Credential } from './accounts';

const SCOPE = 'https://www.googleapis.com/auth/webmasters';
const BASE = 'https://searchconsole.googleapis.com';

const memTokens = new Map<string, { token: string; exp: number }>();

export class GoogleError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Email of the GSC_SA_KEY secret account, if set. */
export function serviceAccountEmail(env: Env): string | null {
  return secretCredential(env)?.client_email ?? null;
}

export async function accessToken(env: Env, cred: Credential): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const mem = memTokens.get(cred.client_email);
  if (mem && mem.exp - 120 > now) return mem.token;
  const kvKey = `google:token:${cred.client_email}`;
  const cached = await env.KV.get<{ token: string; exp: number }>(kvKey, 'json');
  if (cached && cached.exp - 120 > now) {
    memTokens.set(cred.client_email, cached);
    return cached.token;
  }
  const tokenUri = cred.token_uri || 'https://oauth2.googleapis.com/token';
  let key: CryptoKey;
  try {
    key = await importPKCS8(cred.private_key, 'RS256');
  } catch {
    throw new HttpError(400, `The private key for ${cred.client_email} could not be read.`);
  }
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(cred.client_email)
    .setAudience(tokenUri)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const b = (await res.json()) as { error_description?: string; error?: string };
      detail = b.error_description || b.error || '';
    } catch {}
    throw new GoogleError(res.status, `Google rejected the key for ${cred.client_email} (${res.status}${detail ? ': ' + detail : ''})`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  const tok = { token: json.access_token, exp: now + json.expires_in };
  memTokens.set(cred.client_email, tok);
  await env.KV.put(kvKey, JSON.stringify(tok), { expirationTtl: Math.max(60, json.expires_in - 300) });
  return json.access_token;
}

async function gfetch<T>(env: Env, cred: Credential, path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
  const token = await accessToken(env, cred);
  const res = await fetch(BASE + path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  if (res.status === 401 && attempt === 0) {
    memTokens.delete(cred.client_email);
    await env.KV.delete(`google:token:${cred.client_email}`);
    return gfetch(env, cred, path, init, attempt + 1);
  }
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 300));
    return gfetch(env, cred, path, init, attempt + 1);
  }
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) msg = `${res.status}: ${body.error.message}`;
    } catch {}
    throw new GoogleError(res.status, `Search Console API ${msg}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** Calls the API as whichever service account the property is assigned to. */
async function siteFetch<T>(env: Env, siteUrl: string, path: string, init: RequestInit = {}) {
  return gfetch<T>(env, await credentialForSite(env, siteUrl), path, init);
}

const site = (siteUrl: string) => encodeURIComponent(siteUrl);

export type Dimension = 'date' | 'query' | 'page' | 'country' | 'device' | 'searchAppearance' | 'hour';

export interface DimensionFilter {
  dimension: Exclude<Dimension, 'date' | 'hour'>;
  operator?: 'equals' | 'notEquals' | 'contains' | 'notContains' | 'includingRegex' | 'excludingRegex';
  expression: string;
}

export interface SearchAnalyticsRequest {
  startDate: string;
  endDate: string;
  dimensions?: Dimension[];
  type?: SearchType;
  dimensionFilterGroups?: { groupType?: 'and'; filters: DimensionFilter[] }[];
  aggregationType?: 'auto' | 'byPage' | 'byProperty' | 'byNewsShowcasePanel';
  rowLimit?: number;
  startRow?: number;
  dataState?: DataState | 'hourly_all';
}

export interface SearchAnalyticsRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export async function searchAnalytics(env: Env, siteUrl: string, body: SearchAnalyticsRequest) {
  const res = await siteFetch<{ rows?: SearchAnalyticsRow[] }>(env, siteUrl, `/webmasters/v3/sites/${site(siteUrl)}/searchAnalytics/query`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.rows || [];
}

/** Pages through results 25k rows at a time. */
export async function searchAnalyticsAll(env: Env, siteUrl: string, body: SearchAnalyticsRequest, maxPages = 8) {
  const out: SearchAnalyticsRow[] = [];
  const limit = 25000;
  for (let page = 0; page < maxPages; page++) {
    const rows = await searchAnalytics(env, siteUrl, { ...body, rowLimit: limit, startRow: page * limit });
    out.push(...rows);
    if (rows.length < limit) break;
  }
  return out;
}

export interface GscSite {
  siteUrl: string;
  permissionLevel: string;
}

export async function listSites(env: Env, cred: Credential): Promise<GscSite[]> {
  const res = await gfetch<{ siteEntry?: GscSite[] }>(env, cred, '/webmasters/v3/sites');
  return res.siteEntry || [];
}

export interface Sitemap {
  path: string;
  lastSubmitted?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  type?: string;
  lastDownloaded?: string;
  warnings?: string;
  errors?: string;
  contents?: { type: string; submitted?: string; indexed?: string }[];
}

export async function listSitemaps(env: Env, siteUrl: string): Promise<Sitemap[]> {
  const res = await siteFetch<{ sitemap?: Sitemap[] }>(env, siteUrl, `/webmasters/v3/sites/${site(siteUrl)}/sitemaps`);
  return res.sitemap || [];
}

export async function submitSitemap(env: Env, siteUrl: string, feedpath: string) {
  await siteFetch(env, siteUrl, `/webmasters/v3/sites/${site(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`, { method: 'PUT' });
}

export interface InspectionResult {
  inspectionResultLink?: string;
  indexStatusResult?: {
    verdict?: string;
    coverageState?: string;
    robotsTxtState?: string;
    indexingState?: string;
    lastCrawlTime?: string;
    pageFetchState?: string;
    googleCanonical?: string;
    userCanonical?: string;
    crawledAs?: string;
    sitemap?: string[];
    referringUrls?: string[];
  };
  richResultsResult?: { verdict?: string; detectedItems?: { richResultType: string }[] };
  mobileUsabilityResult?: { verdict?: string };
}

export async function inspectUrl(env: Env, siteUrl: string, url: string): Promise<InspectionResult> {
  const res = await siteFetch<{ inspectionResult: InspectionResult }>(env, siteUrl, '/v1/urlInspection/index:inspect', {
    method: 'POST',
    body: JSON.stringify({ inspectionUrl: url, siteUrl, languageCode: 'en-US' }),
  });
  return res.inspectionResult;
}
