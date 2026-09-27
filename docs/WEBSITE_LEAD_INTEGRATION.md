# Website → Magnet OS lead contract

Website repository access is required: the authorized GitHub account currently exposes Magnet OS and three unrelated repositories, not magnetofficial.com. Do not put the website in this repository.

## Server request

POST `https://magnet-op.vercel.app/api/website-leads` from the website backend only.
Headers: `Content-Type: application/json`, `Idempotency-Key: website:<durable-submission-UUID>`, `x-magnet-intake-secret: <server secret>`.
Configure the same `WEBSITE_INTAKE_SECRET` in both server secret stores. Never expose it in HTML, analytics or browser JavaScript.

Required: `form_source` (`project_matcher`, `contact`, `campaign`), `name` or `company`, valid `email` or `phone`.
Optional: `language` (`ar`/`en`), `industry`, `business_stage`, `goals[]`, `services[]`, `current_marketing_setup`, `budget_range`, `timeline`, `website`, `instagram`, `facebook`, `tiktok`, `project_notes`, `contact_preference`, `preferred_contact_time`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `landing_page`, `referrer`, `fbclid`, `gclid`, `ttclid`. HTTP(S) URLs only. Arrays ≤20 strings, each ≤200 characters. Entire request ≤100KB. The server chooses the tenant; browser organization/owner/role claims are ignored. Careers must continue through recruitment, never this endpoint.

A successful response contains `ok`, legacy `id`, canonical `crmLeadId`, `replayed` and `reviewRequired`. API acceptance confirms the CRM transaction committed, not email delivery. HTTP 401/403 = configuration/authentication; 400 = validation or conflicting idempotency; 429 = rate limit; 503 = transient backend unavailable. Never change an existing submission's idempotency key to bypass a conflict.

## Required website-side implementation

1. Validate and persist the full submission in the website's existing durable database before success is returned to the visitor. Preserve original attribution and timestamp; no PII in analytics.
2. Store `sync_status=PENDING`, attempt_count, next_attempt_at, last_attempt, failure_reason, crm_lead_id. Commit this before contacting Magnet OS.
3. A leased server worker sends the same immutable payload and key. On CRM success save `SYNCED` and crm_lead_id. On timeout/429/503 retain PENDING with bounded exponential backoff. Exhaustion is FAILED and raises an operator alert; retain the submission for manual retry. Authentication/schema errors require operator repair, not repeated requests.
4. A browser retry reuses its original submission UUID. Failure to persist must return an error. Persisted-but-pending CRM sync may return success. Do not make visitor latency depend on email delivery.
5. Emit only non-PII analytics: project_matcher_view/start/step/complete, contact_submit, booking_click, whatsapp_click; qualified_lead only after actual configured classification. Ad provider credentials are optional and independent of ingestion.

## Magnet OS behavior

One transactional command reuses canonical intake, tenant checks, rate limits and projections. Identical content within 10 minutes reuses the lead; differing content with a recent matching contact creates a separate review-flagged lead. No silent identity merge. Sales configures a default active owner, default classification and optional follow-up interval in Settings. Qualified/Priority follow-ups are internal only. No automated prospect email is enabled.

Original source fields remain on the lead and new proposal/client records inherit a tenant-checked attribution snapshot. Existing business records are not rewritten.
