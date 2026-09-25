'use strict';
function createTaskDependencies(React, html) {
  const { useState, useEffect, useRef } = React;
  return function TaskDependencies({ rpc, organizationId, taskId, lang, refreshKey, onChanged }) {
    const ar = lang === 'ar',
      L = (en, arabic) => (ar ? arabic : en);
    const [data, setData] = useState(null),
      [busy, setBusy] = useState(false),
      [error, setError] = useState(''),
      [search, setSearch] = useState(''),
      [selected, setSelected] = useState('');
    const generation = useRef(0),
      inFlight = useRef(false),
      pending = useRef(null);
    const message = (err) => {
      const key = String(err?.message || '');
      if (key.includes('task_dependency_cycle'))
        return L(
          'This would create a dependency cycle. Choose another prerequisite.',
          'هذه العلاقة ستنشئ دائرة اعتماد. اختر متطلبًا آخر.',
        );
      if (key.includes('pause_task_before_dependency_change'))
        return L(
          'Move this task to Blocked before adding a prerequisite.',
          'انقل المهمة إلى حالة محظور قبل إضافة متطلب.',
        );
      return L(
        'Change not confirmed. Retry unchanged or reload to review the latest state.',
        'لم يتم تأكيد التغيير. أعد المحاولة دون تعديل أو أعد التحميل لمراجعة أحدث حالة.',
      );
    };
    const load = async (query = search) => {
      const seq = ++generation.current;
      setBusy(true);
      inFlight.current = true;
      setError('');
      try {
        const out = await rpc('get_task_dependencies_v2', {
          p_organization_id: organizationId,
          p_task_id: taskId,
          p_search: query || null,
        });
        if (!out?.ok) throw Error('unavailable');
        if (seq === generation.current) {
          setData(out);
          setSelected('');
        }
      } catch {
        if (seq === generation.current)
          setError(
            L(
              'Prerequisites could not be loaded. Retry when your connection or access is restored.',
              'تعذّر تحميل المتطلبات. أعد المحاولة بعد استعادة الاتصال أو الصلاحية.',
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
      setSearch('');
      pending.current = null;
      load('');
      return () => {
        generation.current++;
      };
    }, [organizationId, taskId, refreshKey]);
    const mutate = async (id, action) => {
      if (inFlight.current || !id || !data?.canManage) return;
      const seq = generation.current,
        key = JSON.stringify([taskId, id, action]);
      if (pending.current?.key !== key)
        pending.current = { key, id: globalThis.crypto.randomUUID() };
      setBusy(true);
      inFlight.current = true;
      setError('');
      try {
        const out = await rpc('set_task_dependency_v2', {
          p_organization_id: organizationId,
          p_task_id: taskId,
          p_depends_on_task_id: id,
          p_action: action,
          p_command_id: pending.current.id,
        });
        if (!out?.ok) throw Error('unconfirmed');
        if (seq === generation.current) {
          setData(out);
          setSelected('');
          setSearch('');
          pending.current = null;
          onChanged?.();
        }
      } catch (err) {
        if (seq === generation.current) setError(message(err));
      } finally {
        if (seq === generation.current) {
          setBusy(false);
          inFlight.current = false;
        }
      }
    };
    return html`<section class="task-detail-card task-dependencies" aria-busy=${busy}>
      <h4>${L('Prerequisites', 'المتطلبات السابقة')}</h4>
      <p class="muted">
        ${L('Finish these tasks before starting this work. Only tasks from the same project can be linked.', 'أكمل هذه المهام قبل بدء هذا العمل. يمكن ربط مهام من نفس المشروع فقط.')}
      </p>
      ${error && html`<p class="task-error" role="alert">${error}</p>`}
      ${busy && html`<p role="status">${L('Loading or saving…', 'جارٍ التحميل أو الحفظ…')}</p>`}
      ${
        data &&
        html`<div>
          ${
            data.items.length
              ? html`<p role="status">
                    ${data.blockedCount ? L(`${data.blockedCount} prerequisite(s) still need completion.`, `${data.blockedCount} متطلبات لم تُستكمل بعد.`) : L('All prerequisites are complete.', 'اكتملت جميع المتطلبات السابقة.')}
                  </p>
                  <ul class="task-dependency-list">
                    ${data.items.map(
                      (item) =>
                        html`<li key=${item.id}>
                          <div>
                            <b
                              >${item.title || L('Restricted prerequisite', 'متطلب محدود الصلاحية')}</b
                            ><span
                              >${item.unavailable ? L('Unavailable — ask a manager to review the link', 'غير متاح — اطلب من المدير مراجعة الربط') : item.done ? L('Complete', 'مكتمل') : L('Not complete', 'غير مكتمل')}</span
                            >
                          </div>
                          ${data.canManage && html`<button class="mini" disabled=${busy} aria-label=${L('Remove prerequisite: ', 'إزالة المتطلب: ') + (item.title || L('Restricted prerequisite', 'متطلب محدود الصلاحية'))} onClick=${() => mutate(item.id, 'REMOVE')}>${L('Remove', 'إزالة')}</button>`}
                        </li>`,
                    )}
                  </ul>`
              : html`<p>${L('No prerequisites linked.', 'لا توجد متطلبات مرتبطة.')}</p>`
          }
          ${
            data.canManage &&
            (data.canAdd
              ? html`<div class="task-dependency-controls">
                  <label
                    ><span>${L('Find a task in this project', 'ابحث عن مهمة في هذا المشروع')}</span
                    ><input
                      class="sel"
                      value=${search}
                      disabled=${busy}
                      maxlength="100"
                      onInput=${(e) => setSearch(e.target.value)}
                      onKeyDown=${(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          load();
                        }
                      }} /></label
                  ><button class="mini" disabled=${busy} onClick=${() => load()}>
                    ${L('Search', 'بحث')}
                  </button>
                  <label
                    ><span>${L('Prerequisite task', 'المهمة المطلوبة أولًا')}</span
                    ><select
                      class="sel"
                      value=${selected}
                      disabled=${busy}
                      onChange=${(e) => setSelected(e.target.value)}
                    >
                      <option value="">${L('Choose a task', 'اختر مهمة')}</option>
                      ${data.candidates.map((item) => html`<option key=${item.id} value=${item.id}>${item.title}</option>`)}
                    </select></label
                  ><button
                    class="mini pri"
                    disabled=${busy || !selected}
                    onClick=${() => mutate(selected, 'ADD')}
                  >
                    ${L('Add prerequisite', 'إضافة متطلب')}
                  </button>
                  ${!data.candidates.length && html`<p class="muted">${L('No matching tasks. Create the prerequisite in this project first, or change your search.', 'لا توجد مهام مطابقة. أنشئ المهمة المطلوبة في المشروع أولًا أو غيّر البحث.')}</p>`}
                </div>`
              : html`<p class="muted">
                  ${L('New prerequisites can be added in Backlog, To Do or Blocked.', 'يمكن إضافة متطلبات عندما تكون المهمة في قائمة الانتظار أو للتنفيذ أو محظورة.')}
                </p>`)
          }
        </div>`
      }
      <button class="mini" disabled=${busy} onClick=${() => load()}>
        ${L('Reload prerequisites', 'إعادة تحميل المتطلبات')}
      </button>
    </section>`;
  };
}
if (typeof window !== 'undefined') window.MagnetTaskDependencies = { createTaskDependencies };
if (typeof module !== 'undefined') module.exports = { createTaskDependencies };
