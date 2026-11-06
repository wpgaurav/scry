/**
 * Annotations: dated notes shown on charts and returned with time series, so people
 * and AI tools can line up traffic changes with releases, incidents and Google updates.
 */
import { HttpError, type Env, type Property } from './env';
import { isDate } from './util';

export const CATEGORIES = ['note', 'release', 'content', 'technical', 'incident', 'google'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Annotation {
  id: number;
  property_id: number | null;
  date: string;
  end_date: string | null;
  title: string;
  note: string | null;
  category: Category;
  source: string;
  url: string | null;
}

/** Annotations overlapping [from, to] for a property: its own, global ones, and Google updates if enabled. */
export async function listAnnotations(env: Env, p: Property | null, from: string, to: string): Promise<Annotation[]> {
  const showGoogle = p ? Boolean(p.show_google_updates ?? 1) : true;
  const { results } = await env.DB.prepare(
    `SELECT id, property_id, date, end_date, title, note, category, source, url FROM annotations
     WHERE date <= ? AND COALESCE(end_date, date) >= ?
       AND (${p ? 'property_id = ? OR ' : ''}property_id IS NULL)
       ${showGoogle ? '' : "AND category <> 'google'"}
     ORDER BY date`,
  )
    .bind(to, from, ...(p ? [p.id] : []))
    .all<Annotation>();
  return results;
}

export async function addAnnotation(env: Env, p: Property | null, input: Record<string, unknown>) {
  const date = String(input.date || '');
  const end = input.end_date ? String(input.end_date) : null;
  if (!isDate(date)) throw new HttpError(400, 'date must be YYYY-MM-DD');
  if (end && (!isDate(end) || end < date)) throw new HttpError(400, 'end_date must be YYYY-MM-DD and not before date');
  const title = String(input.title || '').trim().slice(0, 120);
  if (!title) throw new HttpError(400, 'title is required');
  const category = (CATEGORIES as readonly string[]).includes(String(input.category)) ? String(input.category) : 'note';
  if (category === 'google') throw new HttpError(400, 'The google category is reserved for imported Google updates');
  const url = input.url ? String(input.url).trim() : null;
  if (url && !/^https:\/\//.test(url)) throw new HttpError(400, 'url must start with https://');
  const row = await env.DB.prepare(
    `INSERT INTO annotations (property_id, date, end_date, title, note, category, source, url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?) RETURNING id`,
  )
    .bind(p?.id ?? null, date, end, title, input.note ? String(input.note).slice(0, 1000) : null, category, url, new Date().toISOString())
    .first<{ id: number }>();
  return { id: row!.id, date, end_date: end, title, category, property: p?.site_url ?? 'all properties' };
}

export async function deleteAnnotation(env: Env, id: number) {
  const row = await env.DB.prepare('SELECT source FROM annotations WHERE id = ?').bind(id).first<{ source: string }>();
  if (!row) throw new HttpError(404, 'No such annotation');
  if (row.source === 'google') throw new HttpError(400, 'Google updates can be hidden per property (show_google_updates), not deleted');
  await env.DB.prepare('DELETE FROM annotations WHERE id = ?').bind(id).run();
  return { deleted: id };
}

const FEED = 'https://status.search.google.com/incidents.json';

interface Incident {
  id: string;
  begin: string;
  end?: string | null;
  external_desc: string;
  service_name: string;
  uri?: string;
}

/** Imports Google ranking updates from the Search Status Dashboard. Idempotent; runs daily. */
export async function importGoogleUpdates(env: Env): Promise<number> {
  const res = await fetch(FEED, { headers: { accept: 'application/json', 'user-agent': 'Scry (+https://github.com/wpgaurav/scry)' } });
  if (!res.ok) throw new Error(`Search Status feed returned ${res.status}`);
  const incidents = ((await res.json()) as Incident[]).filter((i) => i.service_name === 'Ranking' && i.begin);
  const now = new Date().toISOString();
  const stmts = incidents.map((i) =>
    env.DB.prepare(
      `INSERT INTO annotations (property_id, date, end_date, title, category, source, external_id, url, created_at)
       VALUES (NULL, ?, ?, ?, 'google', 'google', ?, ?, ?)
       ON CONFLICT (external_id) DO UPDATE SET end_date = excluded.end_date, title = excluded.title`,
    ).bind(
      i.begin.slice(0, 10),
      i.end ? i.end.slice(0, 10) : null,
      i.external_desc.slice(0, 120),
      `google:${i.id}`,
      i.uri ? `https://status.search.google.com/${i.uri.replace(/^\//, '')}` : 'https://status.search.google.com/',
      now,
    ),
  );
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}
