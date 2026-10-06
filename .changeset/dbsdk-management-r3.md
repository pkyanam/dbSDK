---
"dbsdk": patch
---

Management control plane integration review (R3) — the package now covers the full
create/manage/query story for its two built-in providers:

- **First-class list scope (Amendment A3).** `ManagementListQuery` now carries `projectId`,
  `branchId`, and `scope`, validated before dispatch with the same rules as refs. Scoped list
  endpoints type-check directly (`client.list('branch', { projectId: 'p1' })`) — the previous
  runtime-cast workaround is gone. Supabase branch lists and Neon branch/database lists adopt it.
- **Honest readiness (`statusPolling`).** Adapter capabilities may declare which kinds have a
  pollable status field. `wait()` on a bare reference of a kind without one (Neon projects and
  databases, whose readiness is operation-based) is now refused with `CAPABILITY` before any
  request instead of hanging until the timeout budget expires. `describeManagementCapabilities`
  exposes the declaration so docs grids render readiness truthfully.
- **One-time credentials can never leak through later errors.** Secrets extracted from create
  responses (Neon connection strings and role passwords; Supabase generated passwords and branch
  `db_pass`/`jwt_secret`) are registered for redaction, so any subsequent failure message scrubs
  them. Verified against malformed responses, auth failures, redirects, aborts, and timeouts.
- **Accurate package metadata.** The description and keywords now state the real scope (create,
  manage, and query databases on Supabase and Neon) instead of SQL-only wording.
- **Verified provider anchors.** The management contract's Supabase anchors were corrected
  against the official OpenAPI spec: project update is `PATCH /projects/{ref}`, create requires
  `organization_slug` (`organization_id` deprecated) and `db_pass` (generated when omitted),
  `plan` is deprecated and refused, `region` maps to `region_selection`, and branch
  get/update/delete live at the top-level `/branches/{id_or_ref}`.
- **End-to-end lifecycle harness.** A new integration test runs create → wait (aggregating every
  provider operation) → query against a real local PostgreSQL when one is configured, with the
  control plane mocked at the official HTTP shapes (no hosted mutations, no paid resources).
