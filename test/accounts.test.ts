import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { credentialForSite, encryptKey, forgetSiteAccounts, getCredential, parseKeyFile } from '../src/accounts';
import { makeKey, PID, seed } from './helpers';

const worker = (exports as any).default as { fetch: (r: Request) => Promise<Response> };
const E = { ...env, SA_ENCRYPTION_KEY: 'test-encryption-key-0123456789' } as any;
const KEY = (email: string) => ({
  type: 'service_account',
  project_id: 'demo',
  private_key_id: 'abcdef1234567890',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIfake\n-----END PRIVATE KEY-----\n',
  client_email: email,
  token_uri: 'https://oauth2.googleapis.com/token',
});

beforeEach(async () => {
  await seed();
  await env.DB.prepare('DELETE FROM service_accounts').run();
  forgetSiteAccounts();
});
afterEach(() => vi.restoreAllMocks());

describe('key files', () => {
  it('accepts a service account key and drops extra fields', () => {
    const k = parseKeyFile(JSON.stringify({ ...KEY('a@demo.iam.gserviceaccount.com'), client_id: '1', auth_uri: 'x' }));
    expect(k.email).toBe('a@demo.iam.gserviceaccount.com');
    expect(JSON.parse(k.json)).not.toHaveProperty('client_id');
  });

  it('rejects non-JSON, OAuth client files and keyless files', () => {
    expect(() => parseKeyFile('not json')).toThrow(/not valid JSON/);
    expect(() => parseKeyFile(JSON.stringify({ installed: { client_id: 'x' } }))).toThrow(/not a service account key/);
    expect(() => parseKeyFile(JSON.stringify({ ...KEY('a@b.c'), private_key: '' }))).toThrow(/no private_key/);
  });
});

describe('stored accounts', () => {
  it('encrypts at rest and decrypts per property', async () => {
    const k = parseKeyFile(KEY('uploaded@demo.iam.gserviceaccount.com'));
    const enc = await encryptKey(E, k.json);
    expect(enc.ciphertext).not.toContain('PRIVATE KEY');
    const row = await env.DB.prepare(
      "INSERT INTO service_accounts (client_email, key_ciphertext, key_iv, created_at) VALUES (?, ?, ?, 'now') RETURNING id",
    )
      .bind(k.email, enc.ciphertext, enc.iv)
      .first<{ id: number }>();
    await env.DB.prepare('UPDATE properties SET service_account_id = ? WHERE id = ?').bind(row!.id, PID).run();
    const cred = await credentialForSite(E, 'sc-domain:example.com');
    expect(cred.client_email).toBe('uploaded@demo.iam.gserviceaccount.com');
    expect(cred.private_key).toContain('BEGIN PRIVATE KEY');
  });

  it('fails clearly when the encryption secret changes', async () => {
    const k = parseKeyFile(KEY('x@demo.iam.gserviceaccount.com'));
    const enc = await encryptKey(E, k.json);
    const row = await env.DB.prepare("INSERT INTO service_accounts (client_email, key_ciphertext, key_iv, created_at) VALUES (?, ?, ?, 'now') RETURNING id")
      .bind(k.email, enc.ciphertext, enc.iv)
      .first<{ id: number }>();
    await expect(getCredential({ ...E, SA_ENCRYPTION_KEY: 'a-different-secret-value-xyz' }, row!.id)).rejects.toThrow(/Could not decrypt/);
  });

  it('falls back to the GSC_SA_KEY secret when a property has no account', async () => {
    const cred = await credentialForSite({ ...E, GSC_SA_KEY: JSON.stringify(KEY('secret@demo.iam.gserviceaccount.com')) }, 'sc-domain:example.com');
    expect(cred.id).toBeNull();
    expect(cred.client_email).toBe('secret@demo.iam.gserviceaccount.com');
  });
});

describe('routes', () => {
  it('keeps service account management away from API keys', async () => {
    const key = await makeKey('write');
    for (const [method, path] of [['GET', '/api/service-accounts'], ['POST', '/api/service-accounts'], ['DELETE', '/api/service-accounts/1']]) {
      const res = await worker.fetch(
        new Request('https://serp.test' + path, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined }),
      );
      expect(res.status).toBe(403);
    }
  });
});
