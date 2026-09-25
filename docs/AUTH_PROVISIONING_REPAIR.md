# Auth provisioning repair — 2026-09-25

## Reproduced problem

The current `handle_new_user` trigger derives `profiles.username` from the email
local part. `local-test@example.invalid` and `local-test@second.invalid` therefore
collide on `profiles_username_key`. A second legitimate signup fails even though
its normalized email is distinct. Unbounded display-name metadata can also fail
the profile's 160-character constraint. Both failures were reproduced/covered in
the isolated PostgreSQL migration harness with synthetic identities.

## Proposed compatible change

Replace only the provisioning function in a new append-only migration. Keep the
preferred email-derived username for compatibility. If its exact unique constraint
collides, retry the profile insert with a NULL username (already nullable); email
remains the identity and login route. Do not invent privileged aliases. Preserve
existing usernames on idempotent profile reconciliation. Bound the display name
to the existing database limit. Continue creating pending Viewer profiles, ignore
role/membership claims in user metadata, and never create membership implicitly.

## Data migration and rollback

No rows are backfilled, deleted, or rewritten by the migration. Existing users and
memberships remain intact. A new signup with a colliding local part receives no
username alias and can use email. Roll back by restoring the prior function body
in another migration; do not drop new profiles. That rollback reintroduces the
signup failure and should only be used for a demonstrated regression.

## Validation and rollout

Run the entire ordered migration chain and provisioning/RLS/persistence tests on
native PostgreSQL. Test same-local-part emails, excessive display metadata,
untrusted role claims, and existing profile preservation and concurrent colliding signups. Then repeat real Auth
signup/login/invitation and tenant browser flows on an independent Supabase
staging project before production application. The local auth schema fixture is
not a substitute for GoTrue/Storage HTTP integration. No production rollout is
authorized or performed by this local change.

## Related storage authorization repair

`finalize_document_upload_v2` and `cancel_document_upload_v2` currently allow the
original uploader to bypass a fresh `documents.manage` capability check. A suspended
uploader or a user whose permission was revoked can therefore still invoke these
security-definer commands. A separate additive function-replacement migration must
require the current capability before looking up the document and re-check its
visibility authorization before changing state. No storage objects or rows are
removed. Rollback is another function replacement, but restoring the bypass is not
a safe operational remedy; prefer pausing uploads/previous application deployment.
Test active owner completion, suspended uploader denial, capability revocation,
cross-tenant denial, and missing-object rejection on the SQL fixture; hosted Storage
upload/download still requires independent staging.
