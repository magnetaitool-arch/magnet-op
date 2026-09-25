# Database architecture

PostgreSQL is the structured-data authority. This document describes existing
migration intent and proposed additions; it is not a live schema dump. Consult
`DATABASE.md`, timestamped migrations, and environment topology for prior context.

## Reuse existing identities

| Product concept   | Existing canonical storage                                           | Migration approach                                                 |
| ----------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Organizations     | organizations, organization_settings                                 | Extend settings with validated versioned commands                  |
| Users             | auth.users + profiles                                                | No second credentials/user table                                   |
| Memberships       | organization_members                                                 | Active organization chosen explicitly                              |
| Roles/permissions | organization_roles, capabilities, role_capabilities                  | Capability mapping; keep HR/Finance restrictions                   |
| Clients           | client_accounts + legacy_record_id                                   | UUID used by all new client-owned tables                           |
| Leads             | crm_leads, crm_lead_notes, crm_lead_stage_events                     | Existing stage command stays authoritative                         |
| Tasks             | work_tasks, task_comments_v2, task_events_v2, task_document_links_v2 | Extend rather than replace                                         |
| Files/assets      | document_files, document_events, private storage objects             | Add versions/folders to existing file identity                     |
| Notifications     | user_notifications_v2                                                | Reuse delivery/read semantics                                      |
| Audit/auth events | audit_events, auth_events                                            | Append-only sensitive history                                      |
| Async/idempotency | jobs, outbox_messages, outbox_delivery_attempts, idempotency_keys    | Extend leased server work; no browser worker dependency            |
| Approvals         | approval_events_v2 and employee-request v3 family                    | Add content-specific approval aggregate, reuse actor/tenant checks |
| Finance/contracts | finance_invoices, finance_payments, agency_contracts                 | Preserve existing relationships and history                        |

`records` remains a compatibility write model for several domains. The mapping
`legacy_record_tenant_map` and projection `legacy_record_id` link old IDs to UUIDs.
A migration must never create a second client for an already mapped legacy client.

## Proposed normalized domain extensions

All names below are design proposals until a CLI-created, staging-tested migration
exists. Existing names take precedence; aliases in the product are not new tables.

| Domain              | Additions / extensions and relationships                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Client access/brand | client_members → (org, client, member); client_brand_kits → client                                                          |
| Sales               | contacts → client/lead; opportunities → lead/contact; activities → actor + entity; followups → opportunity/contact + owner  |
| Proposals           | proposals → client/opportunity; proposal_items + proposal_versions → proposal; immutable sent snapshot                      |
| Briefs              | briefs → client/project; versioned structured sections, downstream source revision                                          |
| Audit               | audits → client/brief; audit_sections → audit; audit_findings → section, priority/evidence/action                           |
| Strategy            | competitors, buyer_personas, swot_items → client/strategy; strategies → client/audit; strategy_items → strategy/finding     |
| Work                | projects → client; task_assignees → work_task/member; task_dependencies → two work_tasks; reuse task comments               |
| Assets              | folders → client/parent; asset_versions → document_files + storage key; existing document_files is asset identity           |
| Content             | content_items → client/project/task; content_platform_variants → content_item; content_approvals → revision + reviewer      |
| Social              | social_connections → client/provider + encrypted secret reference; social_accounts → connection/provider account ID         |
| Publishing          | publishing_jobs → variant/account/approved revision; published_posts → job/provider post ID; publishing_logs → job          |
| Analytics           | analytics_snapshots → account/post, metric definition, period, source; unique provider sample                               |
| Studio              | studio_documents → client/source entity; studio_pages → document; studio_blocks → page; studio_versions → document snapshot |
| AI optional         | ai_settings → organization (server-managed endpoints/secret references); ai_usage_logs → actor/action/model/outcome         |
| Activities          | extend existing activity/audit boundary; one timeline query combines permitted events, not copied event stores              |

## Integrity contract for every addition

- UUID PK, `organization_id NOT NULL`, server timestamps, integer revision,
  lifecycle checks, and recoverable `deleted_at`/archive state where appropriate.
- Unique `(organization_id,id)` on parents, composite child foreign keys such as
  `(organization_id,client_id) REFERENCES client_accounts(organization_id,id)`.
  A tenant filter alone cannot prevent cross-tenant relationships.
- Parent/child delete is RESTRICT except true owned children; audit history remains.
- Money uses minor units + ISO currency in new tables. Existing numeric finance
  values require an explicit conversion/parity migration, never silent rounding.
- Provider identity unique by organization/provider/account. Publication dedupe by
  organization/account/content revision/schedule command. Webhook event ID unique.
- Approval binds a content revision; an edit invalidates scheduling eligibility.
- Transition + timeline + outbox + idempotency result commit in one transaction.
- Stale expected revision returns conflict; no silent last-write-wins mutation.
- Index org/state/due-date queues and org/client/updated-at lists; paginate server-side.

## Authorization and storage

All private reads/writes require active membership plus capability; assignment
and explicit sharing further restrict client/employee access. RLS validates USING
and WITH CHECK. Anon sees no private rows. Client access requires explicit sharing,
not merely client role or an inferred email match. Service role stays server-only.

Use private object storage for bytes, with metadata and checksum in PostgreSQL.
Authorize upload slot, validate MIME/size, finalize after object inspection, and
serve short-lived signed URLs after fresh access checks. Local development storage
must implement the same object contract without becoming a production fallback.
OAuth tokens are encrypted server-side with key rotation; never JSONB browser payloads.

## Validation requirement

Before deployment: inspect live policies/constraints/functions/storage, backup and
restore, compare counts/references/checksums, exercise anon/authenticated/service
contexts, cross-org parents, least-privilege roles, duplicates, stale versions,
soft deletion, rollback, and reload persistence against PostgreSQL.
No new SQL migration is applied or claimed tested by this documentation pass.
