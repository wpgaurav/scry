export type SearchType = 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews';
export type DataState = 'final' | 'all';

export type Job =
  | { kind: 'sync'; propertyId: number; date: string; searchType: SearchType; dataState: DataState }
  | { kind: 'inspect'; propertyId: number; urls: string[] }
  | { kind: 'sitemaps'; propertyId: number };

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  JOBS: Queue<Job>;
  ASSETS: Fetcher;

  APP_NAME?: string;
  AUTH_MODE?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ALLOWED_EMAILS?: string;

  GSC_SA_KEY?: string;
  SA_ENCRYPTION_KEY?: string;
  ADMIN_PASSWORD?: string;

  EMAIL_API_URL?: string;
  EMAIL_API_KEY?: string;
  DIGEST_TO?: string;
  DIGEST_FROM?: string;
}

export type Scope = 'read' | 'write';

export interface Session {
  kind: 'human' | 'key';
  scope: Scope;
  email?: string;
  keyId?: number;
}

export interface Property {
  id: number;
  site_url: string;
  label: string;
  search_types: string;
  brand_terms: string;
  inspection_budget: number;
  active: number;
  created_at: string;
  show_google_updates?: number;
  service_account_id?: number | null;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
