'use strict';
const { timingSafeEqual } = require('node:crypto');
const { handlePublicIntake } = require('../server/public-intake');
module.exports = async (req,res) => {
 res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
 const expected=Buffer.from(process.env.WEBSITE_INTAKE_SECRET||process.env.PUBLIC_INTAKE_SHARED_SECRET||'');
 const supplied=Buffer.from(String(req.headers['x-magnet-intake-secret']||''));
 const reply=(status,body)=>{res.statusCode=status;res.end(JSON.stringify(body));};
 if(req.method!=='POST')return reply(405,{error:'method_not_allowed'});
 if(!expected.length)return reply(503,{error:'integration_not_configured'});
 if(expected.length!==supplied.length||!timingSafeEqual(expected,supplied))return reply(401,{error:'integration_authentication_required'});
 let body=req.body;try{if(typeof body==='string')body=JSON.parse(body);}catch{return reply(400,{error:'invalid_json'});}
 if(!body||Array.isArray(body)||typeof body!=='object'||!['project_matcher','contact','campaign'].includes(body.form_source)||!/^[A-Za-z0-9_./:-]{8,200}$/.test(String(req.headers['idempotency-key']||'')))return reply(400,{error:'invalid_website_submission'});
 if(body.type&&body.type!=='lead')return reply(400,{error:'sales_leads_only'});
 const result=await handlePublicIntake({method:'POST',headers:req.headers,body:{...body,type:'lead'},websiteIntegration:true});
 reply(result.status,result.body);
};
