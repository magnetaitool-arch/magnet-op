'use strict';
async function changeLegacyTaskStatus({ rpc, organizationId, record, updates, onCommitted }) {
  if (!organizationId || !record?.id || typeof record.status !== 'string')
    throw Error('task_reload_required');
  if (
    Object.keys(updates).some(
      (key) => !['status', 'completedAt', 'completedBy', 'blockers'].includes(key),
    )
  )
    throw Error('task_status_separate_from_details');
  if (updates.status === record.status) return record;
  const out = await rpc('change_task_record_status_v2', {
    p_organization_id: organizationId,
    p_record_id: record.id,
    p_expected_status: record.status,
    p_status: updates.status,
    p_note: updates.blockers || null,
  });
  if (!out?.ok || out.record?.id !== record.id || out.record.status !== updates.status)
    throw Error('task_status_not_confirmed');
  onCommitted(out.record);
  return out.record;
}
function taskErrorMessage(error, lang) {
  const key = String(error?.message || error || ''),
    ar = lang === 'ar';
  const messages = {
    task_dependencies_incomplete: [
      'Finish the prerequisites before starting or completing this task.',
      'أكمل المتطلبات السابقة قبل بدء هذه المهمة أو إكمالها.',
    ],
    pause_dependent_tasks_before_reopening: [
      'Pause dependent tasks before reopening this prerequisite.',
      'أوقف المهام المعتمدة مؤقتًا قبل إعادة فتح هذا المتطلب.',
    ],
    task_dependency_relationship_locked: [
      'Remove or review the dependency links before moving this task to another project.',
      'راجع روابط الاعتماد أو أزلها قبل نقل المهمة إلى مشروع آخر.',
    ],
    task_assignee_review_required: [
      'Choose an employee with one active login in this workspace.',
      'اختر موظفًا له حساب دخول واحد نشط في مساحة العمل.',
    ],
    task_version_conflict: [
      'Someone changed this task. Reload and review before saving again.',
      'غيّر شخص آخر هذه المهمة. أعد التحميل والمراجعة قبل الحفظ مرة أخرى.',
    ],
    task_status_conflict_reload: [
      'The task status changed. Reload before trying another transition.',
      'تغيرت حالة المهمة. أعد التحميل قبل محاولة الانتقال إلى حالة أخرى.',
    ],
    invalid_task_transition: [
      'This status change is not available from the current stage.',
      'هذا الانتقال غير متاح من الحالة الحالية.',
    ],
    task_project_relationship_review_required: [
      'The project/client relationship needs review before execution.',
      'يجب مراجعة علاقة المشروع بالعميل قبل التنفيذ.',
    ],
    task_hours_invalid: [
      'Estimated hours must be between 0 and 10,000, with at most two decimal places.',
      'الساعات المتوقعة يجب أن تكون بين 0 و١٠٬٠٠٠، وبحد أقصى منزلتين عشريتين.',
    ],
    task_dates_invalid: [
      'Choose valid dates, with the deadline on or after the start.',
      'اختر تواريخ صحيحة، ويكون موعد التسليم في تاريخ البداية أو بعده.',
    ],
  };
  const entry = Object.entries(messages).find(([code]) => key.includes(code));
  return entry
    ? entry[1][ar ? 1 : 0]
    : ar
      ? 'لم يتم تأكيد الإجراء. أعد المحاولة دون تعديل، أو أعد التحميل لمراجعة أحدث حالة وصلاحياتك.'
      : 'Action not confirmed. Retry unchanged, or reload to review the latest state and your access.';
}
if (typeof window !== 'undefined')
  window.MagnetTaskStatus = { changeLegacyTaskStatus, taskErrorMessage };
if (typeof module !== 'undefined') module.exports = { changeLegacyTaskStatus, taskErrorMessage };
