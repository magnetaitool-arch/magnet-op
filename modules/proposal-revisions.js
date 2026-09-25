'use strict';
function createProposalRevisions(React, html) {
  const { useState, useEffect, useRef } = React;
  return function ProposalRevisions({ rpc, organizationId, recordId, lang, onPrint, onCommitted }) {
    const ar = lang === 'ar',
      L = (en, ara) => (ar ? ara : en);
    const [data, setData] = useState(null),
      [selected, setSelected] = useState(''),
      [error, setError] = useState(''),
      [busy, setBusy] = useState(false),
      [action, setAction] = useState(''),
      [evidence, setEvidence] = useState('');
    const [links, setLinks] = useState(null),
      [reviewUrl, setReviewUrl] = useState(''),
      [handoff, setHandoff] = useState(null);
    const pending = useRef(null),
      generation = useRef(0);
    const load = async () => {
      const seq = ++generation.current;
      setError('');
      try {
        const out = await rpc('get_proposal_revisions_v2', {
          p_organization_id: organizationId,
          p_record_id: recordId,
        });
        if (!out?.ok || !Array.isArray(out.revisions)) throw Error('unavailable');
        if (seq === generation.current) setData(out);
      } catch {
        if (seq === generation.current)
          setError(
            L(
              'Proposal revisions could not be loaded. Retry to verify current data.',
              'تعذّر تحميل نسخ العرض. أعد المحاولة للتحقق من البيانات الحالية.',
            ),
          );
      }
    };
    useEffect(() => {
      setData(null);
      setSelected('');
      setAction('');
      pending.current = null;
      load();
      return () => {
        generation.current++;
      };
    }, [organizationId, recordId]);
    const revision = data?.revisions.find((r) => r.id === selected) || data?.revisions[0];
    useEffect(() => {
      setLinks(null);
      setReviewUrl('');
      setHandoff(null);
    }, [revision?.id]);
    const labels = {
      DRAFT: L('Draft', 'مسودة'),
      REVIEW: L('Internal review', 'مراجعة داخلية'),
      APPROVED: L('Approved internally', 'معتمد داخليًا'),
      SENT: L('Sent (recorded)', 'تم تسجيل الإرسال'),
      ACCEPTED: L('Acceptance recorded', 'تم تسجيل القبول'),
      DECLINED: L('Declined', 'مرفوض'),
      SUPERSEDED: L('Superseded', 'نسخة سابقة'),
    };
    const linkedHandoff = handoff || data?.handoffs?.find((h) => h.revisionId === revision?.id);
    const changed = revision && data.currentHash !== revision.source_hash;
    const command = async (name, args) => {
      if (busy) return;
      const seq = generation.current,
        key = JSON.stringify([name, args]);
      if (!pending.current || pending.current.key !== key)
        pending.current = { key, id: globalThis.crypto.randomUUID() };
      setBusy(true);
      setError('');
      try {
        const out = await rpc(name, {
          ...args,
          p_organization_id: organizationId,
          p_command_id: pending.current.id,
        });
        if (!out?.ok) throw Error('unconfirmed');
        if (seq !== generation.current) return;
        setData(out);
        if (out.createdRevisionId) setSelected(out.createdRevisionId);
        setAction('');
        setEvidence('');
        pending.current = null;
        onCommitted?.(out.record);
      } catch {
        if (seq === generation.current)
          setError(
            L(
              'The change could not be confirmed. Retry unchanged, or reload to resolve a version, permission or required-field conflict.',
              'تعذّر تأكيد التغيير. أعد المحاولة دون تعديل، أو أعد التحميل لمراجعة تعارض النسخة أو الصلاحية أو الحقول المطلوبة.',
            ),
          );
      } finally {
        setBusy(false);
      }
    };
    const transition = (kind) =>
      command('transition_proposal_revision_v2', {
        p_revision_id: revision.id,
        p_expected_version: revision.version,
        p_action: kind,
        p_evidence: evidence.trim() || null,
      });
    const handoffAccepted = async () => {
      if (busy) return;
      const seq = generation.current;
      setBusy(true);
      setError('');
      try {
        const out = await rpc('handoff_accepted_proposal_v2', {
          p_organization_id: organizationId,
          p_revision_id: revision.id,
        });
        if (!out?.ok || !out.clientId) throw Error('unconfirmed');
        if (seq === generation.current) setHandoff(out);
      } catch {
        if (seq === generation.current)
          setError(
            L(
              'Discovery handoff could not be confirmed. Reload and retry; conflicting client or lead links require review. No partial conversion is saved.',
              'تعذّر تأكيد التحويل للاكتشاف. أعد التحميل والمحاولة؛ الروابط المتعارضة بين العميل والعميل المحتمل تحتاج مراجعة. لا يتم حفظ تحويل جزئي.',
            ),
          );
      } finally {
        setBusy(false);
      }
    };
    const manageLink = async (kind, id = null) => {
      if (busy) return;
      setBusy(true);
      setError('');
      const seq = generation.current;
      try {
        const args = {
          p_organization_id: organizationId,
          p_revision_id: revision.id,
          p_action: kind,
          p_link_id: id,
        };
        const out = await rpc('manage_proposal_review_link_v2', args);
        if (!out?.ok) throw Error('unconfirmed');
        if (seq !== generation.current) return;
        if (out.token)
          setReviewUrl(
            globalThis.location.origin +
              globalThis.location.pathname +
              '#proposalReview=' +
              out.token,
          );
        if (kind === 'REVOKE') setReviewUrl('');
        const listed =
          kind === 'LIST'
            ? out
            : await rpc('manage_proposal_review_link_v2', {
                ...args,
                p_action: 'LIST',
                p_link_id: null,
              });
        if (seq === generation.current) setLinks(listed.links || []);
      } catch {
        if (seq === generation.current)
          setError(
            L(
              'Review link could not be confirmed. Reload links before retrying.',
              'تعذّر تأكيد رابط المراجعة. أعد تحميل الروابط قبل المحاولة.',
            ),
          );
      } finally {
        setBusy(false);
      }
    };
    const describe = {
      CHANGES: L('Describe the changes required.', 'اشرح التعديلات المطلوبة.'),
      RECORD_SENT: L(
        'Record how and when this exact revision was sent. This does not send an email.',
        'سجّل كيف ومتى أُرسلت هذه النسخة تحديدًا. هذا الإجراء لا يرسل بريدًا.',
      ),
      RECORD_ACCEPTED: L(
        'Record the client response and its reference. This is a staff-recorded acceptance, not a verified digital signature.',
        'سجّل رد العميل ومرجعه. هذا توثيق من الفريق للقبول، وليس توقيعًا رقميًا موثّقًا.',
      ),
      RECORD_DECLINED: L(
        'Record the client’s reason or response reference.',
        'سجّل سبب الرفض أو مرجع رد العميل.',
      ),
    };
    return html`<section class="proposal-revisions" aria-busy=${busy}>
      <p class="muted">
        ${L('Versions preserve the offer reviewed by your team and client. Edit the working proposal, then capture a new revision.', 'النسخ تحفظ العرض الذي راجعه الفريق والعميل. عدّل مسودة العرض ثم أنشئ نسخة جديدة.')}
      </p>
      ${error && html`<div class="rec-error" role="alert">${error} <button class="mini" disabled=${busy} onClick=${load}>${L('Reload', 'إعادة التحميل')}</button></div>`}
      ${!data && !error && html`<p role="status">${L('Loading revisions…', 'جارٍ تحميل النسخ…')}</p>`}
      ${
        data &&
        html`<div class="flex gap8" style=${{ flexWrap: 'wrap', margin: '16px 0' }}>
          ${data.canManage && html`<button class="btn btn-pri" disabled=${busy} onClick=${() => command('create_proposal_revision_v2', { p_record_id: recordId, p_expected_hash: data.currentHash })}>${L('Capture working proposal', 'إنشاء نسخة من المسودة')}</button>`}${
            data.revisions.length > 0 &&
            html`<label
              >${L('Revision', 'النسخة')}
              <select
                class="sel"
                value=${revision.id}
                disabled=${busy}
                onChange=${(e) => {
                  setSelected(e.target.value);
                  setAction('');
                  setEvidence('');
                }}
              >
                ${data.revisions.map((r) => html`<option key=${r.id} value=${r.id}>${r.revision} · ${labels[r.state]}</option>`)}
              </select></label
            >`
          }
        </div>`
      }
      ${data && !data.revisions.length && html`<p>${L('No immutable revisions yet. A lead or client, scope, currency, explicit price, issue date and expiry are required. Existing proposal data remains unchanged.', 'لا توجد نسخ ثابتة بعد. يلزم عميل محتمل أو عميل، ونطاق، وعملة، وسعر صريح، وتاريخ إصدار وانتهاء. بيانات العرض الحالية محفوظة.')}</p>`}
      ${
        revision &&
        html`<div class="rec-section">
            <div class="flex between center gap8">
              <h3>${revision.snapshot.title} · v${revision.revision}</h3>
              <span>${labels[revision.state]}</span>
            </div>
            <p>
              ${revision.snapshot.preparedFor} · ${revision.snapshot.currency}
              ${revision.snapshot.price}
            </p>
            <p>${L('Valid until', 'صالح حتى')} ${revision.snapshot.validUntil}</p>
            <h4>${L('Scope', 'النطاق')}</h4>
            <p style=${{ whiteSpace: 'pre-wrap' }}>
              ${revision.snapshot.scopeOfWork || revision.snapshot.scope}
            </p>
            ${
              revision.snapshot.deliverables &&
              html`<h4>${L('Deliverables', 'التسليمات')}</h4>
                <p style=${{ whiteSpace: 'pre-wrap' }}>${revision.snapshot.deliverables}</p>`
            }<button class="mini" onClick=${() => onPrint(revision.snapshot)}>
              ${L('Print / save PDF of this revision', 'طباعة / حفظ PDF لهذه النسخة')}
            </button>
            ${
              data.canManage &&
              revision.state === 'ACCEPTED' &&
              html`<div class="rec-section">
                <button class="btn btn-pri" disabled=${busy} onClick=${handoffAccepted}>
                  ${L('Connect to client discovery', 'ربط بمرحلة اكتشاف العميل')}
                </button>
                <p class="muted">
                  ${L('Creates or reuses the linked client and discovery workflow. Contract and payment checks still apply before execution.', 'ينشئ أو يستخدم العميل المرتبط وسير عمل الاكتشاف. تظل مراجعة العقد والدفع مطلوبة قبل التنفيذ.')}
                </p>
                ${linkedHandoff && html`<p role="status">${L('Client discovery is connected to this accepted revision.', 'تم ربط اكتشاف العميل بهذه النسخة المقبولة.')} <a class="mini" href=${'?open=clients&id=' + encodeURIComponent(linkedHandoff.clientId)}>${L('Open client workspace', 'فتح مساحة العميل')}</a></p>`}
              </div>`
            }
            ${changed && html`<p role="status">${L('The working proposal has changed. Capture a new revision before further decisions.', 'تم تغيير مسودة العرض. أنشئ نسخة جديدة قبل اتخاذ قرار آخر.')}</p>`}
            <div class="flex gap8" style=${{ marginTop: 16, flexWrap: 'wrap' }}>
              ${!changed && data.canManage && revision.state === 'DRAFT' && html`<button class="btn btn-pri" disabled=${busy} onClick=${() => transition('REVIEW')}>${L('Request internal review', 'طلب مراجعة داخلية')}</button>`}${!changed && data.canApprove && revision.state === 'REVIEW' && html`<button class="btn btn-pri" disabled=${busy} onClick=${() => transition('APPROVE')}>${L('Approve this revision', 'اعتماد هذه النسخة')}</button><button class="btn btn-ghost" disabled=${busy} onClick=${() => setAction('CHANGES')}>${L('Request changes', 'طلب تعديلات')}</button>`}${!changed && data.canManage && revision.state === 'APPROVED' && html`<button class="btn btn-pri" disabled=${busy} onClick=${() => setAction('RECORD_SENT')}>${L('Record sending', 'تسجيل الإرسال')}</button>`}${!changed && data.canManage && revision.state === 'SENT' && html`<button class="btn btn-pri" disabled=${busy} onClick=${() => setAction('RECORD_ACCEPTED')}>${L('Record client acceptance', 'تسجيل قبول العميل')}</button><button class="btn btn-ghost" disabled=${busy} onClick=${() => setAction('RECORD_DECLINED')}>${L('Record decline', 'تسجيل الرفض')}</button>`}
            </div>
            ${
              data.canManage &&
              html`<div class="rec-section">
                <h4>${L('Client review links', 'روابط مراجعة العميل')}</h4>
                <div class="flex gap8" style=${{ flexWrap: 'wrap' }}>
                  ${!changed && ['APPROVED', 'SENT'].includes(revision.state) && html`<button class="mini" disabled=${busy} onClick=${() => manageLink('CREATE')}>${L('Create review link', 'إنشاء رابط مراجعة')}</button>`}<button
                    class="mini"
                    disabled=${busy}
                    onClick=${() => manageLink('LIST')}
                  >
                    ${L('Manage links', 'إدارة الروابط')}
                  </button>
                </div>
                ${reviewUrl && html`<label class="crm-review-link">${L('Share this link only with the intended recipient. It expires within 72 hours.', 'شارك هذا الرابط مع المستلم المقصود فقط. تنتهي صلاحيته خلال ٧٢ ساعة.')}<input class="inp" readonly value=${reviewUrl} onFocus=${(e) => e.target.select()} /><a class="mini" href=${reviewUrl} target="_blank" rel="noopener noreferrer">${L('Open client preview', 'فتح معاينة العميل')}</a></label>`}${links && links.map((link) => html`<div key=${link.id} class="crm-followup-item"><span>${link.revokedAt ? L('Revoked', 'ملغى') : new Date(link.expiresAt) < new Date() ? L('Expired', 'منتهي') : link.acceptedAt ? L('Accepted', 'مقبول') : L('Active', 'نشط')} · ${new Date(link.expiresAt).toLocaleString(ar ? 'ar-EG' : 'en-GB')}</span>${!link.revokedAt && html`<button class="mini" disabled=${busy} onClick=${() => manageLink('REVOKE', link.id)}>${L('Revoke', 'إلغاء الرابط')}</button>`}</div>`)}
              </div>`
            }
            ${
              action &&
              html`<form
                class="crm-followup-form"
                onSubmit=${(e) => {
                  e.preventDefault();
                  transition(action);
                }}
              >
                <label
                  >${describe[action]}<textarea
                    class="inp"
                    required
                    minlength="10"
                    maxlength="2000"
                    value=${evidence}
                    onChange=${(e) => setEvidence(e.target.value)}
                  ></textarea>
                </label>
                <div class="flex gap8">
                  <button class="btn btn-pri" disabled=${busy}>
                    ${L('Save evidence', 'حفظ التوثيق')}</button
                  ><button
                    class="btn btn-ghost"
                    type="button"
                    disabled=${busy}
                    onClick=${() => setAction('')}
                  >
                    ${L('Cancel', 'إلغاء')}
                  </button>
                </div>
              </form>`
            }
          </div>
          <h4>${L('Revision history', 'سجل النسخة')}</h4>
          ${data.events
            .filter((e) => e.revision_id === revision.id)
            .map(
              (event) =>
                html`<article key=${event.id} class="crm-followup-item">
                  <div>
                    <b>${labels[event.to_state] || event.to_state}</b>
                    <p>${new Date(event.created_at).toLocaleString(ar ? 'ar-EG' : 'en-GB')}</p>
                    ${event.evidence && html`<p>${event.evidence}</p>`}
                  </div>
                </article>`,
            )}`
      }
    </section>`;
  };
}
function createPublicProposalReview(React, html) {
  const { useState, useEffect, useRef } = React;
  return function PublicProposalReview({ rpc, token, initialLang = 'en' }) {
    const [lang, setLang] = useState(initialLang),
      [data, setData] = useState(null),
      [state, setState] = useState('loading'),
      [error, setError] = useState(''),
      [busy, setBusy] = useState(false),
      [name, setName] = useState(''),
      [email, setEmail] = useState(''),
      [consent, setConsent] = useState(false);
    const sequence = useRef(0);
    const ar = lang === 'ar',
      L = (en, ara) => (ar ? ara : en);
    const load = async () => {
      const id = ++sequence.current;
      setState('loading');
      setError('');
      try {
        const out = await rpc('get_public_proposal_v2', { p_token: token });
        if (id !== sequence.current) return;
        if (!out?.ok) {
          setState('unavailable');
          return;
        }
        setData(out);
        setState('ready');
      } catch {
        if (id === sequence.current) setState('error');
      }
    };
    useEffect(() => {
      load();
      return () => {
        sequence.current++;
      };
    }, [token]);
    useEffect(() => {
      const oldLang = globalThis.document.documentElement.lang,
        oldDir = globalThis.document.documentElement.dir;
      globalThis.document.documentElement.lang = lang;
      globalThis.document.documentElement.dir = ar ? 'rtl' : 'ltr';
      return () => {
        globalThis.document.documentElement.lang = oldLang;
        globalThis.document.documentElement.dir = oldDir;
      };
    }, [lang]);
    const accept = async (event) => {
      event.preventDefault();
      if (busy || !consent) return;
      setBusy(true);
      setError('');
      try {
        const out = await rpc('accept_public_proposal_v2', {
          p_token: token,
          p_content_hash: data.contentHash,
          p_name: name.trim(),
          p_email: email.trim(),
          p_confirm: consent,
        });
        if (!out?.ok) {
          setError(
            L(
              'This offer could not be accepted. Check your details, then reload to verify the link.',
              'تعذّر قبول العرض. راجع البيانات ثم أعد التحميل للتحقق من الرابط.',
            ),
          );
          return;
        }
        await load();
      } catch {
        setError(
          L(
            'The response could not be confirmed. Reload to check whether acceptance was saved.',
            'تعذّر تأكيد الاستجابة. أعد التحميل للتحقق مما إذا تم حفظ القبول.',
          ),
        );
      } finally {
        setBusy(false);
      }
    };
    const sections = [
      ['executiveSummary', 'Summary', 'الملخص'],
      ['goals', 'Goals', 'الأهداف'],
      ['strategy', 'Strategy', 'الاستراتيجية'],
      ['scopeOfWork', 'Scope of work', 'نطاق العمل'],
      ['deliverables', 'Deliverables', 'التسليمات'],
      ['timeline', 'Timeline', 'الجدول الزمني'],
      ['paymentTerms', 'Payment terms', 'شروط الدفع'],
      ['revisionPolicy', 'Revision policy', 'سياسة التعديلات'],
      ['exclusions', 'Exclusions', 'الاستثناءات'],
      ['nextSteps', 'Next steps', 'الخطوات التالية'],
    ];
    const offer = data?.proposal;
    return html`<div class="proposal-public-page" dir=${ar ? 'rtl' : 'ltr'}>
      <header>
        <a href="/" aria-label="Magnet OS"
          ><img src="/magnet-logo.png" alt="Magnet" width="40" height="40" /></a
        ><span>MAGNET / ${L('PROPOSAL', 'عرض خدمات')}</span
        ><button class="btn btn-ghost" onClick=${() => setLang(ar ? 'en' : 'ar')}>
          ${ar ? 'English' : 'العربية'}
        </button>
      </header>
      <main>
        ${state === 'loading' && html`<h1 role="status">${L('Opening your proposal…', 'جارٍ فتح العرض…')}</h1>`}
        ${
          state === 'unavailable' &&
          html`<h1>${L('This review link is unavailable', 'رابط المراجعة غير متاح')}</h1>
            <p>
              ${L('It may have expired, been revoked, or been replaced by a newer offer. Ask Magnet for a current link.', 'قد يكون الرابط منتهيًا أو ملغيًا أو استُبدل بعرض أحدث. اطلب رابطًا حاليًا من ماجنت.')}
            </p>`
        }
        ${
          state === 'error' &&
          html`<h1>${L('Connection unavailable', 'الاتصال غير متاح')}</h1>
            <p>
              ${L('We could not verify the current offer. Retry when your connection is restored.', 'تعذّر التحقق من العرض الحالي. أعد المحاولة عند استعادة الاتصال.')}
            </p>
            <button class="btn btn-pri" onClick=${load}>${L('Retry', 'إعادة المحاولة')}</button>`
        }
        ${
          state === 'ready' &&
          offer &&
          html`<div class="eyebrow">${L('REVISION', 'النسخة')} ${offer.revisionNumber}</div>
            <h1>${offer.title}</h1>
            <p class="proposal-public-for">
              ${L('Prepared for', 'مُعدّ من أجل')} <bdi>${offer.preparedFor}</bdi>
            </p>
            <div class="proposal-public-summary">
              <div>
                <span>${L('Investment', 'قيمة العرض')}</span
                ><strong
                  ><bdi
                    >${new Intl.NumberFormat(ar ? 'ar-EG' : 'en-GB', { style: 'currency', currency: offer.currency }).format(Number(offer.price))}</bdi
                  ></strong
                >
              </div>
              <div>
                <span>${L('Valid until', 'صالح حتى')}</span
                ><strong><bdi>${offer.validUntil}</bdi></strong>
              </div>
            </div>
            ${sections.map(([key, en, ara]) => {
              const value = offer[key] || (key === 'scopeOfWork' ? offer.scope : '');
              return value
                ? html`<section key=${key}>
                    <h2>${L(en, ara)}</h2>
                    <p>${value}</p>
                  </section>`
                : null;
            })}
            ${
              data.state === 'ACCEPTED'
                ? html`<section role="status" class="proposal-public-decision">
                    <h2>${L('Acceptance recorded', 'تم تسجيل القبول')}</h2>
                    <p>
                      ${L('Acceptance has been recorded for this revision. Keep a copy for your records.', 'تم تسجيل قبول هذه النسخة لدى ماجنت. احتفظ بنسخة لسجلاتك.')}
                    </p>
                  </section>`
                : html`<form class="proposal-public-decision crm-followup-form" onSubmit=${accept}>
                    <h2>${L('Accept this proposal', 'قبول هذا العرض')}</h2>
                    <p>
                      ${L('Confirm this exact revision on behalf of the recipient. Your name and email are recorded with the response; this link does not sign you in to a workspace.', 'أكّد هذه النسخة تحديدًا نيابةً عن الجهة المستلمة. يُسجّل اسمك وبريدك مع الرد؛ هذا الرابط لا يسجّل دخولك إلى مساحة عمل.')}
                    </p>
                    <label
                      >${L('Your full name', 'الاسم الكامل')}<input
                        class="inp"
                        required
                        minlength="2"
                        maxlength="160"
                        autocomplete="name"
                        value=${name}
                        onChange=${(e) => setName(e.target.value)} /></label
                    ><label
                      >${L('Email', 'البريد الإلكتروني')}<input
                        class="inp"
                        type="email"
                        required
                        maxlength="320"
                        autocomplete="email"
                        value=${email}
                        onChange=${(e) => setEmail(e.target.value)} /></label
                    ><label class="proposal-public-consent"
                      ><input
                        type="checkbox"
                        required
                        checked=${consent}
                        onChange=${(e) => setConsent(e.target.checked)}
                      /><span
                        >${L('I have reviewed this revision and am authorized to accept the scope, price and terms for the recipient.', 'راجعت هذه النسخة وأنا مخوّل بقبول النطاق والسعر والشروط نيابةً عن الجهة المستلمة.')}</span
                      ></label
                    ><button class="btn btn-pri" disabled=${busy || !consent}>
                      ${busy ? L('Confirming…', 'جارٍ التأكيد…') : L('Accept revision', 'قبول النسخة')}
                    </button>
                  </form>`
            }
            <button class="btn btn-ghost proposal-no-print" onClick=${() => globalThis.print()}>
              ${L('Print / save PDF', 'طباعة / حفظ PDF')}
            </button> `
        }
        ${error && html`<div role="alert" class="rec-error">${error} <button class="mini" onClick=${load}>${L('Reload offer', 'إعادة تحميل العرض')}</button></div>`}
      </main>
      <footer>Magnet Marketing Agency</footer>
    </div>`;
  };
}
if (typeof module !== 'undefined' && module.exports)
  module.exports = { createProposalRevisions, createPublicProposalReview };
else
  Object.defineProperty(globalThis, 'MagnetProposalRevisions', {
    value: { createProposalRevisions, createPublicProposalReview },
  });
