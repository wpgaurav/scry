import { HttpError, type Env, type Property, type Scope, type Session } from './env';
import { listProperties, propertySearchTypes, resolveProperty, SEARCH_TYPES, withD1Retry } from './db';
import { discoverSites } from './sites';
import { forgetSiteAccounts } from './accounts';
import { breakdown, liveQuery, pageDetail, queryDetail, resolveRange, summary, table, timeseries, type BreakdownDim } from './reports';
import { INSIGHTS, insight, type InsightKind } from './insights';
import { deleteGroup, groupReport, listGroups, saveGroup } from './groups';
import { getInspection, indexingReport, inspectAndStore, refreshSitemaps, submitAndRefresh } from './indexing';
import { planAllSyncs, planSync, syncStatus } from './sync';
import { isDate, sha256Hex } from './util';

export interface ParamSchema {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array';
  description?: string;
  enum?: readonly string[];
  items?: { type: 'string' };
  minimum?: number;
  maximum?: number;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  http: { method: 'GET' | 'POST' | 'DELETE'; path: string };
  input: { properties: Record<string, ParamSchema>; required?: string[] };
  run: (env: Env, args: Record<string, any>, session: Session) => Promise<unknown>;
}

// ---------- shared parameter sets ----------

const PROPERTY: Record<string, ParamSchema> = {
  property: {
    type: 'string',
    description: 'Property to query: numeric id, Search Console site URL (sc-domain:example.com or https://example.com/), or bare domain.',
  },
};

const RANGE: Record<string, ParamSchema> = {
  days: { type: 'integer', minimum: 1, maximum: 486, description: 'Length of the range in days, ending at the latest final data date. Default 28.' },
  from: { type: 'string', description: 'Start date YYYY-MM-DD. Overrides days.' },
  to: { type: 'string', description: 'End date YYYY-MM-DD. Default: latest date with final data.' },
  compare: { type: 'string', enum: ['previous', 'yoy', 'none'], description: 'Comparison period. Default previous (same length, right before).' },
  search_type: { type: 'string', enum: SEARCH_TYPES, description: 'Search type. Default web.' },
  country: { type: 'string', description: 'ISO 3166-1 alpha-3 country code, lowercase (usa, ind, gbr). Triggers a live API call.' },
  device: { type: 'string', enum: ['DESKTOP', 'MOBILE', 'TABLET'], description: 'Device filter. Triggers a live API call.' },
  brand: { type: 'string', enum: ['branded', 'nonbranded', 'all'], description: 'Brand filter using the property brand terms.' },
};

const TABLE: Record<string, ParamSchema> = {
  sort: { type: 'string', enum: ['clicks', 'impressions', 'ctr', 'position', 'delta_clicks', 'delta_impressions', 'delta_position'] },
  order: { type: 'string', enum: ['asc', 'desc'] },
  limit: { type: 'integer', minimum: 1, maximum: 5000, description: 'Rows to return. Default 100.' },
  offset: { type: 'integer', minimum: 0 },
  contains: { type: 'string', description: 'Only rows whose page URL or query text contains this text.' },
  min_impressions: { type: 'integer', minimum: 1 },
};

const prop = (env: Env, a: Record<string, any>) => resolveProperty(env, a.property);

async function propertyInfo(env: Env, p: Property) {
  const row = await env.DB.prepare(
    `SELECT MAX(CASE WHEN provisional = 0 THEN date END) AS latest_final, MAX(date) AS latest, MIN(date) AS first, COUNT(*) AS days
     FROM daily_totals WHERE property_id = ? AND search_type = 'web'`,
  )
    .bind(p.id)
    .first<Record<string, string | number | null>>();
  const groups = await env.DB.prepare('SELECT COUNT(*) AS n FROM keyword_groups WHERE property_id = ?').bind(p.id).first<{ n: number }>();
  return {
    id: p.id,
    site_url: p.site_url,
    label: p.label,
    active: Boolean(p.active),
    search_types: propertySearchTypes(p),
    brand_terms: JSON.parse(p.brand_terms || '[]'),
    inspection_budget: p.inspection_budget,
    data: { first_date: row?.first ?? null, latest_final_date: row?.latest_final ?? null, latest_date: row?.latest ?? null, days_stored: row?.days ?? 0 },
    keyword_groups: groups?.n ?? 0,
  };
}

// ---------- registry ----------

export const TOOLS: ToolDef[] = [
  {
    name: 'list_properties',
    title: 'List properties',
    description: 'List the Search Console properties this server tracks, with stored date coverage. Call this first to get valid property values.',
    scope: 'read',
    http: { method: 'GET', path: '/properties' },
    input: { properties: {} },
    run: async (env) => ({ properties: await Promise.all((await listProperties(env)).map((p) => propertyInfo(env, p))) }),
  },
  {
    name: 'portfolio_overview',
    title: 'Portfolio overview',
    description: 'Clicks, impressions, CTR and position for every active property over the range, with change vs the comparison period and a daily clicks series.',
    scope: 'read',
    http: { method: 'GET', path: '/portfolio' },
    input: { properties: { days: RANGE.days, compare: RANGE.compare } },
    run: async (env, a) => {
      const props = await listProperties(env, true);
      return {
        properties: await Promise.all(
          props.map(async (p) => {
            const [s, t] = await Promise.all([summary(env, p, a), timeseries(env, p, { days: a.days || 28 })]);
            return { id: p.id, label: p.label, site_url: p.site_url, ...s, series: t.rows.map((x) => ({ date: x.date, clicks: x.clicks, impressions: x.impressions })) };
          }),
        ),
      };
    },
  },
  {
    name: 'list_gsc_sites',
    title: 'List Search Console sites',
    description: 'List the service accounts and every Search Console property each one can access. Add an account email as a user in Search Console to grant access.',
    scope: 'read',
    http: { method: 'GET', path: '/gsc/sites' },
    input: { properties: {} },
    run: async (env) => {
      const tracked = new Set((await listProperties(env)).map((p) => p.site_url));
      const { accounts, sites } = await discoverSites(env);
      return {
        service_accounts: accounts.map((x) => ({ id: x.id, client_email: x.client_email, source: x.source, sites: x.sites.length, error: x.error })),
        sites: sites.map((x) => ({ ...x, tracked: tracked.has(x.siteUrl) })),
      };
    },
  },
  {
    name: 'add_property',
    title: 'Add property',
    description: 'Start tracking a Search Console property and queue a 16-month backfill. site_url must match Search Console exactly (sc-domain:example.com or https://example.com/).',
    scope: 'write',
    http: { method: 'POST', path: '/properties' },
    input: {
      properties: {
        site_url: { type: 'string' },
        label: { type: 'string', description: 'Display name. Defaults to the domain.' },
        search_types: { type: 'array', items: { type: 'string' }, description: `Any of ${SEARCH_TYPES.join(', ')}. Default ["web"].` },
      },
      required: ['site_url'],
    },
    run: async (env, a) => {
      const siteUrl = String(a.site_url).trim();
      const { accounts, sites } = await discoverSites(env);
      const match = sites.find((x) => x.siteUrl === siteUrl);
      if (!match) {
        const emails = accounts.map((x) => x.client_email).join(', ') || 'none uploaded yet';
        throw new HttpError(400, `No service account can read ${siteUrl}. Add one of these as a user in Search Console first: ${emails}.`);
      }
      const types = (a.search_types?.length ? a.search_types : ['web']).filter((t: string) => (SEARCH_TYPES as string[]).includes(t));
      const label = a.label || siteUrl.replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/\/$/, '');
      await env.DB.prepare(
        'INSERT INTO properties (site_url, label, search_types, service_account_id) VALUES (?, ?, ?, ?) ON CONFLICT (site_url) DO UPDATE SET active = 1, service_account_id = excluded.service_account_id',
      )
        .bind(siteUrl, label, types.join(','), match.service_account_id)
        .run();
      forgetSiteAccounts();
      const p = await resolveProperty(env, siteUrl);
      const queued = await planSync(env, p);
      return { property: await propertyInfo(env, p), queued_days: queued };
    },
  },
  {
    name: 'update_property',
    title: 'Update property settings',
    description: 'Change a property label, tracked search types, brand terms (used by the brand filter), daily URL Inspection budget, or pause it.',
    scope: 'write',
    http: { method: 'POST', path: '/p/:property/settings' },
    input: {
      properties: {
        ...PROPERTY,
        label: { type: 'string' },
        search_types: { type: 'array', items: { type: 'string' } },
        brand_terms: { type: 'array', items: { type: 'string' }, description: 'Lowercase terms; a query containing any of them counts as branded.' },
        inspection_budget: { type: 'integer', minimum: 0, maximum: 1900 },
        active: { type: 'boolean' },
      },
      required: ['property'],
    },
    run: async (env, a) => {
      const p = await prop(env, a);
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (a.label !== undefined) sets.push('label = ?'), vals.push(String(a.label));
      if (a.search_types !== undefined) {
        const t = (a.search_types as string[]).filter((x) => (SEARCH_TYPES as string[]).includes(x));
        if (!t.length) throw new HttpError(400, 'search_types needs at least one valid type');
        sets.push('search_types = ?'), vals.push(t.join(','));
      }
      if (a.brand_terms !== undefined) sets.push('brand_terms = ?'), vals.push(JSON.stringify((a.brand_terms as string[]).map((x) => x.trim().toLowerCase()).filter(Boolean)));
      if (a.inspection_budget !== undefined) sets.push('inspection_budget = ?'), vals.push(Math.min(1900, Math.max(0, Number(a.inspection_budget))));
      if (a.active !== undefined) sets.push('active = ?'), vals.push(a.active ? 1 : 0);
      if (sets.length) await env.DB.prepare(`UPDATE properties SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, p.id).run();
      const fresh = await resolveProperty(env, p.id);
      if (a.search_types !== undefined) await planSync(env, fresh);
      return { property: await propertyInfo(env, fresh) };
    },
  },
  {
    name: 'get_summary',
    title: 'Performance summary',
    description: 'Total clicks, impressions, CTR (%) and average position for a range, with the comparison period and deltas. Negative position delta = improvement.',
    scope: 'read',
    http: { method: 'GET', path: '/p/:property/summary' },
    input: {
      properties: { ...PROPERTY, ...RANGE, page: { type: 'string', description: 'Exact page URL filter.' }, query: { type: 'string', description: 'Exact query filter.' } },
      required: ['property'],
    },
    run: async (env, a) => summary(env, await prop(env, a), a),
  },
  {
    name: 'get_timeseries',
    title: 'Daily trend',
    description: 'Daily clicks, impressions, CTR and position. Recent days marked provisional may still change.',
    scope: 'read',
    http: { method: 'GET', path: '/p/:property/timeseries' },
    input: { properties: { ...PROPERTY, ...RANGE, page: { type: 'string' }, query: { type: 'string' } }, required: ['property'] },
    run: async (env, a) => timeseries(env, await prop(env, a), a),
  },
  {
    name: 'top_pages',
    title: 'Pages report',
    description: 'Pages with clicks, impressions, CTR, position and change vs the comparison period. Pass query to see which pages rank for one query.',
    scope: 'read',
    http: { method: 'GET', path: '/p/:property/pages' },
    input: { properties: { ...PROPERTY, ...RANGE, ...TABLE, query: { type: 'string', description: 'Only pages ranking for this exact query.' } }, required: ['property'] },
    run: async (env, a) => table(env, await prop(env, a), 'page', a),
  },
  {
    name: 'top_queries',
    title: 'Queries report',
    description: 'Search queries with clicks, impressions, CTR, position and change. Pass page to see the queries one page ranks for.',
    scope: 'read',
    http: { method: 'GET', path: '/p/:property/queries' },
    input: { properties: { ...PROPERTY, ...RANGE, ...TABLE, page: { type: 'string', description: 'Only queries for this exact page URL.' } }, required: ['property'] },
    run: async (env, a) => table(env, await prop(env, a), 'query', a),
  },
  {
    name: 'get_breakdown',
    title: 'Country / device / appearance breakdown',
    description: 'Performance split by country, device or search appearance (rich result types).',
    scope: 'read',
    http: { method: 'GET', path: '/p/:property/breakdown/:dimension' },
    input: {
      properties: { ...PROPERTY, dimension: { type: 'string', enum: ['country', 'device', 'searchAppearance'] }, ...RANGE, page: { type: 'string' }, query: { type: 'string' } },
      required: ['property', 'dimension'],
    },
    run: async (env, a) => breakdown(env, await prop(env, a), a.dimension as BreakdownDim, a),
  },
  {
    name: 'page_details',
    title: 'Page details',
    description: 'Everything about one URL: summary, daily trend, queries it ranks for, position buckets, first-seen date and latest index status.',
    scope: 'read',
    http: { method: 'GET', path: '/p/:property/page' },
    input: { properties: { ...PROPERTY, url: { type: 'string', description: 'Full page URL as Google reports it.' }, ...RANGE }, required: ['property', 'url'] },
    run: async (env, a) => pageDetail(env, await prop(env, a), a.url, a),
  },
  {
    name: 'query_details',
    title: 'Query details',
    description: 'Everything about one query: summary, daily trend, pages that rank for it with impression share, and a cannibalization flag.',
    scope: 'read',
    http: { method: 'GET', path: '/p/:property/query' },
    input: { properties: { ...PROPERTY, query: { type: 'string' }, ...RANGE }, required: ['property', 'query'] },
    run: async (env, a) => queryDetail(env, await prop(env, a), a.query, a),
  },
  {
    name: 'get_insight',
    title: 'SEO insight',
    description:
      'Ready-made SEO analyses. Kinds: ' +
      Object.entries(INSIGHTS)
        .map(([k, v]) => `${k} (${v})`)
        .join('; '),
    scope: 'read',
    http: { method: 'GET', path: '/p/:property/insights/:kind' },
    input: {
      properties: {
        ...PROPERTY,
        kind: { type: 'string', enum: Object.keys(INSIGHTS) },
        days: RANGE.days,
        from: RANGE.from,
        to: RANGE.to,
        compare: RANGE.compare,
        search_type: RANGE.search_type,
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Default 50.' },
        min_impressions: { type: 'integer', minimum: 0 },
        min_clicks: { type: 'integer', minimum: 0 },
      },
      required: ['property', 'kind'],
    },
    run: async (env, a) => insight(env, await prop(env, a), a.kind as InsightKind, a),
  },
  {
    name: 'search_analytics',
    title: 'Live Search Analytics query',
    description:
      'Run a raw Search Console Search Analytics query (any dimensions and filters, up to 25,000 rows). Use when stored reports cannot answer, e.g. query x country x device. Results cached 6 hours.',
    scope: 'read',
    http: { method: 'POST', path: '/p/:property/search-analytics' },
    input: {
      properties: {
        ...PROPERTY,
        start_date: { type: 'string' },
        end_date: { type: 'string' },
        dimensions: { type: 'array', items: { type: 'string' }, description: 'Any of date, query, page, country, device, searchAppearance.' },
        search_type: RANGE.search_type,
        query_contains: { type: 'string' },
        query_regex: { type: 'string', description: 'RE2 regex on query.' },
        page_contains: { type: 'string' },
        page_regex: { type: 'string' },
        country: RANGE.country,
        device: RANGE.device,
        row_limit: { type: 'integer', minimum: 1, maximum: 25000 },
        start_row: { type: 'integer', minimum: 0 },
        data_state: { type: 'string', enum: ['final', 'all'] },
      },
      required: ['property', 'start_date', 'end_date'],
    },
    run: async (env, a) => {
      const p = await prop(env, a);
      if (!isDate(a.start_date) || !isDate(a.end_date)) throw new HttpError(400, 'start_date and end_date must be YYYY-MM-DD');
      const allowed = ['date', 'query', 'page', 'country', 'device', 'searchAppearance'];
      const dims = (a.dimensions || []).filter((d: string) => allowed.includes(d));
      const filters: any[] = [];
      if (a.query_contains) filters.push({ dimension: 'query', operator: 'contains', expression: a.query_contains });
      if (a.query_regex) filters.push({ dimension: 'query', operator: 'includingRegex', expression: a.query_regex });
      if (a.page_contains) filters.push({ dimension: 'page', operator: 'contains', expression: a.page_contains });
      if (a.page_regex) filters.push({ dimension: 'page', operator: 'includingRegex', expression: a.page_regex });
      if (a.country) filters.push({ dimension: 'country', operator: 'equals', expression: String(a.country).toLowerCase() });
      if (a.device) filters.push({ dimension: 'device', operator: 'equals', expression: String(a.device).toUpperCase() });
      const rows = await liveQuery(env, p, {
        startDate: a.start_date,
        endDate: a.end_date,
        dimensions: dims,
        type: a.search_type || 'web',
        dataState: a.data_state || 'all',
        rowLimit: a.row_limit || 1000,
        startRow: a.start_row || 0,
        ...(filters.length ? { dimensionFilterGroups: [{ groupType: 'and', filters }] } : {}),
      });
      return {
        property: p.site_url,
        dimensions: dims,
        rows: rows.map((r) => ({
          ...Object.fromEntries(dims.map((d: string, i: number) => [d, r.keys?.[i]])),
          clicks: r.clicks,
          impressions: r.impressions,
          ctr: Math.round(r.ctr * 10000) / 100,
          position: Math.round(r.position * 10) / 10,
        })),
      };
    },
  },
  {
    name: 'url_inspection',
    title: 'URL inspection',
    description: 'Index status for one URL (verdict, coverage, last crawl, canonicals, rich results). Returns the stored result; refresh=true calls Google (uses daily quota).',
    scope: 'read',
    http: { method: 'GET', path: '/p/:property/inspection' },
    input: { properties: { ...PROPERTY, url: { type: 'string' }, refresh: { type: 'boolean' } }, required: ['property', 'url'] },
    run: async (env, a) => {
      const p = await prop(env, a);
      const stored = a.refresh ? null : await getInspection(env, p.id, a.url);
      return { url: a.url, inspection: stored || (await inspectAndStore(env, p, a.url)), from_cache: Boolean(stored) };
    },
  },
  {
    name: 'indexing_report',
    title: 'Indexing report',
    description: 'Index coverage across inspected pages: counts by state, non-indexed or canonical-mismatch pages ranked by traffic, recent state changes, and sitemaps.',
    scope: 'read',
    http: { method: 'GET', path: '/p/:property/indexing' },
    input: { properties: { ...PROPERTY, limit: { type: 'integer', minimum: 1, maximum: 1000 } }, required: ['property'] },
    run: async (env, a) => indexingReport(env, (await prop(env, a)).id, a.limit || 200),
  },
  {
    name: 'list_sitemaps',
    title: 'Sitemaps',
    description: 'Submitted sitemaps with last download, errors, warnings and URL counts. refresh=true re-reads them from Google.',
    scope: 'read',
    http: { method: 'GET', path: '/p/:property/sitemaps' },
    input: { properties: { ...PROPERTY, refresh: { type: 'boolean' } }, required: ['property'] },
    run: async (env, a) => {
      const p = await prop(env, a);
      if (a.refresh) await refreshSitemaps(env, p);
      const { results } = await env.DB.prepare('SELECT * FROM sitemaps WHERE property_id = ? ORDER BY path').bind(p.id).all();
      return { property: p.site_url, sitemaps: results };
    },
  },
  {
    name: 'submit_sitemap',
    title: 'Submit sitemap',
    description: 'Submit (or resubmit) a sitemap URL to Search Console.',
    scope: 'write',
    http: { method: 'POST', path: '/p/:property/sitemaps' },
    input: { properties: { ...PROPERTY, sitemap_url: { type: 'string' } }, required: ['property', 'sitemap_url'] },
    run: async (env, a) => {
      const p = await prop(env, a);
      if (!/^https?:\/\//.test(a.sitemap_url)) throw new HttpError(400, 'sitemap_url must be a full URL');
      await submitAndRefresh(env, p, a.sitemap_url);
      return { submitted: a.sitemap_url };
    },
  },
  {
    name: 'list_keyword_groups',
    title: 'Keyword groups',
    description: 'Keyword groups (rank-tracker lists) for a property.',
    scope: 'read',
    http: { method: 'GET', path: '/p/:property/groups' },
    input: { properties: { ...PROPERTY }, required: ['property'] },
    run: async (env, a) => listGroups(env, await prop(env, a)),
  },
  {
    name: 'keyword_group_report',
    title: 'Keyword group report',
    description: 'Rank-tracker view of a keyword group: per term clicks, impressions, position, position change and top page, plus group totals.',
    scope: 'read',
    http: { method: 'GET', path: '/p/:property/groups/:group' },
    input: {
      properties: { ...PROPERTY, group: { type: 'string', description: 'Group name or id.' }, days: RANGE.days, from: RANGE.from, to: RANGE.to, compare: RANGE.compare, search_type: RANGE.search_type, limit: { type: 'integer' } },
      required: ['property', 'group'],
    },
    run: async (env, a) => groupReport(env, await prop(env, a), a.group, a),
  },
  {
    name: 'save_keyword_group',
    title: 'Save keyword group',
    description: 'Create a keyword group or add terms to one. match=exact tracks exact queries; contains tracks every query containing the term. replace=true swaps the whole term list.',
    scope: 'write',
    http: { method: 'POST', path: '/p/:property/groups' },
    input: {
      properties: {
        ...PROPERTY,
        name: { type: 'string' },
        terms: { type: 'array', items: { type: 'string' } },
        match: { type: 'string', enum: ['exact', 'contains'] },
        replace: { type: 'boolean' },
      },
      required: ['property', 'name', 'terms'],
    },
    run: async (env, a) => saveGroup(env, await prop(env, a), a.name, a.terms, a.match || 'exact', Boolean(a.replace)),
  },
  {
    name: 'delete_keyword_group',
    title: 'Delete keyword group',
    description: 'Delete a keyword group and its terms. Search data is not affected.',
    scope: 'write',
    http: { method: 'DELETE', path: '/p/:property/groups/:group' },
    input: { properties: { ...PROPERTY, group: { type: 'string' } }, required: ['property', 'group'] },
    run: async (env, a) => deleteGroup(env, await prop(env, a), a.group),
  },
  {
    name: 'sync_status',
    title: 'Sync status',
    description: 'How many days are synced, queued, pending or failed per property and search type, plus recent errors.',
    scope: 'read',
    http: { method: 'GET', path: '/sync' },
    input: { properties: { property: { ...PROPERTY.property, description: 'Optional. Omit for all properties.' } } },
    run: async (env, a) => syncStatus(env, a.property ? (await prop(env, a)).id : undefined),
  },
  {
    name: 'run_sync',
    title: 'Run sync now',
    description: 'Queue any missing or stale days right away instead of waiting for the next scheduled run.',
    scope: 'write',
    http: { method: 'POST', path: '/sync' },
    input: { properties: { property: { ...PROPERTY.property, description: 'Optional. Omit for all properties.' } } },
    run: async (env, a) => ({ queued_days: a.property ? await planSync(env, await prop(env, a)) : await planAllSyncs(env) }),
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/** Coerces and validates args against the tool schema. Query-string values arrive as strings. */
export function coerceArgs(tool: ToolDef, raw: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, schema] of Object.entries(tool.input.properties)) {
    let v = raw[key];
    if (v === undefined || v === null || v === '') continue;
    switch (schema.type) {
      case 'integer':
      case 'number': {
        const n = Number(v);
        if (!Number.isFinite(n)) throw new HttpError(400, `${key} must be a number`);
        v = schema.type === 'integer' ? Math.trunc(n) : n;
        if (schema.minimum !== undefined && (v as number) < schema.minimum) throw new HttpError(400, `${key} must be >= ${schema.minimum}`);
        if (schema.maximum !== undefined && (v as number) > schema.maximum) throw new HttpError(400, `${key} must be <= ${schema.maximum}`);
        break;
      }
      case 'boolean':
        v = v === true || v === 'true' || v === '1' || v === 1;
        break;
      case 'array':
        if (typeof v === 'string') v = v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
        if (!Array.isArray(v)) throw new HttpError(400, `${key} must be an array`);
        v = v.map(String);
        break;
      default:
        v = String(v);
        if (schema.enum && !schema.enum.includes(v as string)) throw new HttpError(400, `${key} must be one of ${schema.enum.join(', ')}`);
    }
    out[key] = v;
  }
  for (const req of tool.input.required || []) {
    if (out[req] === undefined) throw new HttpError(400, `${req} is required`);
  }
  return out;
}

export function toolJsonSchema(tool: ToolDef) {
  return {
    type: 'object',
    properties: tool.input.properties,
    ...(tool.input.required?.length ? { required: tool.input.required } : {}),
    additionalProperties: false,
  };
}

export async function callTool(env: Env, session: Session, name: string, raw: Record<string, unknown>) {
  const tool = TOOL_MAP.get(name);
  if (!tool) throw new HttpError(404, `Unknown tool ${name}`);
  if (tool.scope === 'write' && session.scope !== 'write') throw new HttpError(403, `${name} needs a write-scope API key`);
  const args = coerceArgs(tool, raw);
  if (tool.scope === 'write') {
    const result = await tool.run(env, args, session);
    // Any write invalidates cached reports.
    await env.KV.put('cache:epoch', String(Date.now()));
    return result;
  }
  if (UNCACHED.has(tool.name) || args.refresh) return withD1Retry(() => tool.run(env, args, session));
  // Stored reports change at most once per sync job, so a short cache absorbs repeat
  // loads and keeps D1's per-database compute budget free for the backfill.
  const epoch = (await env.KV.get('cache:epoch')) || '0';
  const key = 'cache:' + (await sha256Hex(`${epoch}|${name}|${JSON.stringify(Object.entries(args).sort())}`));
  const hit = await env.KV.get(key, 'json');
  if (hit) return hit;
  const result = await withD1Retry(() => tool.run(env, args, session));
  await env.KV.put(key, JSON.stringify(result), { expirationTtl: REPORT_CACHE_SECONDS }).catch(() => {});
  return result;
}

const REPORT_CACHE_SECONDS = 900;
/** Cheap or live tools that should always be fresh. */
const UNCACHED = new Set(['list_gsc_sites', 'sync_status', 'url_inspection', 'list_keyword_groups', 'search_analytics']);

export { resolveRange };
