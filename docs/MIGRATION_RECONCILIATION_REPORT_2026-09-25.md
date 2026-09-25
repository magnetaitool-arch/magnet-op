# Migration/reconciliation report — 2026-09-25

## Scope and status

**No production migration was performed. No production migration success is claimed.**
This report analyzes the existing private logical snapshot and rehearses repair
migrations on isolated PostgreSQL with synthetic representative schema/data.
Production post-migration reconciliation is therefore **not yet applicable**.
The snapshot is not transaction-consistent across tables; review findings against
an independently restored staging copy before drawing business conclusions.

Snapshot: `backups/phase1-readonly-20260925/logical-backup.json`.
Validated snapshot manifest SHA-256:
`084e2e9a2c703ce980881fe5ddafacd8281a900e32b9bf10ba90967c967cd5bb`.
Private actionable report: `backups/reconciliation-20260925-reviewed/reconciliation.json`.
Reports contain record identifiers, remain gitignored with directory mode 0700 and
file mode 0600, and are never bundled into the application. No credentials or
personal field values are printed by the reconciliation command.

## Executable checks

`tools/reconcile-data.js` checks exported required columns, primary/unique keys,
foreign keys including composite tenant keys, explicit legacy relationships,
soft-deletion parity, canonical projections, tenant maps, profile/Auth links,
legacy login mappings, employee/user ambiguity, assignment membership, and document
object references. It also inventories unresolved projection issue ledgers.
Shared normalized contact emails are review candidates, never automatic merges.

The snapshot check evaluated **115 foreign keys, 109 primary/unique constraints,
and 436 required columns**. No missing exported FK parents, database-key duplicates,
required-column violations, or tenant-mapping mismatches were found in that scope.
This does not validate CHECK expressions, partial/expression unique indexes,
provider state, file bytes, browser authorization or every unconstrained JSONB field.
Those exclusions are explicit in the machine report.

## Reconciled projection counts

“Active” here means **not soft-deleted**, not a commercial/employment status label.

| Domain     | Legacy total | Legacy active | Canonical total | Canonical active |
| ---------- | -----------: | ------------: | --------------: | ---------------: |
| Clients    |           20 |            17 |              17 |               17 |
| Leads      |          104 |            83 |              85 |               83 |
| Tasks      |          242 |            68 |             242 |               68 |
| Invoices   |           20 |            14 |              14 |               14 |
| Payments   |           14 |            11 |              10 |               10 |
| Contracts  |            1 |             0 |               0 |                0 |
| Applicants |          657 |           652 |             652 |              652 |

Raw count differences must not trigger deletion, recreation or guessed merging.
The payment discrepancy needs review; the contract discrepancy is explained by
soft deletion in this snapshot.

## Review queue

| Finding                                            |      Count | Disposition                                                                                                |
| -------------------------------------------------- | ---------: | ---------------------------------------------------------------------------------------------------------- |
| Active children with soft-deleted parents          |         16 | Retain. Determine whether historical linkage, parent restoration, or explicit reassignment is intended.    |
| Leads sharing normalized contact email             | 32 records | Potential repeated inquiries/shared inboxes; not proven duplicate identities. Preserve each source record. |
| Active payment without canonical projection        |          1 | Preserve amount/currency/invoice evidence; review alongside finance issue ledger.                          |
| Legacy account without a single valid Auth mapping |          1 | Review identity evidence; do not grant membership or link by guessed email/name.                           |
| Storage object outside document catalog            |          1 | Identify owner in other legacy domains; do not delete or move it.                                          |

The 16 parent-link findings comprise seven task→employee links, three
deliverable→client links, three deliverable→project links, and one each for
meeting→client, payment→invoice and report→client.

Separately, existing issue ledgers contain **304 unresolved task issue entries**
(117 missing project, 184 missing assignee, three assignees without login mapping),
with **12 entries attached to non-deleted source tasks**, and one finance issue
(`MISSING_OR_INVALID_INVOICE`). These are issue entries, not distinct record counts;
they may overlap the review queue and must not be added as independent affected users.

## Safe repairs implemented locally

1. Removed browser-triggered hard pruning of business activity/notifications.
   Existing server retention RPC remains for a separately reviewed policy migration.
2. Lead conversion now requires explicit links. Contact matches, conflicting links,
   missing linked clients and deleted/archived linked clients stop that conversion
   with a review message; unrelated work remains available.
3. Added a task-status authorization migration requiring fresh active membership
   and work-read permission, while retaining manager/assignee and revision checks.
   A database test reproduced the suspended-assignee bypass before the fix.
4. Retained earlier unapplied signup and upload-authorization repairs.
5. CRM loading failures no longer display fabricated zero counts or a false empty
   result, and creation is disabled while the read state is unavailable.

These changes do not automatically repair any ambiguous production row.

## Before/after staging rehearsal

The native PostgreSQL suite now runs **32 ordered migration files** against a
schema fixture and synthetic Auth/Storage metadata. The fixture includes the live
legacy metadata trigger required for correct task timestamps. Repair replay checks
compare **all representative public row values**, not only counts, before and after
function replacement. Existing identity/client rows, relationships and state remain
unchanged. Database restart persistence also passes.

This is local representative-schema rehearsal, not a restored hosted Supabase
acceptance test. Production rows have not been copied into a test service.

## Critical workflow coverage and gaps

Executable SQL workflow segments cover:

- employee profile → resolved role/workspace → assigned task → recipient notification
  → read notification → execution → internal review;
- claims removed → private work inaccessible → claims restored → permitted work visible;
- suspended/revoked assignee → denied status mutation;
- wrong tenant → denied task creation;
- lead → contacted → proposal-sent stage → won, with stage notes/history.

These checks execute real database commands in `tools/workflow-database-test.mjs`.
They do **not** claim to send a proposal, create a follow-up, authenticate a browser,
restore a real session, approve a content revision, publish a provider post or
produce a verified report. Full requested end-to-end trajectories remain open
until those implementations and independent hosted staging are available.

## Production acceptance rule

After an approved future rollout, capture a fresh snapshot and run:

```sh
pnpm run reconcile:data -- before/logical-backup.json backups/unique-review-directory after/logical-backup.json
```

The two snapshots must share the same project provenance. Cross-project restored
staging requires a separately verified mapping manifest; the tool refuses to assume
provenance. Comparison uses sorted full-row hashes so unchanged counts cannot hide
changed values. An approved migration mapping must explain every expected change;
all unexpected loss, orphan growth, ownership shift or financial difference blocks
acceptance. Then verify application workflows, object bytes/access, sessions,
provider outcomes and rollback. A clean comparison alone never sets release-ready.

## Final local verification

- Full regression suite: 825 existing assertions plus 27 new tests passed (852 total).
- 32 migration files and the database workflow/reconciliation checks passed.
- Lint, scoped strict typecheck, formatter and 29-file release build passed.
- Security scan: 25 passes, existing inline-CSP warning remains.
- Browser: inspected actual CRM unavailable state at desktop/mobile, no horizontal
  overflow in the mobile check, no false empty result and creation disabled.
  No unexpected JavaScript page errors observed. This disconnected QA view is not
  a hosted authenticated acceptance pass.
- Config/SaaS checks remain blocked by absent explicit application Supabase config.
- No production mutation, deletion, migration application or deployment occurred.

## Subsequent product-review repairs

The later review adds two unapplied migrations: unambiguous task identity and atomic lead conversion. The isolated harness now applies 34 migrations, proves two simultaneous conversion sessions commit one client/workflow, survives restart, and preserves every representative public row value/relationship across function removal/rollback/reapply. This is local synthetic evidence, not a production migration. The production snapshot findings above remain unresolved unless explicitly reviewed; no source record was automatically repaired. See [verification](PRODUCT_REVIEW_VERIFICATION.md) and [conversion boundaries](ATOMIC_LEAD_CONVERSION.md).
