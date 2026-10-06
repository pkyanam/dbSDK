# dbSDK functional checkpoint — 2026-10-06

This checkpoint ships the first functional dbSDK release candidate: one typed SDK to
create, manage, and query PostgreSQL databases on Supabase, Neon, and PlanetScale
Postgres, with a Drizzle ORM bridge and a source-to-target data transfer engine.

## What is included

- **Management control plane** — create/manage/query resource bridges for
  [Supabase](/docs/management) (projects, orgs, regions, connections, actions,
  credential rotation and recovery) and [Neon](/docs/management), plus
  [PlanetScale Postgres](/docs/adapters/planetscale) control-plane and query
  adapters with explicit `cluster_size`, one-time-password role creation, TLS and
  session/secret guards.
- **Query adapters** — Postgres, Supabase, Neon, and PlanetScale Postgres SQL
  adapters with normalized errors, TLS handling, and honest capability reporting.
- **Drizzle ORM bridge** — `dbsdk/drizzle` connects the Drizzle ecosystem to dbSDK
  connections as an optional peer (`drizzle-orm` is never statically bundled);
  see [Drizzle](/docs/drizzle).
- **Resumable data transfer** — `dbsdk/sync` copies tables between PostgreSQL
  databases with an injectable checkpoint store, digit-exact numeric/decimal
  transport, a frozen per-read projection with a catalog drift guard, and a
  single-writer high-water cursor; see [Sync](/docs/sync).
- **License** — the project license is now Apache-2.0 (canonical text in
  `LICENSE`, with `NOTICE` and `THIRD_PARTY_NOTICES.md`; the packed npm tarball
  carries byte-identical copies, checked by `scripts/license-pack-check.mjs`).
  Historical pre-Apache releases remain MIT under their own license.

## Verification

- Whole-package typecheck clean (`tsc --noEmit`, zero errors).
- 945 tests passed / 3 skipped (informational skips) across the SDK suite,
  including focused acceptance suites for management, PlanetScale (R4),
  provider review (R2), Drizzle interop (R3), and sync fidelity (R7/R8, 185
  focused tests) — run against a local PostgreSQL 17 container; no hosted
  database calls.
- Packed-tarball consumer checks: every accepted public subpath present, root /
  management / drizzle entries stay lazy over optional peers, strict TS fences
  clean, and an offline end-to-end sync run from the packed tarball passes.
- Distribution smokes: `dist-smoke.mjs`, `planetscale-exports-smoke.mjs`,
  `drizzle-interop-smoke.mjs`, and `license-pack-check.mjs` all pass.

## Honest boundaries

- The package is **not yet published to npm**; `0.1.0` has no tag or release.
- No Vitess/MySQL PlanetScale support, no PlanetScale lifecycle actions, branch
  PATCH, backups, or IP restrictions.
- `dbsdk/sync` is a one-way PostgreSQL copy with a single writer per key:
  no CDC, no two-way sync, no delete propagation, no distributed atomic
  transactions, and no universal all-PG-types fidelity guarantee beyond the
  documented value classes.
- The Drizzle bridge is an interop surface, not full ORM/Kit/Seed/Studio parity.
- A roadmap RFC for a future successor platform lives at
  [`docs/architecture/drizzle-successor.md`](/architecture/drizzle-successor);
  its "IMPLEMENTED" table is limited to what ships here and everything else is
  explicitly labeled PROPOSAL.
