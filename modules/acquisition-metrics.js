'use strict';
function createAcquisitionMetrics(React,html){
 const {useState,useEffect}=React;
 return function AcquisitionMetrics({rpc,organizationId,lang}){
  const [data,setData]=useState(null),[error,setError]=useState(false);const ar=lang==='ar';
  useEffect(()=>{let active=true;setData(null);const load=()=>rpc('acquisition_metrics_v2',{p_organization_id:organizationId}).then(v=>{if(active){setData(v);setError(false);}}).catch(()=>{if(active)setError(true);});load();const timer=setInterval(load,60000);return()=>{active=false;clearInterval(timer);};},[organizationId]);
  const fields={newLeads:['New leads','عملاء جدد'],leadsToday:['Leads today','عملاء اليوم'],websiteLeads:['Website · 30 days','الموقع · ٣٠ يوم'],followupsToday:['Follow-ups today','متابعات اليوم'],overdueFollowups:['Overdue follow-ups','متابعات متأخرة'],proposalsPending:['Proposals pending','عروض معلقة'],negotiations:['Negotiation','تفاوض'],won:['Won','مكتسب'],lost:['Lost','مفقود']};
  return html`<section class="panel mb18" style=${{padding:16}}><h3>${ar?'متابعة المبيعات':'Sales operations'}</h3><p class="muted">${ar?'اليوم حسب توقيت القاهرة. المصادر خلال آخر ٣٠ يوم.':'Today uses Cairo time. Sources cover the last 30 days.'}</p>${error&&html`<p role="alert">${ar?'تعذّر تحديث المؤشرات':'Metrics could not be refreshed'}</p>`}${data&&html`<div class="grid" style=${{gridTemplateColumns:'repeat(auto-fit,minmax(135px,1fr))'}}>${Object.entries(fields).map(([key,label])=>html`<div key=${key}><small>${label[ar?1:0]}</small><p style=${{fontSize:22}}>${data[key]}</p></div>`)}</div><div>${data.sources.map(s=>html`<p key=${s.source}>${s.source}: ${s.leads} ${ar?'عميل · مكتسب':'leads · won'} ${s.won}</p>`)}</div>`}</section>`;
 };
}
if(typeof window!=='undefined')window.MagnetAcquisitionMetrics={createAcquisitionMetrics};
if(typeof module!=='undefined')module.exports={createAcquisitionMetrics};
