---
"dbsdk": patch
---

Release-fix round 3 — uncertainty honesty and SSL typing fixes:

- **System errnos are no longer mistaken for server SQLSTATEs.** The SQLSTATE
  shape check on `error.code` accepted any 5 uppercase characters, so short
  socket errnos like `EPIPE` (also `EBADF`, `E2BIG`, `EAGAIN`, `EINTR`, ...)
  were reported as a fake `sqlstate`. That suppressed the `indeterminate` flag
  after a transport loss on a write in the single-query and atomic-batch paths
  (the write may have committed, yet the error looked safe). Errno-prefixed
  codes are now recognized as system errors: they never become a `sqlstate`,
  known transport errnos (`EPIPE`, `ECONNRESET`, `ETIMEDOUT`, DNS `EAI_*`,
  ...) are classified as `CONNECTION`, and a write lost to them is reported
  with `indeterminate: true`. Explicit `sqlstate` fields are never errno-
  filtered, so custom and vendor SQLSTATE classes (`P0`, `XX`, `HV`, `FD`,
  custom codes) pass through untouched.
- **`EXPLAIN ANALYZE` is treated as a possible write.** `EXPLAIN ANALYZE` (and
  `EXPLAIN (ANALYZE, ...)`) actually executes the statement, so a transport
  failure during it can hide a committed write. All `EXPLAIN` statements are
  now conservatively flagged as potential writes (plain `EXPLAIN SELECT` is
  over-flagged by design — the heuristic widens `indeterminate`, never narrows
  it, and is never proof a statement is read-only).
- **`ssl` option types accept certificate CA configuration.** The documented
  secure Supabase setup `ssl: { ca }` (and `{ ca, rejectUnauthorized: true }`)
  previously failed to compile (TS2353/TS2322): `ssl` was typed
  `boolean | { rejectUnauthorized: boolean }`. `ssl` on the `supabase`,
  `postgres` and `neon` adapters and on the `pool` escape hatch now accepts a
  pg-compatible TLS options object (`ca`, `cert`, `key`, `rejectUnauthorized`,
  plus other `ConnectionOptions` pass-through). Default verification behavior
  is unchanged: supplying any TLS object keeps validation ON; explicit opt-out
  remains `ssl: { rejectUnauthorized: false }`.
- The Neon adapter's header now states its peer dependency requirement:
  install `@neondatabase/serverless` (pnpm does not auto-install optional
  peers), plus `pg` when using the `postgres` transaction transport.
