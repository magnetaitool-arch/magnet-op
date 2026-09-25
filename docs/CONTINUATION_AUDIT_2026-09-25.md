# Magnet OS continuation audit — 2026-09-25

## Source of truth and scope

Audited the tracked repository inventory, root configuration, production static
shell, public route dispatch, module/server boundaries, service worker, migration
inventory, test tooling, readiness/topology documents, and recent git history.
The latest commit was `e92af64` (monthly finance history and period-end balances),
following monthly cycles and employee request/approval work. The tracked tree
was clean before this pass. Pre-existing untracked proposals, apps, exports,
and other workspace files were left untouched.

This is the existing internal operating system, not a marketing landing page.
Its current React/HTM runtime and styles are embedded in `index.html`, with an
extracted employee request module. Vercel serves the static shell and six API
entrypoints backed by shared server code; Supabase supplies identity and business
storage. Fonts load from Google Fonts, and local images, icons, and the login
video supply the existing brand presentation. No package dependencies were added.

The root app uses internal view dispatch and public query links. No public
marketing route architecture or analytics implementation was introduced. Branding,
UI, responsive rules, animations, content, SEO metadata, integrations, forms,
production host configuration, and application business logic were preserved.

## Plan chosen after inspection

1. Keep the existing architecture and latest finance/request features intact.
2. Fix the observed service-worker lifecycle/offline fallback defects.
3. Add behavior tests to the existing suite and verify local entry/public routes.
4. Correct stale startup/release instructions and record remaining gates.

## Changes

- `serviceworker.js`: v34 caches the shell at a stable `/index.html` key so
  a root visit supports later offline query/deep links without retaining query
  tokens in cache keys. Other HTML documents retain separate cached responses.
- Responses are cloned before browser consumption. `waitUntil` keeps cache writes
  and background refreshes alive. Storage failure does not discard online responses.
- Cold offline navigation returns a bilingual retry page with HTTP 503 instead
  of an undefined response. Auth/runtime configuration remains mandatory; an
  available offline shell does not imply an authenticated offline workspace.
- Activation deletes only old Magnet OS caches. APIs, cross-origin traffic,
  authorization-bearing requests, range requests, video, and non-static fetches
  bypass interception. Failed/partial/redirected responses do not replace assets.
- Added ten executable behavior tests in `tools/service-worker-test.js`, wired
  into the root test script; adapted the older smoke assertion to the cache helper.
- Updated README with the current architecture, Node requirement, route map,
  validation commands, and authoritative environment/release references.

## Verification

Node v24.19.0 and the bundled pnpm runner were used because npm is not on PATH.
`pnpm` ran the same package scripts normally invoked by npm.

| Check | Result |
| --- | --- |
| Existing root test suite | 825 assertions passed, zero failures |
| New service-worker behavior suite | 10 tests passed, zero failures |
| Static security verification | 25 passed, zero failures, existing inline-script CSP warning |
| Final targeted smoke and service-worker recheck | 144 smoke assertions + 10 behavior tests passed |
| `git diff --check` | Passed |
| Lint, typecheck, production build | Attempted; no scripts defined in this static application |
| Configuration validation | Blocked: explicit local Supabase URL/anon key absent |
| SaaS exposure audit | Blocked: explicit local Supabase URL/publishable key absent |

Local browser checks used the in-app browser on an isolated localhost origin:

- Root setup renders; switching to existing-account sign-in works.
- Empty sign-in submission displays validation without a server mutation.
- Sign-in inspected at 390×844 and 1440×900; the mobile document width was
  exactly 390px with no horizontal overflow.
- Arabic switching sets `lang=ar` and `dir=rtl`.
- Missing-config public form and brief links display connection error states.
- The training document loads and its Next action advances to slide 2.
- No errors/warnings appeared in the captured sign-in console log. The preview
  was a static server without `/api/runtime-config` or backend endpoints, so
  it cannot establish that production APIs or authenticated flows are healthy.

The service-worker fault scenarios were exercised in a Node VM with real
Response/Headers primitives (request objects model fetch events), not by toggling
real-browser networking. Real-device offline/update behavior remains a staging
release check.

## Remaining work and release gates

- The latest topology document says staging shares production and email delivery
  is not configured. These are historical documented blockers, not newly verified
  live findings; validate current environment separation and provider delivery.
- Auth lifecycle, role matrix, cross-tenant access, authenticated finance/request
  interactions, real public submissions, and browser/platform coverage still
  require separate staging and test accounts.
- The monolithic UI and historical UX backlog remain; broad extraction must be
  incremental. Older backlog checkboxes cannot be treated as current feature status.
- Existing local UX issues observed: validation text retains its original language
  if language is switched after an error; missing runtime configuration can lead
  to the setup presentation. These warrant a separate auth-entry UX change with
  failure-state coverage. This pass does not claim they are resolved.

No database, schema, production data, auth policy, or deployment was changed.
No migration/backfill is required. Rollback is the prior static application
release; if issuing a new rollback artifact, bump its service-worker version to
invalidate v34 shell assets, and retain the previous deployment per the runbook.
