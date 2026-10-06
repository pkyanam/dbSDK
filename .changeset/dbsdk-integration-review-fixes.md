---
"dbsdk": patch
---

Integration and review round 1 fixes before first release:

- Error classification: SQLSTATE 42501 (insufficient privilege, the RLS denial case) now maps to PERMISSION instead of SYNTAX; classes 25 and 2D (invalid transaction state) map to TRANSACTION.
- Honest uncertainty: transport-level failures during interactive transactions, atomic batches (including multi-statement batches where only a later statement writes), COMMIT races, and lost Neon HTTP batch responses now surface `indeterminate: true` so callers know a write may have committed. dbSDK never retries or replays writes itself.
- Conservative write detection: leading comments, multi-statement strings (simple query protocol), and side-effecting SELECTs (setval, nextval, dblink, large objects, replication functions) are treated as potential writes; added notify, vacuum, analyze, and checkpoint keywords.
- Parameter validation is now consistent: `db.query` and `db.batch` reject `undefined`, function, and symbol parameters exactly like the `sql` tag, before dispatch.
- Supabase adapter defaults to certificate validation ON for remote endpoints (`{ rejectUnauthorized: true }`); Supabase endpoints chain to Supabase's own root CA, so supply it via `pool: { ssl: { ca } }` or opt out explicitly with `ssl: { rejectUnauthorized: false }`. Localhost still defaults to no TLS.
- `db.raw` is now a lazy getter: no pool is created at `createDatabase` time, and after `close()` it surfaces a CONNECTION error instead of a stale pool or a plain Error.
- `db.close()` is fully idempotent: a close failure is reported once; later calls resolve.
- Invalid tagged templates (cooked string parts that are `undefined`) throw instead of silently changing the SQL; the testing adapter's `raw.fixtures` now reflects fixtures added at runtime.
- Clarified capability semantics: `sessionState` means session state works on a dedicated session (inside `transaction()` or a client leased via `raw`); it does not persist between separate top-level pooled queries.
- Contract consolidation: the adapter contract lives only in `src/types.ts`; adapter error classes (`ConfigurationError`, `CapabilityError`) moved to `src/adapters/errors.ts` and remain exported from the adapter subpaths.
