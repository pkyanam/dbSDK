# Third-Party Notices for dbSDK

This file records the licensing status of third-party material that is
**bundled or copied into dbSDK source**, and — separately — the licenses of
third-party packages that dbSDK **depends on and resolves via the package
manager** (npm/pnpm). The two categories are deliberately distinguished:

- **Bundled/copied code** ships inside dbSDK and requires attribution here.
- **Package-manager dependencies** are installed from their own published
  packages by the user's package manager and remain under their own licenses
  and copyright; dbSDK does not redistribute them.

Last reviewed: 2026-10-06.

---

## 1. Code bundled or copied into dbSDK source

**Currently: none.**

- No third-party source code is copied into `packages/dbsdk/src/**` or any
  other dbSDK-owned source today. All dbSDK source is original.
- The only third-party text in the repository is the **canonical Apache
  License 2.0 text** itself, now used as the root `LICENSE`. License texts
  are not copyrightable content and carry no attribution obligation; for
  provenance, the file was taken verbatim from the drizzle-orm repository
  (https://github.com/drizzle-team/drizzle-orm, commit
  `15454dbe49d827c6081f3d0231e2e7985e517295`, file `LICENSE`), which uses the
  standard Apache License 2.0 text.

**Rule for future reuse (per the dbSDK licensing decision):** if any upstream
source is ever copied into dbSDK (e.g. from drizzle-orm, drizzle-kit,
drizzle-seed, or validator packages), this section must be updated with:
component name, upstream repository path + commit, upstream license, retained
copyright and NOTICE text, and the files into which it was copied. Apache-2.0
sources additionally require preserving their NOTICE contents (Apache-2.0
§4(4)); MIT sources require retaining the copyright and permission notice.
License texts and trivial boilerplate are not copied "meaninglessly".

---

## 2. Package-manager dependencies (NOT bundled; resolved by npm/pnpm)

### Runtime peer dependencies of `packages/dbsdk` (optional peers)

| Package | Declared range | Resolved version reviewed | License | Notes |
| --- | --- | --- | --- | --- |
| `pg` | `^8.16.0` | 8.23.1 | MIT | node-postgres driver, used by `dbsdk/postgres` / `dbsdk/supabase` |
| `@neondatabase/serverless` | `^1.2.0` | 1.2.0 | MIT | Neon HTTP/WebSocket driver, used by `dbsdk/neon` |
| `drizzle-orm` | `^0.45.3` | 0.45.3 | Apache-2.0 | used by the optional `dbsdk/drizzle` entry and (planned) the `dbsdk/orm` schema facade entry |

These packages are installed into the user's project by their package
manager from their own published distributions. Their licenses and copyright
notices ship inside those packages and apply to them directly. dbSDK neither
bundles nor modifies them.

### Dev-time dependencies (not distributed to dbSDK consumers)

dbSDK's own dev tooling (TypeScript, tsdown, vitest, @types/*, changesets)
and test-time copies of the peer dependencies are standard npm packages
resolved at development time only; they are not part of the dbSDK
distribution (`files: ["dist"]`).

---

## 3. Related tools frequently used alongside dbSDK (not dependencies of the SDK itself)

| Tool | License | Relationship |
| --- | --- | --- |
| `drizzle-kit` | MIT (per its package metadata; the drizzle-orm monorepo root `LICENSE` is Apache-2.0) | dev-time CLI for migrations/schema tooling in user projects and examples; **not** a runtime dependency of the `dbsdk` package. If/when adopted into examples or docs tooling, it stays a devDependency of that workspace. |
| `drizzle-seed` | Apache-2.0 | candidate optional peer for a future seeding entry; not a dependency today. |
| `drizzle-zod` / `drizzle-valibot` / `drizzle-typebox` / `drizzle-arktype` | Apache-2.0 | candidate optional peers for future validator entries; not dependencies today. |
| Drizzle **Studio** | **Not open source.** Official FAQ: "Is Drizzle Studio open source? No. Drizzle ORM and Drizzle Kit are fully open sourced, while Studio is not." (https://orm.drizzle.team/drizzle-studio/overview) | dbSDK does not copy, fork, or embed the Studio UI. Any dbSDK-owned data browser is independently built. The only Drizzle embedding path is the paid B2B Studio Component, which is a business decision — no license right to the UI is claimed or granted by dbSDK's licensing. |

---

## 4. Historical license of dbSDK itself

Releases of dbSDK published before the Apache-2.0 adoption were distributed
under the MIT License ("MIT License, Copyright (c) 2026 dbSDK
contributors"). Those historical versions remain available under that MIT
license. The current tree and all subsequent releases are Apache-2.0 (see
root `LICENSE` and `NOTICE`).
