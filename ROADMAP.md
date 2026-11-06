# Roadmap

Scry's job is to turn Search Console data into decisions, without sending that data anywhere you don't control. Everything below follows two rules: it runs inside one Cloudflare Worker, and it stays usable through the dashboard, the REST API and MCP alike.

Status: ✅ shipped · 🔨 next · 🗺 planned · 💭 exploring. Open an issue or a discussion to push something up the list.

## Shipped

- ✅ 16-month backfill with ongoing sync, kept beyond Google's window
- ✅ Dashboard with pages, queries, devices, countries, and page and query detail
- ✅ 11 insights: striking distance, CTR gaps, gains and drops, new and lost queries, cannibalization, content decay, zero clicks
- ✅ URL Inspection budget, coverage changes and sitemaps
- ✅ Keyword groups with no cap
- ✅ MCP server, REST API and OpenAPI from one tool registry
- ✅ Multiple service accounts, uploaded and encrypted
- ✅ Password or Cloudflare Access sign-in, plus a one-click deploy
- ✅ **White-label branding:** name, logo, dark-mode logo, favicon, accent colour with automatic 7:1 contrast, and a login page message
- ✅ Weekly email digest and a WordPress plugin

## Next (v0.3)

### 🔨 Alerts

Rules that watch your data and tell you when something breaks, instead of you finding out a month later.

- Built-in rules: clicks down X% week over week, a page dropped out of the index, a keyword group losing positions, a sitemap error, a canonical mismatch on a top page.
- Per-property thresholds and quiet hours.
- Delivery by email, Slack, Discord, Microsoft Teams or a generic webhook. Each alert carries a deep link to the page or query.
- New MCP tools `list_alerts` and `acknowledge_alert`.

### 🔨 Annotations

Mark the dates that explain your charts: a redesign, a migration, a Google core update.

- Add notes by hand, or import from a CSV or the API.
- An optional, maintained feed of confirmed Google ranking updates, toggled per property.
- Shown as markers on every trend chart, and returned by `get_timeseries`, so AI tools can say "the drop starts two days after the March core update."

### 🔨 Content groups

Group pages with URL rules (`/blog/`, `/docs/`, `/product/*`) and see each section's clicks, impressions and position as a unit. Groups work as filters on every report and in the insights, so you can ask "content decay in /blog only."

## Planned (v0.4)

### 🗺 Client portal and shared reports

For agencies and consultants:

- **Share links:** a read-only link to one property's dashboard, with an optional expiry date and password.
- **Viewer accounts:** each sees only the properties assigned to them, by email allow list (Access) or invite (password mode).
- **Scheduled reports:** a monthly PDF per property, rendered with Cloudflare Browser Rendering and emailed with your branding. CSV attachments are optional.

Branding already covers the white-label side.

### 🗺 Anomaly detection

Seasonality-aware baselines (weekday and week-of-year) for clicks and impressions, per property and per content group. Days outside the expected band are flagged in the UI, in the digest and through alerts. That cuts the false alarms that come from comparing a holiday week to a normal one.

### 🗺 Position history for keyword groups

A daily position chart for each tracked term, best and worst position over a range, and the date a term entered or left the top 3, 10 or 20.

### 🗺 Built-in AI summaries

An optional "Ask Scry" box and an AI paragraph in the weekly digest. You'd bring your own model: Workers AI on your account, or an Anthropic or OpenAI key stored as a secret. It reuses the MCP tools internally, so answers cite real numbers.

### 🗺 MCP over OAuth

OAuth 2.1 sign-in for MCP, using Cloudflare's workers-oauth-provider. That lets Claude.ai web connectors and ChatGPT connectors add Scry with a click instead of a pasted key. Bearer keys stay for CLI tools.

## Later (v0.5+)

- 🗺 **Bing Webmaster Tools:** the same reports for Bing, side by side with Google, through the Bing API with your own key.
- 🗺 **GA4 landing pages:** sessions and conversions next to clicks for each page, through the same service account and the GA4 Data API.
- 🗺 **IndexNow:** ping Bing, Yandex and others when a page changes, by webhook or straight from the indexing view.
- 🗺 **Backups:** a scheduled full export to R2 as CSV or Parquet, plus a restore path. Your history is yours to take anywhere.
- 🗺 **Country × page and device × page facts:** stored, so country and device filters work on the stored data instead of live calls.
- 🗺 **Interface translations,** starting with Hindi, Spanish and German.
- 💭 **BigQuery bulk export ingestion:** for very large sites that need the full long tail Google's API truncates.
- 💭 **Update notices:** a small banner when a new Scry release is available, linking to its changelog.

## Not planned

- Hosting other people's data. Scry is self-hosted by design, so there's no SaaS version.
- Rank tracking that scrapes Google. Scry only uses data Google gives you.
- Reusing third-party plugins' Google tokens. See the README for why.
