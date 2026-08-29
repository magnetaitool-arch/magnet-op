# Magnet OS production readiness gates

Current decision (2026-08-29): **Production remains live; the next release is
blocked until true Staging and email delivery are configured and validated.**

The current environment map is
[`ENVIRONMENT_TOPOLOGY_2026-08-29.md`](ENVIRONMENT_TOPOLOGY_2026-08-29.md).
Historical audit evidence below must not be used to infer the current live
project ref: Production now uses `xqqgbvigfojfydzfguan`, while the public
Staging URL incorrectly points to the same database.

## P0 gates

- [ ] Restore Supabase project-admin access.
- [ ] Capture live schema, policies, grants, applied migrations, advisors, function versions, Auth settings, usage, and storage inventory.
- [ ] Create a fresh complete encrypted backup including server-only data.
- [ ] Restore backup to staging and pass count/checksum validation.
- [ ] Close `accounts_safe` anonymous access.
- [ ] Add organization/profile/membership/role foundation and reconcile legacy identities.
- [ ] Require valid Supabase sessions for private data.
- [ ] Enforce tenant/capability RLS and prove Agency A cannot access Agency B.
- [ ] Remove anonymous read/write from every private business collection.
- [ ] Pass auth lifecycle and role-matrix tests for every live role.

## Reliability gates

- [ ] Multi-row workflows use transactional server commands and idempotency.
- [ ] Browser sync uses server versions/conflict detection.
- [ ] Durable jobs/outbox handle reports, reminders, task/payroll emails, and retries.
- [ ] Email webhooks distinguish accepted/delivered/bounced/complained and drive diagnostics.
- [ ] Backup schedule, RPO/RTO, quarterly restore drill, and rollback compatibility matrix are active.
- [ ] Quota/egress/database/storage/email thresholds alert before restriction.

## Security gates

- [ ] No service keys, API secrets, password hashes, or temporary credentials in client bundle/new Git history.
- [ ] Sensitive HR/finance data is separated and capability-restricted.
- [ ] Invites/reset links are hashed, expiring, single-use, revocable, and replay-safe.
- [ ] Auth rate limiting is atomic; admin unlock is audited.
- [ ] Append-only audit covers account, role, membership, payroll, finance, export, deletion, and support access.
- [ ] Dependency/security scanning and RLS tests run in CI.

## Engineering gates

- [ ] CI runs tests, config validation, migration lint, secret scan, and deployment smoke.
- [ ] Compiled production build, lint, and typecheck exist before legacy monolith retirement.
- [ ] Unit/integration/E2E/security/performance/accessibility/RTL coverage is defined and green.
- [ ] Staging matches production schema/config without sharing production data or secrets.
- [ ] Structured errors/logs/metrics/traces have owners and alerts.

## Product/SaaS gates

- [ ] Organization onboarding, invitation, ownership transfer, suspension, archive/export/closure.
- [ ] Plans/entitlements enforced server-side; billing webhooks replay-safe if billing is enabled.
- [ ] Platform admin separated from tenant roles; support access is time-bound and audited.
- [ ] Legal/privacy terms, retention, data export/deletion, and subprocessors reviewed.
- [ ] Client HQ, stakeholder responsibilities, client team, Magnet Flow, approvals, requests, meetings, decisions, and reports use canonical models.

## Deployment procedure

1. Confirm backup/restore gate and migration/app compatibility.
2. Apply additive migration to staging.
3. Run database/RLS/auth and real browser smoke on staging.
4. Validate email provider and webhook lifecycle using test recipients.
5. Deploy compatible application behind disabled feature flags.
6. Enable for owner/test cohort, then one role at a time while monitoring.
7. Stop on auth, membership, RLS, count mismatch, queue, or email failure spikes.
8. Keep previous deployment and policy rollback package ready.
9. After internal stability, run a controlled single-design-partner pilot in an isolated organization.

## Deployment smoke is more than HTTP 200

Mandatory flow:

New test identity → profile → organization/membership → correct role → dashboard → logout → login → session refresh → password reset → login again. Also run invited-new-user, invited-existing-user, invite replay/expiry, missing-membership recovery, disabled user, suspended organization, and direct cross-tenant REST/RPC/storage denial.

## Evidence recorded for this audit

- The legacy evidence below was captured before the V2 cutover and is retained
  only as history: public data exposure, anonymous `accounts_safe`, incomplete
  backups, unavailable Supabase admin inspection, and the older accounts
  function version.
- On 2026-08-29, a fresh read-only Production configuration check reported zero
  failures: anonymous `records` and `_accounts` access is denied,
  `accounts_safe` returns no anonymous rows, sampled client/employee/invoice
  records return no anonymous rows, and the accounts Edge Function responds.
- The offline application, security, identity, tenancy, workflow, finance,
  contract, documents, tasks, approvals, and health suites are green.
- Authenticated role-matrix, cross-tenant, responsive dashboard, and email
  delivery gates must be rerun against a newly separated Staging project.
- No compiled build/typecheck/lint pipeline exists while the legacy single-file
  application remains in place; do not report those gates as passed.
