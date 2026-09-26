# Foundation cleanup — 2026-09-27

Scope: the visible sync permission blocker and operational backup only. The accompanying broad Studio inventory is deferred in favor of the explicit narrower request.

## Sync investigation

Confirmed in the user's Safari session on magnet-op.vercel.app, Studio, displayed role System Owner / Owner: `SYNC BLOCKED: 1 · PERMISSION`. This is the shared legacy `records` outbox indicator, not evidence that a Studio RPC itself failed. Its permission category represents HTTP 403. The canonical Studio module saves through RPCs; the indicator can reflect a separate queued legacy write.

The affected queue payload is local to that Safari session. The in-app browser is signed out. Safari AppleEvents time out even on reading the active URL, and Web Inspector opened blank. No queue item was deleted/reassigned/replayed, no security policy was broadened, and no production ownership was guessed. Exact record, tenant, actor, client/project and policy remain UNVERIFIED pending the sanitized queue diagnostic requested from the affected session. Do not link an arbitrary Legacy Review case or report sync resolved without it. Existing scope binding and permission-blocked retry behavior are preserved.

## Backup component classification

| Component | Classification | Evidence / remaining requirement |
|---|---|---|
| Database encryption/export | ACTIVE (manual component only) | AES-GCM export, remote checksum and actual isolated restore proven. Overall service remains PARTIAL. |
| Storage encryption/export | ACTIVE (manual component only) | Three business object byte streams restored and checked; recovery bucket excluded from recursion. |
| Scheduled execution | MISSING SCHEDULE / MISSING AUTHORIZATION | GitHub live API: zero workflows; current token scopes `gist, read:org, repo`, no `workflow`. |
| Runner credentials | MISSING AUTHORIZATION | Zero repository Actions secrets. Current approved secret stores are Vercel/Supabase; no credentials copied elsewhere. Expiring CLI export login is unsuitable for unattended runs. |
| Off-device copy | ACTIVE, PROVIDER LIMITATION | Private Supabase recovery bucket exists outside this Mac but inside the source project. Independent-provider copy is MISSING OFF-DEVICE STORAGE for project-loss recovery. |
| Retention | ACTIVE on manual runs; MISSING SCHEDULE for unattended enforcement | Recognized recovery artifacts only, 30-day bounded pruning; prepared Actions artifact retention is 30 days. |
| Failure alert | ACTIVE for executed/reportable failures | Database evidence and owner in-app notifications verified. Scheduler that never starts cannot emit a failure; unattended failure/missed-run coverage awaits runner setup. |
| Provider recovery | PROVIDER LIMITATION | Last inspected provider inventory: no available backups, PITR disabled. No paid upgrade assumed. |

Prepared workflow now requires organization ID before export, preventing a missing tenant setting from being discovered only when publishing the receipt. Backup Health explicitly distinguishes manual protection from inactive automation and explains same-project loss exposure in Arabic and English.

Exact owner actions:
1. Authorize GitHub workflow publishing for the existing repository and installation of the prepared job on `main` (grant `workflow` scope or install it yourself).
2. Approve GitHub Actions as an additional secret store and provision the documented stable database connection, storage credential, encryption key and target organization/project settings; retain the recovery key independently. The first scheduled run and independent artifact restore must pass before ACTIVE is claimed.

These actions enable the already-prepared independent GitHub artifact copy, schedule, retention and failure reporting together. No new paid infrastructure is needed or assumed.

## Release evidence

Application 9009e4d deployed to the existing primary alias, immutable target magnet-4pa5hobye-magnetaitool-archs-projects.vercel.app, deployment dpl_CKJK3eSGsFY1k8NtgMwgd5LJ8rFz. Targeted backup tests (4), regression tests (8), smoke assertions (144), scoped lint/typecheck, security checks, asset/service-worker tests and 44-file build passed. Arabic mobile Backup Health was visually inspected on independent staging with no horizontal overflow or JavaScript errors. Production public login loads with no browser JavaScript errors; authenticated affected-user sync remains blocked on session diagnostics. No RLS or business schema changed.

A new manual encrypted recovery point was exported and remotely checksum-verified at `magnet-recovery/snapshots/2026-09-26T22-51-49.882Z-59b90262-39d4-431e-b1f4-cb98378c11f8`. It includes Phase 3 schema: 142 tables restored into isolated PostgreSQL, 2,683 original row values matched, three Storage object files reconstructed/hash-checked, Auth membership mappings intact. The isolated cluster was stopped. Verified RESTORED receipt recorded; schedule remains false. Earlier failed attempts using the expired CLI connection produced truthful failure receipts/alerts and were retained. Authenticated CLI renewal allowed the successful manual retry; no stable scheduler credential was inferred.

Safari reload preserved the permission-blocked indicator, but the affected browser remained on workspace opening while independent production login worked. Do not clear that browser's pending work. Owner must provide the sanitized diagnostic from the affected session before a record-specific fix or Legacy Review linkage can be chosen safely.
