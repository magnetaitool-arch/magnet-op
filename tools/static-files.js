'use strict';

// Explicit release/preview inventory. Never recursively publish this workspace.
const STATIC_FILES = Object.freeze([
  'index.html',
  'modules/studio-workspace.js',
  'modules/studio-builder-resources.js',
  'modules/legacy-review.js',
  'magnet-studio/index.html',
  'magnet-studio/app.js',
  'magnet-studio/builder-model.js',
  'magnet-studio/builder-render.js',
  'magnet-studio/builder-editor.js',
  'magnet-studio/builder.css',
  'magnet-studio/share.html',
  'magnet-studio/share.js',
  'magnet-studio/vendor/jspdf.umd.min.js',
  'magnet-studio/vendor/pptxgen.bundle.js',
  'magnet-studio/integration.js',
  'magnet-studio/app.css',
  'magnet-studio/responsive.css',
  'magnet-studio/magnet-logo.png',
  'serviceworker.js',
  'manifest.json',
  'magnet-logo.png',
  'magnet-hero.jpg',
  'magnet-login.mp4',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'magnetrun.html',
  'Magnet-OS-Training.html',
  'Magnet-OS-Employee-Manual.html',
  'MagnetOS-Presentation.html',
  'MagnetOS-Roles.html',
  'modules/employee-requests-v3.js',
  'modules/auth-entry.js',
  'modules/session-refresh.js',
  'modules/crm-followups.js',
  'modules/proposal-revisions.js',
  'modules/client-onboarding.js',
  'modules/project-briefs.js',
  'modules/task-status.js',
  'modules/task-dependencies.js',
  'modules/legacy-compatibility.js',
  'styles/foundation.css',
]);
const SERVER_FILES = Object.freeze([
  'api/intake.js',
  'api/outbox.js',
  'api/public-form.js',
  'api/runtime-config.js',
  'api/studio-share-asset.js',
  'api/send-email.js',
  'api/system-health.js',
  'server/public-intake.js',
  'server/outbox.js',
  'server/system-health.js',
  'server/runtime-config.js',
]);
/** @param {string} pathname @returns {string | null} */
function staticPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (
    decoded.includes('\\') ||
    decoded.includes('\0') ||
    decoded.split('/').some((part) => part.startsWith('.'))
  )
    return null;
  if (decoded === '/' || decoded === '/index.html') return 'index.html';
  const file = decoded.replace(/^\//, '');
  if (STATIC_FILES.includes(file)) return file;
  // Match the hosted extensionless app rewrite without exposing server folders.
  if (
    !file.includes('.') &&
    !/^(api|server|tools|docs|supabase|backups|node_modules)(\/|$)/.test(file)
  )
    return 'index.html';
  return null;
}
module.exports = { STATIC_FILES, SERVER_FILES, staticPath };
