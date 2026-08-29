# MAGNET OS environment topology — 2026-08-29

This document is the current release source of truth. It supersedes older notes
that describe `jdylrthffifbhyrrhuqd` as the live MAGNET OS database.

## Current state

| Surface | Public URL | Supabase project ref | Status |
| --- | --- | --- | --- |
| Production app | `https://magnet-op.vercel.app` | `xqqgbvigfojfydzfguan` | Live Production |
| Staging app | `https://magnet-os-staging.vercel.app` | `xqqgbvigfojfydzfguan` | **Blocked: points to Production** |
| Retired database | — | `jdylrthffifbhyrrhuqd` | Do not use for new releases |

The Supabase dashboard display name for `xqqgbvigfojfydzfguan` still says
`MAGNET OS STAGING`, but the project was promoted during the V2 cutover and is
the database used by the live Production application. Project refs, not display
names, are authoritative.

## Release gate

No synthetic write test, migration rehearsal, identity repair, or destructive
Staging script may run against either protected ref. `tools/project-safety.js`
enforces this in code.

Before the next Production application deployment:

1. Upgrade and protect `xqqgbvigfojfydzfguan` as the Production Supabase
   project, then rename its dashboard project/organization labels to reflect
   Production.
2. Create a separate Supabase project for MAGNET OS Staging, with separate Auth,
   database, Storage, Functions, API keys, and secrets.
3. Set `MAGNET_STAGING_PROJECT_REF` to that new ref locally and in protected CI.
4. Point `https://magnet-os-staging.vercel.app` Development and Preview settings
   only to the new Staging project.
5. Run `npm run check:env-separation`; it must pass before any live Staging E2E.
6. Restore a current redacted/test-safe snapshot to Staging, apply migrations,
   and run the complete auth, tenant, role, workflow, email, and responsive UI
   gates.
7. Create a fresh Production backup, deploy the compatible app, and preserve the
   previous Vercel deployment for rollback.

## Current verified Production boundary

The 2026-08-29 read-only configuration probe confirmed:

- anonymous access to `records` is blocked;
- anonymous `_accounts` access is blocked;
- `accounts_safe` returns no rows to anonymous callers;
- sampled private client, employee, and invoice data returns no rows to
  anonymous callers;
- the accounts Edge Function is reachable.

These checks do not replace authenticated role-matrix and cross-tenant tests.

## Email blocker

The Production Vercel environment currently has the Supabase and outbox runtime
settings, but no configured external mail provider variables. Supabase billing
does not configure business email delivery. Before the email release gate, add a
verified sender and provider credentials to Vercel/Supabase secret stores, then
test password recovery, task assignment, payslip, employee report, client
report, invoice, contract, retry, bounce, and delivery-status flows.

No secret values belong in this file or in Git.

