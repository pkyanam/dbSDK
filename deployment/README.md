# dbSDK — Deployment (deployment sub-agent)

Owned by the deployment agent. This directory documents and drives the public
GitHub repository, the Cloudflare Worker, and the Vercel proxy layer. Nothing
here contains secrets.

## Final architecture (fully verified live, 2026-10-06)

```
browser / agent
   │  https://dbsdk.com  (also www.dbsdk.com, database-sdk.dev, www.database-sdk.dev)
   ▼
Vercel edge proxy  ── project `dbsdk`, deployment/proxy/vercel.json only
   │  rewrite /:path* → https://dbsdk.preetham-981.workers.dev/:path*
   ▼
Cloudflare Worker `dbsdk`  ── Blume cloudflare() server build (apps/web)
   │  full site: HTML, search, llms.txt, llms-full.txt, .md mirrors,
   │  Accept: text/markdown negotiation, JSON API, MCP server (/mcp),
   │  assistant (POST /api/ask), agent discovery docs
   ▼
(assistant only) Cloudflare Workers AI (free tier), OpenAI-compatible endpoint
```

- **Cloudflare hosts the entire main app** (Blume server build on Workers).
- **Vercel is only a DNS/proxy layer**: DNS + TLS + a one-rule rewrite to the
  Worker. No nameserver change was needed; both domains stay on Vercel DNS.
- No silent failover, no second serving path: the Worker is the only origin.

### Why the Worker sits on workers.dev

Cloudflare custom domains (Workers and Pages alike) require the domain to be a
Cloudflare zone. Both apexes are on Vercel nameservers (Vercel Registrar), and
moving DNS off Vercel was ruled out. A `*.workers.dev` subdomain needs no zone,
and the Vercel rewrite carries the public domains to it. Verified live: every
Blume feature works through the proxy (see verification log below).

## Verified live endpoints (2026-10-06, all over plain public HTTPS)

Currently the Worker serves a **placeholder Blume build** (scaffold content)
until the real `apps/web` build lands; the architecture and every feature
below were verified against it through `https://dbsdk.com`:

| Check | Result |
| --- | --- |
| `GET /` on all 4 domains | `200 text/html` (identical to direct Worker) |
| `GET /` + `Accept: text/markdown` | `200 text/markdown; charset=utf-8` |
| `GET /index.md`, `/llms.txt`, `/llms-full.txt` | `200`, correct content types + UTF-8 |
| `GET /.well-known/api-catalog` | `200` `application/linkset+json` (RFC 9727) |
| `GET /sitemap.xml`, `/robots.txt`, `/api/docs/pages.json` | `200` |
| `POST /api/ask` (assistant) | streams a grounded, page-citing answer (Workers AI llama-3.1-8b) |
| `POST /mcp` (MCP initialize) | valid JSON-RPC result, server info returned |
| `POST`, `OPTIONS`, `DELETE` through proxy | method + body + headers preserved (echo test) |
| Query strings, `Host`/`X-Forwarded-Host`, client IP (`X-Forwarded-For`) | preserved |
| 404s, etags, `x-powered-by: Blume` | pass through |
| Canonical tag on `/` | `https://dbsdk.com/` |

## Components

### 1. Cloudflare Worker `dbsdk`

- Built from `apps/web` with `blume build` using `deployment: cloudflare()`
  (`@astrojs/cloudflare`). Build output: `dist/server/wrangler.json` +
  `dist/client/` assets.
- Deployed with `npx wrangler@4 deploy -c dist/server/wrangler.json --name dbsdk`.
  The `--name dbsdk` flag (or a `wrangler.jsonc` with `"name": "dbsdk"` at
  `apps/web/`) is required — the package name `@dbsdk/web` is not a valid
  Worker name.
- Worker URL: `https://dbsdk.preetham-981.workers.dev` (account subdomain
  `preetham-981`).
- Worker secret (already set, persists across deployments):
  `WORKERS_AI_API_KEY` — Cloudflare API token `dbsdk-workers-ai`, scoped to
  **Workers AI Read** only, for the assistant's Workers AI backend.
- CI token: GitHub secret `CLOUDFLARE_API_TOKEN` = Cloudflare token
  `dbsdk-workers-deploy`, scoped to **Workers Scripts Write + Account Settings
  Read** on the single account (replaced the earlier Pages-only token).
- The old Cloudflare Pages project `dbsdk` still exists but is unused by this
  architecture; it can be deleted at final cleanup.

### 2. Vercel proxy (project `dbsdk`)

- Content: `deployment/proxy/` — **only `vercel.json`**. The project must
  never contain deployable static files: Vercel serves the filesystem before
  rewrites, so a stray `index.html` shadows the Worker for that path (this
  exact failure was reproduced in testing: static file at `/` turned
  `Accept: text/markdown` into HTML and `POST /` into `405`).
- **Deployment Protection is disabled** on the project (`ssoProtection: null`,
  set via API). On the team's Hobby plan, Vercel Authentication otherwise
  gates *every* request — including custom domains — with a 302 to
  `vercel.com/sso-api` (verified). With it cleared, all traffic is public.
- Domains attached: `dbsk.com`… precisely `dbsdk.com`, `www.dbsdk.com`,
  `database-sdk.dev`, `www.database-sdk.dev` (all verified).
- DNS (Vercel DNS, both zones): apexes keep the default ALIAS →
  `cname.vercel-dns-017.com`; added `CNAME www → cname.vercel-dns-017.com` in
  both zones. CAA already allows the relevant CAs.
- Deploy manually: `cd deployment/proxy && vercel deploy --prod` (rarely
  changes; not in CI — no Vercel token exists for CI and none can be created
  via CLI).

### 3. Assistant backend (Cloudflare Workers AI, free tier)

- Blume assistant via the `openai()` adapter with `baseUrl` pointing at the
  account's Workers AI OpenAI-compatible endpoint
  (`/client/v4/accounts/<account>/ai/v1`), model
  `@cf/meta/llama-3.1-8b-instruct-fp8`, `apiKeyEnv: WORKERS_AI_API_KEY`.
- Verified live: grounded answers with citations stream through
  `https://dbsdk.com/api/ask`.
- Free tier: ~10,000 neurons/day on the account, no purchase. If the daily
  allocation is exhausted the assistant answers with an error — acceptable and
  honest for v1.
- Requires `@ai-sdk/openai-compatible` in `apps/web` dependencies.

## GitHub repository

- Public repo: https://github.com/pkyanam/dbSDK (owner `pkyanam`, branch
  `main`). Currently contains: `.gitignore` (core-owned), `.github/workflows/
  deploy.yml` (this agent), `deployment/README.md` + `deployment/proxy/`
  (this agent). `apps/web/` and `packages/` are untracked until the parent's
  integration round.
- Workflow `.github/workflows/deploy.yml` (rewritten for this architecture):
  Node 22.12 → `npm ci` + `npm run build` in `apps/web` → `wrangler-action`
  `deploy -c dist/server/wrangler.json --name dbsdk`. Triggers on `apps/web/**`
  pushes and `workflow_dispatch`. Never runs the Vercel proxy (static config).

## Runbook

```bash
# Worker (normally via CI on push; manually:)
cd apps/web && npm ci && npm run build
npx wrangler@4 deploy -c dist/server/wrangler.json --name dbsdk

# Vercel proxy (only when vercel.json changes):
cd deployment/proxy && vercel deploy --prod

# Verify:
curl -H 'Accept: text/markdown' https://dbsdk.com/        # text/markdown
curl -sS -X POST https://dbsdk.com/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

## Honest capability surface (this deployment)

| Capability | Status |
| --- | --- |
| All docs pages (HTML) | Yes |
| `llms.txt` / `llms-full.txt` | Yes |
| Raw Markdown mirrors (`.md` URLs **and** `Accept:` negotiation) | Yes |
| JSON API (`/api/docs/pages.json`, navigation, per-page) | Yes |
| Search (Orama, client-side) | Yes |
| Sitemap, robots, RSS-capable, OG images, structured data | Yes |
| MCP server (`/mcp`) | Yes (verified live) |
| Assistant (`POST /api/ask`) | Yes — Workers AI free tier, grounded, no tools (OpenAI-compatible default) |
| Agent discovery (api-catalog, ai-catalog, ARD, agent skills, WebMCP) | Yes (generated by build) |
| Analytics / consent | Not configured (needs third-party keys) — honestly absent |
| Turnstile bot protection for assistant | Not configured (needs widget) — rate limit binding in place |

## Never committed

`node_modules`, `dist/`, `.env*`, `.wrangler/`, `.vercel/`, `.blume/`,
`coordination/`, token files, account dumps. Raw token values exist only as
GitHub/Cloudflare secrets and (temporarily) in a shredded-at-cleanup local
scratch file.
