# Security

## Reporting a vulnerability

Please use GitHub's [private vulnerability reporting](https://github.com/wpgaurav/scry/security/advisories/new). Don't open a public issue for a security problem.

## Model

- Every request, including static files, passes the Worker's sign-in check first (`run_worker_first: true`). The only public paths are `/login`, its stylesheet, `/healthz` and `/api/openapi.json`, and none of them contain data.
- Sign-in is either a password session or Cloudflare Access. With neither configured, and no API key, every request is refused.
- Password sessions are HMAC-SHA256 signed cookies (HttpOnly, Secure, SameSite=Lax, 30 days). The signing key comes from `ADMIN_PASSWORD` and `SA_ENCRYPTION_KEY`, so rotating either signs everyone out. Logins are limited to 10 attempts per IP every 15 minutes, and passwords shorter than 12 characters are ignored.
- Access sessions are verified against your team's JWKS, issuer and audience, with an optional email allow list.
- API keys (`gsk_…`) are stored only as SHA-256 hashes, are scoped read or write, and can be revoked immediately.
- Service account keys are validated and tested against Google before saving, then stored AES-GCM encrypted with `SA_ENCRYPTION_KEY`. Only a signed-in person can upload or remove them. API keys and MCP clients cannot, and no endpoint returns key material.
- Requests that change data and rely on a browser cookie must come from the same origin.
- The service account only needs Search Console access. Grant it Restricted if you don't need sitemap submission.
- `AUTH_MODE=none` is for local development and only works on localhost.
