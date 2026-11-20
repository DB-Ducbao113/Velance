#!/usr/bin/env node
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PHOTO_ARCHIVE } from '../../src/data/archive-catalog.js';
import { VEHICLES } from '../../src/data/vehicles.js';
const root=process.env.TEST_ORIGIN||'http://127.0.0.1:8090';
const shots=process.env.QA_SHOT_DIR||'tools/perf/results/archive-review';
mkdirSync(shots,{recursive:true});
const modes=process.env.QA_BACKEND?[process.env.QA_BACKEND]:['webgl','webgpu'];
const viewports=[['desktop',{width:1440,height:900}],['mobile',{width:390,height:844,isMobile:true,hasTouch:true}]];
assert(modes.every(x=>['webgl','webgpu'].includes(x)),'QA_BACKEND must be webgl|webgpu');
assert(!process.env.QA_VIEWPORT||viewports.some(([name])=>name===process.env.QA_VIEWPORT),'QA_VIEWPORT must be desktop|mobile');
const selectedViewports=viewports.filter(([name])=>!process.env.QA_VIEWPORT||name===process.env.QA_VIEWPORT);
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-webgpu','--window-size=1440,900']});
const results=[], cases=[];
let overall='FAIL';
try {
 for(const backend of modes) {
  for(const [name,viewport] of selectedViewports) {
   const context=await browser.createBrowserContext();
   const page=await context.newPage(), errors=[],warnings=[],requests=[];
   const evidence={requestedBackend:backend,viewport:name,actualBackend:null,stage:'initialization',errors,warnings,status:'FAIL'};
   cases.push(evidence);
   page.on('pageerror',e=>errors.push(e.message)); page.on('console',m=>{if(m.type()==='error') errors.push(m.text());if(m.type()==='warn') warnings.push(m.text());});page.on('request',r=>requests.push(r.url()));
   // Observe the app's own WebGPU calls; do not create a second adapter/device
   // or change the requested options to manufacture a passing backend.
   await page.evaluateOnNewDocument(()=>{
    const events=window.__archiveGpuEvents=[];
    const wrap=(proto,key,success)=>{
     if(!proto||typeof proto[key]!=='function')return;
     const original=proto[key];
     try {
      proto[key]=function(...args){
       const event={method:key,options:args[0]??null};
       events.push(event);
       try{return Promise.resolve(original.apply(this,args)).then(value=>{
        event.result=value?'resolved':'null';success?.(value,event);return value;
       },error=>{event.result='rejected';event.error=String(error);throw error;});}
       catch(error){event.result='threw';event.error=String(error);throw error;}
      };
     }catch(error){events.push({method:key,observerError:String(error)});}
    };
    wrap(globalThis.GPU?.prototype,'requestAdapter',(adapter,event)=>{
     if(adapter)event.adapterInfo={architecture:adapter.info?.architecture,vendor:adapter.info?.vendor,isFallbackAdapter:adapter.info?.isFallbackAdapter};
    });
    wrap(globalThis.GPUAdapter?.prototype,'requestDevice',(device)=>{
     device?.lost.then(info=>events.push({method:'device.lost',reason:info.reason,message:info.message}));
    });
   });
   try {
   await page.setViewport(viewport);
   await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
   await page.goto(root+'/index.html?nointro&notelemetry&backend='+backend,{waitUntil:'load'});
   const wait=(f,...a)=>page.waitForFunction(f,{timeout:90000},...a);
   await wait(()=>window.__VELANCE_QA__?.engine?.initialReady);
   evidence.actualBackend=await page.evaluate(()=>window.__VELANCE_QA__.stats().backend);
   assert.equal(evidence.actualBackend,backend==='webgl'?'webgl2':'webgpu','Actual renderer backend must match requested backend');
   evidence.stage='overview';
   await page.click('#overviewBtn');
   await wait(()=>window.__VELANCE_QA__.engine.overview&&!window.__VELANCE_QA__.engine.flight&&window.__VELANCE_QA__.engine.cars.size===16);
   await page.screenshot({path:join(shots,backend+'-'+name+'-overview.png')});
   if(name==='mobile') assert.equal(await page.$$eval('.overview-picker option',x=>x.length),16);
   for(const carId of ['mclarenp1','tourbillon24','jesko25','mclaren765lt','valkyrie']){
    const carIndex=VEHICLES.findIndex(v=>v.id===carId), photos=PHOTO_ARCHIVE[carId]||[];
    evidence.stage='selection:'+carId;
    if(name==='mobile'){await page.select('.overview-picker select',String(carIndex));await page.click('.overview-picker button');}
    else await page.evaluate(i=>document.querySelector('.bay-label[data-index="'+i+'"]').click(),carIndex);
    await wait(i=>window.__VELANCE_QA__.selected===i&&window.__VELANCE_QA__.engine.controls?.enabled&&window.__VELANCE_QA__.boardCount>0,carIndex);
    const d=await page.evaluate(()=>({count:document.querySelectorAll('.archive-tile').length,kind:document.querySelector('#boardGrid').dataset.kind,chapters:document.querySelectorAll('.shot-section').length,hidden:document.querySelector('#navReview').hidden,back:document.querySelectorAll('.selected-actions button').length,settings:!!document.querySelector('#velance-telemetry-settings'),overflow:document.documentElement.scrollWidth-innerWidth,swatches:[...document.querySelectorAll('.paint-swatch')].map(x=>Math.round(x.getBoundingClientRect().width))}));
    assert.equal(d.count,photos.length||5);assert.equal(d.kind,photos.length?'photo':'render');assert.equal(d.chapters,0);assert(d.hidden&&!d.settings&&d.overflow<=0);assert.equal(d.back,1);
    if(name==='mobile') assert(d.swatches.every(x=>x>=44));
    if(carId==='mclarenp1') await page.screenshot({path:join(shots,backend+'-'+name+'-detail.png')});
    evidence.stage='archive:'+carId;
    await page.click('#discoverImages');await wait(()=>document.querySelector('#board').getBoundingClientRect().top<innerHeight*.65);
    await page.evaluate(()=>document.querySelector('.archive-tile').scrollIntoView({block:'center',behavior:'instant'}));
    await wait(()=>{const i=document.querySelector('.archive-tile img');return i.complete&&i.naturalWidth>0;});
    if(carId==='mclarenp1') await page.screenshot({path:join(shots,backend+'-'+name+'-archive.png')});
    if(photos.length && photos[0].full!==photos[0].medium && photos[0].full!==photos[0].thumb) assert(!requests.some(u=>u.endsWith(photos[0].full.slice(1))),'viewer-size image loaded before opening');
    evidence.stage='viewer:'+carId;
    await page.click('.archive-tile');
    await wait(()=>document.querySelector('#archiveViewer').open&&!document.querySelector('#viewerImage').hidden&&document.querySelector('#viewerImage').complete&&document.querySelector('#viewerImage').naturalWidth>0);
    assert.equal(await page.$eval('#viewerCredit',el=>el.querySelectorAll('a').length),photos.length?2:0);
    if(photos.length) assert.equal(await page.$eval('#viewerImage',el=>el.naturalWidth),photos[0].width);
    if(photos.length>1 || !photos.length){
      if(name==='mobile') {
        const bounds=await page.$eval('#viewerImage',el=>{const b=el.getBoundingClientRect();return {x:b.x+b.width*.75,y:b.y+b.height*.5};});
        const cdp=await page.createCDPSession();
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[bounds]});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:bounds.x-100,y:bounds.y}]});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        await cdp.detach();
      } else await page.keyboard.press('ArrowRight');
      await wait(()=>document.querySelector('#viewerCount').textContent.startsWith('02'));
      await page.keyboard.press('ArrowLeft');
      await wait(()=>!document.querySelector('#viewerImage').hidden);
    }
    if(carId==='mclarenp1') await page.screenshot({path:join(shots,backend+'-'+name+'-viewer.png')});
    evidence.stage='return:'+carId;
    await page.keyboard.press('Escape');await wait(()=>!document.querySelector('#archiveViewer').open);assert.equal(await page.evaluate(()=>window.__VELANCE_QA__.selected),carIndex);
    await page.evaluate(()=>document.querySelector('#boardBack').scrollIntoView({block:'center',behavior:'instant'}));
    await page.click('#boardBack');await wait(()=>window.__VELANCE_QA__.selected===null&&!window.__VELANCE_QA__.engine.flight&&window.__VELANCE_QA__.boardCount===0);
    assert.equal(await page.evaluate(()=>window.__VELANCE_QA__.overview),true);
    assert.equal(await page.evaluate(()=>window.__VELANCE_QA__.stats().backend),evidence.actualBackend);
    results.push({backend,name,carId,kind:d.kind,images:d.count});
    console.log('PASS',backend,name,carId,d.kind,d.count);
   }
   assert.deepEqual(errors,[]);
   assert(!warnings.some(w=>/WebGPU is not available|device lost|context lost|3D engine unavailable/i.test(w)),JSON.stringify(warnings));
   evidence.stage='completed';evidence.status='PASS';
   } catch(error) {
    evidence.failure=String(error);
    throw error;
   } finally {
    try {
     evidence.state=await page.evaluate(()=>({
      url:location.href,secureContext:isSecureContext,hasGPU:!!navigator.gpu,userAgent:navigator.userAgent,
      viewport:[innerWidth,innerHeight,devicePixelRatio],stats:window.__VELANCE_QA__?.stats(),
      engineError:window.__VELANCE_QA__?.engineError, fallback:window.__VELANCE_QA__?.fallback,
      gpuEvents:window.__archiveGpuEvents||[]
     }));
     const lost=evidence.state.gpuEvents.some(e=>e.method==='device.lost'&&e.reason!=='destroyed');
     if(lost){evidence.status='FAIL';evidence.failure||='Unexpected GPU device loss';}
     if(await page.evaluate(()=>!!window.__VELANCE_QA__?.engine)){
      await page.evaluate(()=>window.__VELANCE_QA__.engine.dispose());
      evidence.disposed=true;
     }
    } catch(error) {evidence.cleanupError=String(error);evidence.status='FAIL';}
    finally {await context.close();}
    console.log('CASE',JSON.stringify(evidence));
    assert.equal(evidence.status,'PASS',JSON.stringify(evidence));
   }
  }
 }
 // Visitor UI must not activate old consent. Explicit diagnostics remains local-only,
 // using a forced-off URL here so no real telemetry API or database is touched.
 if(!process.env.QA_BACKEND&&!process.env.QA_VIEWPORT){
 const smallContext=await browser.createBrowserContext();
 const small=await smallContext.newPage(), diagnosticRequests=[];
 small.on('request',r=>{if(r.url().includes('/api/telemetry')) diagnosticRequests.push(r.method());});
 await small.setViewport({width:320,height:640,isMobile:true,hasTouch:true});
 await small.evaluateOnNewDocument(()=>{try{localStorage.setItem('velance_telemetry_consent_v1',JSON.stringify({version:1,decision:'granted',at:Date.now()}));}catch{}});
 await small.goto(root+'/index.html?nointro&backend=webgl',{waitUntil:'load'});
 await small.waitForFunction(()=>window.__VELANCE_QA__?.engine?.initialReady,{timeout:90000});
 assert.equal(await small.$('#velance-telemetry-settings'),null);
 assert.equal(await small.evaluate(()=>!!window.__VELANCE_TELEMETRY__),false);
 await small.goto(root+'/index.html?nointro&notelemetry&diagnostics=1&backend=webgl',{waitUntil:'load'});
 await small.waitForSelector('#velance-telemetry-settings summary',{visible:true});
 await small.click('#velance-telemetry-settings summary');
 const panel=await small.$eval('.velance-consent-body',el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,viewport:innerWidth};});
 assert(panel.left>=0&&panel.right<=panel.viewport,JSON.stringify(panel));
 await small.screenshot({path:join(shots,'small-local-diagnostics.png')});
 await small.keyboard.press('Escape');
 assert.equal(await small.$eval('#velance-telemetry-settings details',el=>el.open),false);
 assert.deepEqual(diagnosticRequests,[]);await small.evaluate(()=>window.__VELANCE_QA__.engine.dispose());await smallContext.close();console.log('PASS small diagnostics isolated');
 }
 overall='PASS';
} finally { try{await browser.close();}finally{
 writeFileSync(join(shots,'results.json'),JSON.stringify(results,null,2));
 writeFileSync(join(shots,'case-diagnostics.json'),JSON.stringify({overall,requestedBackends:modes,requestedViewports:selectedViewports.map(([name])=>name),expectedCases:modes.length*selectedViewports.length*5,passedCases:results.length,diagnosticsIncluded:!process.env.QA_BACKEND&&!process.env.QA_VIEWPORT,cases},null,2));
}}
