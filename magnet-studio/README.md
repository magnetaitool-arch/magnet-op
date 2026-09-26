# Magnet Studio

The original vanilla-JavaScript brief/report editors, branded previews and PDF layouts are preserved from checkpoint `dd08ce0`. Studio now opens inside the existing authenticated Magnet OS shell and its deployment.

- `app.js`, `app.css`, `responsive.css`: existing editor and document layouts.
- `integration.js`: same-origin, source-checked bridge to the authenticated parent. No credentials are sent to the frame and embedded operational documents never use localStorage.
- `../modules/studio-workspace.js`: task/client/project/campaign context, server version saving, review/revision/final actions and history.
- Additive `studio_*_v2` tables reference canonical tasks, existing files and identities. Creative work pins an immutable brief version. Review requires independent authorship and existing approval capability.
- Task files/comments and notifications reuse the existing services. Open Studio from the main navigation or Approval Center. Direct top-level editor access redirects to the main shell.

Saving creates a server version. Unsaved edits remain temporary in the editor; an unsuccessful save is never reported as successful. Read-only historical versions cannot be approved as the current version. Published client PDFs keep the original English layout; the workspace/editor supports Arabic and English.

Original standalone local drafts are not deleted or automatically assigned to a workspace. Their ownership must be confirmed before any later import. Historical screenshots and the standalone deployment configuration are excluded from the production artifact.

Use the repository's build/lint/typecheck/test commands. Database Studio tests run on isolated PostgreSQL fixtures via `pnpm run test:database`; hosted verification uses independent staging. Never point staging tools at production.
