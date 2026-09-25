'use strict';
function createProjectBriefs(React, html) {
  const { useState, useEffect, useRef } = React;
  return function ProjectBriefs({ rpc, organizationId, projectId, lang, readOnly = false }) {
    const ar = lang === 'ar',
      L = (en, arabic) => (ar ? arabic : en);
    const [data, setData] = useState(null),
      [error, setError] = useState(''),
      [busy, setBusy] = useState(false),
      [source, setSource] = useState(''),
      [revision, setRevision] = useState('');
    const generation = useRef(0),
      pending = useRef(null),
      inFlight = useRef(false);
    const load = async () => {
      const seq = ++generation.current;
      setError('');
      setBusy(true);
      inFlight.current = true;
      try {
        const out = await rpc('get_project_briefs_v2', {
          p_organization_id: organizationId,
          p_project_id: projectId,
        });
        if (!out?.ok || !Array.isArray(out.revisions) || !Array.isArray(out.sources))
          throw Error('unavailable');
        if (seq === generation.current) {
          setData(out);
          setRevision('');
          setSource('');
          pending.current = null;
        }
      } catch {
        if (seq === generation.current)
          setError(
            L(
              'Could not load project briefs. Check your access and retry.',
              'تعذّر تحميل بريفات المشروع. تحقق من صلاحياتك وأعد المحاولة.',
            ),
          );
      } finally {
        if (seq === generation.current) {
          setBusy(false);
          inFlight.current = false;
        }
      }
    };
    useEffect(() => {
      setData(null);
      pending.current = null;
      load();
      return () => {
        generation.current++;
      };
    }, [organizationId, projectId]);
    const capture = async () => {
      const selected = data?.sources.find((x) => x.id === source);
      if (inFlight.current || !data?.canManage || !selected) return;
      const seq = generation.current,
        key = JSON.stringify([projectId, selected.id, selected.sourceHash, data.revision]);
      if (pending.current?.key !== key)
        pending.current = { key, id: globalThis.crypto.randomUUID() };
      inFlight.current = true;
      setBusy(true);
      setError('');
      try {
        const out = await rpc('capture_project_brief_v2', {
          p_organization_id: organizationId,
          p_project_id: projectId,
          p_brief_id: selected.id,
          p_source_hash: selected.sourceHash,
          p_expected_revision: data.revision,
          p_command_id: pending.current.id,
        });
        if (!out?.ok) throw Error('unconfirmed');
        if (seq === generation.current) {
          setData(out);
          setRevision('');
          setSource('');
          pending.current = null;
        }
      } catch {
        if (seq === generation.current)
          setError(
            L(
              'Snapshot not confirmed. Retry unchanged, or reload to review source or version changes.',
              'لم يتم تأكيد حفظ النسخة. أعد المحاولة دون تعديل، أو أعد التحميل لمراجعة تغييرات المصدر أو الإصدار.',
            ),
          );
      } finally {
        if (seq === generation.current) {
          setBusy(false);
          inFlight.current = false;
        }
      }
    };
    const labels = {
      company: ['Company', 'الشركة'],
      industry: ['Industry', 'المجال'],
      aboutBiz: ['Business context', 'عن النشاط'],
      wants: ['Services and deliverables', 'الخدمات والمخرجات'],
      objective: ['Goals', 'الأهداف'],
      audience: ['Audience', 'الجمهور'],
      geo: ['Markets', 'الأسواق'],
      lang: ['Languages', 'اللغات'],
      competitors: ['Competitors', 'المنافسون'],
      differentiation: ['Differentiation', 'نقاط التميز'],
      brandAssets: ['Brand assets', 'أصول العلامة'],
      tone: ['Tone of voice', 'نبرة التواصل'],
      references: ['References', 'المراجع'],
      donts: ['Restrictions', 'المحاذير'],
      budget: ['Budget guidance', 'توجيهات الميزانية'],
      timeline: ['Timeline', 'الجدول الزمني'],
      urgency: ['Urgency', 'الأولوية'],
      notes: ['Client notes', 'ملاحظات العميل'],
    };
    const active =
      data?.revisions.find((x) => String(x.revision) === revision) || data?.revisions[0];
    const value = (v) =>
      Array.isArray(v)
        ? v.map(value).join(' · ')
        : v && typeof v === 'object'
          ? JSON.stringify(v)
          : String(v ?? '');
    return html`<section class="project-briefs" aria-busy=${busy}>
      <h3>${L('Execution brief', 'بريف التنفيذ')}</h3>
      <p class="muted">
        ${L('Keep the submitted client brief with this project. Each saved version stays unchanged; saving is not client approval.', 'احفظ بريف العميل المُرسل مع المشروع. كل نسخة محفوظة تظل ثابتة؛ الحفظ لا يعني موافقة العميل.')}
      </p>
      ${error && html`<p class="rec-error" role="alert">${error}</p>`}
      ${busy && html`<p role="status">${L('Loading or saving brief…', 'جارٍ تحميل أو حفظ البريف…')}</p>`}
      ${
        data &&
        html`<div>
          ${
            active
              ? html`<div>
                  <label class="project-brief-field fld"
                    ><span>${L('Saved version', 'النسخة المحفوظة')}</span
                    ><select
                      class="inp"
                      value=${revision || String(active.revision)}
                      onChange=${(e) => setRevision(e.target.value)}
                    >
                      ${data.revisions.map((r) => html`<option key=${r.id} value=${String(r.revision)}>${L('Version', 'نسخة')} ${r.revision} · ${new Date(r.capturedAt).toLocaleDateString(ar ? 'ar-EG' : 'en-GB')}</option>`)}
                    </select></label
                  >
                  ${active.sourceChanged && html`<p class="project-brief-notice" role="status">${L('The source was changed, reopened or removed. This saved version is preserved. Review the latest submitted brief before capturing a replacement.', 'تم تغيير المصدر أو إعادة فتحه أو حذفه. هذه النسخة محفوظة. راجع أحدث بريف مُرسل قبل حفظ نسخة بديلة.')}</p>`}
                  <dl class="project-brief-answers">
                    ${Object.entries(active.snapshot.answers || {}).map(
                      ([key, v]) =>
                        value(v) &&
                        html`<div key=${key}>
                          <dt>${labels[key] ? L(...labels[key]) : key}</dt>
                          <dd>${value(v)}</dd>
                        </div>`,
                    )}
                  </dl>
                </div>`
              : html`<p>
                  ${L('No execution brief saved for this project yet.', 'لم يُحفظ بريف تنفيذ لهذا المشروع بعد.')}
                </p>`
          }
          ${
            data.canManage &&
            !readOnly &&
            html`<div class="project-brief-capture">
              ${
                data.sources.length
                  ? html`<label class="project-brief-field fld"
                        ><span
                          >${L('Submitted brief from this client', 'بريف مُرسل من هذا العميل')}</span
                        ><select
                          class="inp"
                          value=${source}
                          disabled=${busy}
                          onChange=${(e) => setSource(e.target.value)}
                        >
                          <option value="">
                            ${L('Select a submitted brief', 'اختر بريفًا مُرسلًا')}
                          </option>
                          ${data.sources.map((s) => html`<option key=${s.id} value=${s.id}>${s.title} · ${s.submittedAt ? new Date(s.submittedAt).toLocaleDateString(ar ? 'ar-EG' : 'en-GB') : s.id}</option>`)}
                        </select></label
                      ><button class="btn btn-pri" disabled=${busy || !source} onClick=${capture}>
                        ${L('Save execution version', 'حفظ نسخة التنفيذ')}
                      </button>`
                  : html`<p class="muted">
                      ${L('No submitted brief is linked to this client. Link the correct client and collect their answers in Client Briefs first.', 'لا يوجد بريف مُرسل مرتبط بهذا العميل. اربط العميل الصحيح واجمع إجاباته من بريفات العملاء أولًا.')}
                    </p>`
              }
            </div>`
          }
        </div>`
      }
      <button class="mini" disabled=${busy} onClick=${load}>
        ${L('Reload briefs', 'إعادة تحميل البريفات')}
      </button>
    </section>`;
  };
}
if (typeof window !== 'undefined') window.MagnetProjectBriefs = { createProjectBriefs };
if (typeof module !== 'undefined') module.exports = { createProjectBriefs };
