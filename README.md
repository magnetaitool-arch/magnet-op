# Magnet OS

Magnet's internal agency operating system: CRM, clients, projects, tasks,
recruitment, HR, finance, approvals, public intake, and training documents.
The existing dark/lime React + HTM PWA is served directly from `index.html`;
the build validates and packages an explicit release inventory. This is not the agency's public marketing site.

Production: [magnet-op.vercel.app](https://magnet-op.vercel.app).
Consult [environment topology](docs/ENVIRONMENT_TOPOLOGY_2026-08-29.md)
before using any Supabase project. Older handovers refer to a retired database.

## Architecture and routes

- `index.html`: bundled React/HTM runtime, styles, app shell, navigation,
  bilingual screens, compatibility data access, and sync. Extract incrementally.
- `modules/employee-requests-v3.js`: extracted employee request UI/domain helpers.
- `api/` and `server/`: Vercel endpoints and shared intake, outbox, and health services.
- `supabase/functions/`: account compatibility and canonical identity services.
- `supabase/migrations/`: ordered database migrations; historical files under
  `supabase/legacy-migrations/` are not a deployment recipe.
- `serviceworker.js`: network-first HTML and cached static assets. APIs,
  cross-origin requests, authorization headers, and media ranges bypass caching.
- `tools/`: local regression checks, staging checks, backup and recovery tooling.

The root serves sign-in/setup and authorized internal views. Existing public
query routes include `?form=`, `?brief=`, `?verify=`, and `?contractReview=`.
Record links use `?open=…&id=…`. Training/manual HTML pages and `magnetrun.html`
are separate documents. Vercel rewrites extensionless non-API paths to the shell.

## Local validation

Use **Node 22+**. The root package has no third-party production runtime dependencies. Lint and strict
JavaScript type checking cover the newly extracted foundation modules, not the legacy
inline shell. PostgreSQL and developer tooling are development dependencies.

```bash
npm run lint
npm run typecheck
npm run build
npm test
npm run test:database
npm run verify:security
npm run check:config
npm run audit:saas
npm run test:service-worker
```

`pnpm run <script>` runs the same checks when pnpm is the available runner.
The test suite is local. Configuration and SaaS audits require explicit
Supabase environment settings; they must not fall back to another project.
See [.env.example](.env.example). Keep secrets out of Git and browser code.

`npm run dev` starts an allowlisted loopback preview on port 48763. `npm run build`
writes the validated release inventory and SHA-256 manifest to `.magnet-build/`; it
does not deploy. Vercel explicitly skips installation/build to preserve the existing
static delivery and built-in-only server endpoints; developer tooling is not required
in production. The preview deliberately serves no production credentials or business APIs.
Authenticated flows also require
`/api/runtime-config` and the configured server services. A plain static preview
without those services is not evidence of working authentication or setup.
Offline shell caching likewise does not bypass runtime configuration or auth.

## Recent implementation

The latest committed feature work adds employee requests/approvals and monthly
finance cycles, including historical fixed costs and period-end balances.
See [continuation audit](docs/CONTINUATION_AUDIT_2026-09-25.md) for the latest
local validation and PWA reliability changes.

## Release and recovery

Read [AGENTS.md](AGENTS.md), [production readiness](docs/PRODUCTION_READINESS.md),
and [environment topology](docs/ENVIRONMENT_TOPOLOGY_2026-08-29.md) first.
The last documented release gate requires independent staging and verified
email delivery. Confirm current live state before rollout.

```bash
npm run backup:supabase
npm run backup:validate -- backups/<file>.json
```

Migrations are append-only and must be tested on a restored, separate staging
project with auth, role-matrix, and cross-tenant checks before production.
Never run historical migration instructions from old handovers against production.
Keep the prior deployment available; follow
[disaster recovery](docs/DISASTER_RECOVERY.md) for rollback.

## Documentation

- [Architecture](docs/ARCHITECTURE.md): target architecture and incremental migration.
- [Auth](docs/AUTH_ARCHITECTURE.md), [database](docs/DATABASE.md), and
  [employee requests](docs/EMPLOYEE_REQUESTS_V3.md): domain foundations.
- [Admin operations](docs/ADMIN_OPERATIONS_GUIDE_AR.md): operational workflows.
- [UX backlog](docs/UX_V2_BACKLOG.md): historical planning, not a current completion ledger.
- [Backup and restore](BACKUP_AND_RESTORE.md): backup tooling.

Older root-level audit/handover reports are historical evidence. Resolve conflicts
using current source, timestamped migrations, environment topology, and fresh checks.

## Isolated database verification

`npm run test:database` starts native PostgreSQL 17 on a dynamically selected loopback port with a
random password and a temporary private directory. It never reads `DATABASE_URL`,
production rows, or Supabase credentials. It restores the committed schema-only
legacy fixture and applies the 32 canonical migrations in order, then tests
profile provisioning, anonymous access, cross-tenant reads, denied writes, service
access, membership suspension, capability revocation, and restart persistence.
The temporary test cluster is removed after shutdown.

With pnpm, the platform binary's symlink hydration must be allowed during install;
`pnpm-workspace.yaml` permits only the reviewed Darwin ARM64 package script.
Other platforms require reviewing and permitting their matching package.
The local `auth` and `storage` fixtures model SQL claims and metadata only; this
test does not replace Supabase Auth HTTP, Storage HTTP, or restored staging tests.

## Legacy reconciliation

Review `docs/LEGACY_COMPATIBILITY_MATRIX.md` and
`docs/MIGRATION_RECONCILIATION_REPORT_2026-09-25.md` before migrating a domain.
Run `pnpm run reconcile:data -- <M0-snapshot.json> backups/<new-report-directory>`
for a read-only reconciliation report; optionally append a second snapshot to compare
full row hashes. Findings never trigger repairs or authorize deletion.
`pnpm run test:reconciliation` tests the checker and explicit-link conversion guard.

### Static asset and CSP release checks

After editing local modules/styles, run `pnpm run assets:update` to update their content-based URLs. After editing inline HTML scripts, run `pnpm run csp:update`. The production package build rejects stale asset versions or CSP hashes. These commands only modify local release references/configuration; they do not deploy.
