# Phase 4 release evidence

## Implemented

- Existing canonical notifications now feed the existing delivery outbox. Server-stored category preferences, mandatory security category, live recipient/membership checks and deduplicated events. Task notification UI no longer sends a second email independently.
- Branded HTML/text templates; EMAIL_FROM/EMAIL_REPLY_TO/APP_URL compatibility; bounded HTTP calls; no implicit resend.dev sender. Durable delivery history remains separate from provider acceptance.
- Raw-byte Svix verification with five-minute tolerance; durable metadata-only webhook receipts, replay/order/race reconciliation and separate bounced state. Privileged webhook commands inaccessible to browsers.
- Shared-secret website endpoint; structured matcher data, transactionally committed CRM, exact recent-content dedup, separate ambiguity review flag, configurable default eligible sales owner/classification/qualified follow-up. In-app and queued email alerts. New clients/proposals retain attribution snapshots. Sales/founder metrics use server data and Cairo day boundaries.

## Evidence

65 ordered migrations on isolated PostgreSQL 17 pass, including cross-tenant/anonymous denial, preferences, email queue, webhook replay/order/early-arrival, website retries/dedup/ambiguity, assignment/follow-up, attribution and existing proposal/conversion lifecycle. Targeted server signature/schema/missing-provider/outage tests pass. Full npm test, lint, typecheck, security verification and allowlisted build pass. Config validation: zero failures, existing missing-provider warnings.

Independent staging rehearsals preserve all existing row values. Actual staging HTTP → canonical CRM → configured sales owner → one follow-up → one assignment notification → one outbox message passes, including duplicate requests and wrong-secret/careers rejection. Synthetic fixture is marked PHASE4-QA; no production lead was fabricated. Browser preferences persist after refresh. Desktop settings inspected visually; Arabic/RTL 390px and desktop CRM/settings were visually inspected; no horizontal overflow or errors in the fresh browser session. Production reconciliation passed: all 110 original public tables retain original column values/counts, new nullable outbox metadata excluded from schema-shape comparison; ledger 75, storage still private.

## Migration / rollback

Five additive migrations: 20260927151927, 20260927152218, 20260927152547, 20260927152640, 20260927152950. No historical business rows or identities are backfilled, merged or deleted. New notification preferences/routing/receipt tables are RLS-protected; previous schemas/API entry points remain available. Backup: `backups/phase4-release-20260927` (gitignored), native public/Auth/storage/ledger dump plus 15 object copies, SHA-256 manifests, AES-256-GCM archive and authenticated decryption verified.

Production application rollback target is the preceding Studio deployment `dpl_AqCNChFxzckQXFxfx6noBMBTXejT`. Keep new tables/queued evidence on rollback. If event queuing itself fails, an authorized operator may disable only the new `notification_email_v2` trigger, retaining RLS and durable notifications. Never drop populated tables or reset the database. Record row fingerprints before/after migration; compare every original public table inside the migration transaction and abort on mismatch.

## Not claimed complete

- Real Resend send/delivery/webhook registration: key, verified sender and signing secret are absent. Domain status is not inferred from a From address. Configure provider and verify a real receipt before declaring email delivery operational.
- Unattended outbox scheduling is not verified. Worker credentials exist, but no verified active scheduler was found. Existing worker endpoint remains available; no paid service enabled.
- magnetofficial.com repository/backend access unavailable. Contract is in WEBSITE_LEAD_INTEGRATION.md; real website durability/retry/analytics and public-site deployment remain unverified. The staging API test is not a live public-website test.
- Team invitation issuance/resend/revoke/acceptance and provider recovery are not completed by this release. Existing legacy recovery is not represented as provider-native recovery. These require additional implementation/testing against the transitional identity bridge, not merely Resend credentials.
- Classification currently supports an explicit configurable default; weighted scoring and service/round-robin routing are not implemented. No automatic prospect email is enabled.
