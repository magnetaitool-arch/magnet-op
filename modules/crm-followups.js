'use strict';
// Server-backed lead next actions. Existing legacy activities remain a separate history.
function createLeadFollowups(React, html) {
  const { useState, useEffect, useRef } = React;
  return function LeadFollowups({ rpc, organizationId, leadId, canEdit, lang }) {
    const ar = lang === 'ar',
      L = (en, ara) => (ar ? ara : en);
    const [data, setData] = useState(null),
      [error, setError] = useState(''),
      [busy, setBusy] = useState(false),
      [editing, setEditing] = useState(null);
    const [title, setTitle] = useState(''),
      [due, setDue] = useState(''),
      [owner, setOwner] = useState(''),
      [outcome, setOutcome] = useState(''),
      [status, setStatus] = useState('OPEN');
    const [nextTitle, setNextTitle] = useState(''),
      [nextDue, setNextDue] = useState('');
    const attempt = useRef(null),
      generation = useRef(0);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const load = async () => {
      const current = ++generation.current;
      setError('');
      try {
        const value = await rpc('list_crm_followups_v2', {
          p_organization_id: organizationId,
          p_legacy_record_id: leadId,
        });
        if (!value?.ok || !Array.isArray(value.items) || !Array.isArray(value.owners))
          throw new Error('invalid_followups_response');
        if (current === generation.current) setData(value);
      } catch {
        if (current === generation.current)
          setError(
            L(
              'Follow-ups could not be loaded. Retry; no records have been changed.',
              'تعذّر تحميل المتابعات. أعد المحاولة؛ لم يتم تغيير أي سجلات.',
            ),
          );
      }
    };
    useEffect(() => {
      setData(null);
      setEditing(null);
      load();
      return () => {
        generation.current++;
      };
    }, [organizationId, leadId]);
    const localTime = (value) => {
      const d = new Date(value);
      return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    };
    const edit = (row) => {
      attempt.current = null;
      setEditing(row || { id: globalThis.crypto.randomUUID(), version: 0 });
      setTitle(row?.title || '');
      setDue(row ? localTime(row.due_at) : '');
      setOwner(row?.owner_user_id || '');
      setOutcome('');
      setStatus('OPEN');
      setNextTitle('');
      setNextDue('');
      setError('');
    };
    const save = async (event) => {
      event.preventDefault();
      if (busy || !editing) return;
      const current = generation.current;
      const payload = {
        p_organization_id: organizationId,
        p_legacy_record_id: leadId,
        p_id: editing.id,
        p_expected_version: editing.version,
        p_title: title.trim(),
        p_due_at: new Date(due).toISOString(),
        p_source_timezone: timezone,
        p_owner_user_id: owner,
        p_status: status,
        p_outcome: outcome.trim() || null,
        p_next_action:
          status === 'DONE' && nextTitle.trim()
            ? { title: nextTitle.trim(), dueAt: new Date(nextDue).toISOString() }
            : null,
      };
      const key = JSON.stringify(payload);
      if (!attempt.current || attempt.current.key !== key)
        attempt.current = { key, id: globalThis.crypto.randomUUID() };
      payload.p_command_id = attempt.current.id;
      setBusy(true);
      setError('');
      try {
        const result = await rpc('save_crm_followup_v2', payload);
        if (!result?.ok) throw new Error('unconfirmed');
        if (current !== generation.current) return;
        setEditing(null);
        attempt.current = null;
        await load();
      } catch {
        if (current === generation.current)
          setError(
            L(
              'Save could not be confirmed. Retry unchanged to avoid duplicates. If the record changed, cancel and reload before editing.',
              'تعذّر تأكيد الحفظ. أعد المحاولة دون تعديل لتجنب التكرار. إذا تغيّر السجل، ألغِ التعديل وأعد التحميل.',
            ),
          );
      } finally {
        setBusy(false);
      }
    };
    return html`<section class="rec-section" aria-busy=${busy}>
      <div class="flex between center gap8">
        <h4>${L('Next actions', 'المتابعات القادمة')}</h4>
        ${canEdit && !editing && html`<button class="btn btn-pri" onClick=${() => edit(null)}>${L('Add follow-up', 'إضافة متابعة')}</button>`}
      </div>
      ${error && html`<div role="alert" class="rec-error">${error} ${!editing && html`<button class="mini" onClick=${load}>${L('Retry', 'إعادة المحاولة')}</button>`}</div>`}
      ${
        editing &&
        html`<form onSubmit=${save} class="crm-followup-form">
          <label
            >${L('Action', 'المتابعة')}<input
              class="inp"
              required
              maxlength="240"
              value=${title}
              onChange=${(e) => setTitle(e.target.value)} /></label
          ><label
            >${L('Due', 'الموعد')} · ${timezone}<input
              class="inp"
              type="datetime-local"
              required
              value=${due}
              onChange=${(e) => setDue(e.target.value)} /></label
          ><label
            >${L('Responsible person', 'المسؤول')}<select
              class="sel"
              required
              value=${owner}
              onChange=${(e) => setOwner(e.target.value)}
            >
              <option value="">${L('Choose a person', 'اختر المسؤول')}</option>
              ${(data?.owners || []).map((person) => html`<option key=${person.id} value=${person.id}>${person.name || person.id}</option>`)}
            </select></label
          >
          ${
            editing.version > 0 &&
            html`<label
                >${L('Status', 'الحالة')}<select
                  class="sel"
                  value=${status}
                  onChange=${(e) => setStatus(e.target.value)}
                >
                  <option value="OPEN">${L('Open', 'مفتوحة')}</option>
                  <option value="DONE">${L('Completed', 'مكتملة')}</option>
                  <option value="CANCELLED">${L('Cancelled', 'ملغاة')}</option>
                </select></label
              >${status !== 'OPEN' && html`<label>${L('Outcome / reason', 'النتيجة / السبب')}<textarea class="inp" required maxlength="5000" value=${outcome} onChange=${(e) => setOutcome(e.target.value)}></textarea></label>`}${status === 'DONE' && html`<label>${L('Next action (optional)', 'المتابعة التالية (اختياري)')}<input class="inp" maxlength="240" value=${nextTitle} onChange=${(e) => setNextTitle(e.target.value)} /></label>${nextTitle.trim() && html`<label>${L('Next due date', 'موعد المتابعة التالية')} · ${timezone}<input class="inp" type="datetime-local" required value=${nextDue} onChange=${(e) => setNextDue(e.target.value)} /></label>`}`}`
          }
          <div class="flex gap8">
            <button class="btn btn-pri" disabled=${busy || !data}>
              ${busy ? L('Saving…', 'جارٍ الحفظ…') : L('Save follow-up', 'حفظ المتابعة')}</button
            ><button
              type="button"
              class="btn btn-ghost"
              disabled=${busy}
              onClick=${() => {
                setEditing(null);
                setError('');
                load();
              }}
            >
              ${L('Cancel', 'إلغاء')}
            </button>
          </div>
        </form>`
      }
      ${!data && !error && html`<p role="status">${L('Loading follow-ups…', 'جارٍ تحميل المتابعات…')}</p>`}
      ${
        data &&
        !editing &&
        html`<div class="crm-followup-list">
          ${
            data.items.length
              ? data.items.map(
                  (item) =>
                    html`<article key=${item.id} class="crm-followup-item">
                      <div>
                        <b>${item.title}</b>
                        <p>
                          ${new Date(item.due_at).toLocaleString(ar ? 'ar-EG' : 'en-GB')} ·
                          ${(data.owners.find((person) => person.id === item.owner_user_id) || {}).name || L('Former workspace member', 'عضو سابق')}
                        </p>
                        <span
                          class=${item.status === 'OPEN' && new Date(item.due_at) < new Date() ? 'crm-followup-overdue' : ''}
                          >${item.status === 'OPEN' ? (new Date(item.due_at) < new Date() ? L('Overdue', 'متأخرة') : L('Open', 'مفتوحة')) : item.status === 'DONE' ? L('Completed', 'مكتملة') : L('Cancelled', 'ملغاة')}</span
                        >${item.outcome && html`<p>${item.outcome}</p>`}
                      </div>
                      ${canEdit && item.status === 'OPEN' && html`<button class="mini" onClick=${() => edit(item)}>${L('Update / complete', 'تحديث / إكمال')}</button>`}
                    </article>`,
                )
              : html`<p>
                  ${L('No follow-ups yet. Add the next action and its owner.', 'لا توجد متابعات بعد. أضف الخطوة التالية والمسؤول عنها.')}
                </p>`
          }
        </div>`
      }
    </section>`;
  };
}
function createFollowupQueue(React, html) {
  const { useState, useEffect, useRef } = React;
  return function FollowupQueue({ rpc, organizationId, lang, onOpen, refreshKey }) {
    const ar = lang === 'ar',
      L = (en, ara) => (ar ? ara : en);
    const [scope, setScope] = useState('mine'),
      [bucket, setBucket] = useState('due'),
      [page, setPage] = useState(1),
      [data, setData] = useState(null),
      [error, setError] = useState(''),
      [loading, setLoading] = useState(false);
    const generation = useRef(0);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const load = async () => {
      const sequence = ++generation.current;
      setLoading(true);
      setError('');
      try {
        const value = await rpc('list_crm_followup_queue_v2', {
          p_organization_id: organizationId,
          p_scope: scope,
          p_bucket: bucket,
          p_timezone: timezone,
          p_page: page,
        });
        if (!value?.ok || !Array.isArray(value.items)) throw Error('unavailable');
        if (sequence === generation.current) setData(value);
      } catch {
        if (sequence === generation.current)
          setError(
            L(
              'Follow-up queue unavailable. Retry to load current records.',
              'قائمة المتابعات غير متاحة. أعد المحاولة لتحميل السجلات الحالية.',
            ),
          );
      } finally {
        if (sequence === generation.current) setLoading(false);
      }
    };
    useEffect(() => {
      load();
      return () => {
        generation.current++;
      };
    }, [organizationId, scope, bucket, page, refreshKey]);
    return html`<section class="rec-section" aria-busy=${loading}>
      <div class="flex between center gap8">
        <h3>${L('Follow-ups', 'المتابعات')}</h3>
        <label
          >${L('Show', 'عرض')}
          <select
            class="sel"
            value=${scope}
            onChange=${(e) => {
              setScope(e.target.value);
              setPage(1);
            }}
          >
            <option value="mine">${L('Assigned to me', 'مسندة إليّ')}</option>
            <option value="team">${L('Team', 'الفريق')}</option>
          </select></label
        >
      </div>
      <p class="muted">${L('Dates shown in', 'المواعيد حسب')} ${timezone}</p>
      <div class="rec-tabs">
        ${[
          ['due', L('Today', 'اليوم')],
          ['overdue', L('Overdue', 'متأخرة')],
          ['upcoming', L('Upcoming', 'قادمة')],
          ['all', L('All open', 'كل المفتوحة')],
        ].map(
          ([key, label]) =>
            html`<button
              key=${key}
              class=${key === bucket ? 'on' : ''}
              onClick=${() => {
                setBucket(key);
                setPage(1);
              }}
            >
              ${label} · ${loading || error || !data ? '—' : data.counts[key]}
            </button>`,
        )}
      </div>
      ${error && html`<div role="alert" class="rec-error">${error} <button class="mini" onClick=${load}>${L('Retry', 'إعادة المحاولة')}</button></div>`}
      ${loading && html`<p role="status">${L('Loading follow-ups…', 'جارٍ تحميل المتابعات…')}</p>`}
      ${
        !loading &&
        !error &&
        data &&
        html`<div class="crm-followup-list">
          ${
            data.items.length
              ? data.items.map(
                  (item) =>
                    html`<article class="crm-followup-item" key=${item.id}>
                      <div>
                        <b>${item.title}</b>
                        <p>${item.lead_name} · ${item.owner_name}</p>
                        <time datetime=${item.due_at}
                          >${new Date(item.due_at).toLocaleString(ar ? 'ar-EG' : 'en-GB')}</time
                        >
                      </div>
                      <button class="mini" onClick=${() => onOpen(item.legacy_record_id)}>
                        ${L('Open lead', 'فتح العميل المحتمل')}
                      </button>
                    </article>`,
                )
              : html`<p>
                  ${L('No open follow-ups in this view.', 'لا توجد متابعات مفتوحة في هذا العرض.')}
                </p>`
          }
        </div>`
      }
      ${!loading && !error && data && data.pages > 1 && html`<div class="rec-pagination"><span>${page} / ${data.pages}</span><button class="mini" disabled=${page <= 1} onClick=${() => setPage(page - 1)}>${L('Previous', 'السابق')}</button><button class="mini" disabled=${page >= data.pages} onClick=${() => setPage(page + 1)}>${L('Next', 'التالي')}</button></div>`}
    </section>`;
  };
}
if (typeof module !== 'undefined' && module.exports)
  module.exports = { createLeadFollowups, createFollowupQueue };
else
  Object.defineProperty(globalThis, 'MagnetCrmFollowups', {
    value: { createLeadFollowups, createFollowupQueue },
  });
