# Magnet OS — Refactor Report (Phase 6)

## Decision: Option B (safe, incremental) — not a big-bang Vite conversion

The app is a **single 7,816-line `index.html`** with React/ReactDOM/htm inlined and
authored in `htm` tagged templates (no JSX, no build). Converting it to a Vite/JSX
project in one pass would touch every line, require re-testing every module, and
directly risk the two things the brief forbids: **breaking the UI** and **losing
behaviour**. So this pass took the safe path:

- **New logic was written as isolated, standalone modules** rather than injected into
  the monolith: `tools/*` (backup/restore/validate/checks), `supabase/migrations/*`,
  `api/intake.js`, `.env.example`.
- **In-`index.html` edits were surgical** — only the two security fixes (send
  `newPassword` instead of a client hash in `PwResetForm`). No structural changes.
- The app was **verified still running** after edits (boots, login works, dashboard +
  sidebar + all modules render, dark/lime identity intact, zero console errors).

## What was moved / added
| Concern | Location now | Note |
|---|---|---|
| Cloud backup/restore/validate | `tools/*.js` | standalone Node, no app coupling |
| Config/connectivity/RLS checks | `tools/check-config.js`, `tools/check-rls.sql` | one-command diagnostics |
| DB schema/security | `supabase/migrations/001–004` | idempotent, additive |
| Public intake (Vercel) | `api/intake.js` | new function |
| Env surface | `.env.example` | replaces secrets-in-comments |

## What stayed (intentionally)
- The entire UI, routing, role visibility, PWA, service worker, icons, seed data,
  auth crypto, and sync/merge logic remain in `index.html`, unchanged in behaviour.
- The file already contains **section markers** (`/* ===== crm-cloud.js ===== */`,
  `/* ===== crm-auth.js ===== */`, `/* ===== crm-seed.js ===== */`, …) showing it was
  assembled from separate sources — these are the natural seams for extraction.

## Risks
- The monolith remains hard to maintain (unchanged risk, not increased).
- Any future extraction must preserve global load order (React → htm → helpers →
  cloud → auth → seed → components) since everything shares one scope.

## How to continue the refactor later (recommended sequence)
1. **Extract pure, side-effect-free helpers first** (`uid`, `nowISO`, formatters,
   `mergeDB`, `collSame`) into `src/lib/util.js`, loaded as a plain `<script>` before
   the app. Zero behavioural risk.
2. Extract the **config + cloud layer** (`_rest`, `_headers`, `cloudLoadAll`,
   `cloudUpsert`, …) into `src/services/cloud.js`.
3. Extract the **auth layer** (`window.AUTH` block) into `src/services/auth.js` — it
   already exposes a clean `window.AUTH` surface.
4. Extract the **sync/queue** logic (add the durable queue from
   `SYNC_ENGINE_REPORT.md`) into `src/services/sync.js`.
5. Only then consider a Vite build with `htm`→JSX codemod, one view at a time, behind
   a preview deploy, keeping `index.html` as the fallback until parity is proven.

Each step is independently shippable and testable with `npm run smoke` +
the preview, so the app stays usable throughout.

## Acceptance criteria — status (verified in browser preview)
- [x] App opens. [x] Dashboard renders. [x] Sidebar/nav works. [x] Login works.
- [x] Main modules still open. [x] No major console errors.
