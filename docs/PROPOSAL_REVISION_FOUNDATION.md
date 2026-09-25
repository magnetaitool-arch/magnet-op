# Proposal revision foundation

2026-09-26. Implemented locally; not deployed. This increment does not complete the entire commercial workflow.

## Existing data and corrected behavior

Legacy proposal JSON remains the working draft and existing client/lead identities remain authoritative. Previously the text preview could set Sent/Accepted through a generic update, without freezing the reviewed offer. The new Versions & review panel captures an immutable revision, source hash, exact snapshot hash and explicit canonical lead/client references. It does not create duplicate clients or import ambiguous references.

The additive `20260925210621_proposal_revision_foundation.sql` creates revision history, append-only state events and an internal command ledger. A composite foreign key enforces the proposal record's tenant. No existing proposal is rewritten merely by applying the migration. Staff explicitly enroll a valid working proposal. Missing title, scope, relationship, currency, explicit price or validity dates blocks capture for review instead of guessing business data.

Revision lifecycle: Draft → Internal review → Internally approved → Sending recorded → Acceptance/decline recorded. Internal decisions require `approvals.manage`; commercial commands require `clients.manage`, with active tenant membership and CRM read access. Evidence is required for sending/acceptance/decline/change requests. These are explicitly staff-recorded events, not an email-delivery receipt or verified digital signature.

All commands use row locks, expected content/version and a request UUID. Replays recheck authorization; conflicting reused payloads fail. Capturing a new revision supersedes pending versions. Changing the working content invalidates pending approvals and returns its working status to Draft. Accepted historical snapshots remain immutable. Enrolled records reject generic status changes; the approval-center link opens the versioned review UI.

Printing uses the frozen recipient name consistently, displays revision and expiry, and opens the existing branded browser print/PDF layout. It does not require a new PDF dependency. Company branding/layout assets remain application-managed; this is immutable commercial content, not a stored binary PDF archive.

## Verification

- 39 ordered migrations execute on isolated PostgreSQL 17.
- Actual SQL tests cover immutable content, explicit relations, cross-tenant/anon/direct-write denial, inactive membership, approval capability, evidence, stale content/version, supersession and idempotent transition replay.
- Concurrent committed snapshot requests create one revision. The committed revision survives database restart. Full representative-row reconciliation across the existing function rollback/reapply retains values and relationships.
- Actual UI connected to isolated PostgreSQL: capture → request review → approve → record sending with evidence → record acceptance with evidence → full reload. The accepted state remained present. English desktop/mobile and Arabic mobile were inspected without horizontal overflow. Print output was checked against a deliberately renamed current client; both recipient fields retained the captured name, and expiry remained visible.
- Browser checks exposed a separate unhandled service-worker update rejection during server restarts. Registration now awaits and handles update rejection, records retry state and retries on its normal triggers. An executable regression covers failure recovery and overlapping calls.

Screenshots are in `docs/audit-assets/2026-09-25/proposal-revision-*.png`; the capture directory spans midnight.

## Remaining work and rollout

Richer reusable proposal templates/line pricing/discount controls and durable provider delivery remain to be implemented. Accepted-version discovery is implemented; project/brief execution handoff still needs the canonical execution and commercial gate work. Legacy unenrolled records retain compatibility; that is not certification of all old status-writing paths. Do not deprecate legacy rows or approval requests without reconciliation.

Hosted validation is BLOCKED_EXTERNAL on independent staging configuration. Before release: validate backup/restore, apply additive migration in staging, rehearse legacy enrollment and cross-tenant/user browser paths, and then deploy compatible UI. Rollback preserves the new history tables and business rows; revert application files and matching CSP hashes. A schema-dependent UI must not be shipped first.


## Public client review and discovery — 2026-09-26

`20260925211852_proposal_public_review.sql` adds revocable, expiring 256-bit capability links. Only a SHA-256 token hash is stored. Raw tokens appear once to the authorized creator and use a URL fragment, avoiding HTTP request/referrer query leakage. The public RPC exposes a specific commercial-field allowlist; it exposes no internal notes, tenant identifiers, client identifiers or respondent contact data. Only approved/sent exact current content is reviewable. Links are bounded to 72 hours and offer validity. Revoked, expired, superseded, changed-content or suspended-tenant links fail closed. Creation does not claim delivery.

Acceptance requires the exact content hash, explicit consent and a self-declared name/email. It records one immutable event under row locks, with replay handling. This proves a response from a link holder, not a verified identity or digital signature. Existing authenticated staff-recorded acceptance remains clearly distinguished in audit evidence. The bilingual mobile page has loading/unavailable/retry and uncertain-response recovery states. Browser testing against real isolated PostgreSQL exercised consent, acceptance, restored receipt and revocation; inputs are 44px minimum and no horizontal overflow was present. New browser error history was empty.

`20260925212939_accepted_proposal_handoff.sql` links an accepted revision to the existing canonical client and discovery workflow. Lead-only offers mark the lead Won and call the existing atomic conversion. Existing client offers reuse the client. Explicit conflicting lead/client mappings, duplicate/deleted workflows and stale content require review; they are never guessed. Handoff rows reference tenant-scoped revisions, clients and workflow records. Repeated commands return one handoff and one audit event; authorization is checked before replay. A late failure rolls back the Won stage, client and workflow. Discovery starts at stage 2; no execution project, signed contract or payment is invented.

SQL tests cover lead/client reuse, persisted handoff reads, rejected direct writes, inactive replay, cross-tenant requests, ambiguous links, stale/unaccepted revisions and injected late-failure rollback. Browser testing used the actual proposal revision component and a loopback SQL adapter, including the client-workspace link. This does not establish hosted Auth, remote staging or production migration success.
