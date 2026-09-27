# Studio V2 release verification — 2026-09-27

The existing embedded Studio, task ownership, Supabase session and immutable version commands remain canonical. This release adds structured document/page/block payloads, not a second application or parallel document database. Historical brief/report/creative-note workflows remain available.

## Executed staging evidence

- All ten templates created through UI and saved as canonical versions. All 21 block types added/edited in a 24-page document. Real pointer page/block drag, keyboard reorder controls, duplicate/delete, logout/login and reopen preserved the saved order.
- Canonical client kit saved; finance/HR/sales/client writes denied with actual JWTs. Changing the kit did not mutate existing document snapshots. Authorized same-client logo inheritance and narrowly scoped public image delivery passed. A reusable client template produced a separate persisted draft.
- Actual proposal source populated service/price/currency. Actual report source populated summary/metrics/recommendations. An independently approved Studio content version populated the content-plan draft and exported. Draft content is excluded; legacy calendar permissions were not broadened.
- Historical final version restored as a separate draft; original v4 remained FINAL. Offline save failure retained input; manual retry persisted it. Earlier revision-conflict/idempotency/unauthorized-write coverage remains applicable.
- Page/block comments saved. External COMMENT/APPROVE/CHANGES persisted separately from internal approval. Same-document reopening now refreshes external responses; regression retested. Public links work without OS login, expose one immutable snapshot, and revoke/regenerate correctly. Old links and unauthorized images fail. Expiry, issuer suspension, opt-in review and tenant denial passed isolated PostgreSQL tests.
- Chromium PDF downloads: proposal, strategy, monthly report, Arabic audit, approved-content plan and 24-page all-block document. Native Safari downloaded proposal, strategy, monthly report and Arabic audit PDFs; parsed page counts and visually inspected Arabic layout. PNG 2560×1440 opened and inspected. PPTX has three valid raster slides; ZIP CRC and all XML parsed. Native editable PowerPoint text/objects and native PowerPoint application verification are not claimed.
- Arabic RTL cover/logo overlap repaired; native Safari Arabic PDF retested. At 390px, internal and public review have no horizontal page overflow, readable text below scaled canvases, and reachable review controls. Independent manager approved/finalized on mobile. Desktop remains the authoring interface.
- Private MP4 upload/task link/hash readback and anonymous denial passed. Actual preview played at 1280×720 after a CSP fix allowing only the two approved Supabase project media origins.
- 24-page PDF: 9.257 seconds, 1,003,347 bytes. Compression reduced the ordinary three-page PDF from ~32MB to ~165KB. Rendering/export processes one page at a time. This is not sustained-load or low-end-device certification.

Private evidence is retained in `backups/studio-builder-v3/`, the two subsequent staging migration directories, and `backups/studio-builder-release-20260927/`. These are deliberately excluded from Git. Export/screenshot artifacts also remain in `/tmp` and native Safari Downloads; no capability tokens or credentials are published.

## Database and rollback

Three additive migrations: `20260927125403`, `20260927131600`, `20260927134252`. All 60 canonical migrations passed the isolated PostgreSQL behavioral suite. Each live staging migration was backed up and reconciled. The first coincided with exactly one identified QA save (four inserted document/version/event/audit rows); all pre-existing rows remained unchanged. Subsequent staging comparisons were exact.

Production preflight: native custom-format archive includes public/auth/storage/migration schemas; archive index validated. Full row snapshot, function rollback definitions, ledger, constraints and policies captured. All 15 storage objects copied with exact size/SHA-256 verification. Recovery package encrypted with AES-256-GCM; authenticated decryption and checksum verified. The earlier independent restore remains applicable; a new full restore of this archive is not claimed.

Production rollout: all three migrations committed atomically; counts/full-row fingerprints of all 106 existing public tables unchanged. Ledger now 70; canonical migration files 60. Private storage retained. No data backfill or ownership repair.

Application rollback: retain the previous production deployment (`dpl_DM5Kh1rkhDq2ujqrJfv5CNnh4uSU`). Restore that deployment if auth, membership or tenant gates regress. Retain all additive tables and version data. No destructive down migration, identity reassignment or speculative legacy repair.

## Configuration and limits

Shared-image endpoint uses existing server-only `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Browser receives only the existing public configuration and its own user session. Public token validation resolves exactly one referenced file before signing a URL lasting at most 60 seconds. The service key never enters the browser bundle. Client-side export vendors are pinned and bundled with their licenses.

PPTX remains PARTIAL (raster slides). Sustained concurrency/large-library/throttled-device performance remains PARTIAL. Video editing, threaded/mention/media-annotation comments and social publishing are NOT SUPPORTED. Existing email/social credentials and scheduled backup authorization remain independent external blockers, not false successes.

## Live deployment verification

Application `2f6203c` pushed and deployed to `dpl_AqCNChFxzckQXFxfx6noBMBTXejT`; primary alias https://magnet-op.vercel.app. Thirteen shell/editor/vendor/shared-presentation artifacts match local build SHA-256. Invalid shared-asset token returns 403; production CSP matches the intended policy. Anonymous deep link reaches login with no captured JavaScript errors; Arabic login at 390px has no horizontal overflow.

Native Safari restored the existing System Owner session, opened Studio, exposed all ten builder template choices, switched AR/EN and refreshed without losing authentication. This account currently has no eligible canonical tasks in its Studio list, so no production authoring mutation was invented. Complete builder mutation/review/export/negative tests ran on independent staging. Previous deployment remains available.
