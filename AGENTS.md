# Magnet OS engineering guide

Magnet OS is currently a static, single-file React/HTM PWA backed by Supabase. It is in a staged migration from an internal, single-agency tool to a multi-tenant SaaS. Treat production data and authentication as critical infrastructure.

## Architecture today

- `index.html`: the production UI, client-side authorization, local cache, sync engine, and direct PostgREST access. This legacy monolith must be reduced incrementally; do not rewrite it in one change.
- `supabase/functions/accounts/index.ts`: legacy account API plus an optional Supabase Auth bridge. The legacy token is not a Supabase JWT.
- `supabase/migrations/`: ordered, committed database migrations. Never edit an already-applied migration to change production state.
- `api/`: Vercel serverless email and public-intake endpoints.
- `tools/`: backups, restores, configuration checks, and QA scripts.
- `backups/`: local exports. They are intentionally gitignored and are not a substitute for a managed, encrypted backup policy.
- `docs/`: authoritative architecture, database, recovery, and readiness documentation.

## Runtime and commands

Use Node 22 or newer. Supabase JavaScript tooling no longer supports Node 20 as of June 2026.

```bash
npm test
npm run verify:security
npm run check:config
npm run audit:saas
npm run backup:supabase
npm run backup:validate -- backups/<file>.json
```

The static application has no compile, lint, or type-check step yet. Do not report those as passing. A future modular TypeScript migration must add them before replacing the legacy shell.

## Database migration workflow

1. Inspect the live schema, applied migrations, advisors, row counts, constraints, policies, and storage usage.
2. Create and validate a full production backup, including server-only collections. Record checksum and row counts.
3. Document existing schema, problem, proposed schema, data migration, rollback, and risk.
4. Create migrations with the Supabase CLI (`supabase migration new <name>`). Migrations are append-only and ordered.
5. Prefer additive nullable columns/tables first, then backfill in bounded batches, validate, and only then add `NOT NULL` or stricter policies.
6. Test migrations against a restored staging copy. Run RLS tests as `anon`, `authenticated`, and service-role contexts.
7. Apply to staging, run auth and cross-tenant browser tests, then schedule production rollout with a rollback owner.
8. Never paste person-specific password hashes, access tokens, service-role keys, or one-off employee fixes into migrations.

No destructive production command is allowed without an explicit target, verified backup, tested rollback, and user authorization.

## Authentication rules

- Supabase Auth is the target identity provider. Application profiles and organization memberships are separate records linked by `auth.users.id`.
- Resolve every protected request through one server-side auth context: identity, account status, memberships, active organization, role, and capabilities.
- Normalize email with trim + lowercase and enforce database uniqueness where it represents one logical identity.
- Account creation and invite acceptance must be idempotent. Never report success until required profile and membership state exists.
- Never accept password hashes, organization IDs, roles, permissions, or invite claims from an untrusted browser.
- Never log passwords, tokens, invite secrets, reset links, bank details, national IDs, or full email payloads.
- Recovery endpoints must be enumeration-safe while emitting structured internal diagnostics.

## Authorization and tenant isolation

- Frontend hiding is UX only; it is never authorization.
- Every business row must have an `organization_id` or derive tenant ownership through an enforced foreign-key chain.
- Every browser query and mutation must use the user's Supabase access token. The public key alone must reveal no private business data.
- RLS must validate active membership and the required capability for reads and writes. Service-role access is server-only and narrowly scoped.
- Users may belong to multiple organizations. Never infer organization from email, role name, the first membership, or a hardcoded ID.
- Uniqueness is scoped correctly, for example `(organization_id, slug)` and `(organization_id, user_id)`.
- Sensitive HR and finance fields require narrower tables/policies than general employee profiles.

## Data integrity and coding conventions

- Use database constraints for invariants, transactions for multi-row state changes, and idempotency keys for retried commands.
- Prefer explicit state machines over unrelated booleans or nullable timestamps.
- Use soft deletion for recoverable business data and append-only audit events for sensitive changes.
- Use foreign keys with intentional delete behavior. Default to `RESTRICT`; use `CASCADE` only for true owned children.
- Avoid last-write-wins updates without a version check. Show conflicts instead of silently overwriting them.
- Avoid new business logic in `index.html` when it can be placed in a tested server module. Preserve current behavior while extracting incrementally.
- Keep Arabic/English parity, correct document `lang`/`dir`, keyboard access, and mobile layouts in every UI change.

## Deployment rules

- Production is `https://magnet-op.vercel.app`; validate exact Supabase Site URL and redirect allow-list entries for production, staging, and localhost.
- Required secrets live only in Vercel/Supabase secret stores. `.env.local` is never committed.
- A healthy `/` response is insufficient. Release gates include backup validation, migrations, security tests, cross-tenant tests, role matrix, auth lifecycle, email delivery, and rollback readiness.
- Keep the previous Vercel deployment available during rollout. Stop and roll back on login failure, membership-resolution failure, RLS denial spikes, or data-count mismatch.
- Do not deploy schema-dependent application code before the compatible additive migration is live. Do not enable restrictive RLS before JWT data access is verified.

## Mandatory review checklist

- No unrelated user files changed.
- No secrets or personal credentials committed.
- No production data deleted.
- Migration, data backfill, validation, and rollback documented.
- Tenant filter and server authorization covered by tests.
- Auth state and failure paths observable.
- `npm test`, security verification, config validation, and relevant browser flows executed with honest results.
