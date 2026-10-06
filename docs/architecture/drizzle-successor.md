# dbSDK as the Drizzle successor platform — architecture RFC (R1)

Status: **PROPOSAL + first additive foundation.** Public-readable. Every statement is labeled
**IMPLEMENTED** (source path + passing test cited) or **PROPOSAL** (not shipped, not advertised).
Companion backlog with per-feature acceptance criteria:
`coordination/drizzle-successor-feature-ledger-r1.md`.

## 1. Thesis

Drizzle's ORM/Kit/Seed/validators are mature open source (Apache-2.0 / MIT). dbSDK does not
reimplement them; it composes them over dbSDK-owned connections and adds the layer Drizzle does
not have: provisioning, management, credentials, lifecycle, transfer, capability/evidence
semantics. The successor claim is earned feature-by-feature through the ledger, never by
marketing.

## 2. What exists today (IMPLEMENTED)

| Capability | Where | Evidence |
| --- | --- | --- |
| Provisioning/management: Supabase + Neon (accepted); Planet PostgreSQL source accepted, public exports pending integration owner | `src/management/**` | coordination/drizzle-acceptance-r3.md, planetscale-postgres-acceptance-r4.md |
| Parameterized SQL, capability/evidence model, normalized errors, indeterminate-write semantics | `src/core/database.ts`, `src/sql.ts`, `src/capabilities.ts`, `src/errors.ts` | `tests/core/**` |
| Drizzle execution over dbSDK-owned handles: `drizzlePostgres` / `drizzleNeonHttp` with mode gates (DSN/connection/client refused before dispatch; `sessionState:false` poolers refused before pool creation) | `src/drizzle-interop/index.ts` | `tests/drizzle-interop.test.ts` (accepted r3) |
| Resumable transfer | `src/sync/**` | sync acceptance |
| Schema-authoring import surface `dbsdk/orm` — pure re-export of stable drizzle-orm 0.45.3 root + pg-core. **Integrated in the public tree** as an optional subpath (`dbsdk/orm` export + tsdown entry + packed-consumer smoke; independently accepted in `coordination/orm-public-acceptance-r4.md`) — no full-Drizzle-parity claim (PostgreSQL authoring only; execution, capabilities, and lifetime stay with `dbsdk/drizzle`) | `src/orm-facade/index.ts` | `tests/orm-facade.test.ts` 7/7 + `tests/types/orm-facade.test-d.ts` 5/5 + `tests/orm-facade-acceptance-r2.test.ts` 12/12 + `tests/orm-facade-acceptance-r4.test.ts` 8/8 + whole-package `tsc --noEmit` clean + `scripts/orm-exports-smoke.mjs` (fresh packed consumers: zero-peer root works / subpath-only native refusal; strict NodeNext + EOPT + NUIA inference with non-vacuous negatives; runtime identity vs direct drizzle-orm; live PG through the frozen bridge). **Public API: optional subpath requiring the `drizzle-orm` peer.** |

Simplicity measures (actual counts, not claims):

- Author + execute a typed schema with `dbsdk/orm` (integrated, optional
  public subpath): **2 imports** (`dbsdk` + `dbsdk/orm`) + 1 factory call
  (`drizzlePostgres`) vs today's 3+ imports
  (`dbsdk`, `dbsdk/drizzle`, `drizzle-orm`, `drizzle-orm/pg-core`).
- The facade's `export *` keeps 100% upstream API fidelity: 118 root + 212 pg-core exports,
  zero renames, zero shims; the 5 doubly-exported type names resolve explicitly to the
  pg-core specializations.
- Provision → query → close flow (existing, example 10 + facade tests):
  `createDatabase({ adapter })` → `drizzlePostgres(db, { schema })` → typed queries → `db.close()`
  (lifetime stays with dbSDK; Drizzle never ends the pool).

## 3. Unified API architecture (PROPOSAL — nothing here is shipped)

One client/configuration model across control plane + queries + schema + migrations + seed +
Studio; named provider connections enabling simultaneous multi-provider operations; common verbs
and resource collections.

Design constraints carried from accepted reviews:

1. **Two credential classes, never conflated:** data-plane credentials (connection strings,
   SQL passwords) vs control-plane API credentials (provider keys). Provider API keys are never
   usable as SQL passwords and never reach browsers.
2. **Explicit lifecycle:** `provision → wait → connect (credential reveal) → use → deprovision`;
   one-time secrets are returned once, not stored behind hidden mutations. No undocumented paid
   mutations; bootstrap actions are explicit creation calls that return the connection.
3. **Capability-engine honesty:** a per-connection capability record (engine, transport,
   sessionState, transaction/batch support) gates every verb; non-SQL providers get their own
   surface or no surface — never a fake SQL-parity promise.
4. **Error semantics:** one error model (cause chaining, `indeterminate` for unobservable
   writes, no-retry classes). Today's Drizzle-bridge boundary (native Drizzle errors pass
   through) is a documented first bridge boundary, not the ultimate contract; a guard/error
   seam inside the engine is proposed as a coordinated additive change (ledger F24), not a
   rewrite of accepted APIs.
5. **Provider selection:** simple discriminated config (provider id + credentials + adapter
   options) initially; no hidden global state.

Acceptance criteria when built (sketch): one import exposes management + query factories;
two providers can be provisioned and queried in one process without credential cross-talk;
every verb refuses cleanly on missing capability with actionable errors; no example needs a
raw DSN string for a provider we manage.

## 4. Studio parity plan (PROPOSAL — no UI code this round)

Independent, dbSDK-owned UI (Drizzle's Studio UI is proprietary and is not copied, forked, or
embedded; only the open `drizzle-kit` local-server side is integrable):

- **Architecture:** the UI talks to one shared SDK executor behind a local/self-hosted agent
  (or backend). Provider credentials stay server-side; the published website never holds keys.
  Auth reuses the existing console auth; no anonymous public SQL executor.
- **Feature checklist (parity targets, each gated by its own acceptance):** connection browser;
  table/schema explorer; typed + raw SQL editor; pagination/filter/sort; grid edits/forms;
  constraints/relations view; query history; export/import (CSV/SQL); migrations status;
  capability/status panel from the SDK's evidence model.
- **First vertical slice (proposed):** connection browser + table list + read-only grid with
  pagination/filter, driven by the SDK executor over one local connection. Acceptance: typed
  schema round-trip, parameterized-only execution (no string interpolation of user input),
  credential redaction in every response, mobile-capable monochrome UI per brand.
- Explicitly out: fake/mock UI claiming parity; unsafe public executors; UI code before the
  credential architecture review.

## 5. Licensing (IMPLEMENTED this round)

- dbSDK-owned code: **Apache-2.0** (root `LICENSE` = canonical Apache-2.0 text, taken verbatim
  from the drizzle-orm repository copy; license text itself carries no copyright).
- `NOTICE` (new): dbSDK copyright, license history note — pre-Apache releases remain MIT,
  no history rewrite.
- `THIRD_PARTY_NOTICES.md` (new): distinguishes bundled/copied code (currently **none**) from
  package-manager dependencies (`pg` 8.23.1 MIT, `@neondatabase/serverless` 1.2.0 MIT,
  `drizzle-orm` 0.45.3 Apache-2.0 — versions verified from installed packages) and names the
  Studio UI licensing fact accurately.
- `packages/dbsdk` package metadata: license field changed MIT → Apache-2.0 as a single
  license-only hunk; README license paragraph updated as a single paragraph. Historical MIT
  releases remain available under their own license.
- The `src/orm-facade` module copies **no** upstream source (pure re-export), so it adds no
  third-party attribution obligations; if REUSE ever happens it is registered in
  THIRD_PARTY_NOTICES.md per the rules there.

## 6. What this RFC is not

- Not a claim that dbSDK matches Drizzle feature-for-feature today (see ledger for the honest
  grid).
- Not a performance claim: homepage benchmarks cite Drizzle 1.0.0-beta.2 vs Prisma; dbSDK will
  run its own harness (ledger §3) or claim nothing.
- Not a promise of edge/browser support: browser support is explicitly excluded (credentials
  never reach browsers).
