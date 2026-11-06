/**
 * Content groups: named sets of pages matched by URL path patterns, e.g. "/blog/*".
 * Patterns become SQL LIKE clauses for stored data and RE2 regexes for live queries.
 */
import { HttpError, type Env, type Property } from './env';

export interface ContentGroup {
  id: number;
  property_id: number;
  name: string;
  include: string[];
  exclude: string[];
}

interface Row {
  id: number;
  property_id: number;
  name: string;
  include_patterns: string;
  exclude_patterns: string;
}

const toGroup = (r: Row): ContentGroup => ({
  id: r.id,
  property_id: r.property_id,
  name: r.name,
  include: JSON.parse(r.include_patterns || '[]'),
  exclude: JSON.parse(r.exclude_patterns || '[]'),
});

/** "/blog/*" style patterns. A pattern without a leading "/" matches anywhere in the path. */
export function normalizePatterns(list: unknown): string[] {
  const arr = Array.isArray(list) ? list : typeof list === 'string' ? list.split(/[\n,]/) : [];
  const out = [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];
  for (const p of out) {
    if (p.length > 200) throw new HttpError(400, 'Patterns must be under 200 characters');
    if (/[\s"'<>]/.test(p)) throw new HttpError(400, `Pattern "${p}" contains spaces or quotes`);
  }
  if (out.length > 50) throw new HttpError(400, 'Up to 50 patterns per list');
  return out;
}

/** SQLite expression for the path of a full URL column ("https://host/a/b?x" -> "/a/b?x"). */
export const pathExpr = (col: string) => `substr(${col}, instr(substr(${col}, 9), '/') + 8)`;

/** "/blog/" (no wildcard) means "starts with /blog/". */
const asGlob = (p: string) => (p.startsWith('/') && !p.includes('*') ? p + '*' : p);

function globToLike(raw: string) {
  const p = asGlob(raw);
  const escaped = p.replace(/[\\%_]/g, (m) => '\\' + m).replace(/\*/g, '%');
  return p.startsWith('/') ? escaped : '%' + escaped + '%';
}

function globToRegex(raw: string) {
  const p = asGlob(raw);
  const body = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return p.startsWith('/') ? `^https?://[^/]+${body}$` : `^https?://[^/]+/.*${body}`;
}

/** SQL condition (with params) that a URL column belongs to the group. */
export function groupSql(g: ContentGroup, col: string): { sql: string; params: string[] } {
  const path = pathExpr(col);
  const inc = g.include.map(() => `${path} LIKE ? ESCAPE '\\'`).join(' OR ');
  const exc = g.exclude.map(() => `${path} LIKE ? ESCAPE '\\'`).join(' OR ');
  return {
    sql: `(${inc || '1=0'})${exc ? ` AND NOT (${exc})` : ''}`,
    params: [...g.include.map(globToLike), ...g.exclude.map(globToLike)],
  };
}

/** RE2 page filters for live Search Analytics queries. */
export function groupRegexFilters(g: ContentGroup) {
  const f: { dimension: 'page'; operator: 'includingRegex' | 'excludingRegex'; expression: string }[] = [];
  if (g.include.length) f.push({ dimension: 'page', operator: 'includingRegex', expression: g.include.map(globToRegex).join('|') });
  if (g.exclude.length) f.push({ dimension: 'page', operator: 'excludingRegex', expression: g.exclude.map(globToRegex).join('|') });
  return f;
}

export async function listContentGroups(env: Env, p: Property): Promise<ContentGroup[]> {
  const { results } = await env.DB.prepare('SELECT * FROM content_groups WHERE property_id = ? ORDER BY name').bind(p.id).all<Row>();
  return results.map(toGroup);
}

export async function findContentGroup(env: Env, p: Property, ref: string | number): Promise<ContentGroup> {
  const s = String(ref);
  const row = await env.DB.prepare('SELECT * FROM content_groups WHERE property_id = ? AND (name = ? OR CAST(id AS TEXT) = ?)')
    .bind(p.id, s, s)
    .first<Row>();
  if (!row) throw new HttpError(404, `No content group "${s}". Call list_content_groups to see them.`);
  return toGroup(row);
}

export async function saveContentGroup(env: Env, p: Property, name: string, include: unknown, exclude: unknown) {
  const n = String(name || '').trim().slice(0, 60);
  if (!n) throw new HttpError(400, 'name is required');
  const inc = normalizePatterns(include);
  if (!inc.length) throw new HttpError(400, 'Add at least one include pattern, e.g. /blog/*');
  const exc = normalizePatterns(exclude);
  await env.DB.prepare(
    `INSERT INTO content_groups (property_id, name, include_patterns, exclude_patterns, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (property_id, name) DO UPDATE SET include_patterns = excluded.include_patterns, exclude_patterns = excluded.exclude_patterns`,
  )
    .bind(p.id, n, JSON.stringify(inc), JSON.stringify(exc), new Date().toISOString())
    .run();
  const g = await findContentGroup(env, p, n);
  const matched = await countPages(env, p, g);
  return { group: g, matching_pages: matched };
}

export async function deleteContentGroup(env: Env, p: Property, ref: string) {
  const g = await findContentGroup(env, p, ref);
  await env.DB.prepare('DELETE FROM content_groups WHERE id = ?').bind(g.id).run();
  return { deleted: g.name };
}

export async function countPages(env: Env, p: Property, g: ContentGroup) {
  const c = groupSql(g, 'url');
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM pages WHERE property_id = ? AND ${c.sql}`)
    .bind(p.id, ...c.params)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** Sample of matching URLs, for previewing patterns before saving. */
export async function previewPatterns(env: Env, p: Property, include: unknown, exclude: unknown, limit = 20) {
  const g: ContentGroup = { id: 0, property_id: p.id, name: 'preview', include: normalizePatterns(include), exclude: normalizePatterns(exclude) };
  const c = groupSql(g, 'url');
  const [rows, count] = await Promise.all([
    env.DB.prepare(`SELECT url FROM pages WHERE property_id = ? AND ${c.sql} ORDER BY length(url) LIMIT ?`).bind(p.id, ...c.params, limit).all<{ url: string }>(),
    countPages(env, p, g),
  ]);
  return { matching_pages: count, sample: rows.results.map((r) => r.url) };
}
