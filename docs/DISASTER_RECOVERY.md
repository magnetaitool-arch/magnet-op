# Disaster recovery — Phase 3

## Recovery scope and location

Production uses Supabase PostgreSQL/Auth/Storage (`xqqgbvigfojfydzfguan`), Vercel `magnet-op`, and the existing GitHub repository. The checked provider inventory had zero available database backup entries and PITR disabled. Provider internals are not assumed to provide a usable recovery point.

`tools/operational-backup.mjs` streams native PostgreSQL 17 archives (public, auth, storage, supabase_migrations) and Storage bytes through AES-256-GCM. Ciphertext and manifests are uploaded to private Supabase bucket `magnet-recovery`, downloaded again, and SHA-256 compared. The recovery bucket is excluded from object-byte export to avoid recursive backups. Recovery files are off-device but in the same Supabase project: this does NOT protect against loss of the provider/project. The prepared GitHub artifact workflow supplies a separate-provider copy once authorized.

Database engine roles, provider-owned extensions/configuration, Vercel/Supabase secrets, DNS/provider accounts and the encryption key are not in the archive. Keep code in the existing remote and a separately controlled copy of the recovery key. Auth restore includes identity rows; provider configuration and external integrations need separate restoration.

## Frequency, retention and alerts

Current execution is manual; automatic scheduling remains NOT CONFIGURED. Do not call backup ACTIVE. The supplied workflow is daily 01:20 UTC with 30-day private artifact retention. GitHub authorization lacks workflow publication scope; owner must install the template on the default branch and authorize secret delivery under AGENTS.md. No payment or new project is required by this implementation.

The Supabase runner retains its recognized `snapshots/<timestamp>-<uuid>/` recovery artifacts for 30 days, pruning only its four exact artifact names after a new verified upload. Nothing in business buckets is eligible. Retention executes with the runner, not as an independently active schedule. The existing initial copies must be retained until the first automated recovery point is checked.

`backup_evidence_v3` accepts runner receipts only through a service-role RPC. Failure emits an owner/admin in-app notification. Backup Health shows NOT CONFIGURED without receipts, FAILED after a failure, WARNING for manual/missing/stale schedule or restore evidence, and HEALTHY only with recent off-device, scheduled and restore evidence. There is no email dependency. Until a scheduler is authorized, no unattended failure-monitoring claim is made.

## Operator run

An authorized recovery operator injects the documented `MAGNET_BACKUP_*` environment values from approved secret stores: explicit production ref, organization ID, stable database URL, server Storage key, 32-byte base64 encryption key, and trusted CA path if required. Never paste values into chat, git or logs. Use Node 24 and PostgreSQL 17 clients, then run `node tools/operational-backup.mjs`. A temporary CLI database password may support a manual rehearsal; it is not a recurring credential.

## Restore (never over production for a rehearsal)

1. Retrieve the four ciphertext/manifest artifacts using authorized server access. Verify receipt hashes. Supply the offline recovery key through the environment.
2. Run `node tools/decrypt-backup.mjs database.aesgcm database.manifest.json database.dump` and the equivalent Storage command. Output must be a new private file; authentication or manifest failure aborts. Check the archive with `pg_restore --list`.
3. Create an isolated PostgreSQL 17 cluster bound only to loopback. Prepare required Supabase role names (`anon`, `authenticated`, `service_role`, `supabase_admin`, `supabase_auth_admin`, `supabase_storage_admin`, `authenticator`, `dashboard_user`, `supabase_read_only_user`, `supabase_replication_admin`) and `extensions` with pgcrypto/uuid-ossp. On this fresh disposable cluster only, remove its empty public schema before `pg_restore --no-owner --no-acl --exit-on-error`. Managed staging instead needs its provider-owned prerequisites and an explicitly reviewed restore plan; never blindly clean a shared database.
4. Decode Storage JSONL object/chunk/end records into a private isolated directory. Verify the final complete marker, every object byte count/SHA-256, and matching Storage catalog IDs. Exclude `magnet-recovery` backup metadata from expectations of restored business-file bytes. To restore service, upload verified bytes to the matching private buckets with their reviewed access policies.
5. Verify table/entity counts, native FK/constraint restoration, membership→Auth mappings, canonical links and representative source values. Verify application auth/RLS before exposing a restored environment. Record the exact archive receipt, target and results. A valid SQL exit alone is insufficient.
6. For real disaster recovery, owner selects the target/cutover window and authorizes any overwrite. Configure secrets/redirect allow-lists and retain the previous deployment until login, tenant isolation and core workflows pass.

## Verified rehearsal

The Phase 3 recovery point was downloaded from provider-hosted ciphertext, decrypted with valid GCM tags/manifests, and restored into a fresh local PostgreSQL 17 cluster. All 137 archived application/Auth/Storage/ledger tables restored with strict error handling; three business object streams passed byte/hash checks and matched catalog IDs; membership→Auth orphan count was zero. The cluster was stopped afterward. Private receipts/counts live under ignored `backups/phase3-20260927/`; no credentials or archive contents are committed. Scheduled and independent-provider recovery still require owner activation.

## Incident ownership and response

Assign an incident commander, database/recovery operator, application rollback operator, security contact and communications owner outside the public repository. Retain timestamps, impact, recovery actions and reconciliation evidence without credentials or sensitive payloads. The earlier internal objectives (24-hour RPO / 4-hour RTO) remain planning targets, not achieved guarantees while scheduling is inactive; commercial targets and longer retention require an explicit cost/contract decision. Rehearse quarterly and before high-risk permission cutovers.

For a bad deployment, retain/promote the preceding compatible Vercel deployment and compare auth/RLS errors. For an additive migration defect, withdraw the new UI and prefer a forward correction; retain tables/history. For corruption, freeze affected writes, preserve current evidence, restore into isolation, then obtain approval for a scoped production repair. For an Auth outage, never reopen anonymous private-data access: inspect project health, redirects and Edge Functions and use audited recovery. Provider quota restrictions require an owner capacity decision, not an assumed paid upgrade.
