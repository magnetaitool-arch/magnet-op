'use strict';
function createStudioWorkspace(React, html) {
  const { useState, useEffect, useRef } = React;
  return function StudioWorkspace({ ctx }) {
    const L = (en, ar) => (ctx.lang === 'ar' ? ar : en);
    const statusLabel = (value) =>
      ({
        DRAFT: L('Draft', 'مسودة'),
        INTERNAL_REVIEW: L('Internal review', 'مراجعة داخلية'),
        REVISION: L('Revision requested', 'مطلوب تعديل'),
        APPROVED: L('Approved', 'معتمد'),
        FINAL: L('Final', 'نهائي'),
        SAVE: L('Saved', 'حفظ'),
        SUBMIT: L('Submitted', 'إرسال'),
        APPROVE: L('Approved', 'اعتماد'),
      })[value] || value;
    const [list, setList] = useState(null),
      [detail, setDetail] = useState(null),
      [task, setTask] = useState(''),
      [kind, setKind] = useState('brief'),
      [error, setError] = useState(''),
      [busy, setBusy] = useState(false),
      [comment, setComment] = useState(''),
      [file, setFile] = useState(''),
      [editor, setEditor] = useState(null),
      [campaign, setCampaign] = useState(''),
      [brief, setBrief] = useState(''),
      [dirty, setDirty] = useState(false);
    const frame = useRef(null),
      current = useRef({}),
      lock = useRef(false),
      pending = useRef(null),
      generation = useRef(0),
      edits = useRef(0);
    current.current = { ctx, detail, editor, task, kind, file, campaign, brief };
    const errorText = L(
      'Not confirmed. Check your connection and permissions. For a version conflict, reopen the document before editing.',
      'لم يتم تأكيد العملية. تحقق من الاتصال والصلاحيات. عند تعارض النسخ، أعد فتح المستند قبل التعديل.',
    );
    const load = async () => {
      setBusy(true);
      setError('');
      const g = generation.current;
      try {
        const out = await ctx.rpc('list_studio_v2', { p_organization_id: ctx.organizationId });
        if (!out?.ok) throw Error();
        if (g === generation.current) setList(out);
      } catch {
        if (g === generation.current) setError(errorText);
      } finally {
        if (g === generation.current) setBusy(false);
      }
    };
    useEffect(() => {
      generation.current++;
      setList(null);
      setDetail(null);
      setEditor(null);
      pending.current = null;
      load();
      return () => {
        generation.current++;
      };
    }, [ctx.organizationId]);
    const post = (message) =>
      frame.current?.contentWindow?.postMessage(
        { channel: 'magnet-studio', ...message },
        location.origin,
      );
    const initialize = () => {
      const c = current.current;
      post({
        type: 'OPEN',
        lang: c.ctx.lang,
        payload: c.editor?.payload || null,
        kind: c.editor?.kind || 'brief',
        readOnly: c.editor?.readOnly || false,
        briefId: c.editor?.briefId || c.brief,
        clientName: list?.tasks.find((t) => t.id === c.task)?.client || '',
      });
    };
    useEffect(() => {
      post({ type: 'LANG', lang: ctx.lang });
    }, [ctx.lang]);
    useEffect(() => {
      const guard = (event) => {
        if (
          (dirty || lock.current) &&
          !window.confirm(
            L(
              'Leave Studio with unsaved work? Keep this page open to save it.',
              'مغادرة ستوديو مع عمل غير محفوظ؟ ابقَ في الصفحة لحفظه.',
            ),
          )
        )
          event.preventDefault();
      };
      window.addEventListener('magnet:before-navigate', guard);
      return () => window.removeEventListener('magnet:before-navigate', guard);
    }, [dirty, ctx.lang]);
    const run = async (action, payload) => {
      if (lock.current) return;
      const c = current.current,
        g = generation.current,
        edit = edits.current,
        d = c.detail?.document;
      if (!c.editor && !d) return;
      const args = {
        p_organization_id: c.ctx.organizationId,
        p_document_id: d?.id || c.editor.id,
        p_task_id: d?.task_id || c.editor.taskId,
        p_kind: d?.kind || c.editor.kind,
        p_campaign_id: d ? d.campaign_record_id : c.editor.campaignId || null,
        p_expected_revision: d?.revision || 0,
        p_action: action,
        p_payload: action === 'SAVE' ? payload : {},
        p_file_id: c.file || null,
        p_comment: comment || null,
      };
      const key = JSON.stringify(args);
      if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() };
      args.p_command_id = pending.current.id;
      lock.current = true;
      setBusy(true);
      setError('');
      try {
        const out = await c.ctx.rpc('studio_command_v2', args);
        if (!out?.ok) throw Error();
        if (g !== generation.current) return;
        setDetail(out);
        setComment('');
        setEditor((previous) =>
          previous ? { ...previous, revision: out.document.revision } : previous,
        );
        if (edit === edits.current) setDirty(false);
        pending.current = null;
        post({ type: 'SAVED', payload: action === 'SAVE' ? payload : null });
        post({ type: 'LOCK', readOnly: !['DRAFT', 'REVISION'].includes(out.document.status) });
        await load();
      } catch {
        if (g === generation.current) {
          setError(errorText);
          post({ type: 'SAVE_FAILED' });
        }
      } finally {
        lock.current = false;
        if (g === generation.current) setBusy(false);
      }
    };
    useEffect(() => {
      const receive = (event) => {
        if (
          event.origin !== location.origin ||
          event.source !== frame.current?.contentWindow ||
          event.data?.channel !== 'magnet-studio'
        )
          return;
        if (event.data.type === 'DIRTY') {
          edits.current++;
          setDirty(true);
        }
        if (event.data.type === 'READY') initialize();
        if (event.data.type === 'SAVE') run('SAVE', event.data.payload);
      };
      window.addEventListener('message', receive);
      return () => window.removeEventListener('message', receive);
    });
    const open = async (id) => {
      if (lock.current) return;
      lock.current = true;
      setBusy(true);
      setError('');
      const g = ++generation.current;
      try {
        const out = await ctx.rpc('get_studio_v2', {
          p_organization_id: ctx.organizationId,
          p_document_id: id,
        });
        if (!out?.ok) throw Error();
        if (g !== generation.current) return;
        setDetail(out);
        setComment('');
        setList((previous) =>
          previous
            ? {
                ...previous,
                documents: previous.documents.map((item) =>
                  item.id === id
                    ? {
                        ...item,
                        revision: out.document.revision,
                        status: out.document.status,
                        title: out.versions[0]?.payload.title,
                      }
                    : item,
                ),
              }
            : previous,
        );
        setTask(out.document.task_id);
        setKind(out.document.kind);
        setCampaign(out.document.campaign_record_id || '');
        setBrief(out.document.brief_document_id || '');
        setDirty(false);
        setFile(out.versions[0]?.fileId || '');
        setEditor({
          id,
          kind: out.document.kind,
          revision: out.document.revision,
          payload: out.versions[0]?.payload,
          readOnly: !['DRAFT', 'REVISION'].includes(out.document.status),
          nonce: crypto.randomUUID(),
        });
        pending.current = null;
      } catch {
        setError(errorText);
      } finally {
        lock.current = false;
        setBusy(false);
      }
    };
    const create = () => {
      if (!task || lock.current) return;
      setDirty(false);
      setDetail(null);
      setFile('');
      pending.current = null;
      setEditor({
        id: crypto.randomUUID(),
        kind,
        taskId: task,
        campaignId: campaign,
        briefId: brief,
        payload: null,
        nonce: crypto.randomUUID(),
      });
    };
    return html`<section class="studio-workspace" aria-busy=${busy}>
      <h2>${L('Magnet Studio', 'ماجنت ستوديو')}</h2>
      <p class="muted">
        ${L('Briefs, reports and creative versions linked to your assigned work. Save a server version before requesting review.', 'بريفات وتقارير ونسخ إبداعية مرتبطة بمهامك. احفظ نسخة على الخادم قبل طلب المراجعة.')}
      </p>
      ${error && html`<p role="alert" class="rec-error">${error}</p>`}${busy && html`<p role="status">${L('Loading / saving…', 'جارٍ التحميل أو الحفظ…')}</p>`}
      <div class="flex gap8" style=${{ flexWrap: 'wrap' }}>
        <button class="btn" disabled=${busy} onClick=${load}>${L('Reload', 'إعادة التحميل')}</button
        ><button class="btn" onClick=${() => ctx.go('tasks')}>
          ${L('Tasks, comments & files', 'المهام والتعليقات والملفات')}
        </button>
      </div>
      ${dirty && html`<p role="status">${L('Unsaved edits — save before switching documents or requesting review.', 'تعديلات غير محفوظة — احفظ قبل تغيير المستند أو طلب المراجعة.')}</p>`}
      ${
        list &&
        html`<div class="studio-controls">
          <label
            >${L('Client / project / task', 'العميل / المشروع / المهمة')}<select
              class="inp"
              value=${task}
              disabled=${busy}
              onChange=${(e) => {
                setTask(e.target.value);
                setCampaign('');
                setBrief('');
              }}
            >
              <option value="">${L('Choose assigned work', 'اختر المهمة')}</option>
              ${list.tasks.map((t) => html`<option value=${t.id}>${t.client} / ${t.project} / ${t.title}</option>`)}
            </select></label
          >
          <label
            >${L('Document type', 'نوع المستند')}<select
              class="inp"
              value=${kind}
              onChange=${(e) => setKind(e.target.value)}
            >
              ${[
                ['brief', 'Brief', 'بريف'],
                ['report', 'Report', 'تقرير'],
                ['content', 'Content', 'محتوى'],
                ['design', 'Design', 'تصميم'],
                ['video', 'Video', 'فيديو'],
              ].map(([v, en, ar]) => html`<option value=${v}>${L(en, ar)}</option>`)}
            </select></label
          ><label
            >${L('Campaign (optional)', 'الحملة (اختياري)')}<select
              class="inp"
              value=${campaign}
              onChange=${(e) => setCampaign(e.target.value)}
            >
              <option value="">${L('No campaign', 'بدون حملة')}</option>
              ${(list.campaigns || []).filter((c) => c.clientId === list.tasks.find((t) => t.id === task)?.clientId).map((c) => html`<option value=${c.id}>${c.title}</option>`)}
            </select></label
          >
          ${
            ['content', 'design', 'video'].includes(kind) &&
            html`<label
              >${L('Project brief', 'بريف المشروع')}<select
                class="inp"
                value=${brief}
                onChange=${(e) => setBrief(e.target.value)}
              >
                <option value="">${L('Choose saved brief', 'اختر بريفًا محفوظًا')}</option>
                ${list.documents.filter((d) => d.kind === 'brief' && list.tasks.find((t) => t.id === d.taskId)?.projectId === list.tasks.find((t) => t.id === task)?.projectId).map((d) => html`<option value=${d.id}>${d.title}</option>`)}
              </select></label
            >`
          }<button
            class="btn btn-pri"
            disabled=${busy || dirty || !task || (['content', 'design', 'video'].includes(kind) && !brief)}
            onClick=${create}
          >
            ${L('Create document', 'إنشاء مستند')}
          </button>
        </div>`
      }
      ${list && !list.tasks.length && html`<p>${L('No eligible assigned work. A manager must link a task to a valid client and project first.', 'لا توجد مهام متاحة. يجب ربط المهمة بعميل ومشروع صحيحين أولًا.')}</p>`}
      ${list && html`<div class="studio-list">${list.documents.map((d) => html`<button class="btn" disabled=${busy || dirty} onClick=${() => open(d.id)}>${d.title} · v${d.revision} · ${statusLabel(d.status)}</button>`)}</div>`}
      ${
        detail &&
        html`<div class="studio-review">
          <p>
            ${L('Saved version', 'النسخة المحفوظة')} ${detail.document.revision} ·
            ${statusLabel(detail.document.status)}
          </p>
          ${editor?.revision !== detail.document.revision && html`<p role="status">${L('Historical version. Reopen the current document before making a review decision.', 'نسخة سابقة. أعد فتح المستند الحالي قبل اتخاذ قرار المراجعة.')}</p>`}
          ${detail.document.brief_revision && html`<p>${L('Source brief version', 'نسخة البريف المرجعية')}: ${detail.document.brief_revision}</p>`}
          <label
            >${L('Review note', 'ملاحظة المراجعة')}<textarea
              class="inp"
              maxlength="2000"
              value=${comment}
              onInput=${(e) => setComment(e.target.value)}
            />
          </label>
          ${detail.document.status === 'DRAFT' && html`<button class="btn" disabled=${busy || dirty || editor?.revision !== detail.document.revision} onClick=${() => run('SUBMIT')}>${L('Submit for internal review', 'إرسال للمراجعة الداخلية')}</button>`}
          ${detail.document.status === 'INTERNAL_REVIEW' && detail.canReview && html`<button class="btn" disabled=${busy || !comment.trim() || editor?.revision !== detail.document.revision} onClick=${() => run('REVISION')}>${L('Request revision', 'طلب تعديل')}</button><button class="btn btn-pri" disabled=${busy || editor?.revision !== detail.document.revision} onClick=${() => run('APPROVE')}>${L('Approve this version', 'اعتماد هذه النسخة')}</button>`}
          ${detail.document.status === 'APPROVED' && html`<button class="btn btn-pri" disabled=${busy || editor?.revision !== detail.document.revision} onClick=${() => run('FINAL')}>${L('Mark final', 'اعتماد النسخة النهائية')}</button>`}
          <label
            >${L('Linked task file', 'ملف مرتبط بالمهمة')}<select
              class="inp"
              value=${file}
              disabled=${busy || editor?.revision !== detail.document.revision || !['DRAFT', 'REVISION'].includes(detail.document.status)}
              onChange=${(e) => {
                setFile(e.target.value);
                setDirty(true);
                post({ type: 'MARK_DIRTY' });
              }}
            >
              <option value="">${L('No file', 'بدون ملف')}</option>
              ${detail.files.map((f) => html`<option value=${f.id}>${f.title}</option>`)}
            </select></label
          >
          <details>
            <summary>${L('Version and review history', 'سجل النسخ والمراجعة')}</summary>
            ${detail.versions.map((v) => html`<button class="btn" disabled=${busy || dirty} onClick=${() => setEditor({ id: detail.document.id, kind: detail.document.kind, revision: v.revision, payload: v.payload, readOnly: true, nonce: crypto.randomUUID() })}>${L('View version', 'عرض نسخة')} ${v.revision}</button>`)}${detail.events.map((e) => html`<p>${statusLabel(e.action)} · v${e.revision} ${e.comment || ''}</p>`)}
          </details>
        </div>`
      }
      ${editor && html`<iframe key=${editor.nonce} ref=${frame} class="studio-frame" title=${L('Studio document editor', 'محرر مستندات ستوديو')} src="/magnet-studio/index.html?embedded=1" onLoad=${initialize} />`}
    </section>`;
  };
}
if (typeof window !== 'undefined') window.MagnetStudioWorkspace = { createStudioWorkspace };
