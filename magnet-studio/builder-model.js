/* Structured document data. Existing Studio versions remain the canonical store. */
(function (root) {
  'use strict';
  const types = [
    'cover',
    'headline',
    'paragraph',
    'image',
    'logo',
    'big_number',
    'metric_group',
    'chart',
    'table',
    'comparison',
    'swot',
    'buyer_persona',
    'timeline',
    'services',
    'pricing',
    'campaign_performance',
    'social_content',
    'recommendation',
    'action_plan',
    'cta',
    'spacer',
  ];
  const templates = {
    proposal: [
      'Proposal',
      'عرض مقترح',
      ['cover', 'paragraph', 'services', 'pricing', 'timeline', 'cta'],
    ],
    audit: [
      'Social Media Audit',
      'تدقيق التواصل الاجتماعي',
      ['cover', 'metric_group', 'comparison', 'swot', 'recommendation', 'action_plan'],
    ],
    strategy: [
      'Marketing Strategy',
      'استراتيجية التسويق',
      ['cover', 'paragraph', 'buyer_persona', 'swot', 'services', 'action_plan'],
    ],
    content_plan: [
      'Content Plan',
      'خطة المحتوى',
      ['cover', 'paragraph', 'table', 'social_content', 'timeline'],
    ],
    monthly_report: [
      'Monthly Report',
      'التقرير الشهري',
      ['cover', 'metric_group', 'chart', 'social_content', 'recommendation'],
    ],
    media_report: [
      'Media Buying Report',
      'تقرير الإعلانات',
      ['cover', 'campaign_performance', 'chart', 'table', 'recommendation'],
    ],
    campaign_report: [
      'Campaign Report',
      'تقرير الحملة',
      ['cover', 'campaign_performance', 'comparison', 'recommendation'],
    ],
    persona: [
      'Buyer Persona',
      'شخصية العميل',
      ['cover', 'buyer_persona', 'paragraph', 'recommendation'],
    ],
    competitors: [
      'Competitor Analysis',
      'تحليل المنافسين',
      ['cover', 'comparison', 'table', 'swot', 'recommendation'],
    ],
    quarterly_review: [
      'Quarterly Review',
      'المراجعة ربع السنوية',
      ['cover', 'metric_group', 'chart', 'comparison', 'action_plan'],
    ],
  };
  const labels = {
    cover: ['Cover', 'غلاف'],
    headline: ['Headline', 'عنوان'],
    paragraph: ['Paragraph', 'فقرة'],
    image: ['Image', 'صورة'],
    logo: ['Logo', 'شعار'],
    big_number: ['Big number', 'رقم رئيسي'],
    metric_group: ['Metric group', 'مجموعة مؤشرات'],
    chart: ['Chart', 'رسم بياني'],
    table: ['Table', 'جدول'],
    comparison: ['Comparison', 'مقارنة'],
    swot: ['SWOT', 'تحليل SWOT'],
    buyer_persona: ['Buyer persona', 'شخصية العميل'],
    timeline: ['Timeline', 'جدول زمني'],
    services: ['Services', 'الخدمات'],
    pricing: ['Pricing', 'التسعير'],
    campaign_performance: ['Campaign performance', 'أداء الحملة'],
    social_content: ['Social content preview', 'معاينة محتوى'],
    recommendation: ['Recommendation', 'توصية'],
    action_plan: ['Action plan', 'خطة عمل'],
    cta: ['CTA', 'دعوة لاتخاذ إجراء'],
    spacer: ['Spacer', 'مسافة'],
  };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const id = () => globalThis.crypto.randomUUID();
  const brand = () => ({
    primary: '#11140e',
    secondary: '#f3f4ee',
    accent: '#c8ff22',
    font: 'Manrope',
    style: 'Editorial',
    logoId: null,
  });
  function block(type, lang = 'en') {
    if (!types.includes(type)) throw Error('Unknown block type');
    return {
      id: id(),
      type,
      title: labels[type][lang === 'ar' ? 1 : 0],
      text: '',
      rows: [],
      alignment: lang === 'ar' ? 'right' : 'left',
      variant: 'standard',
      height: type === 'cover' ? 400 : type === 'spacer' ? 40 : 170,
      mediaId: null,
    };
  }
  function create(key, context = {}, lang = 'en') {
    const t = templates[key];
    if (!t) throw Error('Unknown template');
    const d = {
      builder: 1,
      kind: 'report',
      template: key,
      title: t[lang === 'ar' ? 1 : 0],
      language: lang === 'ar' ? 'ar' : 'en',
      pageSize: 'landscape',
      brand: clone(context.brand || brand()),
      binding: {
        client: context.client || '',
        project: context.project || '',
        campaign: context.campaign || '',
      },
      pages: [],
    };
    for (let i = 0; i < t[2].length; i += 2) {
      const blocks = t[2].slice(i, i + 2).map((type) => block(type, lang));
      d.pages.push({
        id: id(),
        title: (lang === 'ar' ? 'صفحة ' : 'Page ') + (d.pages.length + 1),
        blocks,
      });
    }
    d.pages[0].blocks[0].title = d.title;
    d.pages[0].blocks[0].text = context.client || '';
    return d;
  }
  function move(items, from, to) {
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 0 ||
      to < 0 ||
      from >= items.length ||
      to >= items.length
    )
      return items;
    const copy = [...items];
    copy.splice(to, 0, copy.splice(from, 1)[0]);
    return copy;
  }
  function duplicate(item) {
    const x = clone(item);
    x.id = id();
    if (x.blocks) x.blocks = x.blocks.map(duplicate);
    return x;
  }
  function validate(d) {
    if (
      !d ||
      d.builder !== 1 ||
      d.kind !== 'report' ||
      typeof d.title !== 'string' ||
      d.title.trim().length < 2 ||
      d.title.length > 240
    )
      throw Error('Document title must contain 2–240 characters');
    if (!['en', 'ar'].includes(d.language) || !['landscape', 'portrait'].includes(d.pageSize))
      throw Error('Invalid document settings');
    if (!Array.isArray(d.pages) || !d.pages.length || d.pages.length > 60)
      throw Error('Use 1–60 pages');
    const ids = new Set();
    const checkId = (x) => {
      if (typeof x !== 'string' || !x || ids.has(x)) throw Error('Duplicate or missing identifier');
      ids.add(x);
    };
    for (const page of d.pages) {
      checkId(page.id);
      if (typeof page.title !== 'string') throw Error('Invalid page title');
      if (!Array.isArray(page.blocks) || page.blocks.length > 30)
        throw Error('Use at most 30 blocks per page');
      for (const b of page.blocks) {
        checkId(b.id);
        if (
          !types.includes(b.type) ||
          typeof b.title !== 'string' ||
          typeof b.text !== 'string' ||
          b.title.length > 500 ||
          b.text.length > 12000 ||
          !Number.isFinite(b.height) ||
          b.height < 30 ||
          b.height > 900 ||
          !['left', 'center', 'right'].includes(b.alignment) ||
          !['standard', 'accent', 'minimal'].includes(b.variant)
        )
          throw Error('Invalid block');
        if (
          !Array.isArray(b.rows) ||
          b.rows.length > 50 ||
          b.rows.some(
            (r) =>
              !Array.isArray(r) ||
              r.length > 6 ||
              r.some((c) => typeof c !== 'string' || c.length > 1000),
          )
        )
          throw Error('Invalid rows');
      }
    }
    for (const k of ['primary', 'secondary', 'accent'])
      if (!/^#[a-f\d]{6}$/i.test(d.brand?.[k] || '')) throw Error('Use six-digit hex colors');
    if (!['Manrope', 'Readex Pro', 'Arial', 'Georgia'].includes(d.brand.font))
      throw Error('Unsupported font');
    if (new TextEncoder().encode(JSON.stringify(d)).length > 230000)
      throw Error('Document is too large; split it into smaller documents');
    return d;
  }
  const api = {
    types,
    templates,
    labels,
    clone,
    id,
    brand,
    block,
    create,
    move,
    duplicate,
    validate,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MagnetBuilderModel = api;
})(typeof window === 'undefined' ? globalThis : window);
