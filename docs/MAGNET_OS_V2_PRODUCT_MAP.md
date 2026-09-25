# Magnet OS V2 product map

Target design, not implemented-state declaration. Incrementally retain the existing shell, brand, bilingual behavior and working commands. The source inventory and deprecation gates are in [the compatibility matrix](LEGACY_COMPATIBILITY_MATRIX.md).

## Canonical modules

| Module | Owns | Connects to | Technical action and reason |
|---|---|---|---|
| Identity & workspace | Auth user, profile, organization, membership, role/capability, employee-user mapping | Every protected command | IMPROVE: existing Supabase foundation is useful; ambiguous legacy identity cannot grant access |
| Clients | Client, contacts, engagement ownership, account timeline | Sales, delivery, content, finance | MERGE: Accounts is the client workspace; no separate Studio/publishing client |
| Sales | Lead, opportunity, activity, follow-up, source, qualification, won/lost reason | Commercial snapshot and onboarding | IMPROVE: keep stage history; replace browser multi-write conversion |
| Commercial | Proposal versions, price packages, contract, invoice reference | Opportunity/client/project | MERGE: quotations become a commercial document type; signature evidence remains distinct from internal approval |
| Delivery | Project, campaign, task, dependencies, recurring instances, comments, assignment | Brief, assets, reviews | IMPROVE: extend versioned task commands; move project relationships out of loose JSON |
| Knowledge & Studio | Brief, audit, strategy, SOP, structured document, document version/export | Client/project/task/campaign | REBUILD persistence boundary: retain useful editor/export work, migrate local drafts with hashes and review; no second record model |
| Assets & review | Asset, immutable asset version, feedback, approval decision, final designation | Task/content/publishing | MERGE: Files, Client Assets, Document Center, deliverables and revisions become related views of one asset lineage |
| Content & publishing | Content item, platform variant, schedule, connection, publish job, receipt | Approved revision, campaign, result | REBUILD publication authority: manual status is not provider confirmation; keep calendar as a view |
| Results & reports | Metric definitions, source observations, report snapshot, renewal opportunity | Provider receipt/campaign/client | IMPROVE: preserve manual reports with provenance; never substitute invented metrics for disconnected integrations |
| Attention | Inbox, My Work, saved role views, search/commands | References entities owned elsewhere | MERGE: no new duplicated task or approval tables for dashboards |
| People & finance | Employee/private HR, requests, availability, payroll, invoices/payments | Identity, staffing, commercial | IMPROVE: preserve restricted domains and reconcile live deployment before promising availability |
| Platform operations | Audit, outbox, jobs, integration health, reconciliation, backup/recovery, settings | All domains | KEEP core outbox; IMPROVE adapters and release evidence. DEPRECATE browser success-only webhook orchestration after replacement verification |
| Personal utilities | Radio, theme/language | User preference only | KEEP optional Radio with opt-in lifecycle; DEPRECATE gamification as an operational priority, not delete historical data |

## Role homes are views, not new sources of truth

- My Work: Today, overdue, upcoming, blocked, waiting review, mentions. Preserve filter across return navigation; open the original task with brief/files available.
- Founder/management: exception queue with accountable owner and next action: overdue work, client risk, follow-ups, pending proposals/reviews, publication failures, capacity, campaign variance and renewals. Each number links to the records and states its freshness.
- Account manager: assigned clients, today's work, client approvals/revisions, upcoming content, meetings, requests and reports due.
- Creative: assigned/due/revision/review/approved filters plus inline brief, references and exact asset revision. CRM navigation is secondary.
- Sales: new leads, due/overdue follow-ups, meetings, proposals, negotiation and won/lost. Every open opportunity needs an owner and next action or an explicit reason why none is required.

## Navigation and command rules

Primary: My Work, Inbox, Clients, Sales, Delivery, Content, Reports. People/Finance/Settings appear by capability; secondary views live inside their domain. Preserve old route aliases and entity deep links during cutover. Do not hide access problems by silently redirecting.

Cmd/Ctrl+K supports search and permitted create/jump commands first. Add assignment/upload/scheduling only when their canonical authorized command exists. Keyboard selection, focus return, labelled dialog, truthful loading/error state and mobile touch entry are required. Frontend command visibility never grants permission.

An Inbox event has an immutable source key, recipient, organization, entity reference, event type, created time, read time and optional resolved/snoozed state. Assignment/review events, follow-ups, publishing failures and system alerts enter through server commands/outbox. Read is not completion. Notification preferences cannot disable required business audit events.

## Entity boundaries

Auth user ≠ employee ≠ contact. Lead ≠ opportunity ≠ client. Task ≠ content item. Asset ≠ storage object ≠ asset version. Approval ≠ comment ≠ signature. Scheduled ≠ published. Report ≠ a mutable dashboard total. Workspace IDs and enforceable tenant foreign-key chains apply to every aggregate.
