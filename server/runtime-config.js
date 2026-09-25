'use strict';

/** @typedef {{url: string, key: string}} PublicConfig */
/**
 * Validate deployment-owned browser credentials, not user authentication.
 * JWT decoding here does NOT verify a signature or grant any authorization.
 * Supabase still verifies the key and every user's JWT on protected requests.
 * @param {string} key
 * @param {string} projectRef
 */
function isPublicKey(key, projectRef) {
  if (/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(key)) return true;
  const parts = key.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return (
      header?.alg === 'HS256' &&
      payload?.role === 'anon' &&
      payload.iss === 'supabase' &&
      payload.ref === projectRef &&
      typeof payload.exp === 'number' &&
      Number.isFinite(payload.exp) &&
      payload.exp > Date.now() / 1000
    );
  } catch {
    return false;
  }
}

/** @param {Record<string, string | undefined>} env @returns {PublicConfig | null} */
function publicRuntimeConfig(env) {
  const url = String(env.SUPABASE_URL || '')
    .trim()
    .replace(/\/$/, '');
  const key = String(env.SUPABASE_ANON_KEY || '').trim();
  const match = /^https:\/\/([a-z]{20})\.supabase\.co$/.exec(url);
  if (!match || !isPublicKey(key, match[1])) return null;
  return { url, key };
}

module.exports = { publicRuntimeConfig, isPublicKey };
