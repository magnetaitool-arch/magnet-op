# Studio verification — 2026-09-27

Scope: existing embedded Studio. VERIFIED means the stated end-to-end behavior passed, not every browser, format or load condition. Writes and failure injection use independent Supabase staging `vsurqqbxjvqzvqbmetjw`; production customer records were not modified for QA. Earlier passing evidence is retained rather than rerunning unchanged migrations.

| Workflow / controls | Status | Verified behavior / remaining limit |
|---|---|---|
| Auth handoff, session restore, sync, logout | VERIFIED | Single shell session; real expired-token refresh and queued write/readback; logout unmounts editor; production Safari restores System Owner and opens Studio. |
| Direct Studio link | VERIFIED | Standalone URL restores the authenticated shell and opens Studio after identity hydration; fresh login follows the same link; unauthorized roles remain gated. |
| Assigned task / client / project / campaign | VERIFIED | Actual task-scoped list/create/save; unrelated/deleted campaigns and unassigned/cross-tenant writes rejected. |
| Brief template and seven sections | VERIFIED | All sections, title, text, links, project type, deadline; bilingual save/reopen and actual PDF output. Links are reference text, not a brand-kit manager. |
| Report template and six steps | VERIFIED | Platform toggles, metrics, content, insights switch, Back/Continue/step navigation, save/reopen; real 3/4-page ordinary exports. |
| Content/design/video notes and pinned brief | VERIFIED | UI create/save/reopen for all three; Content Creator now tested separately with an assigned task, brief and content document. Video means execution notes, not video editing. |
| Save, persistence, retry and iframe lifecycle | VERIFIED | Versions persist; transport retry and in-flight editing retain edits. Fixed duplicate READY/load initialization that reset visible edits. Delayed load now preserves typing; real iframe reload restores saved v2. |
| Versions/history and unsaved guards | VERIFIED | Historical payload/file selector read-only; immutable server history; dirty navigation/logout cancellation; concurrent save conflict and command replay. Restoring an old version is not supported. |
| Comments / files / notifications | VERIFIED | Canonical task comment persists, version links private files, actual recipient notification; ordinary task comments only. |
| PNG/PDF upload, preview and download | VERIFIED | PNG UI plus exact byte/hash storage readback; PDF now uploaded via actual task dialog, linked and opened in embedded preview. Missing-object finalize, anonymous access, oversized and unsupported MIME rejected. Archive/restore tested. |
| Revision → save → resubmit → approve → final | VERIFIED | Newly repeated actual UI revision/save v2/resubmit; distinct manager approves/finalizes at 390px. Locked final editor and self-review rejection. Revision must be saved to a new Draft before resubmission. |
| PDF exports | VERIFIED | Fixed fixed-height clipping. Actual long report = 6 pages; long brief = 9 pages; final sentinel text extracted from both PDF files. Rendered continuation page inspected. Normal pages keep existing layout. |
| Arabic/English, desktop/mobile, theme | PARTIAL | Tested EN/AR editor, RTL, desktop light/dark, 390px mobile review/final and no overflow. Export templates intentionally retain English headings; native Safari/iOS print-dialog matrix not exhaustive. |
| Roles, permissions and tenant isolation | VERIFIED | Designer/manager/Content Creator positive UI; finance/HR/sales/client/anon and cross-tenant negative RPC checks. Real other-user forged overwrite rejected 403/42501. No RLS changes. |
| Error states | VERIFIED | Missing assignment disables create; required brief enforced; failed save retains edits; version conflicts, dirty export, locked history, unauthorized writes and rejected uploads handled. Not a claim to every possible provider outage. |
| Performance | PARTIAL | Observed staging navigation 1,040 ms; 11 RPC samples, slowest 1,016 ms; tested mobile page had no overflow. No sustained multi-user load, large-library benchmark or throttled mobile-device certification. |
| Templates / editor blocks / brand kit | PARTIAL | Existing brief/report templates and fixed section fields work. No reusable template CRUD, draggable blocks, page reordering or editable brand-kit feature exists. |
| Advanced Studio functions | NOT SUPPORTED | Video upload/editing; PNG/PPTX export; share links; media annotation; threaded/resolved/mention comments; client Studio approval; publishing; version restoration; Studio search/filter/sort. No fake controls added. |

## Defects repaired in this pass

1. Long PDF content was silently clipped by fixed-height pages. Only overflowing pages now expand and flow across print pages; both saved long-document exports retain their final text.
2. The iframe READY and late load paths could initialize twice, resetting current input to an older/blank payload. Per-frame handshake deduplication prevents this, and confirmed save payloads are retained for actual iframe reload.

3. Standalone Studio redirected to the shell but ignored `open=studio`. The shell now consumes that link only after authenticated context and existing navigation permissions are confirmed.

## Release checks / remaining blockers

- Scoped lint/typecheck, full existing test command plus new behavioral control regressions, security checks and allowlisted build pass. Existing database schema/RLS unchanged; no migration required.
- No known broken supported critical workflow remains in the tested scope. Overall Studio remains PARTIAL because unsupported features and the explicit browser/performance limits above are not completed features.
- No owner credentials or business-ownership decision is required for these frontend fixes. No production data was fabricated, reassigned or deleted.
- Private evidence: `backups/foundation-cleanup-20260927/`, including `studio-long-fixed.pdf`, `studio-long-brief-fixed.pdf`, continuation-page rendering and mobile final-review screenshot. Original role/database/workflow proof remains in prior release artifacts.

Deployment: application `4f57e03`, `dpl_2k7rsWx19G8JZYZyTfMnM7KFyo4z`, primary https://magnet-op.vercel.app. All six changed/current app artifacts match release checksums. Actual production standalone Studio entry redirects anonymous users to login with no captured JavaScript runtime errors. Authenticated mutation/negative tests remain deliberately on independent staging.

## Additional control pass — same release foundation

- Actual seven-section navigation, Back/Continue and both endpoints passed without changing saved v2. Blocked-popup injection displayed the export recovery message and preserved the title/version.
- At 320px, EN/AR shell width was 320px and embedded editor width 284px; neither overflowed. Visual inspection found a punctuation mismatch in the Arabic brief helper dictionary; corrected and retested in both languages.
- Eight sequential, read-only staging library reloads completed in 232–335ms; RPC durations 185–282ms, all without application errors. This does not certify concurrent, large-library or throttled-device performance.
- Native Safari verification could not proceed because Safari had an unrelated password-update system prompt. It was left untouched. Native Safari/iOS print coverage remains PARTIAL; no successful print claim is made.
- Existing full tests, lint, typecheck, security and 44-file build passed again. Configuration: zero failures, two existing email warnings. No schema or authorization changes.
- Additional private evidence: `studio-additional-controls.json`, `studio-mobile-320-ar.png`, `studio-mobile-320-ar-editor.png` in the existing recovery evidence directory. Earlier workflow verification remains applicable; unsupported features remain unsupported.
