/**
 * Google service accounts. Two sources:
 *  - the GSC_SA_KEY Worker secret (id = null, read-only in the UI), and
 *  - keys uploaded from Settings, stored AES-GCM encrypted in D1 under SA_ENCRYPTION_KEY.
 * Each property records which account reads it (properties.service_account_id).
 */
import { HttpError, type Env } from './env';

export interface Credential {
  id: number | null;
  client_email: string;
  private_key: string;
  token_uri?: string;
  project_id?: string;
  private_key_id?: string;
}

interface AccountRow {
  id: number;
  client_email: string;
  project_id: string | null;
  private_key_id: string | null;
  key_ciphertext: string;
  key_iv: string;
  created_at: string;
  last_ok_at: string | null;
  last_error: string | null;
}

const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(env: Env): Promise<CryptoKey> {
  if (!env.SA_ENCRYPTION_KEY || env.SA_ENCRYPTION_KEY.length < 16) {
    throw new HttpError(503, 'Set the SA_ENCRYPTION_KEY secret (any long random string) before uploading service accounts.');
  }
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.SA_ENCRYPTION_KEY));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptKey(env: Env, json: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), new TextEncoder().encode(json));
  return { ciphertext: b64(ct), iv: b64(iv) };
}

async function decryptKey(env: Env, row: AccountRow): Promise<Credential> {
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(row.key_iv) }, await aesKey(env), unb64(row.key_ciphertext));
    const sa = JSON.parse(new TextDecoder().decode(pt));
    return { id: row.id, client_email: sa.client_email, private_key: sa.private_key, token_uri: sa.token_uri, project_id: sa.project_id, private_key_id: sa.private_key_id };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(503, `Could not decrypt the key for ${row.client_email}. Was SA_ENCRYPTION_KEY changed? Upload the JSON key again.`);
  }
}

/** Validates an uploaded key file. Returns the normalized JSON to store. */
export function parseKeyFile(input: unknown): { json: string; email: string; projectId: string | null; keyId: string | null } {
  let obj = input;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      throw new HttpError(400, 'That file is not valid JSON. Upload the JSON key file Google Cloud downloads for a service account.');
    }
  }
  const sa = obj as Record<string, unknown>;
  if (!sa || typeof sa !== 'object' || Array.isArray(sa)) throw new HttpError(400, 'Upload a service account JSON key file.');
  if (sa.type !== 'service_account') throw new HttpError(400, 'This JSON is not a service account key ("type" must be "service_account").');
  if (typeof sa.client_email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(sa.client_email)) throw new HttpError(400, 'The key file has no valid client_email.');
  if (typeof sa.private_key !== 'string' || !sa.private_key.includes('-----BEGIN PRIVATE KEY-----')) {
    throw new HttpError(400, 'The key file has no private_key. Create a new JSON key for the service account and upload that.');
  }
  const keep = {
    type: 'service_account',
    project_id: sa.project_id ?? null,
    private_key_id: sa.private_key_id ?? null,
    private_key: sa.private_key,
    client_email: sa.client_email,
    token_uri: typeof sa.token_uri === 'string' && sa.token_uri.startsWith('https://') ? sa.token_uri : 'https://oauth2.googleapis.com/token',
  };
  const json = JSON.stringify(keep);
  if (json.length > 10_000) throw new HttpError(400, 'Key file is too large to be a service account key.');
  return { json, email: sa.client_email, projectId: (sa.project_id as string) ?? null, keyId: (sa.private_key_id as string) ?? null };
}

export function secretCredential(env: Env): Credential | null {
  if (!env.GSC_SA_KEY) return null;
  try {
    const sa = JSON.parse(env.GSC_SA_KEY);
    if (!sa.client_email || !sa.private_key) return null;
    return { id: null, client_email: sa.client_email, private_key: sa.private_key, token_uri: sa.token_uri, project_id: sa.project_id, private_key_id: sa.private_key_id };
  } catch {
    return null;
  }
}

export async function getCredential(env: Env, id: number | null | undefined): Promise<Credential> {
  if (id === null || id === undefined) {
    const c = secretCredential(env);
    if (!c) throw new HttpError(503, 'No service account: upload a JSON key in Settings (or set the GSC_SA_KEY secret).');
    return c;
  }
  const row = await env.DB.prepare('SELECT * FROM service_accounts WHERE id = ?').bind(id).first<AccountRow>();
  if (!row) throw new HttpError(503, `Service account ${id} was removed. Re-add the property or upload its key again.`);
  return decryptKey(env, row);
}

/** Every usable credential: the secret first, then uploaded ones. */
export async function allCredentials(env: Env): Promise<{ cred: Credential | null; error?: string; email: string; id: number | null }[]> {
  const out: { cred: Credential | null; error?: string; email: string; id: number | null }[] = [];
  const secret = secretCredential(env);
  if (secret) out.push({ cred: secret, email: secret.client_email, id: null });
  const { results } = await env.DB.prepare('SELECT * FROM service_accounts ORDER BY id').all<AccountRow>();
  for (const row of results) {
    try {
      out.push({ cred: await decryptKey(env, row), email: row.client_email, id: row.id });
    } catch (e) {
      out.push({ cred: null, error: (e as Error).message, email: row.client_email, id: row.id });
    }
  }
  return out;
}

// Per-isolate memo of site_url -> service_account_id, so sync jobs don't hit D1 per Google call.
const siteMemo = new Map<string, { id: number | null; at: number }>();

export function forgetSiteAccounts() {
  siteMemo.clear();
}

export async function credentialForSite(env: Env, siteUrl: string): Promise<Credential> {
  const hit = siteMemo.get(siteUrl);
  let id: number | null;
  if (hit && Date.now() - hit.at < 300_000) id = hit.id;
  else {
    const row = await env.DB.prepare('SELECT service_account_id AS id FROM properties WHERE site_url = ?').bind(siteUrl).first<{ id: number | null }>();
    id = row?.id ?? null;
    siteMemo.set(siteUrl, { id, at: Date.now() });
  }
  return getCredential(env, id);
}

export async function recordAccountStatus(env: Env, id: number | null, error: string | null) {
  if (id === null) return;
  await env.DB.prepare(
    error ? 'UPDATE service_accounts SET last_error = ? WHERE id = ?' : 'UPDATE service_accounts SET last_ok_at = ?, last_error = NULL WHERE id = ?',
  )
    .bind(error ?? new Date().toISOString(), id)
    .run()
    .catch(() => {});
}

export type { AccountRow };
