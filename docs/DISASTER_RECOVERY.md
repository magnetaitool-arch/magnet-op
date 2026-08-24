# Magnet OS disaster recovery

## Current status

Local JSON exports and restore tools exist, but the 2026-08-16 audit could not create a fresh complete production backup because no service-role credential/project-admin access was available. Existing files in `backups/` are useful recovery evidence but may exclude server-only account data and have not been demonstrated through a current staging restore.

Until this runbook is exercised, recovery is **not production-proven**.

## Objectives

Initial internal target:

- RPO: 24 hours maximum; reduce to 1 hour before commercial launch for critical business data.
- RTO: 4 hours internal; reduce to 1 hour for commercial launch.
- Retention: daily 35 days, monthly 12 months, plus pre-migration snapshots.
- Backups encrypted at rest, access logged, and stored outside the primary project/account failure domain.

Final targets require owner approval based on customer contracts and cost.

## Backup layers

1. Managed Postgres backup/PITR appropriate to plan.
2. Scheduled logical schema + data export with checksums and row counts.
3. Private Storage object inventory/export or provider replication.
4. Hosting/environment configuration inventory without printing secret values.
5. Git repository, applied migration list, Edge Function versions, and Vercel deployment reference.
6. Pre-migration snapshot and verified rollback package for every high-risk release.

Never commit production dumps, account hashes, HR/finance data, or environment secrets to Git.

## Required backup gate

Before any restrictive or destructive migration:

```bash
npm run backup:supabase
npm run backup:validate -- backups/<new-file>.json
```

Record:

- Timestamp and operator.
- Supabase project reference and migration head.
- Schema checksum/version.
- Per-table/per-collection row counts.
- Export checksum and encrypted storage location.
- Whether server-only collections and Storage objects are included.
- Staging restore test result.

If any item is missing, stop the migration.

## Restore drill

1. Create an isolated staging Supabase project.
2. Apply migrations from zero in order.
3. Restore the logical backup using dry-run first, then apply.
4. Validate checksums/counts and anomaly queries.
5. Run login, profile/membership resolution, role matrix, cross-tenant denial, core CRUD, file access, email outbox, and Arabic/English browser smoke.
6. Measure elapsed time against RTO and document gaps.
7. Destroy the staging copy safely after approval or retain it under controlled access.

Run quarterly and before the tenant/RLS production cutover.

## Incident recovery paths

### Bad application deployment

- Stop rollout and promote the previous Vercel deployment.
- Do not roll back the app alone when it depends on a newer restrictive schema; use the documented compatibility matrix.
- Compare error/RLS/auth metrics and preserve logs.

### Bad additive migration

- Disable the feature flag/dual-write path.
- Prefer a forward corrective migration.
- Leave new tables/columns intact for investigation unless removal is explicitly approved.

### Data corruption or accidental deletion

- Freeze affected mutations and identify exact organization/entity/time window.
- Preserve audit logs and current snapshot.
- Restore to isolated staging first; extract only required rows when possible.
- Reconcile versions and tenant ownership; obtain approval before production restore.
- Notify affected customers according to policy/law.

### Auth outage

- Do not re-enable anonymous private-data access as a shortcut.
- Verify Supabase status, project quota, Site URL/redirect config, secrets, Edge Function health, and provider email delivery.
- Use audited admin recovery/reconciliation; never distribute a committed shared password.

### Provider quota/egress restriction

- Alert before 60/80/95% thresholds.
- Reduce full-table sync and oversized assets; move static/media delivery to appropriate storage/CDN.
- Keep an approved capacity/plan decision and an export path. A “free forever” dependency is not a continuity guarantee.

## Ownership and communications

Assign by name outside this public repository:

- Incident commander.
- Database/recovery operator.
- Application rollback operator.
- Security/privacy contact.
- Customer/team communications owner.

Every incident gets timestamps, impact, root cause, actions, data validation, and prevention follow-up. Do not include credentials or sensitive payloads in incident notes.
