# Contributing

Thanks for helping. The setup takes a minute and needs no Google account.

```bash
npm install
cp .dev.vars.example .dev.vars     # then add AUTH_MODE=none for localhost
npm run seed:demo
npm run dev                         # http://localhost:8787
```

Before opening a pull request, run `npm run typecheck && npm test`.

## Ground rules

- **No real Search Console data** in fixtures, tests or screenshots. Use `npm run seed:demo`.
- **New features for AI tools go in `src/tools.ts`.** That one registry feeds the REST API, the MCP server and the OpenAPI spec.
- **Migrations are append-only.** Add a new numbered file to `migrations/`, run `npm run migrations` to refresh `src/schema.ts`, and never edit a released migration.
- **UI uses Tabler components.** Add icons to the list in `scripts/build-icons.mjs` and run `npm run icons`.
- **Accessibility:** UI text stays at 0.9rem or larger, and every text colour clears 7:1 contrast in light and dark mode.
- **Secrets never touch the repo.** Config values with IDs, domains or keys belong in your own deployment, not in `wrangler.jsonc`.
