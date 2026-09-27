'use strict';
function createBuilderResources(React, html) {
  const { useState, useEffect } = React;
  return function BuilderResources({
    ctx,
    task,
    detail,
    dirty,
    onResources,
    onTemplate,
    post,
    target,
  }) {
    const L = (en, ar) => (ctx.lang === 'ar' ? ar : en);
    const [source, setSource] = useState('');
    const [data, setData] = useState(null),
      [kit, setKit] = useState(window.MagnetBuilderModel.brand()),
      [busy, setBusy] = useState(false),
      [error, setError] = useState(''),
      [name, setName] = useState(''),
      [shares, setShares] = useState([]),
      [link, setLink] = useState(''),
      [review, setReview] = useState(false),
      [days, setDays] = useState(7),
      [comment, setComment] = useState(''),
      [comments, setComments] = useState([]);
    const doc = detail?.document,
      payload = detail?.versions?.[0]?.payload;
    const rpc = (fn, args) => ctx.rpc(fn, { p_organization_id: ctx.organizationId, ...args });
    const update = (r) => {
      setData(r);
      setKit(r.kit?.brand || window.MagnetBuilderModel.brand());
      onResources({ ...r, taskId: task });
    };
    useEffect(() => {
      let live = true;
      setData(null);
      onResources(null);
      setSource('');
      setError('');
      setLink('');
      setShares([]);
      setComments([]);
      if (task)
        rpc('studio_resources_v3', { p_task_id: task })
          .then((r) => {
            if (live) update(r);
          })
          .catch(() => {
            if (live)
              setError(
                L(
                  'Builder resources unavailable. Existing documents remain accessible.',
                  'موارد المحرر غير متاحة. المستندات الحالية تظل متاحة.',
                ),
              );
          });
      return () => {
        live = false;
      };
    }, [task, ctx.organizationId]);
    useEffect(() => {
      let live = true;
      setLink('');
      setShares([]);
      setComments([]);
      if (doc?.id && payload?.builder === 1) {
        rpc('studio_comments_v3', { p_document_id: doc.id })
          .then((r) => {
            if (live) setComments(r.comments);
          })
          .catch(() => {
            if (live)
              setError(
                L(
                  'Review resources could not be refreshed. Reopen the document to retry.',
                  'تعذر تحديث بيانات المراجعة. أعد فتح المستند للمحاولة.',
                ),
              );
          });
        if (data?.canShare)
          rpc('studio_share_v3', { p_document_id: doc.id, p_action: 'LIST' })
            .then((r) => {
              if (live) setShares(r.shares);
            })
            .catch(() => {
              if (live)
                setError(
                  L(
                    'Review resources could not be refreshed. Reopen the document to retry.',
                    'تعذر تحديث بيانات المراجعة. أعد فتح المستند للمحاولة.',
                  ),
                );
            });
      }
      return () => {
        live = false;
      };
    }, [detail, data?.canShare]);
    const run = async (fn) => {
      setBusy(true);
      setError('');
      try {
        await fn();
      } catch {
        setError(
          L(
            'Not confirmed. Check permissions, connection or version and retry.',
            'لم يتم التأكيد. تحقق من الصلاحيات والاتصال والنسخة ثم أعد المحاولة.',
          ),
        );
      } finally {
        setBusy(false);
      }
    };
    const share = (action, id) =>
      run(async () => {
        const r = await rpc('studio_share_v3', {
          p_document_id: doc.id,
          p_action: action,
          p_share_id: id || null,
          p_review: review,
          p_days: Number(days),
        });
        setShares(r.shares);
        setLink(r.token ? location.origin + '/magnet-studio/share.html#token=' + r.token : '');
      });
    if (!task) return null;
    return html`<div class="studio-builder-resources">
      ${error && html`<p role="alert" class="rec-error">${error}</p>`}${
        data &&
        html`
          <details>
            <summary>
              ${L('Client brand kit & reusable templates', 'هوية العميل والقوالب القابلة لإعادة الاستخدام')}
            </summary>
            <p class="muted">
              ${L('Canonical client identity. Updating it never changes saved document snapshots. Drafts can explicitly refresh below.', 'هوية العميل الأصلية. تعديلها لا يغير نسخ المستندات المحفوظة. يمكن تحديث هوية المسودة صراحةً بالزر أدناه.')}
            </p>
            <div class="studio-controls">
              ${[
                ['primary', 'Primary', 'الأساسي'],
                ['secondary', 'Background', 'الخلفية'],
                ['accent', 'Accent', 'المميز'],
              ].map(
                ([k, en, ar]) =>
                  html`<label
                    >${L(en, ar)}<input
                      type="color"
                      value=${kit[k]}
                      disabled=${busy || !data.canManageBrand}
                      onInput=${(e) => setKit({ ...kit, [k]: e.target.value })}
                  /></label>`,
              )}
              <label
                >${L('Font', 'الخط')}<select
                  class="inp"
                  value=${kit.font}
                  disabled=${busy || !data.canManageBrand}
                  onChange=${(e) => setKit({ ...kit, font: e.target.value })}
                >
                  ${['Manrope', 'Readex Pro', 'Arial', 'Georgia'].map((f) => html`<option value=${f}>${f}</option>`)}
                </select></label
              >
              <label
                >${L('Visual style notes', 'ملاحظات الهوية')}<input
                  class="inp"
                  value=${kit.style || ''}
                  maxlength="1000"
                  disabled=${busy || !data.canManageBrand}
                  onInput=${(e) => setKit({ ...kit, style: e.target.value })}
              /></label>
              <label
                >${L('Logo — linked task image', 'الشعار — صورة مرتبطة بالمهمة')}<select
                  class="inp"
                  value=${kit.logoId || ''}
                  disabled=${busy || !data.canManageBrand}
                  onChange=${(e) => setKit({ ...kit, logoId: e.target.value || null })}
                >
                  <option value="">${L('No logo', 'بدون شعار')}</option>
                  ${(detail?.files || []).filter((f) => f.mimeType?.startsWith('image/')).map((f) => html`<option value=${f.id}>${f.title}</option>`)}
                </select></label
              >
            </div>
            ${data.canManageBrand && html`<button class="btn" disabled=${busy} onClick=${() => run(async () => update(await rpc('studio_brand_v3', { p_task_id: task, p_expected_revision: data.kit?.revision || 0, p_brand: kit })))}>${L('Save client brand kit', 'حفظ هوية العميل')}</button>`}
            ${payload?.builder === 1 && ['DRAFT', 'REVISION'].includes(doc.status) && html`<button class="btn" disabled=${busy} onClick=${() => post({ type: 'BRAND_REFRESH', brand: data.kit?.brand || window.MagnetBuilderModel.brand() })}>${L('Refresh this draft from saved client kit', 'تحديث هذه المسودة من الهوية المحفوظة')}</button>`}
            <h3>${L('Real client data', 'بيانات العميل الفعلية')}</h3>
            <label
              >${L('Available source', 'المصدر المتاح')}<select
                class="inp"
                value=${source}
                onChange=${(e) => setSource(e.target.value)}
              >
                <option value="">${L('Choose source', 'اختر المصدر')}</option>
                ${(data.sources || []).map((s) => html`<option value=${s.id}>${{ proposals: L('Proposal', 'عرض سعر'), reports: L('Report', 'تقرير'), contentCalendar: L('Approved calendar content', 'محتوى تقويم معتمد'), studio_content: L('Approved Studio content', 'محتوى ستوديو معتمد'), briefs: L('Brief', 'بريف'), campaigns: L('Campaign', 'حملة') }[s.type] || s.type} · ${s.title || s.id}</option>`)}
              </select></label
            >
            <button
              class="btn"
              disabled=${busy || !source || !payload?.builder || !['DRAFT', 'REVISION'].includes(doc?.status)}
              onClick=${() => {
                const row = data.sources.find((s) => s.id === source);
                if (
                  row &&
                  window.confirm(
                    L(
                      'Apply this source to matching blocks in this draft?',
                      'تطبيق هذا المصدر على البلوكات المطابقة في المسودة؟',
                    ),
                  )
                )
                  post({ type: 'APPLY_SOURCE', source: row });
              }}
            >
              ${L('Apply source to draft', 'تطبيق المصدر على المسودة')}
            </button>
            ${!data.sources?.length && html`<p class="muted">${L('No readable matching source exists. Enter available evidence; do not invent metrics.', 'لا يوجد مصدر مطابق متاح للصلاحية. أدخل الأدلة المتاحة دون اختلاق مؤشرات.')}</p>`}
            <h3>${L('Reusable client templates', 'قوالب العميل')}</h3>
            ${data.templates.map((t) => html`<button class="btn" disabled=${busy || dirty} onClick=${() => onTemplate(t.payload)}>${t.title}</button>`)}
            ${
              payload?.builder === 1 &&
              html`<label
                  >${L('Template name', 'اسم القالب')}<input
                    class="inp"
                    value=${name}
                    maxlength="120"
                    onInput=${(e) => setName(e.target.value)} /></label
                ><button
                  class="btn"
                  disabled=${busy || dirty || name.trim().length < 2}
                  onClick=${() =>
                    run(async () => {
                      update(
                        await rpc('studio_template_v3', {
                          p_task_id: task,
                          p_title: name.trim(),
                          p_payload: payload,
                        }),
                      );
                      setName('');
                    })}
                >
                  ${L('Save current version as template', 'حفظ النسخة الحالية كقالب')}
                </button>`
            }
          </details>
          ${
            payload?.builder === 1 &&
            html`<details>
              <summary>${L('Document review comments', 'تعليقات مراجعة المستند')}</summary>
              <p class="muted">
                ${target?.pageId ? L('Comment targets the selected page/block.', 'التعليق مرتبط بالصفحة أو البلوك المحدد.') : L('General document comment', 'تعليق عام على المستند')}
              </p>
              <label
                >${L('Comment', 'تعليق')}<textarea
                  class="inp"
                  maxlength="2000"
                  value=${comment}
                  onInput=${(e) => setComment(e.target.value)}
                /></label
              ><button
                class="btn"
                disabled=${busy || dirty || !comment.trim()}
                onClick=${() =>
                  run(async () => {
                    const r = await rpc('studio_comments_v3', {
                      p_document_id: doc.id,
                      p_body: comment.trim(),
                      p_page_id: target?.pageId || null,
                      p_block_id: target?.blockId || null,
                    });
                    setComments(r.comments);
                    setComment('');
                  })}
              >
                ${L('Add comment', 'إضافة تعليق')}</button
              >${comments.map(
                (c) =>
                  html`<article>
                    <strong
                      >${c.external ? L('External reviewer', 'مراجع خارجي') : L('Team', 'الفريق')} ·
                      v${c.revision} · ${c.decision}</strong
                    >
                    <p>${c.body}</p>
                    <small
                      >${c.reviewerName || ''}
                      ${c.pageId ? L('Page-linked', 'مرتبط بصفحة') : ''}</small
                    >
                  </article>`,
              )}
            </details>`
          }
          ${
            payload?.builder === 1 &&
            data.canShare &&
            html`<details>
              <summary>${L('Share saved presentation', 'مشاركة العرض المحفوظ')}</summary>
              <p class="muted">
                ${L('Anyone holding a link can view its exact saved version until expiry or revocation. Internal comments and workspace access are excluded.', 'يمكن لحامل الرابط مشاهدة النسخة المحفوظة حتى الانتهاء أو الإلغاء. لا تُشارك التعليقات الداخلية أو صلاحيات مساحة العمل.')}
              </p>
              <label
                >${L('Expiry (days)', 'الانتهاء (أيام)')}<input
                  class="inp"
                  type="number"
                  min="1"
                  max="90"
                  value=${days}
                  onInput=${(e) => setDays(e.target.value)} /></label
              ><label
                ><input
                  type="checkbox"
                  checked=${review}
                  onChange=${(e) => setReview(e.target.checked)}
                />${L('Explicitly allow external comments / approval / changes', 'السماح صراحةً بالتعليقات والاعتماد وطلب التعديلات الخارجية')}</label
              ><button
                class="btn"
                disabled=${busy || dirty || days < 1 || days > 90}
                onClick=${() => share('CREATE')}
              >
                ${L('Generate secure link', 'إنشاء رابط آمن')}</button
              >${link && html`<label>${L('New link — copy before closing', 'الرابط الجديد — انسخه قبل الإغلاق')}<input class="inp" readonly value=${link} /></label><a href=${link} target="_blank" rel="noreferrer">${L('Open presentation', 'فتح العرض')}</a>`}${shares.map(
                (s) =>
                  html`<article>
                    <p>v${s.revision} · ${s.revokedAt ? L('Revoked', 'ملغى') : s.expiresAt}</p>
                    <small>${L('Last viewed', 'آخر مشاهدة')}: ${s.lastViewedAt || '—'}</small
                    >${!s.revokedAt && html`<button class="btn" disabled=${busy} onClick=${() => share('REVOKE', s.id)}>${L('Revoke', 'إلغاء')}</button><button class="btn" disabled=${busy || dirty} onClick=${() => share('REGENERATE', s.id)}>${L('Revoke & regenerate', 'إلغاء وإعادة إنشاء')}</button>`}
                  </article>`,
              )}
            </details>`
          }
        `
      }
    </div>`;
  };
}
window.MagnetBuilderResources = { createBuilderResources };
