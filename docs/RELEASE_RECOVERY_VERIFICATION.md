# Release recovery verification — 2026-09-26

Production: `xqqgbvigfojfydzfguan`; independent hosted staging: `vsurqqbxjvqzvqbmetjw`.

- PostgreSQL 17 custom archive includes public, Auth, Storage metadata and the actual migration ledger. Native PostgreSQL 17.11 restored it without errors into a new, loopback-only database. No production rows were copied to hosted staging.
- All **109 tables / 16,961 rows** matched a subsequent read-only production snapshot after UTC timestamp and row-order normalization. Password/session-bearing evidence is restricted and gitignored.
- The one stored object was downloaded (18,187 bytes), size checked and SHA-256 recorded. Archive and object bytes are packaged with AES-256-GCM; authenticated decrypt/byte comparison passes. Key is outside the repository in a private configuration directory. This is a verified release recovery point, not a managed offsite backup service.
- The live ledger had 38 applied files and 19 pending originals. Actual-data rehearsal exposed a missing legacy registry dependency. New ordered prerequisite `20260902000000_legacy_migration_registry_compatibility.sql` creates only the private legacy audit registry. CLI-generated file was ordered before its existing dependent migration; no applied SQL was edited. Production now needs **20 files**.
- All 20 passed on the restored production copy. Business records and identity rows are unchanged. Existing work-task rows retain their values, with **121 deterministic project links** added; unresolved references remain present and receive **121 review entries**. Capability additions: 7 keys / 36 grants. No existing table loses rows.
- Before/after reconciliation checks 115→180 foreign keys, 109→151 unique constraints and 436→624 required columns, with no unsupported constraints in this report. Existing findings remain unchanged: 16 active children of deleted parents, 32 shared contact identities, one missing finance projection, one ambiguous legacy identity and one uncatalogued object. No guessed repair was made.
- Tested application-contract rollback restores 124 prior function definitions/privileges and prior trigger definitions on a separate migrated clone. All original business rows remain unchanged; additive tables remain available. Recovery SQL is private beside the archive. Previous production deployment: `dpl_2ZuEpYPwnfQPHvvTHqb5TGFXXdd7` (`magnet-7rqszj73h-magnetaitool-archs-projects.vercel.app`).
- Hosted SQL suite passed tenant/capability/assignment denial, task transitions, proposal acceptance and client handoff, onboarding, atomic project setup, brief snapshots, retries/concurrency, dependencies, follow-ups and conversion. Real hosted Storage HTTP upload/finalize/download checksum/private-public denial/signed download passed. Existing hosted browser evidence covers login, session restore/logout, CRM persistence, projects/tasks/approvals and Arabic mobile.

Private evidence: `backups/release-recovery-20260926/` and `backups/release-staging-20260926/`. Recovery owner for this rollout: executing release operator; retain the previous deployment and use tested contract rollback if an auth, tenant or data regression occurs. Reconcile after production migration before accepting the release.

Standalone Studio prototype, provider-backed social publishing, external email delivery and exhaustive real-employee account testing are **not** certified by these checks. They remain explicitly outside this core release claim; no successful external delivery is simulated.

## Production result

All 20 files applied successfully through the existing authenticated Supabase CLI. Post-apply snapshot: **134 tables / 58 migration ledger entries / zero pending files**. Every pre-existing business and identity value is preserved (new nullable task project links match the rehearsal). Existing reconciliation issue counts remain unchanged. No count loss, guessed ownership repair or production reset occurred.

A temporary synthetic identity/workspace was created solely for production browser testing, separately from Magnet's actual organization; no real employee password was changed. Testing exposed and fixed an account helper that overwrote existing organization IDs with the legacy default. Repeat login and isolated workspace/RLS tests pass after the correction, which was first deployed and tested on independent staging.

After production browser tests, 2,683 original records/profiles/memberships/clients/invoices/payments/tasks were compared again and remained unchanged. The isolated QA account/workspace is disabled, provider identity banned, password randomized and token refresh denied. Private restore cluster was stopped after verification.
