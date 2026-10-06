# dbSDK — Deployment (deployment sub-agent)

Owned by the deployment agent. This directory documents and drives the public
GitHub repository and Cloudflare deployment. Nothing here contains secrets.

## Verified state (2026-10-06)

| Item | Status |
| --- | --- |
| Cloudflare `cf` CLI | v1.0.0-beta.12, OAuth-authenticated, 1 account |
| Cloudflare zones | none (both target domains are NOT Cloudflare zones) |
| GitHub | `gh` authed as `pkyanam`, scopes `repo, workflow, gist, read:org` |
| Repo name `dbSDK` | free (no case-variant collision under `pkyanam`) |
| Vercel | CLI 59.16.0, authed as `preethambelweave` / team `preetham-kyanams-projects` |
| `dbsdk.com` | owned via Vercel Registrar, **Vercel nameservers**, created 2026-10-05, expires 2027-10-05 |
| `database-sdk.dev` | owned via Vercel Registrar, **Vercel nameservers**, created 2026-10-05, expires 2027-10-05 |
| Existing DNS | default Vercel records only (ALIAS → `cname.vercel-dns-017.com`, wildcard ALIAS, CAA, Vercel-managed HTTPS/ECH). No project attached; nothing in use |
| Vercel projects | no dbSDK project exists yet |
| Web framework | `blume@^2.1.3` in `apps/web` (static Astro docs build → `dist/`) |

## Cloudflare deployment strategy (verified against official docs)

Primary route: **Cloudflare Pages, direct upload, static Blume build.**

- Blume docs (useblume.dev/docs/deployment): `blume build` → static `dist/` that
  deploys to Cloudflare Pages with zero config. Static output includes every
  page as HTML, local search index, `sitemap.xml`, `robots.txt`, `llms.txt`,
  `llms-full.txt`, redirect pages, prerendered OG images, `.md` raw mirrors
  (served at `<route>.md`), and static JSON API pages
  (`/api/docs/pages/{route}.json`), plus a `_headers` file pinning UTF-8 on the
  agent-facing text endpoints (Cloudflare Pages honors `_headers`).
- Deployed with the `cf` CLI locally (`cf pages create` / `cf pages deploy`)
  and with official `cloudflare/wrangler-action@v3` in CI (the `cf` CLI is not
  published on npm, so CI uses wrangler — the sanctioned fallback).
- Wrangler config for the static path: none required. If the site later needs
  server features (assistant, MCP server, `Accept: text/markdown`
  negotiation), Blume's `cloudflare()` adapter produces a Workers build
  (`npx wrangler deploy`, config auto-written to `.wrangler/deploy/`). **That
  path cannot carry our custom domains today** — see constraint below.

### Hard constraint (verified, do not guess around it)

Cloudflare Pages custom **apex** domains require the domain to be a zone on the
Cloudflare account (nameservers pointed at Cloudflare). Only custom
**subdomains** work with external DNS via a CNAME to `<project>.pages.dev`.
Workers custom domains have the same zone requirement.

Both `dbsdk.com` and `database-sdk.dev` are apexes with nameservers on Vercel
(domains registered through Vercel Registrar). Renaming nameservers would move
DNS away from Vercel management, which the project brief avoids unless the user
explicitly chooses it.

### Consequence: canonical domains (recommended, no nameserver change)

- Cloudflare Pages project `dbsdk` → `dbsdk.pages.dev`.
- Custom domains attached on the Pages project: `www.dbsdk.com` and
  `www.database-sdk.dev` (subdomains — supported with external DNS).
- Vercel DNS changes needed (exactly these, nothing else):
  1. Add `CNAME www → dbsdk.pages.dev` in `dbsdk.com`.
  2. Add `CNAME www → dbsdk.pages.dev` in `database-sdk.dev`.
  3. Apex traffic: a tiny Vercel redirect project (files under
     `deployment/vercel-redirect/`) with both apex domains attached, using
     `vercel.json` redirects to send everything to `https://www.dbsdk.com`.
     The existing default apex ALIAS records already point at Vercel, so
     attaching the domains is all that's needed.
- CAA records: both domains already allow `letsencrypt.org` and `pki.goog`
  (Google Trust Services) — the CAs Cloudflare uses for custom-hostname
  certificates. No CAA changes required.
- Alternative requiring user sign-off: move both zones to Cloudflare
  nameservers to serve the apexes natively from Cloudflare. This abandons
  Vercel DNS management for these domains and is NOT done without approval.

Blume canonical URL: set `deployment.site` in `blume.config.ts` (web agent's
file) to `https://www.dbsdk.com`. Blume correctly warns that Cloudflare Pages'
auto-detected `CF_PAGES_URL` changes per deploy, so an explicit `site` is
required for stable canonical/sitemap/OG output.

## Honest capability surface (static build on Cloudflare Pages)

| Capability | Available on this deployment |
| --- | --- |
| All docs pages (HTML) | Yes |
| `llms.txt` / `llms-full.txt` | Yes (static files) |
| Raw Markdown mirrors | Yes at `<route>.md` URLs; **no** `Accept:` header negotiation (Workers-only) |
| JSON API (page index, per-page docs) | Yes (static `/api/docs/pages/*.json`) |
| Local search index | Yes |
| Sitemap, robots, RSS | Yes |
| OG images | Yes (prerendered) |
| MCP server | No (requires Workers server build + custom domain; blocked by apex/zone constraint) |
| In-page assistant | No (requires server build + model API key) |
| Analytics / cookie consent | Only via third-party keys; not configured in v1 |

## Runbook (final deploy round)

Local (preferred CLI):
```bash
cf pages create dbsdk --production-branch main      # once
cd apps/web && npm ci && npm run build              # produces dist/
cf pages deploy dist --project-name dbsdk           # direct upload
cf pages domains create dbsdk --domain www.dbsdk.com
cf pages domains create dbsdk --domain www.database-sdk.dev
cf pages domains list --project-name dbsdk          # check validation status
```

CI: `.github/workflows/deploy.yml` on push to `main` — npm ci + `blume build`
in `apps/web`, then `wrangler-action` `pages deploy dist --project-name=dbsdk
--branch=main`. Requires GitHub secrets `CLOUDFLARE_API_TOKEN` (scoped: Cloudflare
Pages Edit on this account) and `CLOUDFLARE_ACCOUNT_ID`; created via
`cf user tokens create` and `gh secret set` without printing values.

Never committed: `node_modules`, `dist/`, `.env*`, `.wrangler/`, `.vercel/`,
`.blume/`, `coordination/`, raw account/API output dumps.

## Completed prerequisites (2026-10-06)

- Public repo: **https://github.com/pkyanam/dbSDK** (owner `pkyanam`, PUBLIC,
  branch `main`) — initial commit has `.gitignore`, `deploy.yml`, this file.
- Cloudflare Pages project **`dbsdk`** created → `https://dbsdk.pages.dev`.
- GitHub repo secrets set (values never displayed): `CLOUDFLARE_API_TOKEN`
  (Pages Write/Read + Account Settings Read, account-scoped) and
  `CLOUDFLARE_ACCOUNT_ID`. CI is ready; first production deploy happens at the
  final deploy round once `apps/web` is complete.

## Open decision points for the parent

1. Apex-on-Cloudflare needs a nameserver change to Cloudflare (Option B) or the
   www-canonical redirect approach above (Option A, default). If the user
   insists on `dbsdk.com` (apex) served directly by Cloudflare, that requires
   explicit authorization for the nameserver move.
2. Final deploy round waits on web/core agents finishing `apps/web` and
   `packages/*`; the initial public push contains only deployment-owned files.
