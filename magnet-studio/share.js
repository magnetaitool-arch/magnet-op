'use strict';
(function () {
  const token = new URLSearchParams(location.hash.slice(1)).get('token'),
    host = document.getElementById('shared'),
    cfg = window.__MAGNET_RUNTIME_CONFIG__;
  let view,
    index = 0,
    generation = 0;
  const e = (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const L = (a, b) => (view?.payload.language === 'ar' ? b : a);
  async function rpc(args = {}) {
    if (!cfg || !/^[a-f0-9]{64}$/.test(token || '')) throw Error();
    const r = await fetch(cfg.url + '/rest/v1/rpc/studio_shared_v3', {
      method: 'POST',
      headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_token: token, ...args }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw Error();
    return r.json();
  }
  async function show() {
    const gen = ++generation;
    host.querySelectorAll('button').forEach((b) => {
      b.disabled = true;
    });
    try {
      view = await rpc();
      if (gen !== generation) return;
      const d = view.payload;
      window.MagnetBuilderModel.validate(d);
      document.documentElement.lang = d.language;
      document.documentElement.dir = d.language === 'ar' ? 'rtl' : 'ltr';
      index = Math.max(0, Math.min(index, d.pages.length - 1));
      host.innerHTML = `<header class="builder-toolbar"><strong>MAGNET / ${e(d.title)}</strong><span>v${view.revision}</span><button data-prev ${index === 0 ? 'disabled' : ''}>${L('Previous', 'السابق')}</button><span>${index + 1} / ${d.pages.length}</span><button data-next ${index === d.pages.length - 1 ? 'disabled' : ''}>${L('Next', 'التالي')}</button></header><div data-canvas class="builder-canvas" role="img" aria-label="${e(d.pages[index].title)}"></div><section class="builder-sr-only" aria-label="${e(d.pages[index].title)}">${d.pages[index].blocks.map((b) => `<h2>${e(b.title)}</h2><p>${e(b.text)}</p>${b.rows.map((row) => `<p>${row.map(e).join(' · ')}</p>`).join('')}`).join('')}</section><p data-feedback role="status"></p>${view.allowReview ? `<section><h2>${L('Review this shared version', 'مراجعة هذه النسخة المشتركة')}</h2><p>${L('Your response is recorded against this shared version. It does not replace Magnet’s internal approval.', 'تُسجل استجابتك لهذه النسخة المشتركة ولا تحل محل الاعتماد الداخلي لماجنت.')}</p><label>${L('Your name', 'اسمك')}<input data-name maxlength="120"></label><label>${L('Feedback on this page', 'ملاحظاتك على الصفحة')}<textarea data-body maxlength="2000"></textarea></label><div class="builder-actions"><button data-action="COMMENT">${L('Comment', 'تعليق')}</button><button data-action="APPROVE">${L('Approve shared version', 'اعتماد النسخة المشتركة')}</button><button data-action="CHANGES">${L('Request changes', 'طلب تعديلات')}</button></div></section>` : ''}`;
      host.querySelectorAll('button').forEach((b) => {
        b.disabled = true;
      });
      const assets = {};
      for (const b of d.pages[index].blocks) {
        if (b.mediaId) {
          const r = await fetch('/api/studio-share-asset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, fileId: b.mediaId }),
            signal: AbortSignal.timeout(15000),
          });
          if (!r.ok) throw Error();
          assets[b.mediaId] = (await r.json()).url;
        }
      }
      const out = await window.MagnetBuilderRender.render(d, d.pages[index], { assets });
      if (gen !== generation) return;
      host.querySelector('[data-canvas]').replaceChildren(out.canvas);
      host.querySelector('[data-feedback]').textContent = out.errors.join(' · ');
      host.querySelector('[data-prev]').disabled = index === 0;
      host.querySelector('[data-next]').disabled = index === d.pages.length - 1;
      host.querySelectorAll('[data-action]').forEach((b) => {
        b.disabled = false;
      });
      host.querySelector('[data-prev]').onclick = () => {
        index--;
        show();
      };
      host.querySelector('[data-next]').onclick = () => {
        index++;
        show();
      };
      host.querySelectorAll('[data-action]').forEach(
        (button) =>
          (button.onclick = async () => {
            const buttons = host.querySelectorAll('[data-action]');
            buttons.forEach((b) => (b.disabled = true));
            try {
              await rpc({
                p_action: button.dataset.action,
                p_body: host.querySelector('[data-body]').value.trim(),
                p_name: host.querySelector('[data-name]').value.trim(),
                p_page_id: d.pages[index].id,
              });
              host.querySelector('[data-feedback]').textContent = L(
                'Response saved.',
                'تم حفظ الاستجابة.',
              );
              host.querySelector('[data-body]').value = '';
            } catch {
              host.querySelector('[data-feedback]').textContent = L(
                'Not saved. Enter your name and feedback, or check whether this link has expired.',
                'لم يتم الحفظ. أدخل اسمك وملاحظاتك أو تحقق من انتهاء الرابط.',
              );
            } finally {
              buttons.forEach((b) => (b.disabled = false));
            }
          }),
      );
    } catch {
      host.innerHTML =
        '<h1>Presentation unavailable / العرض غير متاح</h1><p>This link may have expired or been revoked. / قد يكون الرابط منتهيًا أو ملغى.</p>';
    }
  }
  window.addEventListener('hashchange', () => {
    host.replaceChildren();
    location.reload();
  });
  show();
})();
