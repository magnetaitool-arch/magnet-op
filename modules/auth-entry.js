'use strict';

/**
 * Startup presentation only; server identity, membership, and RLS remain the
 * authorization boundary. Unknown availability is never evidence of a new tenant.
 * @typedef {'configuration-unavailable'|'service-unavailable'|'setup'|'signin'|'resume'} EntryMode
 * @param {{hosted: boolean, configured: boolean, status: unknown, hasSession: boolean, localAccountCount: number}} input
 * @returns {EntryMode}
 */
function resolveAuthEntry(input) {
  if (input.hosted && !input.configured) return 'configuration-unavailable';
  if (input.configured) {
    if (
      !input.status ||
      typeof input.status !== 'object' ||
      !('needsSetup' in input.status) ||
      typeof input.status.needsSetup !== 'boolean'
    )
      return 'service-unavailable';
    if (input.hasSession) return 'resume';
    return input.status.needsSetup ? 'setup' : 'signin';
  }
  // Retain explicit file/offline development, never a hosted fallback.
  if (input.hasSession) return 'resume';
  return input.localAccountCount > 0 ? 'signin' : 'setup';
}

const authEntryAPI = Object.freeze({ resolveAuthEntry });
if (typeof module !== 'undefined' && module.exports) module.exports = authEntryAPI;
else Object.defineProperty(globalThis, 'MagnetAuthEntry', { value: authEntryAPI });
