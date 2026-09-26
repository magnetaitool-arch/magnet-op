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
