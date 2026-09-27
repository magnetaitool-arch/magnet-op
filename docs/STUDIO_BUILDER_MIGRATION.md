# Studio builder additive migration

Migration: `20260927125403_studio_builder_resources.sql` (not yet deployed to production).

Existing Studio documents, immutable versions, task authorization and storage ownership remain canonical. New client-brand snapshots, reusable templates, scoped share capabilities and page/block comments use separate tenant-keyed tables. Direct anonymous/authenticated table access is revoked; narrowly scoped RPCs enforce existing task membership and capabilities. Public links expose a fixed version without bindings or internal comments. Revocation, expiry and issuer membership/capability loss deny subsequent access; already issued image URLs expire within 60 seconds.

The only existing function replacement adds MP4/WebM to the existing upload MIME allowlist. Bucket privacy and size limits remain unchanged. No business rows are backfilled, reassigned, deleted or merged. Existing version validation applies additional checks only to payloads declaring the new builder format.

Before staging and production: capture full private database export, SHA-256 manifest, affected function definitions and storage bucket configuration. Reconcile all pre-existing public row values/counts after applying the transaction. Use independent staging project `vsurqqbxjvqzvqbmetjw`; production is never the rehearsal environment.

Validation: isolated PostgreSQL role/tenant tests, brand revision conflicts and snapshot immutability, invalid structured payload denial, public share allowlist/review/revocation tests. Browser editor, exports, shared assets, mobile and localization remain release gates.

Rollback: restore the previous Vercel application deployment; retain all new tables and data. Revoke new RPC grants if needed. Restore the captured upload function and bucket allowlist only after confirming no new video upload is in flight; otherwise retain the additive MIME support. Never drop new document/version/resource data. Rollback owner: authorized Magnet deployment operator.

Status: isolated rehearsal passed; live staging/production reconciliation is recorded separately when executed.
