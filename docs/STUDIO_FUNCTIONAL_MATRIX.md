# Studio functional verification — 2026-09-27

Scope: existing embedded Studio only. Hosted tests use independent Supabase staging; synthetic documents never replace customer work. VERIFIED below describes the listed test, not untested formats or workflows.

| Feature / control | Before | Fix | Actual test | After |
|---|---|---|---|---|
| Global sync chip shown in Studio | BROKEN: legacy game ownership denied | Confirmed same-tenant identity mapping only | Safari retried `arc-usr-owner`; queue chip disappeared after success; server score 52 persisted on subsequent reads. Other active production member write FALSE; actual staging forged upsert denied | VERIFIED exact retry; owner Safari logout/login acceptance pending |
| Assigned client/project/task selector | WORKING | None | Designer sees assigned task; manager sees two; unassigned staff denied; client/project scope enforced | VERIFIED |
| Campaign selector/save | BROKEN for assigned designer without `clients.read` | Task-scoped campaign reference; no general CRM grant | Actual HTTP failure reproduced, then linked campaign save succeeds; unrelated/deleted campaigns and unassigned users denied | VERIFIED |
| Brief seven sections, title, client text, project type, references, deadline | WORKING | Unsaved-work protection | Real UI inputs in every section saved and reopened with Arabic text; six-page PDF contains answers | VERIFIED tested fields |
| Report six steps, metrics, content, insights toggle | PARTIAL | Platform-only edits now mark dirty | UI values saved/reopened; 100 reach etc. persisted; platforms save independently; insights changes 3/4-page PDF | VERIFIED |
| Content/design/video document notes | WORKING | Save acknowledgement protection | Each created through UI, saved, reopened; brief revision pinned | VERIFIED document notes; not a video editor |
| Manual save, versions, retry | PARTIAL | Acknowledgement cannot clear newer edits | Real delayed RPC response followed by more typing; new edits remain dirty. Injected transport failure retains edits; retry saves real server version. Replay/conflict and immutable history DB tests | VERIFIED |
| Navigation, history switching, logout | PARTIAL | Cancelable navigation/logout; disable history/file switching when unsafe | Cancelled actual navigation retains editor; historical buttons disabled while dirty; frame beforeunload retained | VERIFIED navigation and cancelled logout; fresh designer login retains saved documents |
| Export safety | PARTIAL | Require confirmed saved version | Dirty export produces actionable message, no export; confirmed brief/report opens real print window and generates PDF files | VERIFIED |
| Review/revision/resubmit/approve/final | WORKING | None | Hosted HTTP full cycle with distinct author/reviewer; self-review denied. Designer UI submits brief, separate manager UI approves/finalizes at 390px; final fields read-only | VERIFIED |
| Linked files/comments/notifications | PARTIAL: task files could not be opened/uploaded from assigned workflow | Reuse existing secure upload/profile dialogs in task; retain server authorization | Designer UI uploads PNG, task link confirmed, signed preview/download load, archive/restore succeeds; UI comment persists. Existing HTTP Studio version file and notification checks pass | VERIFIED listed UI and HTTP workflow |
| Image/PDF upload and download | WORKING | None | Real PNG/PDF bytes stored and read back exactly; missing-object finalize rejected; anon download denied; >25MB rejected | VERIFIED PNG upload/preview/download/archive/restore UI and PNG/PDF API/storage; PDF upload UI/progress timing not exhaustively tested |
| Video file upload | NOT IMPLEMENTED | None; no fake upload option added | `video/mp4` rejected; upload UI advertises supported documents/images only | NOT SUPPORTED |
| Historical versions | WORKING | Disable file change on historical editor | DB immutable versions/author/time; V1–V5 persisted; UI history controls inspected and dirty protection tested | VERIFIED V1 read-only selection; historical file selector disabled |
| Arabic / English / mobile | PARTIAL | Missing editor helper translations | Real 1440px EN and 390px AR screenshots reviewed, RTL frame and no page overflow; mobile approval/final actions succeeded | VERIFIED tested screens; PDF template headings remain English |
| Light theme review panel | BROKEN: dark background with dark text | Use existing shell surface/ink tokens | Actual before/after screenshot; white background and rgb(27,36,48) foreground | VERIFIED |
| Role / tenant isolation | WORKING | Narrow campaign correction only | Manager/designer positive; finance/HR/sales/client/anon and cross-tenant negative; inactive/conflicting identity mapping denied | VERIFIED tested roles; separate Content Creator role UI pending |
| Session restoration | PARTIAL acceptance | No credential changes | Staging fresh login reopens all saved documents and versions; production saved game row remains unchanged | Owner Safari refresh/logout-login pending; do not claim complete |

## Unsupported controls (no fake working buttons)

Studio has two document templates: brief and monthly report, plus content/design/video execution-note documents. It does not implement page/block reordering, PNG/PPTX export, share links, editable brand kits, media annotations, threaded/resolved/mention comments, Studio client approval, publishing, or prior-version restoration. Files and ordinary comments belong to the canonical task/document modules; task upload/open now reuses those existing dialogs. Decorative Preview/Activity buttons were replaced with a static heading because both sections are already displayed. Client-intake brief RPCs are only mounted for their existing client-read permission; assigned Studio briefs keep their separate task-scoped access. There is no Studio-specific search/filter/sort UI. These are not claimed as verified and were not added during this recovery.

## Release evidence and limits

- Local PostgreSQL: 57 ordered migrations; authorization, game identity, campaign scope, immutable revisions and workflow regressions PASS.
- Independent hosted staging: real accounts/RPC/storage/browser checks described above PASS. Automated browser sessions occasionally restarted to `about:blank`; this is not counted as application persistence verification.
- Migration `20260926232823_studio_assigned_campaign_scope.sql` rehearsed with rollback, then applied to production: ledger 67, all 106 existing public table counts/full fingerprints unchanged atomically. Previous function definitions retained privately for rollback; no business rows, RLS policies or ownership edited.
- Private artifacts: `backups/foundation-cleanup-20260927/` includes exact retry evidence, campaign rehearsal/production proof, exported PDFs and desktop/mobile screenshots. No tokens or private backups committed.
- Overall remains PARTIAL until the explicit pending browser acceptance checks above pass. Lint, typecheck, full existing npm test command and 44-file production build PASS; live config check has zero failures (email configuration warnings only). Build success alone is not full Studio certification.
