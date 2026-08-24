# M0 safety baseline

Date: 2026-08-24
Timezone: Africa/Cairo
Status: PARTIAL — production changes remain blocked

This document is the pre-V2 recovery checkpoint. It records what was actually
verified. It does not treat a partial export, a Vercel preview, or an HTTP 200 as
a production-safe backup or staging environment.

## Change freeze

- No production database migration was applied.
- No Supabase Edge Function was deployed.
- No Vercel production deployment was created or promoted.
- No production environment variable was changed.
- No production business row was written or deleted.
- Previously applied migrations were not edited.
- UI module work is frozen until the identity and authorization foundation is
  proven in staging.

## Git recovery checkpoint

- Previous branch: `codex/saas-readiness-foundation`
- Recovery branch: `codex/recovery-m0-20260824`
- Recovery commit: `ccb5c0bd0eec3d33267218bdebd018a0a13515e1`
- Remote checkpoint: `origin/codex/recovery-m0-20260824`
- Commit purpose: preserve the full pending Magnet OS safety/foundation work
  before M0 documentation or future implementation.
- Secret-pattern gate: no pending service-role, Resend, private-key, or common
  production-secret pattern was found before the checkpoint.
- Static security gate: 26 passed, 0 failed, 1 documented CSP warning.
- `NoMoreExcusePreview/` was intentionally excluded. It is an unrelated project
  and remains untouched and untracked.

The branch push caused Vercel Git integration to create a preview deployment.
That preview is not approved as staging and must not be used for data-changing
tests because the legacy frontend points to the production Supabase project.

## Production application baseline

- Public alias: `https://magnet-op.vercel.app`
- Vercel project: `magnet-op`
- Current production deployment ID: `dpl_4axXuHGWpZRtVGMcQDL2Lx18D7Fc`
- Current immutable deployment:
  `https://magnet-sox594khb-magnetaitool-archs-projects.vercel.app`
- Deployment state: Ready
- Created: 2026-08-13 16:38:52 +03:00
- Current production Git/content baseline: commit `c955f01`
- Current accounts Edge Function health: version 11, database reachable,
  `needsSetup=false`.
- The locally checkpointed candidate differs from production and must not be
  promoted until database, auth, and role tests pass in isolated staging.

The immediately previous known production artifact is:

`https://magnet-dq8yf0raq-magnetaitool-archs-projects.vercel.app`

It remains an application rollback candidate only. Compatibility with the live
database and Edge Function must be checked again immediately before rollback.

## Production environment inventory

Only names, sensitivity type, and targets were inspected. Values are not stored
in this repository.

| Variable | Vercel type | Targets | M0 finding |
|---|---|---|---|
| `EMAIL_SHARED_SECRET` | Sensitive | Production, Preview | Present |
| `RESEND_API_KEYY` | Sensitive | Production, Preview | Present but misspelled; application does not read it |
| `RESEND_API_KEY` | Non-sensitive | Production, Preview, Development | Present with an unexpected value shape; must be replaced and marked Sensitive |
| `FROM_EMAIL` | Non-sensitive | Production, Preview, Development | Present but not configured as a valid sender address |
| `SUPABASE_URL` | — | — | Missing from Vercel inventory |
| `SUPABASE_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | — | — | Missing from Vercel inventory; public intake falls back to the browser key |
| `EMAIL_ALLOWED_ORIGINS` | — | — | Missing |
| `HR_EMAIL` | — | — | Missing; recruitment email alert is disabled |
| `SALES_EMAIL` | — | — | Missing; website lead email alert is disabled |

Required follow-up is to rotate and correct configuration through the Vercel
secret store. Never copy values into Git, chat, screenshots, or client code.

## Emergency database export

A read-only emergency export was created with the publishable key because the
correct service-role/project-admin access is not available locally.

- Local file:
  `backups/magnet-os-backup-2026-08-24-15-00-21.json`
- Git status: ignored; must never be committed.
- Created at: `2026-08-24T12:00:21.166Z`
- File permissions: owner read/write only (`0600`).
- File size: 1,075,985 bytes.
- Exported rows: 1,592.
- Exported logical collections: 43.
- Envelope checksum:
  `sha256:bdcda51ae4e5b63e8bc9e96c45ae403fad8315de1d4426ebc55b6a00c67c0ed9`
- Whole-file SHA-256:
  `93406f8ce0024cd9891065727fefed8eec04f28dac4e899559ae067724a7a004`
- Backup validator: VALID, no duplicate IDs, missing IDs, missing collection
  names, corrupt data objects, count mismatch, or checksum mismatch.
- Includes `_accounts`: no.
- Includes `_ratelimit`: no.
- Includes Auth users/schema, Storage objects, Edge secrets, or database schema:
  no.

This is useful emergency evidence, but it is not the required full production
backup and it is not encrypted/off-device. It cannot satisfy the migration gate.

### Collection row counts in the emergency export

| Collection | Rows | Collection | Rows |
|---|---:|---|---:|
| `_config` | 1 | `activityLogs` | 507 |
| `approvalRequests` | 8 | `attendance` | 104 |
| `briefs` | 3 | `campaigns` | 3 |
| `candidates` | 53 | `chatMessages` | 23 |
| `clientAssets` | 4 | `clients` | 20 |
| `collections` | 8 | `comments` | 10 |
| `contacts` | 1 | `contracts` | 1 |
| `departments` | 9 | `deliverables` | 3 |
| `employeePayments` | 18 | `employees` | 26 |
| `expenses` | 1 | `files` | 1 |
| `fixedCosts` | 31 | `freelancers` | 2 |
| `gameScores` | 10 | `gameStats` | 11 |
| `invoices` | 20 | `leads` | 75 |
| `leaves` | 2 | `meetings` | 1 |
| `notifications` | 277 | `packages` | 3 |
| `partnerSettlements` | 31 | `payments` | 14 |
| `performanceReviews` | 1 | `plans` | 9 |
| `projects` | 21 | `proposals` | 1 |
| `quotations` | 1 | `renewals` | 1 |
| `reports` | 21 | `revisions` | 2 |
| `salesActivities` | 1 | `services` | 11 |
| `tasks` | 242 |  |  |

## Migration baseline

The repository contains ordered legacy migrations `001` through `008` and two
new additive migration candidates:

- `20260816060242_harden_accounts_safe_view.sql`
- `20260816101341_saas_identity_tenancy_foundation.sql`

The production migration ledger could not be read: PostgREST correctly returned
HTTP 406 because `supabase_migrations` is not an exposed API schema. There is no
local Supabase CLI authentication for the account that owns the production
project. Therefore:

- Do not claim the two new migrations are applied.
- Do not infer the exact migration head from filenames or observed columns.
- Do not run `APPLY_ALL.sql` against production.
- Retrieve the real ledger through Supabase project-admin/CLI access before any
  migration.
- Hash and archive the live schema before comparing it with repository state.

## Staging status

M0 staging gate: FAILED / NOT AVAILABLE.

- A Vercel Preview exists for the recovery branch.
- It is not a safe staging environment because the static frontend contains the
  production Supabase URL/key and there is no isolated staging database.
- Preview and production currently share email environment entries.
- No staging Supabase project, independent Auth tenant, Storage bucket, migration
  ledger, or sanitized restore was verified.
- No data-changing test may be executed against the preview.

Required staging properties:

1. Separate Supabase project and credentials.
2. Schema created from ordered migrations.
3. Restore from a sanitized or controlled full backup.
4. Separate Auth users, callbacks, secrets, Storage, email test recipient, and
   WhatsApp test provider.
5. A Preview deployment whose public configuration points only to staging.
6. Production domain and providers cannot be called accidentally.

## Rollback plan

### Application artifact

1. Stop rollout and preserve logs/request IDs.
2. Confirm the previous artifact is compatible with the current database and
   Edge Function.
3. Use Vercel rollback/promote only after owner approval.
4. Smoke login, membership resolution, dashboard, logout, and one read-only core
   module after rollback.

### Edge Function

1. Export and checksum the currently deployed accounts v11 source/config before
   replacing it. The repository's v5 rollback copy is too old to be the primary
   rollback artifact.
2. Keep v11 and the new candidate as immutable deployable artifacts.
3. Roll back function and frontend as one compatibility unit when required.
4. Never restore anonymous private data access to make login appear healthy.

### Additive database migration

1. Disable the feature flag/dual-write path.
2. Prefer a forward corrective migration.
3. Do not drop additive tables after they receive production writes.
4. Compare before/after/orphan/conflict counts.

### Data incident

1. Freeze the affected mutations.
2. Take a fresh full snapshot.
3. Restore to isolated staging first.
4. Reconcile only the affected rows with version/audit evidence.
5. Require explicit approval before any production restore.

## M0 completion blockers

M0 is complete only when all of the following are resolved:

- [ ] Project-admin or service-role access to Supabase production is available.
- [ ] Full schema and applied migration ledger are captured.
- [ ] Complete database backup includes `_accounts` and server-only data.
- [ ] Auth users and Storage inventory/backup are included.
- [ ] Backup is encrypted and copied outside the primary failure domain.
- [ ] Isolated staging Supabase exists.
- [ ] Full backup is restored to staging.
- [ ] Row counts/checksums and orphan/conflict reports pass after restore.
- [ ] Current Edge Function v11 is archived as a rollback artifact.
- [ ] Named recovery, deployment, security, and communications owners are recorded
  outside the public repository.

## M0 verification results

Executed with bundled Node.js `v24.19.0`, which satisfies the repository's
Node 22+ requirement:

- Static/application smoke: 69 passed, 0 failed.
- Email/security tests: 24 passed, 0 failed.
- SaaS foundation safety tests: 47 passed, 0 failed.
- Static Python security verifier: 26 passed, 0 failed, 1 known `unsafe-inline`
  CSP warning.
- Emergency backup validator: valid checksum and structure.
- Git diff whitespace check for the new M0/M1/backlog documents: passed.

Production gates intentionally remain red:

- Configuration audit: 2 failures, 2 warnings.
- `accounts_safe` is anonymously readable.
- Sample private collections are anonymously readable.
- Read-only exposure audit found 20 private collections/views accessible with the
  public key.
- Full server-only backup and provider-level email validation are unavailable.

These failures are release stop conditions, not ignored test noise.

Until then, M1 implementation may be designed and tested statically, but no
production-sensitive migration or cutover may begin.
