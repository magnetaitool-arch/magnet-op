# Hosted staging verification — 2026-09-26

Independent free Supabase: `vsurqqbxjvqzvqbmetjw`; connected preview: https://magnet-lxn09czi0-magnetaitool-archs-projects.vercel.app (existing Vercel magnet-op project). PRIVATE Auth was paused with owner approval to free the second free-project slot. No paid subscription was purchased. No production rows were copied to hosted staging.

- **48 canonical migrations** applied with original SQL/versions. The extra legacy-registry prerequisite was discovered by restoring actual production data; the test baseline no longer creates that registry invisibly. All source checksums and per-migration counts/constraints/policies are retained privately.
- Real accounts login, Supabase JWT, canonical membership, refresh, restored session, logout, missing JWT and cross-tenant HTTP denial pass. A second synthetic workspace reproduces and verifies the corrected tenant-preserving account update.
- Hosted SQL tests pass authority/role revocation, private file policy, task execution and review, ambiguous assignee denial, approval notifications, accepted proposal handoff, authoritative workflow transitions, persisted onboarding, atomic project setup, immutable brief snapshots, task retry/concurrency/dependencies, follow-ups, immutable/public proposal revisions and concurrent lead conversion.
- Actual Storage HTTP upload, finalize, download checksum, anonymous/public denial and authorized signed download pass.
- Real preview browser: login/dashboard, CRM create/reload persistence, tasks/projects/approvals, Arabic RTL at 390×844, logout/session restoration. Screenshots retained under `audit-assets/2026-09-26`.
- Complete local PostgreSQL 17 behavioral suite passes all 48 migrations, restart persistence, representative reconciliation and rollback/reapply.

Production recovery, actual-data rehearsal and production rollout are recorded in [RELEASE_RECOVERY_VERIFICATION.md](RELEASE_RECOVERY_VERIFICATION.md) and [SHIP_STATUS.md](SHIP_STATUS.md). Staging tests are not relabelled as complete browser E2E or proof of external email/social delivery.

All QA credentials/session files are restricted under `~/.config/magnet-os/`, outside Git. Synthetic staging fixtures remain for future testing. Production QA uses a separately isolated synthetic workspace and is disabled after verification. Never use those credentials as real employee identities.
