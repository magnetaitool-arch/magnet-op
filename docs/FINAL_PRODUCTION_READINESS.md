# Core release gate — 2026-09-26

Ready for controlled rollout of the existing main Magnet OS application after the 20 rehearsed pending migrations. No destructive migration or data cleanup is authorized or included.

Evidence: [recovery and reconciliation](RELEASE_RECOVERY_VERIFICATION.md), [hosted staging](RELEASE_STAGING_VERIFICATION.md). Independent free staging is active. Full local 48-migration behavioral suite, hosted workflow/permission/concurrency suite, actual hosted Auth and Storage tests, build, scoped lint/typecheck and 26 security checks pass. The database test now exercises the real legacy-registry prerequisite rather than supplying a hidden fixture.

Deployment must use existing `magnet-op`, allowlisted `.magnet-build`, production Supabase `xqqgbvigfojfydzfguan`, and production environment secrets. Never promote staging database bindings. Sensitive Vercel env values cannot be pulled; `[SENSITIVE]` is a redaction, not a usable credential. Verify actual runtime configuration instead.

Keep prior deployment and tested private contract rollback. Stop/rollback on authentication or membership regression, cross-tenant exposure, crash or unexpected reconciliation change. Final acceptance requires post-migration reconciliation and production browser verification. Production application status is recorded in SHIP_STATUS.md.

Unresolved legacy ambiguities are preserved and flagged; owner review is required before repairing those records. Standalone Studio and external integrations remain POST_DEPLOY/BLOCKED_EXTERNAL as applicable; this is not certification that every master-directive phase is complete.
