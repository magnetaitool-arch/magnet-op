'use strict';

function normalOrigin(value) {
  try { return new URL(String(value || '')).origin; } catch (error) { return ''; }
}

function allowedOrigins(env) {
  const configured = String(env.EMAIL_ALLOWED_ORIGINS || '').split(',').map((item) => normalOrigin(item.trim())).filter(Boolean);
  const deployment = env.VERCEL_URL ? normalOrigin('https://' + env.VERCEL_URL) : '';
  return new Set(['https://magnet-op.vercel.app', 'https://magnet-os-staging.vercel.app', deployment, ...configured].filter(Boolean));
}

function responseHeaders(origin, env) {
  const headers = {
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-magnet-organization-id',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store, max-age=0',
    'Content-Type': 'application/json',
    'Vary': 'Origin',
  };
  const normalized = normalOrigin(origin);
  if (normalized && allowedOrigins(env).has(normalized)) headers['Access-Control-Allow-Origin'] = normalized;
  return headers;
}

function serverConfig(env) {
  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!/^https:\/\/[a-z]{20}\.supabase\.co$/.test(base) || !key) return null;
  return { base, key };
}

function bearerToken(headers) {
  const match = String(headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function organizationId(headers) {
  const value = String(headers['x-magnet-organization-id'] || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : '';
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function statusCount(snapshot, status) {
  return number(snapshot && snapshot.statuses && snapshot.statuses[status]);
}

function deploymentInfo(env) {
  const commit = String(env.VERCEL_GIT_COMMIT_SHA || '');
  return {
    environment: String(env.VERCEL_ENV || 'local').slice(0, 24),
    region: String(env.VERCEL_REGION || 'local').slice(0, 24),
    commit: /^[0-9a-f]{7,64}$/i.test(commit) ? commit.slice(0, 7) : '',
  };
}

function providerSnapshot(env) {
  const emailConfigured = !!(env.RESEND_API_KEY && env.FROM_EMAIL);
  const whatsappConfigured = !!(
    String(env.WHATSAPP_PROVIDER || '').toLowerCase() === 'meta'
    && env.WHATSAPP_ACCESS_TOKEN
    && env.WHATSAPP_PHONE_NUMBER_ID
  );
  const workerConfigured = !!(env.OUTBOX_WORKER_SECRET || env.CRON_SECRET);
  return {
    email: { status: emailConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED' },
    whatsapp: { status: whatsappConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED' },
    worker: { status: workerConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED' },
  };
}

function healthWarnings(snapshot, providers) {
  const warnings = [];
  if (providers.email.status !== 'CONFIGURED') warnings.push({ code: 'EMAIL_NOT_CONFIGURED', severity: 'CRITICAL' });
  if (providers.worker.status !== 'CONFIGURED') warnings.push({ code: 'WORKER_NOT_CONFIGURED', severity: 'CRITICAL' });
  if (providers.whatsapp.status !== 'CONFIGURED') warnings.push({ code: 'WHATSAPP_NOT_CONFIGURED', severity: 'OPTIONAL' });

  const outboxFailed = statusCount(snapshot.outbox, 'FAILED');
  const outboxProcessing = statusCount(snapshot.outbox, 'PROCESSING');
  const outboxAge = number(snapshot.outbox && snapshot.outbox.oldestReadyAgeSeconds);
  if (outboxFailed > 0) warnings.push({ code: 'OUTBOX_FAILURES', severity: 'CRITICAL', count: outboxFailed });
  if (outboxAge > 900) warnings.push({ code: 'OUTBOX_DELAYED', severity: 'CRITICAL', ageSeconds: outboxAge });
  if (outboxProcessing > 0) warnings.push({ code: 'OUTBOX_PROCESSING', severity: 'INFO', count: outboxProcessing });

  const deadJobs = statusCount(snapshot.jobs, 'DEAD');
  const failedJobs = statusCount(snapshot.jobs, 'FAILED');
  const jobsAge = number(snapshot.jobs && snapshot.jobs.oldestReadyAgeSeconds);
  if (deadJobs > 0) warnings.push({ code: 'DEAD_JOBS', severity: 'CRITICAL', count: deadJobs });
  if (failedJobs > 0) warnings.push({ code: 'JOB_FAILURES', severity: 'CRITICAL', count: failedJobs });
  if (jobsAge > 900) warnings.push({ code: 'JOBS_DELAYED', severity: 'CRITICAL', ageSeconds: jobsAge });
  return warnings;
}

async function requestSnapshot(config, token, targetOrganizationId) {
  const started = Date.now();
  const response = await fetch(config.base + '/rest/v1/rpc/system_health_snapshot_v2', {
    method: 'POST',
    headers: {
      apikey: config.key,
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_organization_id: targetOrganizationId }),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload, latencyMs: Date.now() - started };
}

async function handleSystemHealth(request, env = process.env) {
  const method = String(request.method || '').toUpperCase();
  const headers = Object.fromEntries(Object.entries(request.headers || {}).map(([key, value]) => [String(key).toLowerCase(), value]));
  const origin = String(headers.origin || '');
  const normalizedOrigin = normalOrigin(origin);
  const originAllowed = !!(normalizedOrigin && allowedOrigins(env).has(normalizedOrigin));
  const responseBase = responseHeaders(origin, env);
  const reply = (status, body) => ({ status, headers: responseBase, body });

  if (method === 'OPTIONS') return reply(originAllowed ? 200 : 403, originAllowed ? {} : { error: 'origin_not_allowed' });
  if (method !== 'GET') return reply(405, { error: 'method_not_allowed' });
  if (origin && !originAllowed) return reply(403, { error: 'origin_not_allowed' });

  const token = bearerToken(headers);
  const targetOrganizationId = organizationId(headers);
  const config = serverConfig(env);
  if (!token) return reply(401, { error: 'authenticated_session_required' });
  if (!targetOrganizationId) return reply(400, { error: 'active_organization_required' });
  if (!config) return reply(503, { error: 'service_not_configured' });

  let result;
  try {
    result = await requestSnapshot(config, token, targetOrganizationId);
  } catch (error) {
    return reply(503, { ok: false, status: 'UNAVAILABLE', error: 'health_service_unavailable' });
  }

  if (!result.response.ok || !result.payload || result.payload.ok !== true) {
    const message = String(result.payload && (result.payload.message || result.payload.error) || '');
    if (result.response.status === 401) return reply(401, { error: 'authenticated_session_required' });
    if (result.response.status === 403 || /capability|required|membership/i.test(message)) return reply(403, { error: 'system_health_not_allowed' });
    return reply(503, { ok: false, status: 'UNAVAILABLE', error: 'health_snapshot_failed' });
  }

  const providers = providerSnapshot(env);
  const warnings = healthWarnings(result.payload, providers);
  const degraded = warnings.some((warning) => warning.severity === 'CRITICAL');
  return reply(200, {
    ok: true,
    status: degraded ? 'DEGRADED' : 'HEALTHY',
    checkedAt: result.payload.checkedAt,
    latencyMs: result.latencyMs,
    organization: result.payload.organization,
    database: result.payload.database,
    auth: result.payload.auth,
    storage: result.payload.storage,
    outbox: result.payload.outbox,
    jobs: result.payload.jobs,
    providers,
    deployment: deploymentInfo(env),
    warnings,
  });
}

module.exports = {
  handleSystemHealth,
  _test: { allowedOrigins, providerSnapshot, healthWarnings, deploymentInfo },
};
