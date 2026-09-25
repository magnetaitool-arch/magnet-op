'use strict';
/**
 * Compatibility guard, not authorization. Only explicit relationships prove identity.
 * @typedef {{id:string,leadId?:string,convertedClientId?:string,email?:string,phone?:string,mainContactEmail?:string,mainContactPhone?:string,_del?:boolean|string,deleted_at?:string,status?:string}} LegacyEntity
 * @param {LegacyEntity} lead
 * @param {LegacyEntity[]} clients
 * @returns {{status:'match'|'create'|'review',clientId?:string,reason?:string}}
 */
function resolveLeadClient(lead, clients) {
  /** @param {unknown} value */
  const normalize = (value) =>
    String(value || '')
      .trim()
      .toLowerCase();
  if (!lead.id.trim()) return { status: 'review', reason: 'missing_lead_identity' };
  const linked = clients.filter(
    (client) => client.id === lead.convertedClientId || client.leadId === lead.id,
  );
  if (linked.length > 1) return { status: 'review', reason: 'conflicting_explicit_links' };
  if (lead.convertedClientId && !clients.some((client) => client.id === lead.convertedClientId))
    return { status: 'review', reason: 'linked_client_unavailable' };
  if (linked.length === 1) {
    const client = linked[0];
    if (client.leadId && client.leadId !== lead.id)
      return { status: 'review', reason: 'conflicting_explicit_links' };
    if (
      client.deleted_at ||
      [true, 'true'].includes(client._del || false) ||
      client.status === 'Archived'
    )
      return { status: 'review', reason: 'linked_client_deleted' };
    return { status: 'match', clientId: client.id };
  }
  const possible = clients.some(
    (client) =>
      (normalize(lead.email) && normalize(client.mainContactEmail) === normalize(lead.email)) ||
      (normalize(lead.phone) && normalize(client.mainContactPhone) === normalize(lead.phone)),
  );
  return possible
    ? { status: 'review', reason: 'contact_details_are_not_identity' }
    : { status: 'create' };
}
const compatibilityAPI = Object.freeze({ resolveLeadClient });
if (typeof module !== 'undefined' && module.exports) module.exports = compatibilityAPI;
else Object.defineProperty(globalThis, 'MagnetLegacyCompatibility', { value: compatibilityAPI });
