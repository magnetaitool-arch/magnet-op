'use strict';
function createClientOnboarding(React, html) {
  const { useState, useEffect, useRef } = React;
  return function ClientOnboarding({ rpc, organizationId, clientId, lang, onSaved }) {
    const ar = lang === 'ar',
      L = (en, arabic) => (ar ? arabic : en);
    const [data, setData] = useState(null),
      [busy, setBusy] = useState(false),
      [error, setError] = useState('');
    const generation = useRef(0),
      pending = useRef(null);
    const labels = {
      'Contract signed': 'تم توقيع العقد',
      'Brief collected': 'تم استلام البريف',
      'Brand assets received': 'تم استلام أصول العلامة',
      'Kickoff meeting': 'تم اجتماع بدء العمل',
      'Credentials collected': 'تم تأكيد الوصول عبر مدير كلمات المرور',
    };
    const load = async () => {
      const seq = ++generation.current;
      setError('');
      try {
        const out = await rpc('get_client_onboarding_v2', {
          p_organization_id: organizationId,
          p_client_id: clientId,
        });
        if (!out?.ok || !Array.isArray(out.items)) throw Error('unavailable');
        if (seq === generation.current) setData(out);
      } catch {
        if (seq === generation.current)
          setError(
            L(
              'Checklist could not be loaded. Existing data may need review.',
              'تعذّر تحميل القائمة. قد تحتاج البيانات الحالية إلى مراجعة.',
            ),
          );
      }
    };
    useEffect(() => {
      setData(null);
      setBusy(false);
      pending.current = null;
      load();
      return () => {
        generation.current++;
      };
    }, [organizationId, clientId]);
    const toggle = async (index, done) => {
      if (busy || !data?.canManage) return;
      const seq = generation.current,
        key = JSON.stringify([data.version, index, done]);
      if (pending.current?.key !== key)
        pending.current = { key, id: globalThis.crypto.randomUUID() };
      setBusy(true);
      setError('');
      try {
        const out = await rpc('set_client_onboarding_item_v2', {
          p_organization_id: organizationId,
          p_client_id: clientId,
          p_expected_version: data.version,
          p_index: index,
          p_done: done,
          p_command_id: pending.current.id,
        });
        if (!out?.ok) throw Error('unconfirmed');
        if (seq === generation.current) {
          setData(out);
          pending.current = null;
          onSaved?.(out.client);
        }
      } catch {
        if (seq === generation.current)
          setError(
            L(
              'Change not confirmed. Retry unchanged, or reload to review another person’s changes.',
              'لم يتم تأكيد التغيير. أعد المحاولة دون تعديل، أو أعد التحميل لمراجعة تغييرات شخص آخر.',
            ),
          );
      } finally {
        if (seq === generation.current) setBusy(false);
      }
    };
    return html`<section class="client-onboarding" aria-busy=${busy}>
      <h3>${L('Onboarding checklist', 'قائمة الأونبوردنج')}</h3>
      <p class="muted">
        ${L('Confirm completed work. Keep passwords in your password manager.', 'أكد الأعمال المكتملة. احفظ كلمات المرور في مدير كلمات المرور.')}
      </p>
      ${error && html`<p class="rec-error" role="alert">${error}</p>`}${!data && !error && html`<p role="status">${L('Loading checklist…', 'جارٍ تحميل القائمة…')}</p>`}${data && data.items.map((item, index) => html`<label key=${index} class="client-onboarding-item"><input type="checkbox" checked=${item.done} disabled=${busy || !data.canManage} onChange=${(e) => toggle(index, e.target.checked)} /><span>${ar ? labels[item.item] || item.item : item.item === 'Credentials collected' ? 'Access confirmed through password manager' : item.item}</span></label>`)}<button
        class="mini"
        disabled=${busy}
        onClick=${load}
      >
        ${L('Reload checklist', 'إعادة تحميل القائمة')}
      </button>
    </section>`;
  };
}
if (typeof window !== 'undefined') window.MagnetClientOnboarding = { createClientOnboarding };
if (typeof module !== 'undefined') module.exports = { createClientOnboarding };
