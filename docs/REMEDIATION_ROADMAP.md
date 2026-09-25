# Remediation roadmap

2026-09-25. Execution order follows safety, dependencies and operational value, not number of screens. Local implementation, tested staging and deployed verification are separate states. Nothing here authorizes destructive production migration.

| ID | Priority | Deliverable | Dependency | Exit evidence | State |
|---|---|---|---|---|---|
| S1 | P0 | Fail-closed employee/task identity resolution; canonical assignee authoritative | Existing membership checks | Conflicting mappings deny fallback, unique mapping works, explicit assignment cannot be overridden; full-row migration parity | Implemented and tested locally; staging/rollout pending |
| S2 | P0 | Provisioning, task revocation and upload authorization repair rollout | Independent staging and secured recovery | Real Auth lifecycle, anon/two-tenant/role tests, hosted Storage byte round trip, rollback rehearsal | Local repairs tested; not deployed |
| S3 | P0 | Restore/reconcile production representative staging | Independent Supabase project/credentials | Public rows + Auth mapping + object bytes; reviewed ambiguity ledger; actual restore | External configuration missing; local synthetic SQL harness available |
| S4 | P0 | Resolve identity/payment/storage ambiguity without guessing | Reviewed business evidence | Signed mapping decisions; pre/post hashes/counts/links; no unresolved ownership | Open; preserve affected records |
| S5 | P0 | Exhaustive legacy mutation/tenant policy review | S1/S2, role inventory | Cross-tenant negative tests for every command, sensitive-field denial, service-role narrow scope | Open; no blanket security certification |
| W1 | P1 | Remove false automation success and misleading search failures | None | Unsupported handler cannot write success; failed search differs from no match | Implemented and tested locally; durable automation engine still pending |
| W2 | P1 | Idempotent opportunity/won → client/project/onboarding command | S1, explicit mapping, canonical clients/projects | Concurrent retries produce one conversion; rollback leaves no partial entities; no inferred merge | Lead → client/discovery and accepted revision → discovery implemented/tested; full opportunity/project chain pending |
| W3 | P1 | Follow-ups, meetings and commercial versions | W2 | Owner/next action chain, sent snapshot, approval/signature distinct; reminders persist with browser closed | Follow-ups, queue/reminder adapter, immutable commercial revisions and public review tested locally; hosted scheduler, rich pricing/templates and delivery pending |
| W4 | P1 | Canonical project/brief/audit/strategy → tasks | S3 rehearsal, identity repair | Explicit mapped refs, template retry dedupe, version lineage, dependencies | Pending |
| W5 | P1 | Asset catalog + revision-bound internal/client approval | S2 hosted storage, W4 | Exact version/hash, authorized reviewer, edit invalidation, final file and revision history | Pending |
| W6 | P1 | Content variants + schedule + adapter demo + provider receipt | W5 | Timezone, retry/rate limit/revocation/unknown-result tests; demo never reports real publication | Pending; live OAuth/provider approval later |
| W7 | P1 | Report provenance and renewal handoff | W6 and manual evidence path | Reproducible metric window/source, linked receipt, owned renewal next action | Pending |
| W8 | P1 | Studio persistence and safe draft import | Canonical client/document identity | Draft inventory/export, conflict review, cross-device reload, authorized sharing/export | Pending |
| W9 | P1 | Contextual Inbox across mentions/reviews/follow-ups/failures | Durable domain events | Recipient/read isolation, dedupe, deep links, retries; no silent retention loss | Pending |
| W10 | P1 | Browser webhooks → outbox and observable delivery | Existing server outbox | No immediate sent claims; failure/retry/receipt; no secrets/client side effects | HTTP acceptance/failure corrected; durable adapter migration pending |
| U1 | P2 | Truthful search, accessible command palette and all entity coverage | W1, canonical domains | Label/focus/Escape/arrows, stale response handling, unavailable vs empty, mobile | Error/retry/keyboard semantics repaired locally; entity coverage pending |
| U2 | P2 | Radio opt-in/lazy loading | None | No provider load before user choice; pause/logout cleans up; preserve preferences | Opt-in lifecycle implemented; local Play/Pause/reload verified |
| U3 | P2 | Compact Requests and role-specific execution homes | W9 and reliable source queries | Queue visible early, measured task/approval click budgets, bilingual mobile flows | Requests hierarchy improved; role homes pending |
| U4 | P2 | Incremental module extraction + measured performance | Contract tests per extracted domain | Scoped lint expands, payload/query/render budgets on representative staging volume | Pending; shell 1.53 MB uncompressed |
| U5 | P2 | Mobile/accessibility pass on real populated flows | Staging access | 390px + zoom + keyboard/screen reader, touch targets, measured contrast; task/review/comments/Inbox/CRM/calendar/files | Partial local outage/QA inspection only |
| P1 | P3 | Consistent secondary typography, spacing and motion | P0/P1 gates | Visual regression with same state/viewports | Deferred |
| X1 | P4 | Model-backed helpers, richer Radio/gamification | Reliable core lifecycle | Explicit data/cost policy, labelled output and human approval | Deferred |

## Execution rules

- Continue safe local remediation while external credentials are absent. A demo adapter or fixture proves only its stated contract, never live delivery.
- Every schema repair is append-only, rehearsed on isolated PostgreSQL then representative hosted staging, with before/after full-value reconciliation and rollback. No bulk guessing of employee/client links.
- Browser visual evidence uses fresh captures. Backend-only repairs require real SQL role/persistence tests; screenshots cannot validate authorization.
- Before production use: exact environment separation, full recovery, app/schema compatibility, role matrix, critical agency and employee end-to-end flows, no runtime/console failures, byte storage and delivery checks, observed rollout/rollback owner.
- Phase 1 is still not fully verified on hosted staging. Local work may advance independently; documentation and later-phase screens do not close its gates.

## Why Sheets/WhatsApp cannot yet be retired

Commercial handoffs (W2/W3), reliable execution inputs (W4), versioned approval (W5), publication confirmation (W6), report/renewal lineage (W7), shared drafts (W8), unified attention (W9), delivery receipts (W10), and identity/recovery confidence (S1–S5) are necessary. Keep current operational fallback until each workflow has demonstrated replacement behavior with real staging users and representative data.

New P1 verified finding: mobile bottom navigation intercepted request modal actions. Fixed overlay stacking; required-field validation and Cancel are clickable at 390×844. Hosted request persistence remains a separate gate.

2026-09-26: session rotation/outage handling and workspace selection repaired locally; CSP now uses exact script hashes and blocks event attributes. See `SESSION_AND_CSP_REPAIR.md`. Follow-ups add a canonical linked action chain without importing ambiguous legacy history; see `DURABLE_CRM_FOLLOWUPS.md`.
