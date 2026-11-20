// Resource-lifetime regression. JS heap is not whole-process or GPU memory.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {mkdirSync,writeFileSync} from 'node:fs';
const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:8090';
const shots=process.env.QA_SHOT_DIR||'tools/perf/results/memory';mkdirSync(shots,{recursive:true});
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-webgpu','--window-size=1671,896']});
const reports=[];
try{
  for(const [backend,safari] of [['webgpu',false],['webgl',true]]){
    const page=await browser.newPage(),errors=[],requests=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    page.on('request',r=>{if(r.url().endsWith('.glb'))requests.push(new URL(r.url()).pathname);});
    await page.setViewport({width:1671,height:896,deviceScaleFactor:2});
    if(safari)await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15');
    const cdp=await page.createCDPSession();await cdp.send('Performance.enable');
    const wait=(fn,...args)=>page.waitForFunction(fn,{timeout:90000},...args);
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
    await page.goto(`${origin}/index.html?nointro&backend=${backend}`,{waitUntil:'load'});
    await wait(()=>window.__VELANCE_QA__?.engine?.initialReady);
    assert.equal(requests.length,1);assert.match(requests[0],/\/gallery\//);
    await page.click('#overviewBtn');
    await wait(()=>{const e=window.__VELANCE_QA__.engine;return e.overview&&!e.flight&&e.cars.size===16&&!e.loading&&!e.placeholders.size;});
    await page.evaluate(()=>{const e=window.__VELANCE_QA__.engine;window.__galleryIds=[...e.cars].map(([i,c])=>[i,c.uuid]);window.__disposedDetailResources=0;});
    async function measure(){
      await cdp.send('HeapProfiler.collectGarbage');
      const metrics=(await cdp.send('Performance.getMetrics')).metrics;
      const stats=await page.evaluate(()=>{
        const e=window.__VELANCE_QA__.engine,images=new Set(),textures=new Set(),arrays=new Set(),roots=new Set(e.cars.values());
        if(e.detailResident)roots.add(e.detailResident.gallery);
        for(const root of roots)root.traverse(n=>{
          if(n.geometry){for(const a of Object.values(n.geometry.attributes))arrays.add(a.array||a.data?.array);if(n.geometry.index)arrays.add(n.geometry.index.array);}
          for(const m of Array.isArray(n.material)?n.material:[n.material])if(m){for(const t of [...Object.values(m),m.userData?.baseMap])if(t?.isTexture){textures.add(t);if(t.image)images.add(t.image);}}
        });
        return {...e.stats(),residentCars:roots.size,detailCars:[...roots].filter(r=>r.userData.tier==='detail').length,decodedImageMiB:[...images].reduce((s,i)=>s+(i.width||0)*(i.height||0)*4,0)/1048576,textureBaseMiB:[...textures].reduce((s,t)=>s+(t.image?.width||0)*(t.image?.height||0)*4,0)/1048576,geometryMiB:[...arrays].reduce((s,a)=>s+(a?.byteLength||0),0)/1048576,disposedDetailResources:window.__disposedDetailResources};
      });
      return {...stats,jsHeapMiB:metrics.find(m=>m.name==='JSHeapUsedSize').value/1048576};
    }
    const before=await measure();assert.equal(before.residentCars,16);assert.equal(before.detailCars,0);assert.equal(before.memoryConstrained,safari);assert(before.canvasPixels<=(safari?1500000:2500000));
    // A zero texture count previously passed when CSP blocked GLB blob fetches.
    assert(before.decodedImageMiB>0&&before.decodedImageMiB<80&&before.geometryMiB<40,JSON.stringify(before));
    await page.screenshot({path:`${shots}/${backend}-gallery.png`});
    const returns=[],selections=[];
    for(const index of [15,14,1,0,7,13,4,15]){
      await page.evaluate(i=>document.querySelector(`.bay-label[data-index="${i}"]`).click(),index);
      await wait(i=>{const e=window.__VELANCE_QA__.engine;return e.detailResident?.index===i&&e.controls?.enabled;},index);
      await page.evaluate(()=>{
        const e=window.__VELANCE_QA__.engine,root=e.detailResident.holder,resources=new Set();
        root.traverse(n=>{if(n.geometry)resources.add(n.geometry);for(const m of Array.isArray(n.material)?n.material:[n.material])if(m){resources.add(m);for(const t of [...Object.values(m),m.userData?.baseMap])if(t?.isTexture)resources.add(t);}});
        for(const r of resources)r.addEventListener('dispose',()=>window.__disposedDetailResources++);
        window.__expectedDispose=window.__disposedDetailResources+resources.size;
      });
      const detail=await measure();assert.equal(detail.residentCars,17);assert.equal(detail.detailCars,1);assert(detail.decodedImageMiB-before.decodedImageMiB<=33,JSON.stringify(detail));
      if(index===15&&selections.length===0)await page.screenshot({path:`${shots}/${backend}-valkyrie.png`});
      selections.push({index,...detail});
      await page.click('#backToGarageTop');
      await wait(()=>{const e=window.__VELANCE_QA__.engine;return e.overview&&!e.flight&&!e.returning&&!e.detailResident&&!e.pendingDetail;});
      assert(await page.evaluate(()=>{const e=window.__VELANCE_QA__.engine;return window.__galleryIds.every(([i,id])=>e.cars.get(i).uuid===id)&&window.__expectedDispose===window.__disposedDetailResources;}));
      const back=await measure();assert.equal(back.residentCars,16);assert.equal(back.detailCars,0);assert.equal(back.decodedImageMiB,before.decodedImageMiB);assert.equal(back.geometryMiB,before.geometryMiB);returns.push(back);
      console.log(JSON.stringify({backend,safari,index,decoded:detail.decodedImageMiB,backDecoded:back.decodedImageMiB,backTextures:back.textures,backGeometries:back.geometries,disposed:back.disposedDetailResources,backHeap:back.jsHeapMiB}));
    }
    // Rapid cancellation while a detail request is in flight: no stale high tier.
    await page.evaluate(()=>{window.__VELANCE_QA__.engine.reduced=false;document.querySelector('.bay-label[data-index="13"]').click();});
    await wait(()=>window.__VELANCE_QA__.engine.flight?.selection);
    await page.keyboard.press('Escape');
    await wait(()=>{const e=window.__VELANCE_QA__.engine;return !e.flight&&e.overview&&!e.returning;});
    await page.evaluate(()=>window.__VELANCE_QA__.engine.detailTask);
    assert(await page.evaluate(()=>{const e=window.__VELANCE_QA__.engine;return !e.detailResident&&!e.pendingDetail&&e.cars.size===16&&[...e.cars.values()].every(c=>c.userData.tier==='gallery');}));
    assert(returns.at(-1).textures<=returns[0].textures+5,JSON.stringify(returns.map(r=>r.textures)));
    assert(returns.at(-1).geometries<=returns[0].geometries+5,JSON.stringify(returns.map(r=>r.geometries)));
    assert.deepEqual(errors.filter(e=>!e.includes('ERR_ABORTED')),[]);
    const disposal = await page.evaluate(async () => {
      const e = window.__VELANCE_QA__.engine;
      let calls = 0, disposedGeometry = 0;
      const originalResize = e.resize.bind(e);
      e.resize = () => { calls++; return originalResize(); };
      const geometry = [...e.cars.values()][0].children[0];
      geometry.traverse(n => n.geometry?.addEventListener('dispose', () => disposedGeometry++));
      const first = e.dispose(); const same = first === e.dispose(); await first;
      window.dispatchEvent(new Event('resize'));
      return { same, calls, disposedGeometry, cars: e.cars.size, canvasConnected: e.canvas.isConnected, labels: e.labelHost.querySelectorAll('.bay-label').length };
    });
    assert(disposal.same && disposal.calls === 0 && disposal.disposedGeometry > 0 && disposal.cars === 0 && !disposal.canvasConnected && disposal.labels === 0, JSON.stringify(disposal));
    assert.deepEqual(errors.filter(e=>!e.includes('ERR_ABORTED')),[]);
    reports.push({backend,safariPolicySimulated:safari,before,selections,returns,requests});
    console.log('PASS',backend,'8 detail cycles + canceled approach');await page.close();
  }
}finally{await browser.close();writeFileSync(`${shots}/results.json`,JSON.stringify(reports,null,2)+'\n');}
