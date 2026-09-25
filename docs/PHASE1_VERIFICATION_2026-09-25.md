# Phase 1 continuation verification — 2026-09-25

## Implemented

- Preserved the existing React/HTM shell, routes, brand, responsive components,
  integrations and compatibility data paths; no rewrite or production deployment.
- Extracted checked runtime configuration and auth-entry resolution. Reject secret,
  malformed and foreign-project public keys. Backend discovery failures never
  expose first-owner setup. Added bilingual accessible recovery/loading screens,
  retry, and a bounded 15-second startup discovery wait.
- Hardened PWA cache lifetime, cache writes, offline shell and sensitive request
  exclusions. The service worker cache revision is now v35.
- Added scoped ESLint/strict checked-JS, formatting, allowlisted preview and a
  deterministic 28-file release artifact with SHA-256 manifest. Vercel explicitly
  retains static delivery without installing development-only database tooling.
- Added native PostgreSQL 17 verification, a schema-only legacy fixture, synthetic
  Auth/Storage SQL fixtures, and real role/RLS queries. Test databases use random
  credentials and temporary private directories; they cannot target production.
- Added two unapplied migration files for signup username collisions/oversized
  display metadata and stale uploader authorization. Existing migrations unchanged.
- Updated architecture, database/migration plans, source-license audit, phase
  ledger, README and auth/storage repair/rollback notes.

## Executed checks

| Check                      | Result                                                                        |
| -------------------------- | ----------------------------------------------------------------------------- |
| `pnpm test`                | 825 legacy assertions + 10 service-worker + 7 foundation tests passed         |
| `pnpm run test:database`   | 31 ordered migrations and behavioral checks passed on native PostgreSQL 17    |
| `pnpm run lint`            | Passed for the explicit checked module/tool inventory                         |
| `pnpm run typecheck`       | Passed for extracted foundation JS; legacy inline shell is not strictly typed |
| `pnpm run format:check`    | Passed for the explicit formatted inventory                                   |
| `pnpm run build`           | Passed; 28 allowlisted files packaged, deterministic checksums                |
| `pnpm run verify:security` | 25 passed; existing inline-CSP warning remains                                |
| `git diff --check`         | Passed                                                                        |
| `pnpm run check:config`    | Blocked: explicit application Supabase URL/public key absent                  |
| `pnpm run audit:saas`      | Blocked by the same missing application configuration                         |

Database behaviors exercised: safe pending Viewer provisioning; ignored role
metadata; duplicate-local-part and concurrent signup; bounded display name;
reconciliation retaining existing profile fields; anonymous denial; cross-tenant
read isolation; unauthorized write denial; service-role read; suspended membership;
capability revocation; private bucket; forged object-path rejection; missing-upload
rejection; successful finalize; revoked/suspended uploader denial; restart
persistence; old-function rollback and repair reapplication retaining identity and
client row counts.

## Browser evidence

Ran the application at `http://127.0.0.1:48763` using agent-browser and inspected
actual screenshots. The hosted-without-config state shows recovery, never owner
setup. English/Arabic switching renders correctly at 390×844; desktop at 1440×900.
The existing localhost-only `?uiqa=requests-v3` fixture renders the actual app shell,
request list and new-request picker on mobile and desktop, without horizontal
overflow in the checked desktop view. Training route loads. Captured browser
console/page-error output contained no unexpected JavaScript errors.

This QA fixture does not prove authentication or remote data persistence. Local
preview intentionally returns unavailable for business APIs and public config.
Authenticated browser flows, email delivery, and real Storage HTTP uploads were
not claimed as passing.

## Read-only live database evidence

The existing authenticated CLI could inspect the protected live Supabase project.
A private, gitignored logical public-data backup and schema/Auth/Storage inventory
was created under `backups/phase1-readonly-20260925`. All six file checksums and
all public-table counts validated. It contains 73 public tables, 2,360 records,
45 collections, 20 server-only account records, 17 Auth users, one Storage object,
and 38 applied migrations. All 73 public tables have RLS enabled; policy semantics
still require behavioral review. Catalog inventory: 43 policies, 364 constraints,
191 indexes. Live definitions confirm both repaired defects are present.

Manifest SHA-256:
`084e2e9a2c703ce980881fe5ddafacd8281a900e32b9bf10ba90967c967cd5bb`

The export has Auth metadata and Storage metadata, not password/session secrets
or object bytes. It is not a transaction-consistent, encrypted managed recovery
backup, and no restore of production rows was attempted. Platform advisors and
hosted Auth redirect/email settings were not freshly verified.

## Open release gates

Phase 1 is not production-complete. An independently configured Supabase staging
project is still required for restored-data rehearsal, HTTP Auth/Storage flows,
full role matrix, invitations/recovery/email, cross-tenant browser tests and
rollback ownership. The project whose dashboard name says “STAGING” is the live
production database and remains protected. No new migration was applied remotely.
No later phase is marked complete by documentation or local fixtures.
