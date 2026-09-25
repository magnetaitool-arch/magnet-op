# Current system audit

Date: 2026-09-25. Baseline commit: `e92af64`. Evidence is repository code and
local tests, not an assertion about deployed database state.

## Inventory and boundaries

| Area              | Existing implementation                                                                    | Decision                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Frontend          | `index.html`, embedded React/HTM, inline styles, internal route switch, no bundler         | Incremental extraction; preserve working routes                            |
| Components        | DataTable, Panel, Head, KPI, Modal, drawers, command/search palette, requests module       | Reuse; introduce typed modules alongside the shell                         |
| Design            | Dark/lime tokens, light theme overrides, Arabic/English, responsive rules, cinematic login | Preserve; normalize tokens as components move out                          |
| Auth              | `accounts` legacy token service plus Supabase Auth bridge; `identity` context              | One target identity: Supabase Auth. Retire compatibility only after parity |
| Tenant/RBAC       | organizations, profiles, members, roles, capabilities; tenant mapping/RLS migrations       | Extend these, never create a parallel agency/user model                    |
| Clients           | `client_accounts` projection of legacy client records, canonical workspace RPCs            | Existing canonical UUID is the downstream client key                       |
| Sales             | CRM stages/notes, legacy contacts/proposals/activities, conversion                         | Preserve; normalized follow-ups/proposal versions are pending              |
| Execution         | projects/deliverables in compatibility store; work_tasks, comments/events; approvals       | Preserve existing server commands and version checks                       |
| Finance/HR        | canonical invoice/payment projections; monthly cycles; private employee requests           | Preserve all functionality beyond master directive scope                   |
| Storage           | `document_files`, private bucket, upload/finalize commands and visibility policies         | Extend versions/folders through this ownership chain                       |
| Integrations      | Vercel API + server intake/outbox/health; Netlify adapters                                 | Keep transports thin; auth/domain logic server-owned                       |
| Data              | PostgreSQL plus legacy JSONB records; projections and mapping tables                       | No second canonical DB or duplicate client entity                          |
| Local storage     | caches, pending writes, preferences, sessions, brief drafts; local demo branches           | Inventory and retire business authority per domain, not a blanket wipe     |
| Studio            | `magnet-studio` untracked standalone browser-draft/print prototype                         | Reference only; not production-integrated persistence                      |
| Audit/strategy    | report/brief generators and miscellaneous standalone artifacts                             | No verified normalized audit/strategy workflow found                       |
| Social/publishing | content-calendar helpers, no verified durable Meta/TikTok pipeline                         | Must not label any existing scheduling UI as real publishing               |
| Deployment        | Vercel root static app + six APIs, CSP/PWA, prior Netlify config                           | Preserve production config; package explicit files only                    |
| Dependencies      | embedded frontend libraries; root originally tooling-only                                  | New dev tools only; no paid runtime service                                |

Routes include sign-in/setup, internal views, public `?form`, `?brief`, `?verify`,
`?contractReview`, entity `?open=…&id=…`, and training/manual/game HTML pages.
No unrelated proposal, iOS, course, or private-life project is part of this release.

## Concrete defects selected for the current foundation increment

1. `api/runtime-config.js` accepts any `eyJ` prefix: a service-role key accidentally
   placed in the anon setting can be emitted to the browser. Validate public-key
   shape/role/project claims and fail closed, without printing the input.
2. Account discovery treats a failed health call plus an empty local roster as a
   new installation. Only an explicit successful server result may select setup.
3. Pending auth renders a blank surface; failure needs accessible bilingual loading,
   unavailable, and retry states before cached private content can render.
4. The package has no formatter/linter/type checker/artifact build. Add honest,
   scoped checks for extracted code and syntax coverage for the legacy shell.
5. A general filesystem server can expose unrelated files. Add an allowlisted
   local preview and a checksummed static deployment package.

## Data and security gaps requiring staged work

A browser-local role is not authorization. Existing RLS/RPC tests in the repository
are evidence of intended enforcement, not proof that all deployed policies match.
Some business domains still depend on compatibility writes and browser cache;
full-dataset sync paths remain. Projections must be cut over with reconciliation.
The last topology document reports staging sharing production and missing email
provider configuration. Fresh local checks lack explicit DB configuration.
No live schema/advisor/row-count/storage inspection was possible in this pass.

Backend role mapping must retain existing Owner/Admin/HR/Finance roles while
adding Founder display naming and missing Video Editor/Media Buyer/Viewer grants
through reviewed additive capability changes. Never change privileges by relabeling UI.

The legacy shell embeds libraries; retain their notices. Existing logo/video and
font provenance requires an asset-rights ledger before redistributing a SaaS bundle.
There is no verified license provenance for every existing local visual asset.

## Validation baseline

The prior increment passed 825 existing assertions, 10 service-worker cases, and
25 static security checks. Many older tests assert source patterns, so they are
not substitutes for restored-database integration and authenticated E2E tests.
The new build plan tracks those separately and never marks a phase complete merely
because a screen or local test exists.

## Read-only live verification and implemented repairs

The authenticated Supabase CLI was available even though application environment
variables were absent. A read-only snapshot of the protected live project completed
on 2026-09-25: 73 public tables (all RLS-enabled), 2,360 records across 45
collections, 20 server-only account records, 17 Auth identities, one Storage object,
and 38 applied migrations. The schema inventory contains 43 policies, 364
constraints and 191 indexes. Backup hashes and every public-table count validated.
No live mutations were made. Auth inventory omits password/session secrets and
Storage inventory omits file bytes; these exports do not replace a managed backup.

The live provisioning function still derives username from the email local part
without collision handling or display-name length bounds. Both upload completion
and cancellation retain an original-uploader authorization bypass. New append-only
repair migrations have been exercised locally but are not applied remotely.
The independent hosted staging/Auth/Storage release gate remains open.

## Legacy correction audit

The current architecture is not accepted solely because it runs. See
`LEGACY_COMPATIBILITY_MATRIX.md` for all 29 requested areas and
`MIGRATION_RECONCILIATION_REPORT_2026-09-25.md` for executable reconciliation
and staged workflow evidence. Preserve valid data while replacing unsafe behavior.
Browser-triggered history pruning was removed; email/phone-based client merging
was replaced with an explicit-link review guard; a suspended-assignee task mutation
was reproduced and repaired in a new local migration. No production row was changed.
