'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
test('READY plus delayed iframe load never replaces current edits; a new frame can restore',()=>{
 const source=fs.readFileSync('modules/studio-workspace.js','utf8'),start=source.indexOf('const initialize ='),end=source.indexOf('    useEffect(',start);const sent=[];
 const c={current:{current:{editor:{nonce:'frame1',payload:{title:'Saved'},kind:'brief'},ctx:{lang:'en'}}},initialized:{current:null},list:{tasks:[]},post:m=>sent.push(m)};vm.createContext(c);vm.runInContext(source.slice(start,end)+';globalThis.init=initialize;',c);
 c.init('document1');assert.equal(sent.length,1);c.current.current.editor.payload={title:'Changed while ready'};c.init('document1');assert.equal(sent.length,1);c.init('document2');assert.equal(sent.length,2);assert.equal(sent[1].payload.title,'Changed while ready');c.current.current.editor.nonce='frame2';c.init('document2');assert.equal(sent.length,3);
});
test('PDF overflow expands only affected pages, including cover collisions',()=>{
 const source=fs.readFileSync('magnet-studio/app.js','utf8'),start=source.indexOf('function fitPDFPages('),end=source.indexOf('function exportPDF(',start);
 const page=(height,content,collision=false)=>({clientHeight:height,scrollHeight:content,expanded:false,classList:{add(){this.owner.expanded=true;}},querySelector(s){if(s==='.brand-foot')return {getBoundingClientRect:()=>({top:height-20})};if(collision&&s==='.cover-copy')return {getBoundingClientRect:()=>({bottom:600})};if(collision&&s==='.cover-facts')return {getBoundingClientRect:()=>({top:500})};return null;},querySelectorAll:()=>[],getBoundingClientRect:()=>({bottom:height})});
 const pages=[page(1100,1100),page(1100,2400),page(1100,1100,true)];pages.forEach(p=>p.classList.owner=p);const c={};vm.createContext(c);vm.runInContext(source.slice(start,end),c);c.fitPDFPages({querySelectorAll:()=>pages});assert.deepEqual(pages.map(p=>p.expanded),[false,true,true]);
});
test('login completion preserves authorized Studio intent and rejects unauthorized roles',()=>{
 const source=fs.readFileSync('index.html','utf8'),start=source.indexOf('const protectedEntryRoute='),end=source.indexOf('\n',start);const c={URLSearchParams,location:{search:'?open=studio'},appSettings:{},canView:(_,role)=>role==='Content Creator',moduleEnabled:()=>true,userSeesModule:()=>true};vm.createContext(c);vm.runInContext(source.slice(start,end)+';globalThis.entry=protectedEntryRoute;',c);assert.equal(c.entry({role:'Content Creator'}),'studio');assert.equal(c.entry({role:'Finance'}),'dashboard');assert.equal(c.entry(null),'dashboard');c.moduleEnabled=()=>false;assert.equal(c.entry({role:'Content Creator'}),'dashboard');
});
