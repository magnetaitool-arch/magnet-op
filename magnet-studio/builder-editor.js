(function (root) {
  'use strict';
  const M = root.MagnetBuilderModel,
    R = root.MagnetBuilderRender,
    esc = (s) =>
      String(s ?? '').replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
      );
  let doc,
    pageId,
    blockId,
    locked = false,
    dirty = false,
    saving = false,
    timer,
    send,
    uiLang = 'en',
    generation = 0,
    assets = {},
    assetTimes = {},
    assetRequests = new Map(),
    files = [],
    error = '',
    drag = null;
  const L = (en, ar) => (uiLang === 'ar' ? ar : en),
    host = () => document.getElementById('app'),
    page = () => doc.pages.find((p) => p.id === pageId) || doc.pages[0],
    block = () => page().blocks.find((b) => b.id === blockId);
  function status(value) {
    const e = host().querySelector('[data-status]');
    if (e) e.textContent = value;
  }
  function ensureAsset(id) {
    if (!id) return Promise.resolve();
    if (assets[id] && Date.now() - assetTimes[id] < 240000) return Promise.resolve();
    if (assetRequests.has(id)) return assetRequests.get(id).promise;
    let resolve, reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const timeout = setTimeout(() => {
      assetRequests.delete(id);
      reject(Error(L('Image access timed out. Retry export.', 'تعذر تحميل الصورة. أعد التصدير.')));
    }, 15000);
    assetRequests.set(id, { promise, resolve, reject, timeout });
    send('ASSET_REQUEST', { id });
    return promise;
  }
  function mark() {
    if (locked) return;
    for (const p of doc.pages)
      for (const b of p.blocks)
        if (b.mediaId && !assets[b.mediaId]) ensureAsset(b.mediaId).catch(() => {});
    dirty = true;
    send('DIRTY');
    status(L('Unsaved changes', 'تعديلات غير محفوظة'));
    clearTimeout(timer);
    timer = setTimeout(save, 1800);
    paint();
  }
  function save() {
    clearTimeout(timer);
    if (locked || !dirty || saving) return;
    try {
      M.validate(doc);
      error = '';
      saving = true;
      status(L('Saving…', 'جارٍ الحفظ…'));
      send('SAVE', M.clone(doc));
    } catch (e) {
      error = e.message;
      status(L('Save failed — ', 'تعذر الحفظ — ') + error);
    }
  }
  function button(label, action, extra = '', disabled = false) {
    return `<button type="button" data-do="${action}" ${extra} ${disabled ? 'disabled' : ''}>${esc(label)}</button>`;
  }
  function controls(type, id, index, total) {
    return `<div class="builder-actions">${button(L('↑ Up', '↑ أعلى'), type + '-up', `data-id="${id}"`, locked || index === 0)}${button(L('↓ Down', '↓ أسفل'), type + '-down', `data-id="${id}"`, locked || index === total - 1)}${button(L('Duplicate', 'تكرار'), type + '-copy', `data-id="${id}"`, locked)}${button(L('Delete', 'حذف'), type + '-delete', `data-id="${id}"`, locked || (type === 'page' && total === 1))}</div>`;
  }
  function field(label, key, value, type = 'text', scope = 'block') {
    return `<label>${esc(label)}<${type === 'textarea' ? 'textarea' : 'input'} data-scope="${scope}" data-field="${key}" ${type === 'textarea' ? '' : `type="${type}" value="${esc(value)}"`} ${locked ? 'disabled' : ''}>${type === 'textarea' ? esc(value) + '</textarea>' : ''}</label>`;
  }
  function select(label, key, value, options, scope = 'block') {
    return `<label>${esc(label)}<select data-scope="${scope}" data-field="${key}" ${locked ? 'disabled' : ''}>${options.map(([v, t]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
  }
  function render() {
    const p = page(),
      b = block(),
      label = (t) => M.labels[t][uiLang === 'ar' ? 1 : 0];
    host().innerHTML = `<div class="builder" dir="${uiLang === 'ar' ? 'rtl' : 'ltr'}"><header class="builder-toolbar"><strong>MAGNET / STUDIO</strong><input aria-label="${L('Document title', 'عنوان المستند')}" data-scope="document" data-field="title" value="${esc(doc.title)}" ${locked ? 'disabled' : ''}>${button(L('Save version', 'حفظ نسخة'), 'save', 'class="primary"', locked)}<span data-status role="status" class="builder-status">${locked ? L('Read-only version', 'نسخة للقراءة فقط') : dirty ? L('Unsaved changes', 'تعديلات غير محفوظة') : L('Saved', 'محفوظ')}</span>${button('PDF', 'pdf')}${button('PNG', 'png')}${button('PPTX', 'pptx')}</header><p class="builder-hint builder-mobile-note">${L('Mobile review. Use desktop for page and block authoring. Review, comments and versions are above the document.', 'وضع المراجعة على الهاتف. استخدم الكمبيوتر لتحرير الصفحات والبلوكات. المراجعة والتعليقات والنسخ أعلى المستند.')}</p><div class="builder-shell"><nav class="builder-pages" aria-label="${L('Pages', 'الصفحات')}">${doc.pages.map((p, i) => `<div class="builder-page" draggable="${!locked}" data-page-id="${p.id}" aria-current="${p.id === pageId}">${button(i + 1 + '. ' + p.title, 'page', `data-id="${p.id}"`)}${controls('page', p.id, i, doc.pages.length)}</div>`).join('')}<div class="builder-authoring">${button(L('+ Page', '+ صفحة'), 'page-add', '', locked)}</div></nav><main class="builder-canvas"><div data-canvas role="img" aria-label="${esc(p.title)}"></div><div data-export-errors role="status" class="builder-error" hidden></div><section class="builder-page-text" aria-label="${L('Readable page content', 'محتوى الصفحة المقروء')}">${p.blocks
      .filter((b) => b.type !== 'spacer')
      .map(
        (b) =>
          `<h4>${esc(b.title)}</h4>${b.text ? `<p>${esc(b.text)}</p>` : ''}${b.rows.map((row) => `<p>${row.map(esc).join(' · ')}</p>`).join('')}`,
      )
      .join(
        '',
      )}</section><div class="builder-blocks"><h3>${L('Page blocks', 'بلوكات الصفحة')}</h3>${p.blocks.map((b, i) => `<div class="builder-block ${b.id === blockId ? 'selected' : ''}" draggable="${!locked}" data-block-id="${b.id}">${button(label(b.type) + ' · ' + b.title, 'block', `data-id="${b.id}"`)}${controls('block', b.id, i, p.blocks.length)}</div>`).join('')}<label>${L('Add block', 'إضافة بلوك')}<select data-new-block>${M.types.map((t) => `<option value="${t}">${esc(label(t))}</option>`).join('')}</select></label>${button(L('Add selected block', 'أضف البلوك المحدد'), 'block-add', '', locked)}</div></main><aside class="builder-properties"><h3>${L('Document', 'المستند')}</h3>${select(
      L('Content language', 'لغة المحتوى'),
      'language',
      doc.language,
      [
        ['en', 'English'],
        ['ar', 'العربية'],
      ],
      'document',
    )}${select(
      L('Page size', 'حجم الصفحة'),
      'pageSize',
      doc.pageSize,
      [
        ['landscape', L('Presentation 16:9', 'عرض 16:9')],
        ['portrait', L('A4 portrait', 'A4 رأسي')],
      ],
      'document',
    )}${field(L('Page title', 'عنوان الصفحة'), 'title', p.title, 'text', 'page')}<h3>${L('Document brand snapshot', 'نسخة هوية المستند')}</h3><p class="builder-hint">${L('These overrides affect this document version only.', 'هذه التعديلات تخص نسخة المستند فقط.')}</p>${['primary', 'secondary', 'accent'].map((k) => field({ primary: L('Primary', 'أساسي'), secondary: L('Background', 'خلفية'), accent: L('Accent', 'مميز') }[k], k, doc.brand[k], 'color', 'brand')).join('')}${select(
      L('Font', 'الخط'),
      'font',
      doc.brand.font,
      ['Manrope', 'Readex Pro', 'Arial', 'Georgia'].map((x) => [x, x]),
      'brand',
    )}${
      b
        ? `<h3>${label(b.type)}</h3>${field(L('Heading', 'العنوان'), 'title', b.title)}${field(L('Text', 'النص'), 'text', b.text, 'textarea')}${field(L('Height (px)', 'الارتفاع (بكسل)'), 'height', b.height, 'number')}${select(
            L('Alignment', 'المحاذاة'),
            'alignment',
            b.alignment,
            [
              ['left', L('Left', 'يسار')],
              ['center', L('Center', 'وسط')],
              ['right', L('Right', 'يمين')],
            ],
          )}${select(L('Variant', 'التنسيق'), 'variant', b.variant, [
            ['standard', L('Standard', 'عادي')],
            ['accent', L('Accent', 'مميز')],
            ['minimal', L('Minimal', 'بسيط')],
          ])}${['image', 'logo'].includes(b.type) ? select(L('Task image', 'صورة المهمة'), 'mediaId', b.mediaId || '', [['', L('Choose image', 'اختر صورة')], ...files.filter((f) => /image\//.test(f.mimeType || '')).map((f) => [f.id, f.title])]) : `<h3>${L('Structured rows', 'صفوف البيانات')}</h3>${b.rows.map((r, i) => `<div class="builder-row">${r.map((v, j) => `<input aria-label="${L('Row', 'صف')} ${i + 1}, ${L('column', 'عمود')} ${j + 1}" data-row="${i}" data-col="${j}" value="${esc(v)}" ${locked ? 'disabled' : ''}>`).join('')}${button('×', 'row-delete', `data-index="${i}" aria-label="${L('Delete row', 'حذف الصف')}"`, locked)}</div>`).join('')}${button(L('+ Row', '+ صف'), 'row-add', '', locked)}${button(L('+ Column', '+ عمود'), 'column-add', '', locked)}<p class="builder-hint">${L('Chart: label and numeric value. Leave unknown metrics empty.', 'الرسم البياني: اسم وقيمة رقمية. اترك المؤشرات غير المتاحة فارغة.')}</p>`}`
        : `<p class="builder-hint">${L('Select a block to edit its properties.', 'اختر بلوكًا لتحرير خصائصه.')}</p>`
    }</aside></div></div>`;
    host()
      .querySelectorAll('[data-do]')
      .forEach((e) => (e.onclick = () => action(e.dataset.do, e.dataset)));
    host()
      .querySelectorAll('[data-field]')
      .forEach((e) => {
        const on = () => {
          if (locked) return;
          const target =
            e.dataset.scope === 'document'
              ? doc
              : e.dataset.scope === 'brand'
                ? doc.brand
                : e.dataset.scope === 'page'
                  ? page()
                  : block();
          if (!target) return;
          if (
            e.dataset.scope === 'document' &&
            e.dataset.field === 'language' &&
            target.language !== e.value
          ) {
            const previous = target.language === 'ar' ? 'right' : 'left';
            for (const p of doc.pages)
              for (const b of p.blocks)
                if (b.alignment === previous) b.alignment = e.value === 'ar' ? 'right' : 'left';
          }
          target[e.dataset.field] =
            e.dataset.field === 'height'
              ? Math.min(900, Math.max(30, Number(e.value) || 30))
              : e.value;
          mark();
        };
        if (e.tagName === 'SELECT') e.onchange = on;
        else e.oninput = on;
      });
    host()
      .querySelectorAll('[data-row]')
      .forEach(
        (e) =>
          (e.oninput = () => {
            if (!locked) {
              block().rows[Number(e.dataset.row)][Number(e.dataset.col)] = e.value;
              mark();
            }
          }),
      );
    host()
      .querySelectorAll('[draggable]')
      .forEach((e) => {
        e.ondragstart = (event) => {
          if (locked) {
            event.preventDefault();
            return;
          }
          drag = {
            type: e.dataset.pageId ? 'page' : 'block',
            id: e.dataset.pageId || e.dataset.blockId,
          };
          event.dataTransfer.setData('text/plain', drag.id);
          event.dataTransfer.effectAllowed = 'move';
        };
        e.ondragover = (event) => {
          if (drag && drag.type === (e.dataset.pageId ? 'page' : 'block')) event.preventDefault();
        };
        e.ondrop = (event) => {
          event.preventDefault();
          if (locked || !drag) return;
          const type = e.dataset.pageId ? 'page' : 'block';
          if (type !== drag.type) return;
          const items = type === 'page' ? doc.pages : page().blocks,
            toId = e.dataset.pageId || e.dataset.blockId,
            moved = M.move(
              items,
              items.findIndex((x) => x.id === drag.id),
              items.findIndex((x) => x.id === toId),
            );
          if (type === 'page') doc.pages = moved;
          else page().blocks = moved;
          drag = null;
          mark();
          render();
        };
      });
    paint();
  }
  async function paint() {
    const gen = ++generation;
    try {
      const out = await R.render(doc, page(), { assets });
      if (gen !== generation) return;
      const target = host().querySelector('[data-canvas]');
      if (!target) return;
      target.replaceChildren(out.canvas);
      const e = host().querySelector('[data-export-errors]');
      e.hidden = !out.errors.length;
      e.textContent = out.errors.join(' · ');
    } catch (e) {
      status(e.message);
    }
  }
  function action(a, data = {}) {
    if (a === 'page') {
      pageId = data.id;
      blockId = null;
      send('SELECTION', { pageId, blockId });
      render();
      return;
    }
    if (a === 'block') {
      blockId = data.id;
      send('SELECTION', { pageId, blockId });
      render();
      return;
    }
    if (['pdf', 'png', 'pptx'].includes(a)) {
      exportFile(a);
      return;
    }
    if (locked) return;
    if (a === 'save') {
      save();
      return;
    }
    if (a === 'page-add') {
      if (doc.pages.length >= 60) return;
      const p = { id: M.id(), title: L('New page', 'صفحة جديدة'), blocks: [] };
      doc.pages.push(p);
      pageId = p.id;
      blockId = null;
    } else if (a === 'block-add') {
      if (page().blocks.length >= 30) return;
      const b = M.block(host().querySelector('[data-new-block]').value, doc.language);
      page().blocks.push(b);
      blockId = b.id;
    } else if (a === 'row-add') {
      const b = block();
      if (b.rows.length < 50) b.rows.push(Array(b.rows[0]?.length || 2).fill(''));
    } else if (a === 'column-add') {
      const b = block();
      if (!b.rows.length) b.rows = [['', '']];
      else if (b.rows[0].length < 6) b.rows.forEach((r) => r.push(''));
    } else if (a === 'row-delete') block().rows.splice(Number(data.index), 1);
    else {
      const [type, op] = a.split('-'),
        items = type === 'page' ? doc.pages : page().blocks,
        i = items.findIndex((x) => x.id === data.id);
      if (i < 0) return;
      if (op === 'delete') {
        if (type === 'page' && items.length === 1) return;
        if (
          !confirm(
            L(
              'Delete this item from the draft? Previous saved versions remain.',
              'حذف العنصر من المسودة؟ النسخ المحفوظة السابقة تبقى متاحة.',
            ),
          )
        )
          return;
        items.splice(i, 1);
        if (type === 'page') {
          pageId = doc.pages[Math.min(i, doc.pages.length - 1)].id;
          blockId = null;
        } else blockId = null;
      }
      if (op === 'copy') {
        if (items.length >= (type === 'page' ? 60 : 30)) return;
        items.splice(i + 1, 0, M.duplicate(items[i]));
      }
      if (op === 'up' || op === 'down') {
        const moved = M.move(items, i, i + (op === 'up' ? -1 : 1));
        if (type === 'page') doc.pages = moved;
        else page().blocks = moved;
      }
    }
    mark();
    render();
  }
  const load = (src) =>
    new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(Error('Export library unavailable'));
      document.head.append(s);
    });
  function download(blob, name) {
    const url = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  async function exportFile(format) {
    if (dirty || saving) {
      status(L('Save the current version before exporting.', 'احفظ النسخة الحالية قبل التصدير.'));
      return;
    }
    try {
      status(L('Preparing export…', 'جارٍ إعداد التصدير…'));
      M.validate(doc);
      // Render one page at a time: a 60-page export must not retain 60 high-resolution canvases.
      const snapshot = M.clone(doc),
        pages = format === 'png' ? [M.clone(page())] : snapshot.pages,
        name = snapshot.title.replace(/[\\/:*?"<>|]/g, '-').slice(0, 100),
        [w, h] = R.size(snapshot);
      let pdf, pptx;
      if (format === 'pdf') {
        if (!root.jspdf) await load('/magnet-studio/vendor/jspdf.umd.min.js');
        pdf = new root.jspdf.jsPDF({
          orientation: w > h ? 'landscape' : 'portrait',
          unit: 'px',
          format: [w, h],
          hotfixes: ['px_scaling'],
          compress: true,
        });
      }
      if (format === 'pptx') {
        if (!root.PptxGenJS) await load('/magnet-studio/vendor/pptxgen.bundle.js');
        pptx = new root.PptxGenJS();
        pptx.defineLayout({ name: 'MAGNET', width: w / 96, height: h / 96 });
        pptx.layout = 'MAGNET';
        pptx.author = 'Magnet';
        pptx.subject = snapshot.title;
      }
      for (let i = 0; i < pages.length; i++) {
        await Promise.all(
          pages[i].blocks.filter((b) => b.mediaId).map((b) => ensureAsset(b.mediaId)),
        );
        const out = await R.render(snapshot, pages[i], { scale: 2, assets });
        if (out.errors.length) throw Error(pages[i].title + ': ' + out.errors.join(' · '));
        if (pdf) {
          if (i) pdf.addPage([w, h], w > h ? 'landscape' : 'portrait');
          pdf.addImage(out.canvas.toDataURL('image/png'), 'PNG', 0, 0, w, h, undefined, 'FAST');
        } else if (pptx) {
          pptx.addSlide().addImage({
            data: out.canvas.toDataURL('image/png'),
            x: 0,
            y: 0,
            w: w / 96,
            h: h / 96,
          });
        } else {
          const blob = await new Promise((resolve) => out.canvas.toBlob(resolve, 'image/png'));
          if (!blob) throw Error('PNG export failed');
          download(
            blob,
            name + '-' + (snapshot.pages.findIndex((p) => p.id === pages[i].id) + 1) + '.png',
          );
        }
        out.canvas.width = out.canvas.height = 1;
      }
      if (pdf) pdf.save(name + '.pdf');
      if (pptx) await pptx.writeFile({ fileName: name + '.pptx' });
      status(L('Export ready', 'التصدير جاهز'));
    } catch (e) {
      status(L('Export failed: ', 'تعذر التصدير: ') + e.message);
    }
  }
  root.MagnetBuilderEditor = {
    active: false,
    open(m, callback) {
      this.active = true;
      send = callback;
      uiLang = m.lang === 'ar' ? 'ar' : 'en';
      doc = m.payload
        ? M.clone(m.payload)
        : M.create(
            m.templateKey || 'proposal',
            {
              client: m.clientName || '',
              project: m.projectName || '',
              campaign: m.campaignName || '',
              brand: m.brand,
            },
            uiLang,
          );
      M.validate(doc);
      pageId = doc.pages[0].id;
      blockId = null;
      locked = !!m.readOnly;
      dirty = !m.payload || !!m.isNew;
      saving = false;
      assets = {};
      assetTimes = {};
      for (const request of assetRequests.values()) {
        clearTimeout(request.timeout);
        request.reject(Error('Document changed'));
      }
      assetRequests = new Map();
      files = m.files || [];
      render();
      for (const p of doc.pages)
        for (const b of p.blocks) if (b.mediaId) ensureAsset(b.mediaId).catch(() => {});
      if (dirty) send('DIRTY');
    },
    handle(m) {
      if (!this.active) return false;
      if (m.type === 'LANG') {
        uiLang = m.lang === 'ar' ? 'ar' : 'en';
        render();
      }
      if (m.type === 'LOCK' && locked !== m.readOnly) {
        locked = m.readOnly;
        render();
      }
      if (m.type === 'ASSET_URL') {
        assets[m.id] = m.url;
        assetTimes[m.id] = Date.now();
        const request = assetRequests.get(m.id);
        if (request) {
          clearTimeout(request.timeout);
          request.resolve();
          assetRequests.delete(m.id);
        }
        paint();
      }
      if (m.type === 'ASSET_ERROR') {
        const request = assetRequests.get(m.id);
        if (request) {
          clearTimeout(request.timeout);
          request.reject(Error('Image access denied'));
          assetRequests.delete(m.id);
        }
        status(L('Image access failed', 'تعذر الوصول إلى الصورة'));
      }
      if (m.type === 'APPLY_SOURCE' && !locked) {
        const source = m.source;
        for (const p of doc.pages)
          for (const b of p.blocks) {
            if (b.type === 'paragraph' && source.summary) b.text = source.summary;
            if (b.type === 'recommendation' && source.recommendations)
              b.text = source.recommendations;
            if (b.type === 'action_plan' && source.nextPlan) b.text = source.nextPlan;
            if (b.type === 'metric_group' && source.metrics) b.text = source.metrics;
            if (b.type === 'services' && source.service) b.text = source.service;
            if (b.type === 'pricing' && source.price !== null && source.price !== undefined)
              b.rows = [
                [source.service || source.title || '', String(source.price), source.currency || ''],
              ];
            if (b.type === 'timeline' && source.timeline) b.text = source.timeline;
            if (b.type === 'social_content' && source.summary) b.text = source.summary;
          }
        doc.binding = { ...doc.binding, sourceId: source.id, sourceType: source.type };
        mark();
        render();
      }
      if (m.type === 'BRAND_REFRESH' && !locked) {
        doc.brand = M.clone(m.brand);
        for (const p of doc.pages)
          for (const b of p.blocks)
            if (b.type === 'cover' || b.type === 'logo') b.mediaId = doc.brand.logoId || null;
        mark();
        render();
      }
      if (m.type === 'MARK_DIRTY') mark();
      if (m.type === 'SAVED') {
        const filesChanged =
          Array.isArray(m.files) && JSON.stringify(files) !== JSON.stringify(m.files);
        if (filesChanged) files = m.files;
        saving = false;
        if (!m.payload || JSON.stringify(m.payload) === JSON.stringify(doc)) {
          dirty = false;
          if (filesChanged) render();
          status(locked ? L('Read-only version', 'نسخة للقراءة فقط') : L('Saved', 'محفوظ'));
        } else {
          clearTimeout(timer);
          timer = setTimeout(save, 1800);
        }
      }
      if (m.type === 'SAVED') {
        for (const p of doc.pages)
          for (const b of p.blocks)
            if (b.mediaId && !assets[b.mediaId]) ensureAsset(b.mediaId).catch(() => {});
      }
      if (m.type === 'SAVE_FAILED') {
        saving = false;
        clearTimeout(timer);
        status(
          L(
            'Save failed. Keep this page open and retry Save version.',
            'تعذر الحفظ. اترك الصفحة مفتوحة وأعد حفظ النسخة.',
          ),
        );
      }
      return true;
    },
    isDirty: () => dirty,
  };
})(window);
