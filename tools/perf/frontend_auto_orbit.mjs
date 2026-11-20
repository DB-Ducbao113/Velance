import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
const backend=process.env.QA_BACKEND||'webgpu', mobile=process.env.QA_MOBILE==='1', shots=process.env.QA_SHOT_DIR;
if(shots)mkdirSync(shots,{recursive:true});
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-webgpu','--window-size=1440,900']});
try{
  const page=await browser.newPage(), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.setViewport(mobile?{width:390,height:844,isMobile:true,hasTouch:true}:{width:1440,height:900});
  const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:8090';
  const wait=(fn,...args)=>page.waitForFunction(fn,{timeout:60000},...args);
  await page.goto(`${origin}/index.html?nointro&notelemetry&backend=${backend}`,{waitUntil:'load'});
  await wait(()=>window.__VELANCE_QA__?.engine?.initialReady);
  await page.click('#overviewBtn');
  await wait(()=>{const e=window.__VELANCE_QA__.engine;return e.overview&&!e.flight&&e.cars.size===16;});
  assert(await page.evaluate(()=>{const e=window.__VELANCE_QA__.engine;return e.overviewApron.visible&&e.hallArchitecture.visible&&!e.studioGroup.visible;}));
  if(shots)await page.screenshot({path:`${shots}/${backend}-${mobile?'mobile':'desktop'}-overview.png`});
  for(const index of (mobile?[15]:[0,15])){
    await page.evaluate(i=>document.querySelector(`.bay-label[data-index="${i}"]`).click(),index);
    await wait(()=>!!window.__VELANCE_QA__.engine.autoShot);
    await wait(()=>window.__VELANCE_QA__.engine.detailResident?.index===window.__VELANCE_QA__.engine.selected);
    await page.evaluate(()=>{
      const e=window.__VELANCE_QA__.engine,car=e.cars.get(e.selected),start=car.position.clone();
      const logo=e.studioMark.getWorldPosition(start.clone()), logoQ=e.studioMark.getWorldQuaternion(e.camera.quaternion.clone());
      window.orbitSamples=[];
      const tick=()=>{
        if(!e.autoShot)return;
        const p=e.camera.position,c=e.controls.target,offset=p.clone().sub(c),v=c.clone().project(e.camera);
        const relative=p.clone().sub(e.studioGroup.position);
        window.orbitSamples.push({angle:Math.atan2(offset.x,offset.z),elapsed:e.autoShot.elapsed,y:p.y,visible:car.visible,stationary:car.position.distanceTo(start)<.001,tracked:Math.abs(v.x)<.99&&Math.abs(v.y)<.99,wallClear:e.studioActive&&e.studioGroup.visible&&!e.hallArchitecture.visible&&Math.hypot(relative.x,relative.z)<e.studioRadius-1&&relative.y>0&&relative.y<7.6,logoFixed:e.studioMark.getWorldPosition(start.clone()).distanceTo(logo)<.0001&&e.studioMark.getWorldQuaternion(e.camera.quaternion.clone()).angleTo(logoQ)<.0001,position:p.toArray()});
        requestAnimationFrame(tick);
      }; requestAnimationFrame(tick);
    });
    await wait(()=>window.__VELANCE_QA__.engine.autoShot.elapsed>8.65);
    if(shots)await page.screenshot({path:`${shots}/${backend}-${index+1}-rear.png`});
    await wait(()=>window.__VELANCE_QA__.engine.autoShot.elapsed>16.4);
    const report=await page.evaluate(()=>{
      const a=window.orbitSamples;let swept=0,maxStep=0;
      for(let i=1;i<a.length;i++){
        const d=a[i].angle-a[i-1].angle;swept+=Math.atan2(Math.sin(d),Math.cos(d));
        maxStep=Math.max(maxStep,Math.hypot(...a[i].position.map((n,k)=>n-a[i-1].position[k])));
      }
      return {degrees:Math.abs(swept)*180/Math.PI,samples:a.length,maxStep,allVisible:a.every(s=>s.visible&&s.stationary&&s.tracked&&s.wallClear&&s.logoFixed)};
    });
    assert(report.degrees>350&&report.samples>200&&report.maxStep<.5&&report.allVisible,JSON.stringify(report));
    // User gesture interrupts the track without snapping back to the opening pose.
    const host=await page.$('#selectedModelHost'),b=await host.boundingBox();
    await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2+30,b.y+b.height/2,{steps:4});await page.mouse.up();
    await wait(()=>!window.__VELANCE_QA__.engine.autoShot);
    await page.click('#autoOrbit');await wait(()=>!!window.__VELANCE_QA__.engine.autoShot);
    await wait(()=>window.__VELANCE_QA__.engine.autoShot.elapsed>8.65);
    await page.click('#backToGarageTop');
    await wait(()=>{const e=window.__VELANCE_QA__.engine;return !e.flight&&e.overview&&!e.returning&&e.selected===null;});
    assert(await page.evaluate(()=>{const e=window.__VELANCE_QA__.engine;return !e.autoShot&&!e.controls&&!e.studioActive&&!e.studioGroup.visible&&e.hallArchitecture.visible&&e.overviewApron.visible&&e.northGroup.visible&&[...e.sideGroups.values()].every(g=>g.visible)&&[...e.cars.values()].every(c=>c.visible)&&Number(e.studioCurtain.style.opacity)===0; }));
    assert(await page.evaluate(()=>{const e=window.__VELANCE_QA__.engine;return e.overviewGallery.parent===e.overviewApron&&e.overviewGallery.visible&&e.overviewGallery.userData.sides===4&&e.overviewGallery.children.every(m=>m.isInstancedMesh)&&e.bayArchitecture.children.every(m=>m.count===18);}));
    if(shots)await page.screenshot({path:`${shots}/${backend}-${mobile?'mobile':'desktop'}-back-${index+1}.png`});
    console.log(JSON.stringify({backend,mobile,bay:index+1,...report,manualInterrupt:true,resume:true,back:true}));
  }
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.goto(`${origin}/index.html?nointro&notelemetry&backend=${backend}`,{waitUntil:'load'});
  await wait(()=>window.__VELANCE_QA__?.engine?.initialReady);
  await page.click('#selectCar');await wait(()=>window.__VELANCE_QA__.engine.controls?.enabled);
  assert(await page.evaluate(()=>!window.__VELANCE_QA__.engine.autoShot&&document.querySelector('#autoOrbit').disabled));
  assert.deepEqual(errors,[]);console.log('PASS reduced-motion, no browser errors');
}finally{await browser.close();}
