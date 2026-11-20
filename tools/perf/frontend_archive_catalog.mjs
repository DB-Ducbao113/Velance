#!/usr/bin/env node
// Exercise every gallery/full-size file using the real production archive module,
// actual HTML markup and shared static delivery, without starting a GPU or DB.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { serveStatic } from '../delivery/static.mjs';
import { PHOTO_ARCHIVE } from '../../src/data/archive-catalog.js';
import { VEHICLES } from '../../src/data/vehicles.js';
const root=resolve(import.meta.dirname,'../..');
const shots=process.env.QA_SHOT_DIR||join(root,'tools/perf/results/archive-catalog');
mkdirSync(shots,{recursive:true});
const html=readFileSync(join(root,'index.html'),'utf8');
const archive=html.match(/<div id="review"[\s\S]*?<\/dialog>/)[0].replace('</main>','');
const fixture='<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles/main.css"><link rel="stylesheet" href="/styles/archive.css"><title>Archive fixture</title></head><body><header class="topbar"><a class="identity"><strong>VÉLANCE</strong></a><nav class="topnav"><a id="navBoard">ARCHIVE</a></nav></header><main>'+archive+'</main></body></html>';
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname==='/fixture') {res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(fixture);return;}
    await serveStatic(req,res,{root,path:decodeURIComponent(url.pathname),search:url.search,policy:'immutable'});
  } catch(err){if(res.headersSent)res.destroy();else{res.writeHead(err.status||500);res.end();}}
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;const results=[];
try {
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  for(const [name,viewport] of [['desktop',{width:1440,height:900}],['retina',{width:1440,height:900,deviceScaleFactor:2}],['small',{width:320,height:640,isMobile:true,hasTouch:true,deviceScaleFactor:2}]]) {
    const page=await browser.newPage(), errors=[], requests=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('response',r=>{
      const path=new URL(r.url()).pathname;
      if(path.startsWith('/assets/archive/')&&r.status()===200) requests.push({path,bytes:Number(r.headers()['content-length'])});
    });
    await page.setCacheEnabled(false);
    await page.setViewport(viewport);await page.goto(origin+'/fixture');
    await page.evaluate(async()=>{
      document.querySelector('#review').hidden=false;
      const {createArchive}=await import('/src/ui/archive.js');window.qa=createArchive(()=>{});
    });
    for(const v of VEHICLES) {
      const photos=PHOTO_ARCHIVE[v.id]||[];if(!photos.length) continue;
      const start=requests.length;
      await page.evaluate(v=>window.qa.render(v,[]),v);
      const count=await page.$$eval('.archive-tile',els=>els.length);assert.equal(count,photos.length);
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);assert(overflow<=0,`${name} ${v.id} overflow ${overflow}`);
      const gallerySrc=[];
      for(let i=0;i<count;i++) {
        const tile=(await page.$$('.archive-tile'))[i];await tile.evaluate(el=>el.scrollIntoView({block:'center'}));
        await page.waitForFunction(i=>{const im=document.querySelectorAll('.archive-tile img')[i];return im.complete&&im.naturalWidth>0&&!im.hidden;},{timeout:15000},i);
        gallerySrc.push(await page.$$eval('.archive-tile img',(els,i)=>new URL(els[i].currentSrc).pathname,i));
      }
      const galleryRequests=requests.slice(start).filter(r=>r.path.startsWith('/assets/archive/'+v.id+'/'));
      const galleryPaths=new Set(photos.flatMap(p=>[p.thumb,p.medium,p.large].filter(Boolean).map(p=>p.slice(1))));
      assert(galleryRequests.length>0,`No cold gallery requests: ${v.id}`);
      for(const r of galleryRequests){assert(galleryPaths.has(r.path),`Eager full viewer image: ${r.path}`);assert(Number.isFinite(r.bytes)&&r.bytes>0,r.path);}
      const galleryBytes=galleryRequests.reduce((n,r)=>n+r.bytes,0);
      assert(gallerySrc.every(p=>galleryPaths.has(p)),`Unexpected candidate: ${v.id}`);
      if(['mclaren765lt','valkyrie'].includes(v.id)) {
        await page.$eval('#board',el=>el.scrollIntoView({block:'start'}));
        await page.screenshot({path:join(shots,`${name}-${v.id}-gallery.png`)});
      }
      const viewerStart=requests.length;
      await page.evaluate(()=>document.querySelector('.archive-tile').click());
      for(let i=0;i<count;i++) {
        const p=photos[i];
        await page.waitForFunction((n,w,h)=>{const im=document.querySelector('#viewerImage');return document.querySelector('#viewerCount').textContent.startsWith(String(n).padStart(2,'0'))&&!im.hidden&&im.complete&&im.naturalWidth===w&&im.naturalHeight===h;},{timeout:15000},i+1,p.width,p.height);
        if(name==='small') {
          const dimensions=await page.evaluate(()=>({stage:document.querySelector('.viewer-stage').getBoundingClientRect().width,image:document.querySelector('#viewerImage').getBoundingClientRect().width}));
          assert(Math.abs(dimensions.stage-dimensions.image)<1,JSON.stringify(dimensions));
        }
        assert.equal(await page.$eval('#viewerCredit',el=>el.querySelectorAll('a').length),2);
        if(i+1<count) await page.click('#viewerNext');
      }
      assert.equal(await page.$eval('#viewerNext',el=>el.disabled),count===1);
      if(count>1) {
        // Rapid forward/back must settle to the final requested frame.
        await page.evaluate(()=>{const n=document.querySelector('#viewerNext'),p=document.querySelector('#viewerPrev');n.click();n.click();p.click();});
        const target=photos[0];await page.waitForFunction(p=>{const im=document.querySelector('#viewerImage');return !im.hidden&&im.naturalWidth===p.width&&im.src.endsWith(p.full.slice(1));},{timeout:15000},target);
      }
      if(['mclarenp1','jesko25','mclaren765lt','valkyrie'].includes(v.id)) await page.screenshot({path:join(shots,`${name}-${v.id}.png`)});
      await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#archiveViewer').open&&document.activeElement.className==='archive-tile'&&!document.body.classList.contains('archive-viewer-open'));
      const viewerRequests=requests.slice(viewerStart).filter(r=>r.path.startsWith('/assets/archive/'+v.id+'/'));
      results.push({name,id:v.id,verifiedImages:count,galleryBytes,gallerySrc,viewerBytes:viewerRequests.reduce((n,r)=>n+r.bytes,0),galleryRequests,viewerRequests});console.log('PASS',name,v.id,count,'gallery bytes',galleryBytes);
    }
    // Empty photographic album keeps a distinct render mode and no false credit.
    await page.evaluate(()=>window.qa.render({id:'missing-fixture',make:'TEST',name:'RENDER'},[{label:'Fallback',alt:'3D render',thumb:'/assets/images/mclarenp1/01-front-three-quarter.webp',medium:'/assets/images/mclarenp1/01-front-three-quarter.webp',full:'/assets/images/mclarenp1/01-front-three-quarter.webp'}]));
    assert.equal(await page.$eval('#boardGrid',el=>el.dataset.kind),'render');
    assert.match(await page.$eval('#archiveKind',el=>el.textContent),/3D RENDERS/);
    await page.evaluate(()=>document.querySelector('.archive-tile').click());
    await page.waitForFunction(()=>!document.querySelector('#viewerImage').hidden);
    assert.match(await page.$eval('#viewerCredit',el=>el.textContent),/not a photograph/);
    await page.click('#viewerClose');await page.waitForFunction(()=>!document.querySelector('#archiveViewer').open);
    assert.deepEqual(errors,[]);await page.close();
    console.log('PASS',name,'render fallback');
  }
} finally {if(browser)await browser.close();await new Promise(r=>server.close(r));writeFileSync(join(shots,'results.json'),JSON.stringify(results,null,2));}
