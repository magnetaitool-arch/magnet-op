# Studio functional matrix — 2026-09-27

VERIFIED means the stated real workflow passed; it does not certify every browser/load condition. Mutating and adversarial tests use independent staging. Previous foundation evidence is retained in Git history and private recovery artifacts; no customer data was created or repaired for QA.

| Workflow | Status | Executed behavior / exact limitation |
|---|---|---|
| Shared auth, session restore, sync, logout, direct Studio entry | VERIFIED | Existing shell session and previous expired-token/queued-write, logout, Safari owner and deep-link tests retained. No alternate Studio login. |
| Canonical tasks, pinned briefs, content/design/video notes | VERIFIED | Existing create/save/reopen/review paths retained; task/client/project/campaign scope and immutable brief version enforced. Video is execution notes plus private attached media, not editing. |
| Structured builder and 10 templates | VERIFIED | UI-created/saved proposal, audit, strategy, content plan, monthly/media/campaign reports, persona, competitor analysis and quarterly review. |
| Pages and 21 block types | VERIFIED | Actual UI edit, page/block duplicate/delete and real pointer drag; 24-page document reopened after fresh login with persisted order. Overflow blocks export instead of silently clipping. |
| Client brand kit and reusable template | VERIFIED | Canonical kit save, immutable historical snapshots, authorized inherited logo; saved client template creates a separate draft. |
| Real data sources | VERIFIED | Actual proposal pricing, client report metrics/recommendations and approved Studio content applied/saved/exported. Unreadable or absent metrics are not fabricated. Legacy Calendar authorization unchanged. |
| Save, retry and persistence | VERIFIED | Autosave/version persistence, refresh/relogin, offline failure retains edits and retry saves. Existing optimistic conflict/idempotency tests retained. |
| Versions and restoration | VERIFIED | History read-only; restore creates new draft while original FINAL v4 remains unchanged. |
| Page/block/internal and external comments | VERIFIED | Persisted targeted comments; external responses refresh when reopening the same document. Threading, resolution and mentions are not implemented. |
| Review → revision → resubmit → approval → final | VERIFIED | Existing distinct-role revision workflow plus manager mobile approval/finalization; self-review and locked-history writes denied. External review never replaces internal approval. |
| Scoped public presentation links | VERIFIED | Anonymous fixed snapshot, private referenced logo, opt-in responses, revoke/regenerate and old-link denial. Expiry/issuer suspension/invalid targets/tenant isolation tested in database suite. Signed image URLs can remain valid for up to 60 seconds after revocation. |
| Builder PDF and PNG | VERIFIED | Actual Chromium and native Safari proposal/strategy/report/Arabic audit downloads; parsed and visually inspected. PNG opened at 2560×1440. 24-page PDF passed. |
| PPTX | PARTIAL | Valid ZIP/XML with rasterized page slides. Text/blocks are not native editable PowerPoint objects; no native PowerPoint application available for acceptance. |
| Existing legacy print templates | PARTIAL | Chromium exports and native Safari 160-phrase long brief verified previously. Legacy report/iOS print dialogs and full translation of old export headings remain outside the new builder export coverage. |
| Arabic/English and mobile review | VERIFIED | Builder RTL/mixed content and Arabic Safari PDF verified; 390px internal/public review readable without horizontal overflow. Desktop-only page/block authoring is explicit. |
| Permissions / tenant and storage isolation | VERIFIED | Isolated 60-migration suite; actual role-denied brand writes; user-JWT storage readback and anonymous denial; task/client-scoped shares/images. No RLS disabling or browser service key. |
| Performance | PARTIAL | 24-page PDF ~9.3s/~1MB; bounded concurrent reads previously passed. Sustained multi-user load, very large libraries and throttled physical devices remain unverified. |
| Private MP4/WebM storage | VERIFIED | MP4 upload, task link, exact hash readback and anonymous denial. Actual 1280×720 playback passed after limiting CSP media sources to the two approved Supabase projects. |
| Video editing, publishing, media annotation, Studio library search/filter | NOT SUPPORTED | No successful integration or editing claim. |

Detailed builder execution, fixes, backup and rollback: [STUDIO_V2_RELEASE_VERIFICATION.md](STUDIO_V2_RELEASE_VERIFICATION.md). Current deployment and migration status: [SHIP_STATUS.md](SHIP_STATUS.md).
