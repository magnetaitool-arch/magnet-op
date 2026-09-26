# Operational backup

Status: PARTIAL / OWNER_ACTION_REQUIRED. Existing release archive was restore-tested. The new scheduled job is not active or restore-certified until configured on the repository default branch and its first run is verified.

- Daily 01:20 UTC GitHub Actions job; AES-256-GCM encrypted PostgreSQL custom archive uploaded as a private Actions artifact, retained 30 days. No plaintext archive leaves the stream or enters git.
- Required repository secrets: `MAGNET_BACKUP_DATABASE_URL` (stable server-side backup connection, not an expiring CLI login), `MAGNET_BACKUP_KEY_BASE64` (32 random bytes, base64), and `MAGNET_BACKUP_STORAGE_SERVICE_KEY` (server-only Storage read credential). Variable `MAGNET_BACKUP_PROJECT_REF` must match the connection. Keep an independent offline copy of the encryption key.
- Failure is a failed workflow with a summary. Owner must enable Actions failure notifications and designate a responder. Missing configuration fails visibly; no false success.
- Database and Storage bytes use separate authenticated encrypted archives. Storage object inventory is read server-side; every downloaded object is byte-counted and SHA-256 checksummed. The job fails on missing/changed objects. A successful scheduled run and offsite restore rehearsal remain required before calling backup active.

Restore into a separate staging database only. Download ciphertext and its manifest, verify AES-GCM tag, and compare plaintext SHA-256 to the manifest. Archive layout: ASCII `MAGNET-BACKUP-V1\n`, 12-byte nonce, ciphertext, trailing 16-byte authentication tag. Decrypt with the offline 32-byte key; use `pg_restore --list`, then restore with PostgreSQL 17 into an isolated empty rehearsal database. Never target production. Compare counts, relationships, ownership and actual application behavior using the existing recovery/reconciliation tools. The Storage archive decrypts to JSONL: header, object metadata, base64 chunks, per-object end/checksum, complete count. Concatenate chunks per object and verify its size/SHA-256 before restoring to the matching staging bucket/name. Never accept an archive without its complete marker and valid authentication tag. Record evidence before declaring recovery successful.

TLS verifies the server certificate (`verify-full`); use the system CA bundle or set `MAGNET_BACKUP_SSLROOTCERT` to a provisioned trusted provider CA file.

Current AGENTS.md limits required secrets to Vercel/Supabase stores. Enabling this optional GitHub Actions transport requires an owner-approved exception for repository secrets, or an owner-selected runner that injects secrets from those existing stores. No credentials have been uploaded to GitHub.

No paid plan, production reset, key upload or scheduled success is assumed.

Deployment authorization: the existing GitHub OAuth credential cannot publish Actions workflows (missing `workflow` scope). The complete workflow is preserved as `tools/encrypted-backup-workflow.yml`; an authorized repository owner must install it at `.github/workflows/encrypted-backup.yml` on the default branch after approving credential delivery. No automation is claimed active. Studio publication does not depend on this permission.

Phase 3 adds `tools/operational-backup.mjs`, a private same-provider off-device recovery copy, strict decrypt/manifest verification, bounded 30-day artifact retention, persistent Backup Health receipts and in-app failure alerts. An actual encrypted off-device download/restore rehearsal passed (137 tables, three business object byte streams). This remains PARTIAL: neither an unattended schedule nor independent-provider protection is active. See DISASTER_RECOVERY.md for the exact runbook and exclusions.

Foundation follow-up: live GitHub API confirms zero workflows and zero Actions secrets; token still lacks workflow scope. Required organization ID is now checked before export. A fresh recovery copy including Phase 3 passed isolated restore (142 tables, three files, 2,683 original row values). See FOUNDATION_CLEANUP.md for per-component classifications and the two exact authorization/configuration actions. Overall status remains PARTIAL.
