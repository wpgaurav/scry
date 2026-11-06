# Scry

**Your Google Search Console data on your own Cloudflare account, with a dashboard, insights and an MCP server your AI tools can query.**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wpgaurav/scry)
[![CI](https://github.com/wpgaurav/scry/actions/workflows/ci.yml/badge.svg)](https://github.com/wpgaurav/scry/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-informational.svg)](LICENSE)

Search Console keeps 16 months of data, then forgets it. Its interface answers one question at a time, and nothing you build on top of it can see last year next to last week without exports and spreadsheets.

Scry is one Cloudflare Worker that copies your Search Console data into D1 every six hours and keeps it. It gives you fast reports, analyses Search Console doesn't offer, and an API that Claude, ChatGPT, Codex or Cursor can call directly. It runs on your Cloudflare account, and no third party sees your data.

## What you get

- **Dashboard.** All your properties on one page, then per property: trend chart, pages, queries, devices, countries, and a detail page for any URL or query. Every report compares against the previous period or the same period last year. Filters cover search type, device, country and branded vs non-branded queries, and every table exports to CSV. Built on [Tabler](https://tabler.io), with dark mode.
- **Insights.** Eleven ready-made analyses:

  | Insight | What it finds |
  |---|---|
  | Striking distance | Queries at positions 4 to 20, ranked by the extra clicks position 3 would bring |
  | CTR gaps | Top-10 queries whose CTR is under half of what your site usually gets at that position |
  | Page and query drops | The biggest click losses vs the comparison period |
  | Page and query gains | The biggest click gains |
  | New and lost queries | Queries that appeared or disappeared |
  | Cannibalization | Queries where two or more of your pages split the impressions |
  | Content decay | Pages that lost clicks in four 28-day blocks in a row |
  | Zero clicks | Pages with many impressions and no clicks |

- **Indexing.** A daily URL Inspection budget works through your most valuable pages. Scry flags pages that aren't indexed, canonical mismatches and coverage changes, tracks sitemap health, and lets you submit sitemaps.
- **Keyword groups.** Rank tracking from your own Search Console data, with exact or contains matching and no keyword limit.
- **AI access.** An MCP server at `/mcp`, a REST API at `/api` and an OpenAPI 3.1 spec at `/api/openapi.json`. All three come from one tool registry.
- **Multiple Google accounts.** Upload as many service account keys as you need. They're stored encrypted, and each property uses the account that can read it.
- **Weekly digest** by email, plus a **WordPress plugin** that adds Search Console numbers to your posts list and editor.

## Deploy

### Option A: Deploy to Cloudflare button (about 5 minutes)

1. **Click the button above.** Cloudflare copies this repository to your GitHub account, creates the D1 database, KV namespace and queue, and deploys the Worker.
2. **Enter the two secrets** when it asks:
   - `ADMIN_PASSWORD`: your dashboard password, 12 characters or more.
   - `SA_ENCRYPTION_KEY`: any long random string. `openssl rand -base64 48` makes a good one. It encrypts the Google keys you upload, so keep it: if you change it, you'll have to upload the keys again.
3. **Open the Worker URL** (`https://scry.<your-subdomain>.workers.dev`) and sign in with the password.
4. **Connect Google.** Follow [Create a Google service account](#create-a-google-service-account) below, then go to **Settings → Service accounts** and upload the JSON key.
5. **Add your sites.** Settings lists every property the service account can read. Add one and its 16-month backfill starts right away.

The database schema sets itself up on the first request, so there are no migrations to run.

### Option B: Command line

```bash
git clone https://github.com/wpgaurav/scry.git && cd scry
npm install
npx wrangler login
npm run deploy                                   # creates D1, KV and the queue on first deploy
npx wrangler secret put ADMIN_PASSWORD
openssl rand -base64 48 | npx wrangler secret put SA_ENCRYPTION_KEY
```

Then carry on from step 3 above.

### Create a Google service account

Scry reads Search Console as a Google service account. It doesn't use your personal Google login, so there's nothing to refresh or re-authorize.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project (or pick one).
2. Go to **APIs & Services → Library**, search for **Google Search Console API** and click **Enable**.
3. Go to **IAM & Admin → Service accounts → Create service account**. Any name works. Skip the optional role and access steps.
4. Open the new account, go to **Keys → Add key → Create new key → JSON**, and save the file.
5. In [Search Console](https://search.google.com/search-console), open each property, go to **Settings → Users and permissions → Add user** and paste the service account's email (it ends in `iam.gserviceaccount.com`). Choose **Full** to submit sitemaps from Scry, or **Restricted** if read-only is enough.

With the gcloud CLI, steps 1 to 4 look like this:

```bash
gcloud projects create my-scry-project
gcloud services enable searchconsole.googleapis.com --project my-scry-project
gcloud iam service-accounts create scry --project my-scry-project
gcloud iam service-accounts keys create scry-key.json \
  --iam-account scry@my-scry-project.iam.gserviceaccount.com
```

Upload `scry-key.json` in Settings, then delete the file.

**Can I reuse Rank Math's or another plugin's Google connection?** No. Plugins connect through their own OAuth app, and its client secret lives on the vendor's servers, so another app can't refresh those tokens. A service account is the supported way for server software to read Search Console.

## Optional setup

### Cloudflare Access instead of a password

Access gives you Google or one-time PIN sign-in with an email allow list.

1. In Zero Trust, go to **Access → Applications** and add a **self-hosted** application for your Scry hostname with an Allow policy for your email.
2. Add three more applications with the action **Bypass** and the include rule **Everyone**, for `<host>/api`, `<host>/mcp` and `<host>/healthz`. The Worker still checks an API key on every request to those paths. The bypass only stops Access from blocking AI tools, which can't complete a browser login.
3. Set the `ACCESS_TEAM_DOMAIN` variable (`https://yourteam.cloudflareaccess.com`) and the `ACCESS_AUD` secret (the application's audience tag). You can also limit sign-ins with `ALLOWED_EMAILS`.

Access and the password can run side by side. Remove `ADMIN_PASSWORD` to switch to Access only.

### Custom domain

Uncomment `routes` in `wrangler.jsonc` and set your hostname, or add it in the dashboard under the Worker's **Settings → Domains & Routes**.

### Weekly digest

Set `EMAIL_API_URL`, `DIGEST_TO` and `DIGEST_FROM`, and add the `EMAIL_API_KEY` secret. Any provider that accepts `{from, to, subject, html}` JSON with a Bearer key works, including [Emailit](https://emailit.com) and [Resend](https://resend.com). The sender must be on a domain you've verified with that provider. **Settings → Preview weekly digest** shows what will be sent.

### More search types

Web is tracked by default. You can turn on Image, Video, News, Discover or Google News for each property in **Settings → Properties → Edit**.

## Connect AI tools

Create a key in **Settings → API keys**. A read key can see all your data. A write key can also change settings, keyword groups and sitemaps, and start a sync. Only a signed-in person can manage keys or service accounts.

**Claude Code**

```bash
claude mcp add --transport http scry https://YOUR-HOST/mcp --header "Authorization: Bearer gsk_..."
```

**Claude Desktop, Cursor and other `mcp.json` clients**

```json
{
  "mcpServers": {
    "scry": { "type": "http", "url": "https://YOUR-HOST/mcp", "headers": { "Authorization": "Bearer gsk_..." } }
  }
}
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.scry]
url = "https://YOUR-HOST/mcp"
bearer_token_env_var = "SCRY_API_KEY"
```

**ChatGPT custom GPTs and other HTTP tool runners:** import `https://YOUR-HOST/api/openapi.json` and set Bearer authentication.

Then ask questions like "Which example.com pages lost the most clicks this month, and what queries did they lose?" or "Find cannibalized queries on example.com and tell me which page should win."

### Tools

| Tool | What it does |
|---|---|
| `list_properties`, `portfolio_overview` | Tracked properties, stored date coverage, and totals across all of them |
| `get_summary`, `get_timeseries` | Totals or the daily trend, with page, query, country, device and brand filters |
| `top_pages`, `top_queries` | Sortable tables with deltas. Pages for one query, or queries for one page |
| `page_details`, `query_details` | Everything about one URL or one query |
| `get_breakdown` | Split by country, device or search appearance |
| `get_insight` | Any of the 11 insights |
| `search_analytics` | A raw live Search Analytics query with any dimensions and filters |
| `url_inspection`, `indexing_report` | Index status for one URL or the whole property |
| `list_sitemaps`, `submit_sitemap` | Sitemap health and submission |
| `list_keyword_groups`, `keyword_group_report`, `save_keyword_group`, `delete_keyword_group` | Rank tracking |
| `list_gsc_sites`, `add_property`, `update_property` | Property management |
| `sync_status`, `run_sync` | Sync coverage and a manual run |

Every tool is also a REST endpoint:

```bash
curl -H "Authorization: Bearer gsk_..." "https://YOUR-HOST/api/p/example.com/queries?days=28&sort=delta_clicks&order=asc"
curl -H "Authorization: Bearer gsk_..." "https://YOUR-HOST/api/p/example.com/insights/striking_distance?format=csv"
```

A property can be given as its id, its exact Search Console URL (`sc-domain:example.com`) or a bare domain. CTR is a percentage. Position is the impression-weighted average, so a negative `delta_position` is an improvement.

## How it works

```
Cron, every 6h ──► Queue ──► Search Console API ──► D1 (daily rows, 16 months)
                                                      │
Browser (password or Access) ──┐                      ▼
AI tools (gsk_ keys) ──────────┴──► Worker ──► reports · insights · MCP · REST
```

- Final data is fetched for every day from 16 months ago up to 3 days ago. The last few days are stored as provisional and replaced once Google finalizes them.
- Each day stores totals plus page, query, query×page, country, device and search appearance rows. Position is stored as `position × impressions`, so averages stay correct across any date range.
- Country and device filters, and anything the stored tables can't answer, go to Google live and are cached for 6 hours. Stored reports are cached for 15 minutes.
- The first backfill for a large site takes a while. Expect roughly an hour per busy property. The Settings page shows progress.

### Limits worth knowing

- **Totals can run higher than query-level numbers.** Google hides rare queries (anonymized queries) from query-level data, and Scry's query views say so where it matters. Property totals match Search Console.
- **The API returns the top rows for each day, not every long-tail pair.** On very large sites, query×page detail stops at what Google returns. Only Search Console's BigQuery bulk export has every row.
- **URL Inspection is limited to 2,000 checks per property per day.** Scry uses up to the daily budget you set (500 by default) and keeps headroom for manual checks.
- **Plan.** Scry runs within Workers limits, but 16 months of data for several busy sites is most comfortable on **Workers Paid** ($5/month), which raises D1 storage and CPU time.

## Security

- Every request, including static files, goes through the Worker's sign-in check. The only exceptions are the login page, its stylesheet, `/healthz` and `/api/openapi.json`, and none of them contain data.
- With no password, no Access and no API key, Scry refuses every request.
- Password sessions are HMAC-signed, HttpOnly, Secure, SameSite=Lax cookies. Logins are limited to 10 attempts per IP every 15 minutes, and changing the password signs everyone out.
- API keys are stored as SHA-256 hashes and can be revoked at any time.
- Service account keys are checked against Google, then stored AES-GCM encrypted with `SA_ENCRYPTION_KEY`. No endpoint ever returns them.
- Requests that change data and rely on a browser cookie must come from the same origin.

Report vulnerabilities through GitHub's [private vulnerability reporting](https://github.com/wpgaurav/scry/security/advisories/new). See [SECURITY.md](SECURITY.md).

## Configuration reference

| Name | Type | Required | Purpose |
|---|---|---|---|
| `ADMIN_PASSWORD` | secret | unless using Access | Dashboard password, 12+ characters |
| `SA_ENCRYPTION_KEY` | secret | yes | Encrypts uploaded service account keys |
| `ACCESS_TEAM_DOMAIN` | var | for Access | `https://yourteam.cloudflareaccess.com` |
| `ACCESS_AUD` | secret | for Access | Access application audience tag |
| `ALLOWED_EMAILS` | var | no | Comma-separated Access allow list |
| `GSC_SA_KEY` | secret | no | One service account JSON key, as an alternative to uploading |
| `EMAIL_API_URL`, `DIGEST_TO`, `DIGEST_FROM` | var | no | Weekly digest |
| `EMAIL_API_KEY` | secret | no | Email provider key |
| `APP_NAME` | var | no | Name shown in the dashboard and MCP clients |

## WordPress plugin

`wordpress-plugin/scry-insights` adds a **Search (28d)** column to the posts and pages lists, plus a Search Console box in the editor with clicks, impressions, CTR, position, index status and top queries. Zip the folder, upload it in WordPress, then go to **Settings → Scry Insights** and enter your Scry URL, a read API key and the property.

## Development

```bash
npm install
cp .dev.vars.example .dev.vars    # add AUTH_MODE=none to skip sign-in on localhost
npm run seed:demo                  # synthetic demo data, no Google account needed
npm run dev                        # http://localhost:8787
npm test
```

New tools go in `src/tools.ts`. That one registry feeds the REST API, the MCP server and the OpenAPI spec. Schema changes go in a new numbered file in `migrations/`, followed by `npm run migrations`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Gaurav Tiwari
