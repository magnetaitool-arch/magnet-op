'use strict';
const TITLES = Object.freeze({
  LEAD_ASSIGNED: 'New lead assigned', NEW_WEBSITE_LEAD: 'New website lead',
  FOLLOWUP_DUE: 'Follow-up due', CRM_FOLLOWUP: 'Follow-up updated', TASK_ASSIGNED: 'Task assigned',
  TASK_MENTIONED: 'You were mentioned', APPROVAL_REQUESTED: 'Approval requested',
  REVISION_REQUESTED: 'Revision requested', DEADLINE_APPROACHING: 'Important deadline',
  PROPOSAL_EVENT: 'Proposal update', PUBLISHING_FAILED: 'Publishing needs attention',
  SECURITY_EVENT: 'Security alert', TEAM_INVITATION: 'Team invitation', WELCOME: 'Welcome to Magnet',
});
const escape = value => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function appOrigin(env) {
  try { const url = new URL(env.APP_URL || env.MAGNET_APP_URL || 'https://magnet-op.vercel.app'); return url.protocol === 'https:' ? url.origin : 'https://magnet-op.vercel.app'; }
  catch { return 'https://magnet-op.vercel.app'; }
}
function renderEmail(payload, env = {}) {
  const origin = appOrigin(env);
  const route = String(payload.deepLinkPath || (payload.entityType && payload.entityId ? '/?open='+encodeURIComponent(payload.entityType)+'&id='+encodeURIComponent(payload.entityId) : payload.route) || '');
  const target = route.startsWith('/') && !route.startsWith('//') && !route.includes('\\') ? origin + route : origin;
  const title = String(payload.title || TITLES[payload.eventType] || 'Magnet OS notification').slice(0, 200);
  const message = String(payload.message || '').slice(0, 10000);
  return {
    subject: '[Magnet OS] ' + title,
    text: title + '\n\n' + message + '\n\nOpen Magnet OS: ' + target + '\n\nMADE TO MATTER.',
    html: '<!doctype html><html lang="en"><body style="margin:0;background:#080a08;color:#f8faf5;font-family:Arial,sans-serif"><table role="presentation" width="100%"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" style="max-width:600px"><tr><td><img width="64" height="64" alt="Magnet" src="'+escape(origin)+'/magnet-logo.png"><h1 style="font-size:26px;line-height:1.3">'+escape(title)+'</h1><p style="font-size:16px;line-height:1.7;white-space:pre-line">'+escape(message)+'</p><p style="margin:28px 0"><a style="background:#dfff3f;color:#080a08;padding:14px 22px;display:inline-block;font-weight:bold;text-decoration:none" href="'+escape(target)+'">Open Magnet OS</a></p><p style="font-size:12px;color:#adb3a6">MAGNET · MADE TO MATTER.</p></td></tr></table></td></tr></table></body></html>',
  };
}
module.exports = { renderEmail, appOrigin, TITLES };
