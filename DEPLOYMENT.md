# Magnet OS — Deployment & Go-Live Runbook

> ⚠️ **This is the LEGACY Netlify runbook.** The live site runs on **Vercel** — use
> **[DEPLOYMENT_FIXED.md](DEPLOYMENT_FIXED.md)** as the current, authoritative guide.
> The production Supabase project is **`jdylrthffifbhyrrhuqd`** (an older draft of
> this file said `ksunojpdzunyqrxdmogd` — that was wrong and is corrected below).
> The "edit index.html line ~773 by hand" step is no longer needed: the real anon
> key is already wired in `index.html`.
>
> ⛔ **Do not execute the historical SQL/key steps below.** They describe the old
> anonymous internal-app architecture and can expose private employee/client data.
> New database work must follow `docs/PRODUCTION_READINESS.md`,
> `docs/DATABASE.md`, and the ordered Supabase CLI migrations after a verified
> service-role backup and staging restore. This file remains historical only.

دليل التشغيل أونلاين خطوة بخطوة. نفّذه مرة واحدة.

---

## 1) Supabase (الداتابيز)
1. افتح مشروعك على Supabase → **SQL Editor** → **New query**.
2. **متشغّليش `supabase-schema.sql`** — الملف قديم وبيفتح بيانات الشغل للـ anon. استخدم الـ migrations المرتبة بعد backup وstaging.
3. روح **Project Settings → API** وانسخ:
   - **Project URL** = `https://jdylrthffifbhyrrhuqd.supabase.co`
   - **anon public key** (هتتحط في `index.html`).
   - **service_role key** (هتتحط في Netlify بس — **متحطهاش في الكود أبداً**).

## 2) index.html — مفتاح anon الحقيقي
- في `index.html` (سطر ~773) غيّر:
  ```js
  key:"PASTE_MAGNET_ANON_KEY"
  ```
  لمفتاح الـ anon الحقيقي. (ابعتهولي وأنا أحطّه، أو غيّره بنفسك.)
- نفس المفتاح هيتحط كمان في خانة الإعدادات داخل التطبيق (Settings → Cloud) لو حبيت.

## 3) Netlify — النشر + متغيّرات البيئة
1. ارفع مجلد المشروع كامل على **app.netlify.com/drop** (drag & drop).
2. بعد النشر: **Site settings → Environment variables** وأضف:
   | Key | Value |
   |---|---|
   | `SUPABASE_URL` | `https://jdylrthffifbhyrrhuqd.supabase.co` |
   | `SUPABASE_KEY` | الـ **service_role** key |
   | `RESEND_API_KEY` | مفتاح Resend (اختياري للإيميل) |
   | `FROM_EMAIL` | `Magnet OS <onboarding@resend.dev>` |
   | `HR_EMAIL` | إيميل HR (تنبيه المتقدّمين) |
   | `SALES_EMAIL` | إيميل المبيعات (تنبيه العملاء) |
3. اعمل **Redeploy** بعد إضافة المتغيّرات.

## 4) ربط الفورمين بدل الواتساب
الدالة جاهزة على: `https://YOUR-SITE.netlify.app/.netlify/functions/intake`

### فورم التوظيف (Candidate)
بدّل كود الإرسال (اللي بيبعت واتساب) بده:
```js
async function submitHiringForm(form, gameScore) {
  const payload = {
    type: 'candidate',
    fullName:      form.fullName.value,
    age:           form.age.value,
    mobile:        form.mobile.value,
    otherPhones:   form.otherPhones.value,
    email:         form.email.value,
    area:          form.area.value,            // Governorate / Area
    maritalStatus: form.maritalStatus.value,
    position:      form.position.value,
    specialization:form.specialization.value,
    experience:    form.experience.value,      // Years of experience
    availableFrom: form.availableFrom.value,
    currentSalary: form.currentSalary.value,   // EGP
    gameScore:     gameScore || 0,             // "beat the chaos" score
    company_website: ''                        // honeypot — سيبه فاضي (مخفي للبوتس)
  };
  const res = await fetch('https://YOUR-SITE.netlify.app/.netlify/functions/intake', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return res.ok;
}
```

### فورم العملاء (Lead)
```js
async function submitClientForm(form) {
  const payload = {
    type: 'lead',
    name:            form.name.value,
    company:         form.company.value,
    email:           form.email.value,
    phone:           form.phone.value,
    serviceInterest: form.service.value,   // اختياري
    notes:           form.message.value,   // اختياري
    brand:           'Magnet',
    company_website: ''                    // honeypot
  };
  const res = await fetch('https://YOUR-SITE.netlify.app/.netlify/functions/intake', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return res.ok;
}
```
> ملاحظة: غيّر `form.X.value` لأسماء الحقول الفعلية في الفورم بتاعك. لو بعتّلي كود الفورم هظبّطها لك بالظبط.

## 5) التأكد إن كله شغّال (Verification)
- اختبار الدالة من التيرمنال:
  ```bash
  curl -X POST https://YOUR-SITE.netlify.app/.netlify/functions/intake \
    -H 'Content-Type: application/json' \
    -d '{"type":"candidate","fullName":"Test User","mobile":"01000000000","email":"t@t.com","position":"Designer"}'
  # المفروض يرجّع: {"ok":true,"id":"can-..."}
  ```
- افتح Magnet OS → **Recruitment** → المفروض تلاقي المتقدّم ظهر + إشعار للـ HR.
- جرّب العميل بنفس الطريقة (`"type":"lead"`) → يظهر في **CRM / Leads**.
- داخل التطبيق: **Settings → Cloud → Test connection** المفروض تنجح.

## 6) الدخول
- مفيش مستخدم أو باسورد افتراضي. إنشاء أول Owner محمي بـ `INITIAL_OWNER_SETUP_SECRET` من إعدادات السيرفر.

---

### ملاحظات أمان
- مفتاح الـ **service_role** يفضل في Netlify بس، عمره ما يتحط في `index.html`.
- النسخ الاحتياطي: من داخل التطبيق (Backup Center) + فعّل الباك أب التلقائي في Supabase.
