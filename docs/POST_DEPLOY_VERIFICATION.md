# Production verification — 2026-09-26

Live: https://magnet-op.vercel.app
Vercel: `dpl_PeWe9xURQsp1QiYFSwAhVForExxU` (`magnet-c90axbgv9-magnetaitool-archs-projects.vercel.app`). Deployed UI: `c0f31f6`. Backend ledger: 61, no repository migrations pending.

## Verified on production

All mutations used isolated synthetic organization data. Business commands used real Owner/Content Creator JWTs; administrative credentials were confined to fixtures, backups, reviewed function deployment and fixture shutdown. No real employee account or business record was edited.

- A coherent persisted chain: lead → completed follow-up and next action → immutable proposal revision → review/approval/acceptance evidence → Won/client handoff → atomic project, ten template tasks and draft invoice → submitted brief and sanitized immutable execution brief → assigned task → execution/revisions/review/approval/delivery/completion → report. Retried commands did not duplicate entities. “Scheduled/Delivered” were internal status tests, not claims of provider publication.
- Actual production browser: populated dashboard/projects/tasks, manager task approval and comment persistence, notifications opening assigned work, canonical employee role and one-task visibility, finance, request submission/manager approval/completion and persisted timeline, report print preview, authenticated workspace search, content calendar navigation, reload/session restoration and logout.
- Real independent employee identity could access assigned work and notifications, but not other assigned tasks, finance, project creation or self-approval. Existing staging role/tenant tests remain applicable; this is not a claim of testing every actual employee account.
- Public contract UI rejected missing signer/consent, accepted a synthetic signer, persisted signature evidence and rejected reuse. Manager activation passed; invalid tokens failed closed. No contract email was sent.
- Synthetic bookkeeping: invoice subtotal 1,000 / final total 990; payments 300 + 690; persisted Paid status and zero balance confirmed in the UI. No money moved.
- Production private storage: reserve → upload real bytes → finalize → authenticated and expiring signed download with matching SHA-256. Anonymous and public-bucket access denied.
- Arabic RTL employee dashboard at 390×844 visually inspected; document width 390. English desktop and critical navigation checked. Screenshots: `audit-assets/2026-09-26/e2e-*.png`. Final Owner/employee sessions had no console entries or uncaught page errors.

55 saved checkpoints cover API workflow/fixture/persistence assertions; browser interactions supplement them. New repeatable regression tests cover canonical employee resolution and real-database request submission, idempotency, self-decision denial, manager approval, saved drafts, list scopes and timelines.

## Issues found and fixed

1. Employee auto-attendance used a legacy account ID and could queue forbidden writes; dashboard employee matching also missed canonical assignments. Canonical employee resolution now uses the Auth-linked employee, never guesses from matching names/emails when a canonical identity exists. Fresh production login saved correct attendance and showed assigned work.
2. Stale approval raised retryable SQLSTATE `40001`, hanging a duplicate business action. Function-only migration returns `PT409`; production retest returned HTTP 409 in 242 ms without changing the saved approval.
3. Direct/draft employee request submission had an ambiguous `step_no` reference. Qualified routing-step columns repaired both paths.
4. Request lists referenced a CTE outside its SQL statement. Count and page now share the same authorized query. Employee and manager browser workflows passed after repair.

All three SQL repairs were separately rehearsed on independent hosted staging, including rollback/reapply. They changed no table, row, role, grant or policy. Each production transaction compared row counts and full-row fingerprints across 11 critical tables and found no business-data change. Details: [APPROVAL_CONFLICT_RELEASE.md](APPROVAL_CONFLICT_RELEASE.md).

## Release gates and cleanup

- PASS: production build; scoped lint/typecheck; full `pnpm test`; 26 security checks; 51 ordered migrations and workflow tests on fresh PostgreSQL 17; independent hosted staging regressions; served HTML/service-worker/critical-module checksums matching build; production runtime target.
- Configuration check: zero failures; external email configuration warning and expected unauthorized email endpoint warning. No email-provider success inferred from these checks.
- Complete private backups include 134-table consistent snapshots, Auth/server-only collections, counts/checksums, encrypted/decryption-verified backup and a fresh native PostgreSQL dump. Prior full restore rehearsal remains documented separately.
- Both temporary production identities disabled, memberships disabled, organization suspended, Auth identities banned/passwords randomized. Old JWT business reads, refresh and legacy login denied. Temporary passwords/sessions/public token removed from private runner state. Synthetic evidence retained in its isolated workspace.
- Final reconciliation: **2,683 original rows across seven critical business/identity tables unchanged**, including after fixture shutdown.

## Verification boundary

Core shipped workflows above passed. **Full external-service sign-off is BLOCKED_EXTERNAL:** Resend/email delivery, real password-recovery/invitation email receipt, and Meta/Instagram/TikTok publication require configured credentials/provider approval and controlled recipient/provider tests. No successful external delivery is claimed. Standalone Studio is not part of this deployed shell; its previously documented unfinished work remains POST_DEPLOY and was not expanded here. Preserved legacy ambiguities still require business review, not automatic repair.
