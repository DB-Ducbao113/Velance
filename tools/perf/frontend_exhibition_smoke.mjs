import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:8090';
const shots=process.env.QA_SHOT_DIR||'tools/perf/results/exhibition-final';
mkdirSync(shots,{recursive:true});
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-webgpu','--window-size=1671,896']});
try {
  const cases=[['webgpu','desktop',{width:1671,height:896}],[ 'webgl','mobile',{width:390,height:844,isMobile:true,hasTouch:true}]];
  for(const [backend,name,viewport] of cases){
    const page=await browser.newPage(),errors=[],diagnostics=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    page.on('request',r=>{if(r.url().includes('/api/telemetry')||r.url().includes('/telemetry/collector.js')) diagnostics.push(r.method()+' '+r.url());});
    // Even a valid legacy grant cannot activate diagnostics on the visitor URL.
    await page.evaluateOnNewDocument(()=>{
      if(window===window.top&&location.protocol.startsWith('http')){
        try{localStorage.setItem('velance_telemetry_consent_v1',JSON.stringify({version:1,decision:'granted',at:Date.now()}));}catch{}
      }
    });
    await page.setViewport(viewport);
    await page.goto(`${origin}/index.html?nointro&backend=${backend}`,{waitUntil:'load'});
    const wait=(fn,...args)=>page.waitForFunction(fn,{timeout:90000},...args);
    await wait(()=>window.__VELANCE_QA__?.engine?.initialReady);
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('velance_telemetry_consent_v1')).decision),'granted');
    await page.evaluate(async()=>{
      const THREE=await import('/vendor/three/three.webgpu.js');
      window.__inspectRoom=(checkCars=false)=>{
        const e=window.__VELANCE_QA__.engine,cam=e.camera,b=e.exhibitionBounds;
        e.scene.updateMatrixWorld(true);cam.updateMatrixWorld(true);
        const p=cam.position,ray=new THREE.Raycaster();ray.far=cam.far;
        let hits=0;
        for(const x of [-.95,-.5,0,.5,.95])for(const y of [-.95,-.5,0,.5,.95]){
          ray.setFromCamera(new THREE.Vector2(x,y),cam);
          if(ray.intersectObject(e.overviewApron,true).length)hits++;
        }
        const visible=[];
        if(checkCars)for(const [i,car] of e.cars){
          const center=car.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0,.65,0));
          const screen=center.clone().project(cam),direction=center.clone().sub(p),distance=direction.length();
          ray.set(p,direction.normalize());ray.far=distance-.1;
          const blocked=ray.intersectObjects([e.overviewApron,e.bayArchitecture],true).length>0;
          if(car.visible&&!blocked&&Math.abs(screen.x)<1&&Math.abs(screen.y)<1&&screen.z<1)visible.push(i);
        }
        return {hits,visible,inside:Math.abs(p.x)<b.halfX&&Math.abs(p.z)<b.halfZ&&p.y>b.floor&&p.y<b.ceiling,room:e.overviewApron.visible,studio:e.studioActive};
      };
    });
    await page.click('#overviewBtn');
    await wait(()=>{const e=window.__VELANCE_QA__.engine;return e.overview&&!e.flight&&e.cars.size===16;});
    const home=await page.evaluate(()=>window.__inspectRoom(true));
    assert(home.inside&&home.room&&home.hits===25&&home.visible.length===16,JSON.stringify(home));
    await page.screenshot({path:`${shots}/${name}-overview.png`});
    for(const index of [15,0]){
      if(name==='mobile'){
        await page.select('.overview-picker select',String(index));await page.click('.overview-picker button');
      }else await page.evaluate(i=>document.querySelector(`.bay-label[data-index="${i}"]`).click(),index);
      await wait(()=>{const e=window.__VELANCE_QA__.engine;return e.flight?.selection&&e.flight.t>.27;});
      const mid=await page.evaluate(()=>window.__inspectRoom());
      assert(mid.inside&&mid.room&&!mid.studio&&mid.hits===25,JSON.stringify(mid));
      await page.screenshot({path:`${shots}/${name}-bay-${index+1}-approach.png`});
      await wait(()=>window.__VELANCE_QA__.engine.controls?.enabled);
      assert(await page.evaluate(()=>window.__VELANCE_QA__.engine.studioActive&&!window.__VELANCE_QA__.engine.overviewApron.visible));
      await page.click('#backToGarageTop');
      await wait(()=>{const e=window.__VELANCE_QA__.engine;return e.overview&&!e.flight&&!e.returning&&e.selected===null;});
      await wait(()=>Number(getComputedStyle(document.querySelector('.bay-label.is-loaded:not(.is-off)')).opacity)>.5&&(getComputedStyle(document.querySelector('#overviewTitle')).display==='none'||Number(getComputedStyle(document.querySelector('#overviewTitle')).opacity)>.95));
      const back=await page.evaluate(()=>window.__inspectRoom(true));
      assert(back.inside&&back.room&&back.hits===25&&back.visible.length===16,JSON.stringify(back));
      await page.screenshot({path:`${shots}/${name}-bay-${index+1}-back.png`});
      console.log(JSON.stringify({backend,name,bay:index+1,home,mid,back}));
    }
    assert.equal(await page.$('#velance-telemetry-settings'),null);
    assert.equal(await page.evaluate(()=>typeof window.__VELANCE_TELEMETRY__),'undefined');
    assert.deepEqual(diagnostics,[]);assert.deepEqual(errors,[]);
    console.log(`PASS ${name}: no Settings or diagnostics requests with prior consent`);
    await page.close();
  }
}finally{await browser.close();}
