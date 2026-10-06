# dbSDK Deployment

Owned by the deployment agent. This directory documents and drives the public
GitHub repository, the Cloudflare Worker, and the Vercel proxy layer. Nothing
here contains secrets.

## Status: PRODUCTION LIVE (2026-10-06)

The real website is deployed and verified on all four public domains. The
site is the actual dbSDK documentation site with generated brand art, docs,
MCP server, and the grounded assistant.

## Architecture

```
browser / agent
   |  https://dbsdk.com  (also www.dbsdk.com, database-sdk.dev, www.database-sdk.dev)
   v
Vercel edge proxy  -- project `dbsdk`, deployment/proxy/vercel.json only
   |  rewrite /:path* -> https://dbsdk.preetham-981.workers.dev/:path*
   v
Cloudflare Worker `dbsdk`  -- Blume cloudflare() server build (apps/web)
   |  full site: HTML, search, llms.txt, llms-full.txt, .md mirrors,
   |  Accept: text/markdown negotiation, JSON API, MCP server (/mcp),
   |  assistant (POST /api/ask), agent discovery docs
   v
(assistant only) Cloudflare Workers AI (free tier), OpenAI-compatible endpoint
```

- Cloudflare hosts the entire main app (Blume server build on Workers).
- Vercel is only a DNS/proxy layer: DNS + TLS + a one-rule rewrite to the
  Worker. No nameserver change was needed; both domains stay on Vercel DNS.
- No silent failover, no second serving path: the Worker is the only origin.

### Why the Worker sits on workers.dev

Cloudflare custom domains (Workers and Pages alike) require the domain to be a
Cloudflare zone. Both apexes are on Vercel nameservers (Vercel Registrar), and
moving DNS off Vercel was ruled out. A `*.workers.dev` subdomain needs no zone,
and the Vercel rewrite carries the public domains to it.

## Verified live (2026-10-06, real content, both apexes and www hosts)

| Check | Result |
| --- | --- |
| `GET /` on all 4 domains | 200 text/html, real dbSDK hero, banner art, giant wordmark |
| `GET /` + `Accept: text/markdown` | 200 text/markdown; charset=utf-8 |
| `.md` mirrors (`/index.md`, `/docs/getting-started.md`, ...) | 200 text/markdown |
| Docs routes | `/docs/getting-started`, `/docs/capabilities`, `/docs/queries`, `/docs/errors`, `/docs/transactions`, `/docs/testing`, `/docs/frameworks`, `/docs/switching`, `/docs/installation`, `/docs/faq`, `/docs/adapters/{postgres,supabase,neon}` all 200 |
| `/llms.txt`, `/llms-full.txt` | 200, contain all real docs pages |
| `/openapi.json`, `/.well-known/api-catalog` (RFC 9727), `/.well-known/ai-catalog.json`, `/.well-known/ard.json`, `/.well-known/mcp.json`, `/agent-readability.json` | 200 |
| `/sitemap.xml`, `/robots.txt`, `/api/docs/pages.json` | 200 |
| `POST /mcp` (initialize) | valid JSON-RPC result, serverInfo `dbSDK` |
| `POST /api/ask` (assistant) | grounded answer citing `/docs/adapters/supabase` and `/docs/queries` (Workers AI llama-3.1-8b) |
| Assistant UI | `aria-label="Assistant"` button on docs pages, `Ask about this code` on code blocks |
| Brand assets | `/brand/banner-v2.webp` (+768/1280), `/brand/icon-v2.webp`, `/icon.png`, `/apple-icon.png`, `/og/*.png` all 200 |
| Canonical + OG | `https://dbsdk.com/`, og:title/og:url/og:image present, twitter summary_large_image |
| Code contrast fix (theme.css) | deployed CSS contains the `pre.astro-code` navy panel + cream text rules, light and dark |
| GET and POST through proxy | all methods, bodies, `Accept` headers pass through intact |

## Components

### 1. Cloudflare Worker `dbsdk`

- Built from `apps/web` with `blume build` using `deployment: cloudflare()`
  (`@astrojs/cloudflare`). Build output: `dist/server/wrangler.json` plus
  `dist/client/` assets.
- Deployed with `npx wrangler@4 deploy -c dist/server/wrangler.json --name dbsdk`.
  `apps/web/wrangler.jsonc` already carries `"name": "dbsdk"`.
- Worker URL: `https://dbsdk.preetham-981.workers.dev` (account subdomain
  `preetham-981`).
- Worker secret `WORKERS_AI_API_KEY` (Workers AI Read token, value never
  displayed) persists across deployments; verified present after the
  production deploy.
- Worker bindings: `BLUME_RATE_LIMIT` (20 requests / 60 s, Cloudflare rate
  limiting binding) and `ASSETS` (static client bundle).
- CI token: GitHub secret `CLOUDFLARE_API_TOKEN` = Cloudflare token
  `dbsdk-workers-deploy`, scoped to Workers Scripts Write + Account Settings
  Read on the single account.
- Total upload ~2.0 MiB (gzip ~494 KiB), 109 client assets, startup ~13 ms.

### 2. Vercel proxy (project `dbsdk`)

- Content: `deployment/proxy/` with only `vercel.json`. The project must
  never contain deployable static files: Vercel serves the filesystem before
  rewrites, so a stray `index.html` would shadow the Worker (reproduced in
  testing earlier: static file at `/` turned `Accept: text/markdown` into
  HTML and `POST /` into 405).
- Deployment Protection is disabled on the project (`ssoProtection: null`,
  set via API). On the Hobby plan, Vercel Authentication otherwise gates
  every request, custom domains included, with a 302 to SSO.
- Domains attached and verified: `dbsdk.com`, `www.dbsdk.com`,
  `database-sdk.dev`, `www.database-sdk.dev`.
- DNS (Vercel DNS, both zones): apexes keep the default ALIAS to
  `cname.vercel-dns-017.com`; `www` CNAMEs added in both zones.
- Deploy manually: `cd deployment/proxy && vercel deploy --prod` (only when
  `vercel.json` changes; no Vercel token exists for CI).
- Note: brief stale-cache windows (seconds) can appear at the edge right
  after a Worker deploy; responses carry `cache-control: public, max-age=0,
  must-revalidate` and clear on their own.

### 3. Assistant backend (Cloudflare Workers AI, free tier)

- Blume assistant via the `openai()` adapter with `baseUrl` pointing at the
  account's Workers AI OpenAI-compatible endpoint
  (`/client/v4/accounts/<account>/ai/v1`), model
  `@cf/meta/llama-3.1-8b-instruct-fp8`, `apiKeyEnv: WORKERS_AI_API_KEY`.
- Verified live: grounded answers with doc citations stream through
  `https://dbsdk.com/api/ask`.
- Free tier: about 10,000 neurons/day, no purchase. If the daily allocation
  is exhausted the assistant answers with an error, acceptable and honest
  for v1.

## GitHub repository

- Public repo: https://github.com/pkyanam/dbSDK (owner `pkyanam`, branch
  `main`). Full source pushed: website (`apps/web`), SDK (`packages/dbsdk`),
  examples, skill, workspace config, root docs, changesets, workflows.
- `.github/workflows/deploy.yml` (this agent): Node 22.12, `npm ci` +
  `npm run build` in `apps/web`, `wrangler-action` deploy of
  `dist/server/wrangler.json` as Worker `dbsdk`. Triggers on `apps/web/**`
  pushes and `workflow_dispatch`. Verified green on the release push.
- `.github/workflows/ci.yml` (core-owned): workspace typecheck/test/build
  for the SDK. Known open failure reported to the parent (pnpm version
  conflict, see coordination/deployment.md).
- No npm registry publication has been made.

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
curl -sS -X POST https://dbsdk.com/api/ask \
  -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d '{"messages":[{"role":"user","content":"What is dbSDK?"}]}'
```

## Cleanup status (2026-10-06)

Deleted as validation artifacts: Workers `blume-cf-test` and `db-echo-test`,
Cloudflare Pages project `dbsdk`, Vercel project `dbsdk-proxy-test`.
Retained: Worker `dbsdk` with its secret, Vercel project `dbsdk` with all
four domains, both GitHub secrets.

## Honest capability surface (this deployment)

| Capability | Status |
| --- | --- |
| All docs pages (HTML) | Yes |
| `llms.txt` / `llms-full.txt` | Yes |
| Raw Markdown mirrors (`.md` URLs and `Accept:` negotiation) | Yes |
| JSON API (`/api/docs/pages.json`, navigation, per-page) | Yes |
| Search (Orama, client-side) | Yes |
| Sitemap, robots, OG images, structured data | Yes |
| MCP server (`/mcp`) | Yes, verified live |
| Assistant (`POST /api/ask`) | Yes, Workers AI free tier, grounded, no tools |
| Assistant UI on docs pages | Yes, header button plus code-block ask affordance |
| Agent discovery (api-catalog, ai-catalog, ARD, agent skills, WebMCP) | Yes, generated by build |
| Analytics / consent | Not configured (needs third-party keys), honestly absent |
| Turnstile bot protection for assistant | Not configured (needs widget), rate limit binding in place |

## Never committed

`node_modules`, `dist/`, `.env*`, `.wrangler/`, `.vercel/`, `.blume/`,
`.blume-verify/`, `coordination/`, `research/`, token files, account dumps.
Raw token values exist only as GitHub/Cloudflare secrets.
