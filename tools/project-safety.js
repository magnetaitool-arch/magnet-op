'use strict';

// Deployment safety rail. `xqq...` was promoted to the live MAGNET OS
// database during the V2 cutover even though its Supabase display name still
// says "STAGING". Every destructive or synthetic Staging tool must therefore
// protect both the current Production project and the retired Production
// snapshot. A project name alone is never a sufficient safety check.
const CURRENT_PRODUCTION_REF = 'xqqgbvigfojfydzfguan';
const RETIRED_PRODUCTION_REFS = Object.freeze(['jdylrthffifbhyrrhuqd']);
const PROTECTED_PROJECT_REFS = new Set([CURRENT_PRODUCTION_REF, ...RETIRED_PRODUCTION_REFS]);

function validProjectRef(value) {
  return /^[a-z]{20}$/.test(String(value || '').trim());
}

function assertNonProductionProjectRef(value) {
  const projectRef = String(value || '').trim();
  if (!validProjectRef(projectRef) || PROTECTED_PROJECT_REFS.has(projectRef)) {
    throw new Error('Refused: an explicit non-Production Supabase project ref is required.');
  }
  return projectRef;
}

module.exports = {
  CURRENT_PRODUCTION_REF,
  RETIRED_PRODUCTION_REFS,
  PROTECTED_PROJECT_REFS,
  validProjectRef,
  assertNonProductionProjectRef,
};
