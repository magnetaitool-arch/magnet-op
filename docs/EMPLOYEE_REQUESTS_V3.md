# Magnet OS Employee Requests V3

## What this module adds

Employee Requests V3 is an incremental, server-authoritative replacement for the legacy generic approval-request form. It does not rewrite the Magnet OS shell or delete legacy request history.

The employee experience provides:

- a bilingual **New Request** picker with policy-controlled request types;
- mobile Quick Request flows for lateness, early leave, emergencies, remote work, documents, and expenses;
- server-filled employee identity, department, direct manager, and shift context;
- drafts, review-before-submit, personal status tracking, missing-information responses, cancellation, timeline, private attachments, and A4 PDF output;
- leave quotes that show allowance, used/pending units, remaining balance, holidays/weekends, and team conflicts;
- separate My Requests, My Approvals, Authorized View, Team Calendar, and HR Policies workspaces.

## Security and data model

Migration `20260902000100_employee_requests_v3.sql` creates versioned request policies, request headers, separately protected sensitive payloads, expense lines, approval steps, append-only events, private document links, and idempotent effect records.

The browser has no direct insert/update/delete grants on these tables. All commands resolve the active user and organization server-side. The browser cannot claim an employee, organization, approver, role, balance, or status.

Sensitive request data is split from the normal request shell:

- managers assigned to a sick-leave or expense request can see only the decision context;
- medical content requires sensitive HR access;
- financial content requires finance access;
- confidential complaints bypass ordinary manager dashboards and require `requests.confidential.read`;
- opening a confidential request as HR creates a safe audit event without complaint content;
- confidential attachments use the dedicated `CONFIDENTIAL_REQUEST` document visibility and remain readable only by the owning employee or authorized confidential HR users.

## Approval flow

Default routes are policy-driven. The primary flow is:

`Employee → Direct Manager → HR / Finance / Administration when required → Applied system effect → Employee notification`

HR can create a new policy version to rename, enable/disable, change attachment rules, change allowances, or change approval steps. Existing approved requests continue to reference the historical policy version.

Routing rules support optional `minAmount`, `maxAmount`, `minDays`, `maxDays`, and `department` conditions. Equipment requests can add Finance automatically when a purchase is required. Salary advances intentionally skip the direct manager and route through restricted HR, Finance, and Management approval.

Every decision requires the current request version. Repeated clicks cannot create duplicate submissions or approvals. The requester cannot approve their own request. Partial approval preserves requested units and records the approved units separately.

## Attendance, payroll, and finance effects

Final approval runs one idempotent server command:

- Leave creates a leave record plus dated attendance entries.
- Remote work creates dated attendance entries.
- Late arrival, early leave, shift/day-off, mission, and overtime create authorized attendance records.
- Expenses move into finance processing.
- Salary advances move into restricted employee payment processing.
- Completed HR documents are attached to the employee request and downloaded through short-lived signed URLs.

Existing attendance is never silently overwritten. Any overlapping attendance record changes the request effect to `CONFLICT` so HR can reconcile it through the audited attendance workflow.

## Notifications

Submission, approval, rejection, missing information, and completion create in-system notifications that link to the exact request. Email notifications are queued through the tracked delivery outbox. A queued email is not reported as delivered; provider delivery status remains authoritative.

Confidential email and in-system notification content contains no complaint, medical, payroll, or bank detail.

## Release order

1. Validate a current Production backup and restore it into the isolated Staging Supabase project.
2. Apply this additive migration to Staging only.
3. Run `npm test`, `npm run verify:security`, `npm run check:config`, and `npm run test:employee-requests-v3` with Node 22+.
4. Run authenticated browser tests for employee, manager, HR, finance, administration, and confidential HR roles.
5. Verify Vercel Preview points only to Staging Supabase.
6. Do not deploy the schema-dependent UI to Production until the migration and environment gate pass and Production email secrets are restored.

## Rollback

Rollback is forward-only: remove or feature-disable the V3 UI entry, revoke authenticated execute permission from V3 public RPCs, and keep the request, event, policy, and attachment data for recovery. Do not physically delete request or audit records.
