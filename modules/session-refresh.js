'use strict';

/** @typedef {{access_token: string, refresh_token: string, expires_at?: number, expires_in?: number}} Session */
/** @typedef {{status: 'refreshed'|'superseded'|'missing'|'retry'|'invalid', session?: Session, retryAt?: number, invalid?: true}} RefreshResult */
/**
 * Rotation coordinator. Only explicit provider revocation codes erase credentials.
 * Storage is compared before every commit, including after a cross-tab lock wait.
 * @param {{read:()=>Session|null, write:(session:Session|null)=>void, fetch:typeof fetch, now?:()=>number, lock?: (name:string, run:()=>Promise<RefreshResult>)=>Promise<RefreshResult>}} deps
 */
function createSessionRefresh(deps) {
  const now = deps.now || Date.now;
  /** @type {Map<string, Promise<RefreshResult>>} */
  const pending = new Map();
  /** @type {Map<string, {fingerprint:string, attempts:number, until:number}>} */
  const retries = new Map();
  /** @param {Session|null} session */
  const fingerprint = (session) =>
    session ? JSON.stringify([session.access_token, session.refresh_token]) : '';
  /** @param {string} project */
  function retryAt(project) {
    const retry = retries.get(project);
    return retry && retry.fingerprint === fingerprint(deps.read()) ? retry.until : 0;
  }
  /** @param {{url:string, key:string}} cfg @returns {Promise<RefreshResult>} */
  function refresh(cfg) {
    const project = cfg.url.replace(/\/$/, '');
    const existing = pending.get(project);
    if (existing) return existing;
    const initial = fingerprint(deps.read());
    /** @returns {Promise<RefreshResult>} */
    const run = async () => {
      const session = deps.read();
      if (!session?.refresh_token || !project || !cfg.key) return { status: 'missing' };
      if (fingerprint(session) !== initial) return { status: 'superseded', session };
      if (retryAt(project) > now()) return { status: 'retry', retryAt: retryAt(project) };
      /** @param {Response | undefined} [response] @returns {RefreshResult} */
      const retry = (response) => {
        const previous = retries.get(project);
        const attempts = previous?.fingerprint === initial ? previous.attempts + 1 : 1;
        const header = response?.headers.get('retry-after');
        const seconds = header ? Number(header) : NaN;
        const requested = header
          ? Number.isFinite(seconds)
            ? now() + seconds * 1000
            : Date.parse(header)
          : 0;
        const until = Math.max(
          now() + Math.min(300000, 5000 * 2 ** Math.min(attempts - 1, 6)),
          Math.min(now() + 3600000, requested || 0),
        );
        retries.set(project, { fingerprint: initial, attempts, until });
        return { status: 'retry', retryAt: until };
      };
      /** @returns {RefreshResult|null} */
      const superseded = () => {
        const current = deps.read();
        return fingerprint(current) === initial
          ? null
          : current
            ? { status: 'superseded', session: current }
            : { status: 'missing' };
      };
      try {
        const response = await deps.fetch(project + '/auth/v1/token?grant_type=refresh_token', {
          method: 'POST',
          headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: session.refresh_token }),
          signal: AbortSignal.timeout(15000),
        });
        const body = await response.json().catch(() => null);
        const changed = superseded();
        if (changed) return changed;
        if (!response.ok) {
          // A reused-token response can be a competing rotation in browsers without
          // Web Locks. It is not sufficient evidence to destroy the local session.
          const terminal = [
            'refresh_token_not_found',
            'session_not_found',
            'session_expired',
            'user_banned',
          ];
          if ([400, 401, 403].includes(response.status) && terminal.includes(body?.code)) {
            deps.write(null);
            retries.delete(project);
            return { status: 'invalid', invalid: true };
          }
          return retry(response);
        }
        if (
          !body ||
          typeof body.access_token !== 'string' ||
          !body.access_token ||
          typeof body.refresh_token !== 'string' ||
          !body.refresh_token
        )
          return retry(response);
        if (!Number.isFinite(body.expires_at) && Number.isFinite(body.expires_in))
          body.expires_at = Math.floor(now() / 1000) + body.expires_in;
        if (!Number.isFinite(body.expires_at) || body.expires_at * 1000 <= now())
          return retry(response);
        deps.write(body);
        retries.delete(project);
        return { status: 'refreshed', session: body };
      } catch {
        return superseded() || retry();
      }
    };
    const operation = (deps.lock ? deps.lock('magnet-auth-refresh:' + project, run) : run())
      .catch(() => /** @type {RefreshResult} */ ({ status: 'retry', retryAt: now() + 5000 }))
      .finally(() => pending.delete(project));
    pending.set(project, operation);
    return operation;
  }
  return Object.freeze({ refresh, retryAt });
}
const sessionRefreshAPI = Object.freeze({ createSessionRefresh });
if (typeof module !== 'undefined' && module.exports) module.exports = sessionRefreshAPI;
else Object.defineProperty(globalThis, 'MagnetSessionRefresh', { value: sessionRefreshAPI });
