# Production smoke verification — 2026-09-26

Live: https://magnet-op.vercel.app
Deployment: `dpl_BioCb7Jb1x3gLaAJuWbmhg6eW2Rc`; code `0c9d060`.

- Production runtime points to `xqqgbvigfojfydzfguan`, never staging. Served HTML, service worker and critical module/style SHA-256 checksums match the allowlisted build.
- Real production accounts login → Supabase JWT → exactly one isolated synthetic workspace. Other organizations' data remains inaccessible.
- Actual browser: dashboard, projects, tasks, CRM, approvals and employee requests open. A CRM lead created only in the isolated QA workspace persists after reload; session restoration succeeds.
- Browser smoke uncovered two release defects: account updates attempted legacy tenant reassignment; reports/briefs/contract print icon was missing. Both fixed, covered by regression tests and deployed. Reports, client briefs and document center were revisited successfully on the final deployment.
- Desktop 1440×1000 and Arabic RTL mobile 390×844 visually inspected. Mobile document width equals viewport width. English and Arabic critical navigation work; remaining mixed labels are documented as POST_DEPLOY.
- Final fresh browser session: no console entries or uncaught page errors. Logout and reload return to sign-in. Screenshots: `audit-assets/2026-09-26/production-*.png`.
- Temporary QA account and workspace are disabled/suspended, provider identity banned and password randomized. Old access token reveals no business rows; refresh and legacy login are denied. No actual employee password was changed; no real business data was deleted. Synthetic evidence is retained rather than mixed into Magnet's organization.
- Final read-only comparison of 2,683 original records/profiles/memberships/clients/invoices/payments/tasks matches the post-migration baseline exactly. Full pre/post-migration reconciliation is separate in RELEASE_RECOVERY_VERIFICATION.md.

No claim of verified external email/social delivery, standalone Studio completion or exhaustive real-employee E2E. See REMAINING_WORK.md. Previous immutable Vercel deployments and the tested private rollback remain available.
