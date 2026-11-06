import type { Env } from './env';
import { allCredentials, recordAccountStatus } from './accounts';
import { listSites, type GscSite } from './google';

const RANK: Record<string, number> = { siteOwner: 4, siteFullUser: 3, siteRestrictedUser: 2, siteUnverifiedUser: 0 };

export interface AccountSites {
  id: number | null;
  client_email: string;
  source: 'secret' | 'uploaded';
  sites: GscSite[];
  error: string | null;
}

/** Lists every Search Console site each service account can see. */
export async function discoverSites(env: Env) {
  const accounts: AccountSites[] = await Promise.all(
    (await allCredentials(env)).map(async (a) => {
      const base = { id: a.id, client_email: a.email, source: (a.id === null ? 'secret' : 'uploaded') as AccountSites['source'] };
      if (!a.cred) return { ...base, sites: [], error: a.error ?? 'Unavailable' };
      try {
        const sites = (await listSites(env, a.cred)).filter((s) => (RANK[s.permissionLevel] ?? 0) > 0);
        await recordAccountStatus(env, a.id, null);
        return { ...base, sites, error: null };
      } catch (e) {
        const message = (e as Error).message;
        await recordAccountStatus(env, a.id, message);
        return { ...base, sites: [], error: message };
      }
    }),
  );
  // One entry per site: the account with the highest permission wins (sitemap submit needs Full).
  const best = new Map<string, { siteUrl: string; permissionLevel: string; service_account_id: number | null; service_account: string }>();
  for (const a of accounts) {
    for (const s of a.sites) {
      const cur = best.get(s.siteUrl);
      if (!cur || (RANK[s.permissionLevel] ?? 0) > (RANK[cur.permissionLevel] ?? 0)) {
        best.set(s.siteUrl, { siteUrl: s.siteUrl, permissionLevel: s.permissionLevel, service_account_id: a.id, service_account: a.client_email });
      }
    }
  }
  return { accounts, sites: [...best.values()].sort((x, y) => x.siteUrl.localeCompare(y.siteUrl)) };
}
