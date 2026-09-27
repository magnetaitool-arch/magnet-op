'use strict';
function createNotificationPreferences(React, html) {
 const {useState,useEffect,useRef}=React;
 const labels={assignments:['Assignments','التكليفات'],mentions:['Mentions','الإشارات'],approvals:['Approvals','الموافقات'],revisions:['Revisions','التعديلات'],deadlines:['Deadlines & follow-ups','المواعيد والمتابعات'],leads:['Leads','العملاء المحتملون'],proposals:['Proposals','العروض'],publishing:['Publishing','النشر'],security:['Security (required)','الأمان (إلزامي)']};
 return function NotificationPreferences({rpc,organizationId,lang}) {
  const [values,setValues]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const generation=useRef(0),ar=lang==='ar';
  useEffect(()=>{const current=++generation.current;setValues(null);setError('');
   rpc('notification_preferences_v2',{p_organization_id:organizationId}).then(v=>{if(current===generation.current)setValues(v);}).catch(()=>{if(current===generation.current)setError(ar?'تعذّر تحميل التفضيلات':'Preferences could not be loaded');});
   return()=>{generation.current++;};
  },[organizationId]);
  const save=async(category,enabled)=>{const current=generation.current;setBusy(true);setError('');try{
   const v=await rpc('notification_preferences_v2',{p_organization_id:organizationId,p_category:category,p_enabled:enabled});
   if(current===generation.current)setValues(v);
  }catch{if(current===generation.current)setError(ar?'لم يتم حفظ التغيير. أعد المحاولة.':'Change was not saved. Try again.');}finally{if(current===generation.current)setBusy(false);}};
  return html`<section class="panel mb18" style=${{padding:20}} aria-label=${ar?'تفضيلات الإشعارات':'Notification preferences'}><h3>${ar?'الإشعارات — تفضيلات البريد':'Notifications — email preferences'}</h3><p class="muted">${ar?'تُحفظ تفضيلاتك لهذا الحساب ومساحة العمل. إشعارات الأمان إلزامية.':'Preferences are saved for your account and workspace. Security messages are required.'}</p>${error&&html`<p role="alert">${error}</p>`}${!values&&!error&&html`<p role="status">${ar?'جارٍ التحميل…':'Loading…'}</p>`}<div class="grid g-2">${values&&Object.entries(labels).map(([key,label])=>html`<label key=${key} class="flex gap8" style=${{padding:'10px 0'}}><input type="checkbox" checked=${values[key]!==false} disabled=${busy||key==='security'} onChange=${e=>save(key,e.target.checked)}/>${label[ar?1:0]}</label>`)}</div></section>`;
 };
}
if(typeof window!=='undefined')window.MagnetNotificationPreferences={createNotificationPreferences};
if(typeof module!=='undefined')module.exports={createNotificationPreferences};
