import { HttpError, type Env, type Property, type SearchType } from './env';
import { sqlStr } from './util';

export const SEARCH_TYPES: SearchType[] = ['web', 'image', 'video', 'news', 'discover', 'googleNews'];

export async function listProperties(env: Env, activeOnly = false): Promise<Property[]> {
  const sql = activeOnly ? 'SELECT * FROM properties WHERE active = 1 ORDER BY id' : 'SELECT * FROM properties ORDER BY id';
  const { results } = await env.DB.prepare(sql).all<Property>();
  return results;
}

function normalizeRef(s: string) {
  return s
    .trim()
    .toLowerCase()
    .replace(/^sc-domain:/, '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

/** Accepts an id, exact site_url, label, or bare domain ("example.com"). */
export async function resolveProperty(env: Env, ref: string | number | undefined): Promise<Property> {
  if (ref === undefined || ref === null || ref === '') throw new HttpError(400, 'property is required');
  const props = await listProperties(env);
  const s = String(ref);
  const byId = /^\d+$/.test(s) ? props.find((p) => p.id === Number(s)) : undefined;
  const found =
    byId ||
    props.find((p) => p.site_url === s) ||
    props.find((p) => p.label.toLowerCase() === s.toLowerCase()) ||
    props.find((p) => normalizeRef(p.site_url) === normalizeRef(s));
  if (!found) throw new HttpError(404, `Unknown property "${s}". Call list_properties to see what is tracked.`);
  return found;
}

export function propertySearchTypes(p: Property): SearchType[] {
  return p.search_types
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is SearchType => (SEARCH_TYPES as string[]).includes(s));
}

export function brandTerms(p: Property): string[] {
  try {
    const v = JSON.parse(p.brand_terms);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().toLowerCase()) : [];
  } catch {
    return [];
  }
}

const MAX_STMT_BYTES = 90_000;
const enc = new TextEncoder();

/**
 * Builds multi-row INSERT statements from pre-escaped value tuples, each under
 * D1's 100 KB statement limit. Values must already be SQL literals (sqlStr/sqlNum).
 */
export function buildInserts(prefix: string, tuples: string[]): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let size = enc.encode(prefix).length;
  for (const t of tuples) {
    const len = enc.encode(t).length + 1;
    if (cur.length && size + len > MAX_STMT_BYTES) {
      out.push(prefix + cur.join(','));
      cur = [];
      size = enc.encode(prefix).length;
    }
    cur.push(t);
    size += len;
  }
  if (cur.length) out.push(prefix + cur.join(','));
  return out;
}

/** Runs raw SQL statements in D1 batches (atomic per batch). */
export async function execMany(env: Env, sqls: string[], perBatch = 8, pauseMs = 0) {
  for (let i = 0; i < sqls.length; i += perBatch) {
    if (i && pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
    await withD1Retry(() => env.DB.batch(sqls.slice(i, i + perBatch).map((s) => env.DB.prepare(s))), 6);
  }
}

export function tuple(...vals: string[]) {
  return '(' + vals.join(',') + ')';
}

export { sqlStr };

/** D1 sheds load with this error when writes (e.g. a backfill) use up its window. */
export function isOverloaded(e: unknown): boolean {
  const m = String((e as Error)?.message || e);
  return /overloaded|too many resources consumed|D1_ERROR: .*busy/i.test(m);
}

export async function withD1Retry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isOverloaded(e) || i >= attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 400 * 2 ** i + Math.random() * 250));
    }
  }
}
