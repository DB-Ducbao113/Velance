#!/usr/bin/env node
// Browser acceptance: every real bay, returning to the same gallery context,
// canceling flights, and returning from deep editorial scrolling.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const backend = process.env.QA_BACKEND || 'webgpu';
const mobile = process.env.QA_MOBILE === '1';
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8090';
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--enable-unsafe-webgpu','--window-size=1440,900'] });
const wait = (page, fn, ...args) => page.waitForFunction(fn, {timeout: 90000}, ...args);
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.setViewport(mobile ? {width:390,height:844,isMobile:true,hasTouch:true} : {width:1440,height:900});
  await page.goto(`${origin}/index.html?nointro&notelemetry&backend=${backend}`, {waitUntil:'load'});
  await wait(page, () => window.__VELANCE_QA__?.engine?.initialReady);
  await page.click('#overviewBtn');
  await wait(page, () => { const e=window.__VELANCE_QA__.engine; return e.overview && !e.flight && e.cars.size===16; });
  const baseline = await page.evaluate(() => {
    const e=window.__VELANCE_QA__.engine;
    e.ovPan=e.ovTarget=Math.min(1.7,e.ovLimit); e.applyOverviewCamera();
    return {pan:e.ovPan,focus:e.focus,row:e.row};
  });
  const indices = process.env.QA_BAYS ? process.env.QA_BAYS.split(',').map(Number) : mobile ? [0,7,8,15] : Array.from({length:16},(_,i)=>i);
  const summary=[];
  async function select(index) {
    await page.evaluate(index => {
      const e=window.__VELANCE_QA__.engine;
      window.__flightSamples=[];
      const sample=()=>{
        const f=e.flight;
        if (!f?.selection) return;
        const p=e.camera.position, v=f.toLook.clone().project(e.camera);
        window.__flightSamples.push({t:f.t,x:p.x,y:p.y,z:p.z,u:v.x,v:v.y,visible:e.cars.get(index)?.visible===true});
        requestAnimationFrame(sample);
      };
      document.querySelector(`.bay-label[data-index="${index}"]`).click();
      requestAnimationFrame(sample);
    },index);
    await wait(page,index=>window.__VELANCE_QA__.selected===index && window.__VELANCE_QA__.engine.flight?.selection,index);
  }
  async function assertHome(expected) {
    await wait(page,()=>{const e=window.__VELANCE_QA__.engine;return !e.flight&&!e.returning&&e.mode==='home';});
    const result=await page.evaluate(()=>{
      const e=window.__VELANCE_QA__.engine, q=window.__VELANCE_QA__, pose=e.overview?e.overviewPose():e.homePose(e.position);
      return {overview:e.overview,pan:e.ovPan,focus:e.focus,row:e.row,position:e.position,target:e.target,selected:q.selected,viewOffset:!!e.camera.view?.enabled,poseError:e.camera.position.distanceTo(pose.pos),alpha:[...e.cars.values()].every(c=>Math.abs((c.userData.displayAlpha??1)-1)<.001),visible:[...e.cars].filter(([,c])=>c.visible).map(([i])=>i),controls:!!e.controls,detail:e.detailSet.visible,shadow:e.keyShadow.intensity,reflect:e.reflectOn,reviewHidden:document.getElementById('review').hidden,reviewCount:q.reviewCount,boardCount:q.boardCount,imageCount:q.imageCount,scroll:window.scrollY,fallback:document.querySelectorAll('#selectedModelHost img').length,classes:document.getElementById('showroom').className,overviewButton:document.getElementById('overviewBtn').getAttribute('aria-pressed')};
    });
    assert.equal(result.overview,expected.overview);
    assert.equal(result.focus,expected.focus); assert.equal(result.row,expected.row);
    assert(Math.abs(result.pan-(expected.pan||0))<.01);
    assert.equal(result.position,result.target); assert.equal(result.selected,null);
    assert(!result.viewOffset&&!result.controls&&!result.detail&&result.alpha&&result.shadow===0);
    assert(result.poseError<1.5,JSON.stringify(result));
    assert.equal(result.reflect,!expected.overview); assert.equal(result.overviewButton,String(expected.overview));
    assert(result.reviewHidden&&result.reviewCount===0&&result.boardCount===0&&result.imageCount===0&&result.fallback===0);
    assert(result.scroll<16&&!/is-selected|is-approaching|reveal-selected/.test(result.classes),JSON.stringify(result));
    if(expected.overview) assert.equal(result.visible.length,16);
    else assert(result.visible.includes(expected.focus)&&result.visible.every(i=>Math.floor(i/8)===expected.row));
  }
  for(const index of indices){
    await select(index);
    const duration=await page.evaluate(()=>window.__VELANCE_QA__.engine.flight.dur);
    await wait(page,()=>window.__VELANCE_QA__.engine.controls?.enabled&&window.__VELANCE_QA__.boardCount>0&&window.__VELANCE_QA__.reviewCount===0);
    const sample=await page.evaluate(index=>{
      const e=window.__VELANCE_QA__.engine, samples=window.__flightSamples;
      return {index,samples:samples.length,minY:Math.min(...samples.map(v=>v.y)),subjectVisible:samples.every(v=>v.visible),tracked:samples.filter(v=>v.t>=.40&&v.t<=.98).every(v=>Math.abs(v.u)<.99&&Math.abs(v.v)<.99),safe:samples.filter(v=>v.y<5).every(v=>Math.abs(v.x)<28&&Math.abs(v.z)<7.5),final:e.camera.position.distanceTo(e.heroPose(index).pos),loaded:e.cars.has(index),offset:e.camera.view?.enabled};
    },index);
    assert(duration>=2.8&&duration<=5.2);
    assert(sample.samples>20&&sample.subjectVisible&&sample.tracked&&sample.safe&&sample.loaded&&sample.offset&&sample.final<.01,JSON.stringify(sample));
    if(index===indices[0]){
      await page.click('#navBoard');
      try { await page.waitForFunction(()=>window.scrollY>innerHeight*.5,{timeout:15000}); }
      catch (error) {
        console.error('archive scroll diagnostics',await page.evaluate(()=>({scroll:scrollY,height:document.documentElement.scrollHeight,boardTop:document.querySelector('#board').getBoundingClientRect().top,reviewHidden:document.querySelector('#review').hidden,navHidden:document.querySelector('#navBoard').hidden,motion:window.__VELANCE_MOTION_QA__})));
        throw error;
      }
      await page.waitForFunction(()=>document.querySelector('#board').getBoundingClientRect().top<innerHeight*.6,{timeout:15000});
      await page.evaluate(()=>document.querySelector('#boardBack').scrollIntoView({behavior:'instant',block:'center'}));
      await page.waitForFunction(()=>{const b=document.querySelector('#boardBack'),r=b.getBoundingClientRect();return r.top>0&&r.bottom<innerHeight&&Number(getComputedStyle(b.parentElement).opacity)>.95&&b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));},{timeout:15000});
      await page.click('#boardBack');
    }else if(index%2===0) await page.click('#backToGarageTop');
    else await page.click('#backToGarageTop');
    await assertHome({...baseline,overview:true});
    summary.push({bay:index+1,duration:+duration.toFixed(2),samples:sample.samples});
    console.log(`PASS bay ${index+1}: ${duration.toFixed(2)}s path, subject tracked, BACK restores all sixteen`);
  }
  // Cancel at two different points; a delayed image job must not reopen detail.
  for(const progress of [.28,.88]){
    await select(15);
    await wait(page,p=>window.__VELANCE_QA__.engine.flight?.t>=p,progress);
    if(progress<.5) await page.click('#cancelApproach'); else await page.keyboard.press('Escape');
    await assertHome({...baseline,overview:true});
    console.log(`PASS canceled approach at ${progress}`);
  }
  await page.click('#overviewBtn');
  await wait(page,()=>!window.__VELANCE_QA__.engine.flight&&!window.__VELANCE_QA__.overview);
  await page.click('#rowBtn');
  await wait(page,()=>!window.__VELANCE_QA__.engine.flight&&window.__VELANCE_QA__.row===1);
  const rowFocus=await page.evaluate(()=>window.__VELANCE_QA__.focus);
  await page.click('#selectCar');
  await wait(page,()=>window.__VELANCE_QA__.engine.controls?.enabled&&window.__VELANCE_QA__.boardCount>0&&window.__VELANCE_QA__.reviewCount===0);
  await page.click('#backToGarageTop');
  await assertHome({overview:false,focus:rowFocus,row:1,pan:0});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({backend,mobile,bays:summary,cancelCases:2,archiveBack:true,rowBack:true}));
}finally{await browser.close();}
