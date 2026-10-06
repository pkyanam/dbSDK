# Security Policy

## Reporting a vulnerability

Do not open a public GitHub issue for a security vulnerability. Report it
privately using GitHub's security advisories for this repository
(Security tab, then "Report a vulnerability"), or contact the maintainer
through the repository owner profile. Include a minimal reproduction and
the affected version or commit.

You can expect an initial response within a reasonable timeframe for a
hobby-maintained open-source project; there is no paid support or bug
bounty, and none is claimed.

## Scope

dbSDK is a client library that runs in your application. Vulnerabilities in
the library itself are in scope, for example:

- SQL injection through any documented API path (parameter values, the
  `sql` tag, `sql.identifier`).
- Credential exposure: connection strings appearing in error messages,
  logs, or diagnostic output.
- TLS behavior: silent downgrades or disabled certificate verification.
- The `indeterminate` marking misleadingly claiming a write failed (or
  succeeded) when the code cannot know that.

Out of scope: vulnerabilities in the underlying drivers (`pg`,
`@neondatabase/serverless`) or in the database services themselves; report
those to their respective maintainers. Vulnerabilities in the example
applications that only exist because an example was modified are likewise
out of scope.

## Security posture

Design decisions that bear on security, all verifiable in the source:

- Parameter values are always bound as PostgreSQL parameters, never
  interpolated into SQL text. Dynamic identifiers require the explicit,
  validated `sql.identifier()` API.
- Connection strings stay in your environment. They are never logged and
  error messages redact them (configuration errors name only host, port,
  and username pieces needed for diagnosis).
- Supabase TLS defaults to certificate verification on; connecting without
  verification is always an explicit opt-out.
- No automatic retries of writes, no silent failover, no endpoint
  rewriting.

## Supported versions

The project distributes source only (no npm release yet). If you run a
version, run the current `main`; fixes land there first and are described
in [CHANGELOG.md](CHANGELOG.md).
