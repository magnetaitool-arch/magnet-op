# Session and CSP repair — local verification

2026-09-26. Unreleased; hosted Auth lifecycle and staging remain BLOCKED_EXTERNAL.

## Verified defects and changes

- Refresh previously erased credentials for every 4xx, including rate limits. The extracted coordinator clears only explicit terminal Auth codes; unknown errors, malformed replies, 429, 5xx, timeouts and network failure retain credentials and back off. Provider Retry-After is respected with a one-hour ceiling; exponential retries cap at five minutes. Token lifetime is unchanged.
- Single-flight was tab-local. Web Locks now serialize project refreshes across supporting browsers; the session is reread after waiting. Storage comparison prevents a late response from resurrecting logout, erasing a rotated session or overwriting a different login. Browsers lacking Web Locks retain compare-before-commit protection; ambiguous token-reuse failures do not erase credentials.
- Identity service previously translated every unsuccessful Auth `/user` response into 401. Upstream outages/rate limits/malformed bodies now return recoverable 503. Network requests have timeouts. Late identity replies from a replaced token are rejected.
- Cached identity no longer opens protected screens or starts business sync/automatic business actions before live verification. A transient initial verification failure presents retry while preserving stored credentials. A server-denied membership closes private UI. Explicit logout still clears credentials and private data.
- Multi-organization ambiguity now opens an explicit workspace picker. Selection revalidates live membership, clears old data and restores the selected context. Cross-tab identity changes trigger verification rather than retaining another account's cached authority.
- Blanket script `unsafe-inline` was replaced by SHA-256 hashes of the exact published inline blocks. `script-src-attr 'none'` blocks event attributes; print buttons use listeners. Inline style allowance remains for the existing design system. No `unsafe-eval` was added.
- `pnpm run csp:update` regenerates reviewed hashes after shell changes. Build fails if hashes are stale. The local preview serves the same CSP, and the worker shell cache is versioned.

## Evidence and limits

Eight executable rotation tests cover concurrency, multiple coordinators sharing a lock, logout/account changes during requests, terminal/recoverable errors, backoff and successful recovery. Three tests execute the real identity edge handler with controlled HTTP responses. Full existing regression suite passes after updating guard assertions to require live context.

Actual Chromium: app loaded under CSP; a deliberately injected inline script was blocked with `script-src-elem`; mobile workspace chooser and retry error were exercised in English and Arabic with no horizontal overflow. Screenshots are in `docs/audit-assets/2026-09-25/workspace-selection-*.png` (capture folder retained across midnight). Synthetic chooser contexts prove presentation, not real hosted membership or browser reopen/login.

Independent Supabase URL, public key, server-only service-role key, and authenticated staging CLI/database access are still required for the hosted lifecycle, real concurrent browser Auth rotation and session restoration. Production was not changed. Identity service and app must be rolled out together after staging verification. Keep the previous deployment for rollback; reverting application files requires regenerating matching CSP hashes.
