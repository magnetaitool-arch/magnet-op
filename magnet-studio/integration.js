// The existing Magnet OS parent owns auth and RPCs. Never copy tokens into this frame.
if (window.parent !== window && new URLSearchParams(location.search).has('embedded')) {
  const handshake = crypto.randomUUID();
  let readOnly = false,
    lang = 'en',
    dirty = false,
    creativeKind = '',
    contextBrief = '',
    rendering = false;
  document.querySelectorAll('[data-platform]').forEach((el) => {
    const click = el.onclick;
    el.onclick = (event) => {
      click(event);
      persistWorking();
    };
  });
  const L = (en, ar) => (lang === 'ar' ? ar : en);
  const send = (type, payload) =>
    parent.postMessage({ channel: 'magnet-studio', type, payload }, location.origin);
  const dictionary = {
    'Answer what you know. Detailed answers create a stronger strategic brief':
      'أجب عما تعرفه. الإجابات المفصلة تساعد على إعداد بريف استراتيجي أقوى',
    'Select every platform included': 'اختر جميع المنصات المشمولة',
    'Current period': 'الفترة الحالية',
    'Previous period — for growth comparison': 'الفترة السابقة — لمقارنة النمو',
    'Content published': 'المحتوى المنشور',
    '3-page PDF · Insights excluded': 'PDF من ٣ صفحات · بدون التحليلات',
    '4-page PDF · Insights included': 'PDF من ٤ صفحات · يتضمن التحليلات',
    'Review the live document, save the draft, then use Export PDF.':
      'راجع المعاينة واحفظ المسودة، ثم استخدم تصدير PDF.',
    'BRIEFS & REPORTS': 'البريفات والتقارير',
    'Save draft': 'حفظ نسخة',
    'Export PDF': 'تصدير PDF',
    SECTIONS: 'الأقسام',
    Back: 'السابق',
    Continue: 'التالي',
    Setup: 'الإعداد',
    Platforms: 'المنصات',
    Performance: 'الأداء',
    'Content Output': 'المحتوى المنشور',
    Insights: 'التحليلات',
    Preview: 'المعاينة',
    Business: 'النشاط',
    Project: 'المشروع',
    Audience: 'الجمهور',
    Brand: 'العلامة التجارية',
    Scope: 'نطاق العمل',
    Strategy: 'الاستراتيجية',
    Assets: 'الأصول',
    'LIVE CLIENT PREVIEW': 'معاينة مستند العميل',
    'A4 · ENGLISH': 'A4 · المستند بالإنجليزية',
    'Local draft': 'نسخة غير محفوظة',
    'Company / brand name': 'اسم الشركة / العلامة',
    Industry: 'المجال',
    'Website & social links': 'الموقع وروابط التواصل',
    'Main contact': 'جهة الاتصال',
    'Business overview': 'عن النشاط',
    'Products or services': 'المنتجات أو الخدمات',
    'Project type': 'نوع المشروع',
    'Project background': 'خلفية المشروع',
    'Main challenge': 'التحدي الرئيسي',
    'Primary objective': 'الهدف الرئيسي',
    'Success definition': 'معيار النجاح',
    Deadline: 'الموعد النهائي',
    'Primary audience': 'الجمهور المستهدف',
    Locations: 'المناطق',
    'Age range': 'الفئة العمرية',
    'Interests & behaviors': 'الاهتمامات والسلوكيات',
    'Customer pain points': 'تحديات العميل',
    'Brand personality': 'شخصية العلامة',
    'Tone of voice': 'نبرة التواصل',
    'Key message': 'الرسالة الرئيسية',
    Competitors: 'المنافسون',
    'Brands you admire': 'علامات ملهمة',
    'Things to avoid': 'ما يجب تجنبه',
    'Required services': 'الخدمات المطلوبة',
    'Number of designs': 'عدد التصاميم',
    'Number of videos': 'عدد الفيديوهات',
    'Campaign deliverables': 'مخرجات الحملة',
    Languages: 'اللغات',
    'Campaign idea': 'فكرة الحملة',
    Offer: 'العرض',
    'Call to action': 'الدعوة للتفاعل',
    KPIs: 'مؤشرات الأداء',
    'Budget range': 'نطاق الميزانية',
    'Approval process': 'عملية الاعتماد',
    'Logo / brand kit link': 'رابط الشعار وهوية العلامة',
    'Photos / videos link': 'رابط الصور والفيديوهات',
    'Previous work link': 'رابط الأعمال السابقة',
    'Access notes — never enter passwords': 'ملاحظات الوصول — لا تدخل كلمات مرور',
    'Additional notes': 'ملاحظات إضافية',
    'Client / brand name': 'اسم العميل / العلامة',
    'Report setup': 'إعداد التقرير',
    'Reporting month': 'شهر التقرير',
    'Main objective for this period': 'الهدف الرئيسي لهذه الفترة',
    'Designs / posts': 'التصاميم / المنشورات',
    Engagements: 'التفاعلات',
    'Leads / conversions': 'العملاء المحتملون / التحويلات',
    'Link clicks': 'نقرات الروابط',
    'Previous engagements': 'التفاعلات السابقة',
    'Previous followers': 'المتابعون السابقون',
    'Previous impressions': 'مرات الظهور السابقة',
    'Previous reach': 'الوصول السابق',
    'Top-performing content': 'المحتوى الأعلى أداءً',
    'Videos / reels': 'الفيديوهات / الريلز',
    'Work completed': 'الأعمال المنفذة',
    'Client name': 'اسم العميل',
    'Report title': 'عنوان التقرير',
    'Reporting period': 'فترة التقرير',
    'Campaign objective': 'هدف الحملة',
    Reach: 'الوصول',
    Impressions: 'مرات الظهور',
    Engagement: 'التفاعل',
    Followers: 'المتابعون',
    'Profile views': 'زيارات الملف',
    Clicks: 'النقرات',
    Leads: 'العملاء المحتملون',
    'Ad spend': 'الإنفاق الإعلاني',
    Videos: 'الفيديوهات',
    Designs: 'التصاميم',
    Stories: 'القصص',
    'Top content': 'أفضل محتوى',
    Summary: 'الملخص',
    'Key wins': 'أبرز النتائج',
    'Challenges & learnings': 'التحديات والدروس',
    Recommendations: 'التوصيات',
    'Next month plan': 'خطة الشهر القادم',
    'Story behind the numbers': 'القصة وراء الأرقام',
    'Include Insights page in PDF': 'تضمين صفحة التحليلات في PDF',
    'Optional — turn this off to export a shorter report.': 'اختياري — ألغِه لتصدير تقرير أقصر.',
    'Your report is ready': 'التقرير جاهز',
    'Export client PDF': 'تصدير مستند العميل',
    'Create a complete strategic brief that works for any industry.':
      'أنشئ بريفًا استراتيجيًا متكاملًا للمشروع.',
    'Build the story one section at a time. The client document updates live.':
      'أكمل الأقسام بالتتابع. تتحدث معاينة المستند أثناء الكتابة.',
  };
  const localize = () => {
    if (lang !== 'ar') return;
    for (const element of document.querySelectorAll('.top,.steps,.editor,.preview-label')) {
      const walk = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walk.nextNode())) {
        if (node.parentElement?.closest('textarea,input,[contenteditable]')) continue;
        const text = node.textContent.trim(),
          match = text.match(/^(\d+\. )(.+)$/);
        if (dictionary[text]) node.textContent = node.textContent.replace(text, dictionary[text]);
        else if (match && dictionary[match[2]]) node.textContent = match[1] + dictionary[match[2]];
      }
    }
    document.querySelectorAll('.paper').forEach((e) => {
      e.dir = 'ltr';
      e.lang = 'en';
    });
  };
  docs = [];
  working = null;
  persistWorking = function () {
    if (rendering) return;
    dirty = true;
    send('DIRTY');
    const el = $('#saved');
    if (el) el.textContent = L('Unsaved · Save server version', 'غير محفوظ · احفظ نسخة على الخادم');
  };
  save = function () {
    if (!readOnly && state.doc && dirty) {
      if (contextBrief) state.doc.briefId = contextBrief;
      send('SAVE', JSON.parse(JSON.stringify(state.doc)));
      toast(L('Saving to workspace…', 'جارٍ الحفظ في مساحة العمل…'));
    }
  };
  const originalExport = exportPDF;
  exportPDF = function () {
    if (dirty) {
      toast(L('Save the server version before exporting.', 'احفظ النسخة على الخادم قبل التصدير.'));
      return;
    }
    originalExport();
  };
  const originalRender = renderStudio;
  renderStudio = function () {
    rendering = true;
    if (creativeKind) {
      app.innerHTML = `${topbar(true)}<main class="asset-editor"><h1>${esc(L('Creative asset', 'أصل إبداعي'))}</h1>${field(L('Title', 'العنوان'), 'title', 'text', state.doc.title)}${field(L('Content / execution notes', 'المحتوى / ملاحظات التنفيذ'), 'body', 'textarea', state.doc.body)}<p>${esc(L('Attach private files through the linked task. Save the version, then select its task file above.', 'أرفق الملفات الخاصة من المهمة المرتبطة. احفظ النسخة ثم اختر ملف المهمة أعلاه.'))}</p></main>`;
      bind();
      document.querySelector('[data-action="export"]')?.remove();
    } else {
      originalRender();
      const editor = document.querySelector('.editor');
      if (editor && state.doc.kind === 'brief')
        editor.insertAdjacentHTML(
          'afterbegin',
          field(L('Document title', 'عنوان المستند'), 'title', 'text', state.doc.title),
        );
      bind();
    }
    rendering = false;
    document.querySelectorAll('[data-platform]').forEach((el) => {
      const click = el.onclick;
      el.onclick = (event) => {
        click(event);
        persistWorking();
      };
    });
    if (creativeKind)
      document.querySelectorAll('[data-key]').forEach(
        (el) =>
          (el.oninput = () => {
            state.doc[el.dataset.key] = el.value;
            persistWorking();
          }),
      );
    document
      .querySelectorAll('[data-action="home"],[data-action="new-brief"],[data-action="new-report"]')
      .forEach((el) => el.remove());
    if (readOnly)
      document
        .querySelectorAll('[data-key],[data-platform],[data-action="save"]')
        .forEach((el) => (el.disabled = true));
    document.querySelectorAll('[data-key]').forEach((el) => (el.dir = 'auto'));
    localize();
  };
  window.addEventListener('beforeunload', (event) => {
    if (dirty) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  window.addEventListener('message', (event) => {
    if (
      event.origin !== location.origin ||
      event.source !== parent ||
      event.data?.channel !== 'magnet-studio'
    )
      return;
    const m = event.data;
    if (m.type === 'HELLO') send('READY', handshake);
    if (m.type === 'OPEN') {
      readOnly = !!m.readOnly;
      lang = m.lang === 'ar' ? 'ar' : 'en';
      contextBrief = m.briefId || m.payload?.briefId || '';
      creativeKind = ['content', 'design', 'video'].includes(m.kind) ? m.kind : '';
      document.documentElement.lang = lang;
      document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
      state = {
        screen: 'studio',
        step: 0,
        kind: m.kind,
        doc:
          m.payload ||
          (creativeKind
            ? {
                kind: m.kind,
                title: L('Creative asset', 'أصل إبداعي'),
                body: '',
                briefId: contextBrief,
              }
            : blank(m.kind)),
      };
      if (!m.payload && m.clientName) state.doc.client = m.clientName;
      renderStudio();
      dirty = !m.payload;
      if (dirty) send('DIRTY');
      const label = $('#saved');
      if (label)
        label.textContent = readOnly
          ? L('Read-only version', 'نسخة للقراءة فقط')
          : L('Workspace document', 'مستند مساحة العمل');
    }
    if (m.type === 'MARK_DIRTY') persistWorking();
    if (m.type === 'LANG') {
      lang = m.lang === 'ar' ? 'ar' : 'en';
      document.documentElement.lang = lang;
      document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
      renderStudio();
    }
    if (m.type === 'SAVED') {
      if (m.payload && JSON.stringify(m.payload) !== JSON.stringify(state.doc)) return;
      dirty = false;
      const el = $('#saved');
      if (el) el.textContent = L('Saved to workspace', 'تم الحفظ في مساحة العمل');
      toast(L('Server version saved', 'تم حفظ النسخة على الخادم'));
    }
    if (m.type === 'LOCK') {
      readOnly = m.readOnly;
      document
        .querySelectorAll('[data-key],[data-platform],[data-action="save"]')
        .forEach((el) => (el.disabled = readOnly));
    }
    if (m.type === 'SAVE_FAILED')
      toast(
        L(
          'Not saved. Keep this page open and retry.',
          'لم يُحفظ. اترك الصفحة مفتوحة وأعد المحاولة.',
        ),
      );
  });
  app.innerHTML = '<p role="status">Connecting to Magnet OS…</p>';
  send('READY', handshake);
} else {
  // Production entry belongs to the authenticated shell. Original source/history remains preserved.
  location.replace('/?open=studio');
}
