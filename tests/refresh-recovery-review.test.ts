import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Window } from 'happy-dom';
import { IDBFactory } from 'fake-indexeddb';
import { runInNewContext } from 'node:vm';
import { DEFAULTS } from '../src/core';
import { listHTML } from './fixtures.mjs';

// Independent 0.1.9 review: execute the existing content bundle; no product build,
// browser, live forum or DAV. Only long cache timeout scheduling is accelerated.
const dir = process.env.NSFLOW_RECOVERY_BUNDLE_DIR || resolve('dist');
const bundle = await readFile(resolve(dir, 'content.js'), 'utf8');
const files = ['src/client.ts','src/content.ts','src/background.ts','src/db.ts','dist/content.js','dist/background.js','dist/manifest.json','tests/refresh-recovery-review.test.ts'];
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async p => [p,createHash('sha256').update(await readFile(p)).digest('hex')])));
const before = await hashes();
test.after(async () => console.log('RECOVERY_REVIEW_EVIDENCE ' + JSON.stringify({at:new Date().toISOString(),before,after:await hashes(),manifest:JSON.parse(await readFile(resolve(dir,'manifest.json'),'utf8')).version})));
const pause = (ms=10) => new Promise(r=>setTimeout(r,ms));
async function until(fn:()=>unknown, message:string, ms=1800) {
  const end=Date.now()+ms;
  while(Date.now()<end) { if(fn()) return; await pause(); }
  assert.ok(fn(),message);
}
const cacheKey=(p:any)=>p.account+'|'+p.kind+'|'+(p.kind==='session'?'1|':'')+p.key;
const ids=(w:Window)=>[...w.document.querySelectorAll('.post-list > .post-list-item')].map(e=>(e as any).dataset.nfId||e.querySelector('.post-title a')?.getAttribute('href')?.match(/post-(\d+)/)?.[1]);
const fresh=()=>listHTML().replaceAll('post-101-1','post-999-1').replace('给阅读留一点空间','恢复后的新帖子');
type Fault = { type:'cacheGet'|'cachePut'; matches:(p:any)=>boolean; mode:'hang'|'reject' };
async function fixture(t:any, cfg:{html?:string;hot?:boolean;initialFault?:Fault;url?:string}={}) {
  const w=new Window({url:cfg.url||'https://www.nodeseek.com/?sortBy=replyTime'});
  w.document.write(cfg.html||listHTML());
  const rows=new Map<string,any>(); const calls:{type:string;payload:any;expiresAt?:number;fault:boolean}[]=[];
  let fault=cfg.initialFault; let triggered=0;
  const timer=w.setTimeout.bind(w); const timers:number[]=[];
  // Keep normal debounce/scan timers unchanged. 15s cache timeouts become 60ms.
  Object.assign(w,{setTimeout:(fn:any,ms?:number,...args:any[])=>{
    if(ms && ms>=10000 && ms<=20000) { timers.push(ms); return timer(fn,60,...args); }
    return timer(fn,ms,...args);
  }});
  const pointer=()=>[...rows.entries()].find(([k])=>k.includes('|session|1|')&&!k.includes('|snapshot:'))?.[1];
  Object.assign(w,{
    matchMedia:()=>({matches:false,addEventListener(){}}),
    chrome:{runtime:{sendMessage:async(m:any)=>{
      const p=m.payload||{};
      if(m.type==='cacheGet'||m.type==='cachePut') {
        const hit=!!fault&&fault.type===m.type&&fault.matches(p);
        calls.push({type:m.type,payload:structuredClone(p),expiresAt:m.expiresAt,fault:hit});
        if(hit) { triggered++; if(fault!.mode==='hang') return new Promise(()=>{}); return {ok:false,error:'QA_CACHE_FAILURE'}; }
        if(m.type==='cacheGet') return {ok:true,result:structuredClone(rows.get(cacheKey(p))||null)};
        rows.set(cacheKey(p),structuredClone(p.value)); return {ok:true,result:true};
      }
      if(m.type==='snapshot') return {ok:true,result:{settings:{...DEFAULTS,profiles:false,hot:cfg.hot??false},rules:[],ruleGroups:[],phrases:[],progress:[]}};
      if(m.type==='lease') return {ok:true,result:{token:'qa-cache-recovery'}};
      if(m.type==='hot') return {ok:true,result:{posts:[{id:999,title:'测试热榜',author:'QA',score:1}],at:Date.now()}};
      return {ok:true,result:true};
    },onMessage:{addListener(){}}}},
    fetch:async(url:any)=>new Response(String(url).includes('page-2')?listHTML(2):fresh()),
  });
  t.after(async()=>{await w.happyDOM.abort();});
  w.eval(bundle);
  const refresh=()=>w.document.querySelector<HTMLButtonElement>('#nf-refresh');
  const ready=async()=>{await until(()=>pointer()&&refresh()&&!refresh()!.disabled,'initial committed pointer and usable refresh'); await pause(30);};
  return {w,rows,calls,pointer,refresh,ready,timers,triggered:()=>triggered,setFault:(v?:Fault)=>{fault=v;},click:()=>{assert.ok(refresh(),'refresh control'); refresh()!.click();}};
}
const oldIds=['101','102'];
function intact(h:Awaited<ReturnType<typeof fixture>>, old:any) {
  assert.deepEqual(ids(h.w),oldIds,'failed refresh must preserve visible old rows');
  assert.equal(h.pointer()?.snapshot,old.snapshot,'failed refresh must not replace committed pointer');
  assert.deepEqual(h.pointer()?.urls,old.urls);
  assert.equal(h.w.document.querySelectorAll('.nf-update-divider').length,0);
  const anchors=Array.from({length:h.w.sessionStorage.length},(_,i)=>h.w.sessionStorage.key(i)!).filter(k=>k.startsWith('nf-anchor:'));
  for(const k of anchors) assert.equal(JSON.parse(h.w.sessionStorage.getItem(k)!).snapshot,old.snapshot,'fast anchor must reference committed snapshot');
}

test('recovery category query create-post anchor places hot panel after posting block',async t=>{
  const h=await fixture(t,{hot:true,url:'https://www.nodeseek.com/categories/daily',html:listHTML().replace('href="/new-discussion"','href="/new-discussion?category=daily"')});
  await until(()=>h.w.document.querySelector('#nf-hot-panel'),'hot panel exists');
  const post=h.w.document.querySelector('a[href*="new-discussion"]')!.parentElement!;
  assert.equal(post.nextElementSibling?.id,'nf-hot-panel');
  assert.equal(h.w.document.querySelectorAll('#nf-hot-panel').length,1);
});

test('recovery late posting block repositions existing hot panel in same sidebar without duplicates',async t=>{
  const h=await fixture(t,{hot:true,html:listHTML().replace('<div><a href="/new-discussion">＋ 发帖</a></div>','')});
  await until(()=>h.w.document.querySelector('#nf-hot-panel'),'fallback hot panel exists');
  const panel=h.w.document.querySelector('#nf-hot-panel');
  h.w.document.querySelector('#nsk-right-panel-container')!.insertAdjacentHTML('beforeend','<div id="late-post"><a href="/new-discussion?category=daily">发帖</a></div>');
  await until(()=>h.w.document.querySelector('#late-post')!.nextElementSibling===panel,'late posting anchor must trigger automatic reposition',2400);
  for(let n=0;n<3;n++) h.w.dispatchEvent(new h.w.Event('resize'));
  assert.equal(h.w.document.querySelectorAll('#nf-hot-panel').length,1);
  assert.equal(h.w.document.querySelector('#late-post')!.nextElementSibling,panel);
});

test('recovery sidebar mounted after startup receives one hot panel below query posting link',async t=>{
  const html=listHTML().replace(/<aside[\s\S]*?<\/aside>/,'');
  const h=await fixture(t,{hot:true,html}); await until(()=>h.refresh(),'startup navigation');
  h.w.document.querySelector('#nsk-body')!.insertAdjacentHTML('beforeend','<aside id="nsk-right-panel-container"><div id="late-post"><a href="/new-discussion?category=daily">发帖</a></div></aside>');
  await until(()=>h.w.document.querySelector('#late-post')!.nextElementSibling?.id==='nf-hot-panel','late sidebar populated and correctly positioned',2400);
  assert.equal(h.w.document.querySelectorAll('#nf-hot-panel').length,1);
});

for(const stage of ['snapshot','pointer'] as const) for(const mode of ['hang','reject'] as const) {
  test('recovery refresh '+stage+' cachePut '+mode+' restores both buttons, old pointer and retry',async t=>{
    const h=await fixture(t); await h.ready(); const old=structuredClone(h.pointer());
    h.setFault({type:'cachePut',mode,matches:p=>p.kind==='session'&&(stage==='snapshot'?p.key.startsWith('snapshot:')&&p.value.items?.some((i:any)=>i.id==='999'):!p.key.startsWith('snapshot:')&&p.value.snapshot!==old.snapshot)});
    h.click(); await until(()=>h.triggered()>0,'target cachePut reached');
    await until(()=>!h.refresh()!.disabled,'refresh must leave busy state after '+mode);
    const update=[...h.w.document.querySelectorAll<HTMLButtonElement>('.nf-pager button')].find(b=>b.textContent?.includes('更新'));
    assert.ok(update); assert.equal(update.disabled,false); intact(h,old);
    if(mode==='hang') { assert.ok(h.timers.length,'cache timeout must be scheduled'); const call=h.calls.find(c=>c.fault)!; assert.ok(Number.isFinite(call.expiresAt),'cache write must carry expiresAt'); }
    h.setFault(); h.click();
    await until(()=>h.pointer()?.snapshot!==old.snapshot&&!h.refresh()!.disabled,'retry commits a new snapshot and releases control');
    assert.deepEqual(ids(h.w),['999','101','102']);
    for(const url of h.pointer().urls) assert.ok([...h.rows.keys()].some(k=>k.endsWith('snapshot:'+h.pointer().snapshot+':'+url)),'committed pointer must reference stored pages');
  });
}

for(const mode of ['hang','reject'] as const) test('recovery initial cacheGet '+mode+' falls back to live rows and refresh remains usable',async t=>{
  const h=await fixture(t,{initialFault:{type:'cacheGet',mode,matches:()=>true}});
  await until(()=>h.triggered()>0,'initial cache read fault reached'); await h.ready();
  assert.deepEqual(ids(h.w),oldIds);
  if(mode==='hang') { assert.ok(h.timers.length); assert.ok(Number.isFinite(h.calls.find(c=>c.fault)!.expiresAt)); }
  h.setFault(); h.click(); await until(()=>ids(h.w).includes('999')&&!h.refresh()!.disabled,'manual refresh after cache read failure');
});

test('recovery public-page cache hang after snapshot commit does not strand refresh or roll back new pointer',async t=>{
  const h=await fixture(t); await h.ready(); const old=h.pointer().snapshot;
  h.setFault({type:'cachePut',mode:'hang',matches:p=>p.kind==='page'&&p.value.items?.some((i:any)=>i.id==='999')});
  h.click(); await until(()=>h.triggered()>0,'post-commit public cache write reached');
  await until(()=>!h.refresh()!.disabled,'post-commit cache timeout releases button');
  assert.notEqual(h.pointer().snapshot,old); assert.deepEqual(ids(h.w),['999','101','102']);
  const committed=h.pointer().snapshot; h.setFault(); h.click();
  await until(()=>!h.refresh()!.disabled,'repeat refresh ends'); assert.equal(h.pointer().snapshot,committed);
});

test('recovery repeated pagehide while persist is blocked coalesces work and does not starve refresh',async t=>{
  const h=await fixture(t); await h.ready(); const old=structuredClone(h.pointer());
  h.setFault({type:'cachePut',mode:'hang',matches:p=>p.kind==='session'&&!p.key.startsWith('snapshot:')&&p.value.snapshot===old.snapshot});
  for(let n=0;n<25;n++) h.w.dispatchEvent(new h.w.Event('pagehide'));
  await until(()=>h.triggered()>0,'blocked persist reached'); h.click();
  await until(()=>ids(h.w).includes('999')&&!h.refresh()!.disabled,'bounded persist backlog must let refresh finish',2400);
  assert.ok(h.triggered()<=2,'pagehide flood created '+h.triggered()+' old-snapshot pointer writes instead of coalescing');
  assert.notEqual(h.pointer().snapshot,old.snapshot);
});

async function backgroundFixture(t:any) {
  const factory=new IDBFactory();
  const db:any=await new Promise((resolve,reject)=>{
    const r=factory.open('nodeseek-flow',1);
    r.onupgradeneeded=()=>{const s=r.result.createObjectStore('cache',{keyPath:'key'});s.createIndex('at','at');s.createIndex('kind','kind');};
    r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  });
  const local:any={},session:any={}; let listener:any;
  const area=(data:any)=>({setAccessLevel:async()=>{},get:async(keys:any)=>Object.fromEntries((typeof keys==='string'?[keys]:Array.isArray(keys)?keys:Object.keys(keys||data)).map((k:string)=>[k,structuredClone(data[k])])),set:async(v:any)=>Object.assign(data,structuredClone(v)),remove:async(k:string)=>{delete data[k];}});
  const chrome={storage:{local:area(local),session:area(session)},runtime:{id:'qa',getURL:(p:string)=>'chrome-extension://qa/'+p,onMessage:{addListener:(f:any)=>listener=f},onInstalled:{addListener(){}},onStartup:{addListener(){}},openOptionsPage:async()=>{}},tabs:{query:async()=>[],sendMessage:async()=>{}},alarms:{create:async()=>{},onAlarm:{addListener(){}}},action:{onClicked:{addListener(){}}}};
  runInNewContext(await readFile(resolve(dir,'background.js'),'utf8'),{chrome,indexedDB:factory,crypto,structuredClone,console,URL,TextEncoder,TextDecoder,AbortSignal,setTimeout,clearTimeout,fetch:()=>{throw Error('QA forbids network');}});
  t.after(()=>db.close());
  const call=(type:string,payload:any={},expiresAt?:number)=>new Promise<any>(resolve=>listener({type,payload,expiresAt},{id:'qa',url:'https://www.nodeseek.com/',tab:{id:1}},resolve));
  const p={account:'999',kind:'session',key:'list:test|start:1'};
  const original={snapshot:'committed',urls:['page1'],at:Date.now()};
  assert.equal((await call('cachePut',{...p,value:original},Date.now()+2000)).ok,true);
  return {call,db,p,original};
}

test('recovery built backend refuses already expired pointer write and preserves old committed value',async t=>{
  const h=await backgroundFixture(t);
  const r=await h.call('cachePut',{...h.p,value:{snapshot:'expired'}},Date.now()-1);
  assert.equal(r.ok,false); assert.match(r.error,/超时|取消/);
  assert.deepEqual(JSON.parse(JSON.stringify((await h.call('cacheGet',h.p)).result)),h.original);
});

test('recovery built backend aborts queued pointer transaction at deadline and prevents late overwrite',async t=>{
  const h=await backgroundFixture(t);
  // A genuine fake-indexeddb readwrite transaction holds the object store busy.
  // The product write is queued behind it; backend deadline must abort that write.
  const blocker=h.db.transaction('cache','readwrite'); let keep=true;
  const done=new Promise<void>((resolve,reject)=>{blocker.oncomplete=()=>resolve();blocker.onabort=()=>resolve();blocker.onerror=()=>reject(blocker.error);});
  const pump=()=>{const request=blocker.objectStore('cache').get('qa-keep-alive');request.onsuccess=()=>{if(keep)pump();};}; pump();
  try {
    const r=await Promise.race([
      h.call('cachePut',{...h.p,value:{snapshot:'late-stale-pointer'}},Date.now()+60),
      pause(1000).then(()=>({ok:true,error:'deadline failed to settle'})),
    ]);
    assert.equal(r.ok,false,'queued transaction must abort before blocker releases'); assert.match(r.error,/超时|取消/);
  } finally { keep=false; await done; }
  await pause(30);
  assert.deepEqual(JSON.parse(JSON.stringify((await h.call('cacheGet',h.p)).result)),h.original,'aborted write must not overwrite pointer after queue unblocks');
  assert.equal((await h.call('cachePut',{...h.p,value:{...h.original,snapshot:'retried'}},Date.now()+2000)).ok,true);
  assert.equal((await h.call('cacheGet',h.p)).result.snapshot,'retried');
});
