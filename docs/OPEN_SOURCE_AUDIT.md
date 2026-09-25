# Open-source reference audit

Reviewed 2026-09-25 from the official repositories. These are moving `main` links,
not immutable vendoring pins. No Twenty/Postiz code, package, visual asset, or
trademark is copied into Magnet OS by this increment. Future reuse must pin a
commit and re-check its exact file/package license and headers first.

## Twenty

[Root license](https://github.com/twentyhq/twenty/blob/main/LICENSE): predominantly
AGPL-3.0, with an application-interface exception, commercial files marked by an
Enterprise license header, and specified MIT packages. Modification of AGPL code
carries copyleft/notice/source obligations, including relevant network-use terms.
The exception is not a blanket permission to copy its implementation into Magnet.
Commercial-marked code is excluded from reuse.

| Inspected source                                                                                                                                                                          | License evidence / use                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [RecordTable.tsx](https://github.com/twentyhq/twenty/blob/main/packages/twenty-front/src/modules/object-record/record-table/components/RecordTable.tsx)                                   | Root AGPL terms; no Enterprise header in inspected file. Concept study only: separate table context, permission boundary, loading/empty states, row/cell focus and selection effects. No source copied. |
| [twenty-front package](https://github.com/twentyhq/twenty/blob/main/packages/twenty-front/package.json)                                                                                   | Dependency inventory only; package manifest does not replace file/root licensing. No installation or bundle reuse.                                                                                      |
| [twenty-ui LICENSE](https://github.com/twentyhq/twenty/blob/main/packages/twenty-ui/LICENSE) and [manifest](https://github.com/twentyhq/twenty/blob/main/packages/twenty-ui/package.json) | MIT package exception verified. MIT permits modification subject to retained copyright/license notices. Not imported; its dependencies/assets need separate review before reuse.                        |

Magnet will independently implement scoped record views, keyboard interactions,
and reusable table state around its existing backend. It will not import Twenty's
auth, workspace model, application runtime, or proprietary features.

## Postiz

[Root license](https://github.com/gitroomhq/postiz-app/blob/main/LICENSE): AGPL-3.0.
Modification/reuse requires the applicable notices and corresponding-source duties,
including relevant network-use obligations. This study does not approve every
provider or bundled third-party dependency.

| Inspected source                                                                                                                                                      | License evidence / use                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Social integration interface](https://github.com/gitroomhq/postiz-app/blob/main/libraries/nestjs-libraries/src/integrations/social/social.integrations.interface.ts) | Root AGPL; no separate header in inspected file. Concept study only: OAuth refresh/state, account metadata, media validation, asynchronous pending/finalized publication, provider metrics. No source copied. |
| [Integration manager](https://github.com/gitroomhq/postiz-app/blob/main/libraries/nestjs-libraries/src/integrations/integration.manager.ts)                           | Root AGPL; inspected imports/registry structure. No source copied.                                                                                                                                            |
| [Root package manifest](https://github.com/gitroomhq/postiz-app/blob/main/package.json)                                                                               | Inventory only; transitive packages retain their own licenses. No Postiz dependencies installed.                                                                                                              |

Magnet's future SocialProvider will be independently authored. A provider's
accepted request is distinct from confirmed publication; retry must reconcile
unknown outcomes before resending. Official Meta/TikTok API documentation and app
review will be audited in Phase 7. Password, scraping, or extension-cookie methods
are outside Magnet's design even if a reference repository supports them.

## Dependencies and assets

This increment adds development tools only: ESLint (MIT), Prettier (MIT),
TypeScript (Apache-2.0), and Node type declarations (MIT). The lockfile pins the
resolved graph; preserve package notices. No copied template/font/visual assets.
The existing embedded React/HTM notices and Magnet assets remain intact. Existing
asset ownership is not established by a Git filename; inventory source/rights
before distribution. No claim of complete third-party clearance is made.

## Reuse decision

Use independently implemented concepts now. If actual source reuse is proposed,
record immutable revision, file hashes, headers, package/transitive licenses,
modifications, notice location, and source-disclosure obligations here before
copying. Uncertain or commercial-only material is not eligible.

## Native database verification dependency

`embedded-postgres@17.10.0-beta.17` is a development-only native PostgreSQL
launcher, selected to execute real migrations/RLS without Docker. The installed
launcher and Darwin ARM64 binary wrapper declare MIT; retain bundled upstream
PostgreSQL and dependency notices. Its sole permitted install script reconstructs
relative symlinks inside the packaged native distribution. It is excluded from the
release artifact and does not replace production Supabase. No system user is
created and no production connection is accepted by the test harness.
