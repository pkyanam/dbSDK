# dbSDK — Vercel proxy layer

This directory is the **entire** Vercel deployment for dbSDK's public domains.
Vercel is only a thin edge proxy: it forwards every request to the Blume
Cloudflare Worker, which hosts the whole site (docs, search, llms.txt,
Markdown mirrors, JSON API, MCP server). No content lives here.

## Critical constraint

**This directory must contain no deployable static files** (no `index.html`,
no `public/`, etc.). Vercel's filesystem is evaluated *before* rewrites, so a
static file at a path shadows the rewrite at that path — silently serving
wrong content (and turning `POST` into `405`). Only `vercel.json` is deployed.

## vercel.json

Rewrites every path (and the root) to the Worker `dbsdk` at
`https://dbsdk.preetham-981.workers.dev` (workers.dev subdomain; custom
domains on Cloudflare require a Cloudflare zone, which we deliberately avoid —
see `../README.md`).

If the Worker's workers.dev subdomain ever changes, update both rules here and
redeploy (`vercel deploy --prod` from this directory).

## Project settings (already applied via API, not in files)

- Project name: `dbsdk` (team `preetham-kyanams-projects`).
- **Deployment Protection disabled** (`ssoProtection: null`) — on the Hobby
  plan, Vercel Authentication would otherwise gate every request (302 to SSO),
  including custom domains. Verified: with protection on, `test.dbsdk.com`
  returned `302 → vercel.com/sso-api`; after clearing it, all traffic is public.

## Domains attached to this project

- `dbsdk.com` (canonical, apex)
- `www.dbsk.com`-style aliases: `www.dbsdk.com`, `database-sdk.dev`,
  `www.database-sdk.dev`
- DNS (managed in Vercel DNS): apexes keep their default ALIAS →
  `cname.vercel-dns-017.com`; `www` subdomains are CNAME →
  `cname.vercel-dns-017.com`.
