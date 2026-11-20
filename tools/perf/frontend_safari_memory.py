"""Native Safari WebDriver, no third-party Python dependencies. Local only."""
import base64, json, os, pathlib, socket, subprocess, time, urllib.request, urllib.error

OUT=pathlib.Path(os.environ.get('QA_SHOT_DIR','tools/perf/results/safari-memory')); OUT.mkdir(parents=True,exist_ok=True)
ORIGIN=os.environ.get('TEST_ORIGIN','http://127.0.0.1:8090').rstrip('/')
def processes():
    out={}
    for line in subprocess.check_output(['ps','-ax','-o','pid=,rss=,comm='],text=True).splitlines():
        fields=line.strip().split(None,2)
        if len(fields)==3 and ('com.apple.WebKit.WebContent' in fields[2] or 'com.apple.WebKit.GPU' in fields[2]):
            out[int(fields[0])]={'rssMiB':round(int(fields[1])/1024,2),'kind':'GPU' if 'WebKit.GPU' in fields[2] else 'WebContent'}
    return out
prior=processes()
with socket.socket() as sock:
    sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
driver=subprocess.Popen(['/usr/bin/safaridriver','--port',str(port)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
base=f'http://127.0.0.1:{port}'; sid=None; report={'status':'RUNNING','samples':[],'cycles':[],'baselineProcesses':prior,
    'inputMethod':'WebDriver W3C keyboard actions (Enter), explicit DOM focus; no synthetic click fallback',
    'pointerTargetingVerified':False,'activations':[],
    'programmaticSetup':['nointro bypasses entrance dialog','engine.entrance({stayOverview:true})','scrollIntoView for archive tile and boardBack readiness']}
def req(path,body=None,method=None):
    data=None if body is None else json.dumps(body).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(base+path,data=data,headers={'Content-Type':'application/json'},method=method),timeout=30) as r:
            return json.load(r)['value']
    except urllib.error.HTTPError as e: raise RuntimeError(e.read().decode()) from e
def call(path,body=None,method=None):return req('/session/'+sid+path,body,method)
def js(script,*args):return call('/execute/sync',{'script':script,'args':args})
def activate(selector):
    # Safari element-click can hit the containing header despite a correct
    # elementFromPoint. Test semantic keyboard activation instead, without
    # calling HTMLElement.click() or dispatching fabricated events.
    evidence={'selector':selector,'method':'webdriver-keyboard-enter','status':'PENDING'}
    report['activations'].append(evidence)
    try:
        evidence['focus']=js('''const el=document.querySelector(arguments[0]);
            if(!el)return {found:false};
            const style=getComputedStyle(el),r=el.getBoundingClientRect();
            const eligible=el.matches('button,a[href]')&&!el.matches(':disabled')&&el.tabIndex>=0&&
                !el.closest('[hidden],[inert]')&&style.visibility==='visible'&&style.display!=='none'&&
                Number(style.opacity)>0&&r.width>0&&r.height>0;
            if(!eligible)return {found:true,eligible:false,tabIndex:el.tabIndex,visibility:style.visibility,opacity:style.opacity};
            el.focus({preventScroll:true});
            const events=[];
            const record=e=>events.push({type:e.type,key:e.key??null,trusted:e.isTrusted,
                expected:e.composedPath().includes(el),target:e.target.id||e.target.getAttribute?.('aria-label')||e.target.tagName,
                detail:e.detail});
            document.addEventListener('keydown',record,true);document.addEventListener('click',record,true);
            window.__safariActivation={events,cleanup:()=>{document.removeEventListener('keydown',record,true);document.removeEventListener('click',record,true);}};
            return {found:true,eligible:true,focused:document.activeElement===el,tag:el.tagName,tabIndex:el.tabIndex};''',selector)
        assert evidence['focus'].get('focused'), f'Keyboard target unavailable: {evidence}'
        call('/actions',{'actions':[{'type':'key','id':'velance-keyboard','actions':[
            {'type':'keyDown','value':'\ue007'},{'type':'keyUp','value':'\ue007'}]}]})
        evidence['events']=js('return window.__safariActivation?.events || []')
        assert any(e['type']=='keydown' and e['key']=='Enter' and e['trusted'] and e['expected'] for e in evidence['events']), f'No trusted Enter on expected control: {evidence}'
        clicks=[e for e in evidence['events'] if e['type']=='click']
        assert len(clicks)==1 and clicks[0]['trusted'] and clicks[0]['expected'], f'Unexpected keyboard activation target: {evidence}'
        evidence['status']='PASS'
    except Exception as error:
        evidence['status']='FAIL';evidence['error']=str(error)
        raise
    finally:
        try:
            evidence['events']=js('''const a=window.__safariActivation;if(!a)return [];a.cleanup();delete window.__safariActivation;return a.events;''')
        finally:save()
def wait(expr,seconds=40):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        if js('return Boolean('+expr+')'):return
        time.sleep(.2)
    raise RuntimeError('Timeout: '+expr+' current='+str(js('return {url:location.href,qa:window.__VELANCE_QA__?.stats(),error:window.__VELANCE_QA__?.engineError}')))
def save(): (OUT/'results.json').write_text(json.dumps(report,indent=2)+'\n')
def shot(name): (OUT/(name+'.png')).write_bytes(base64.b64decode(call('/screenshot')))
TOKEN='velance-native-'+str(time.time_ns())
def sample(stage):
    data=js('''const q=window.__VELANCE_QA__,e=q?.engine;if(!e)return null;
    const roots=new Set(e.cars.values()),images=new Set(),arrays=new Set();if(e.detailResident)roots.add(e.detailResident.gallery);
    for(const root of roots)root.traverse(n=>{if(n.geometry){for(const a of Object.values(n.geometry.attributes))arrays.add(a.array||a.data?.array);if(n.geometry.index)arrays.add(n.geometry.index.array);}for(const m of Array.isArray(n.material)?n.material:[n.material])if(m)for(const t of [...Object.values(m),m.userData?.baseMap])if(t?.isTexture&&t.image)images.add(t.image);});
    return {...e.stats(),residentCars:roots.size,detailCars:[...roots].filter(r=>r.userData.tier==='detail').length,decodedImageMiB:[...images].reduce((s,i)=>s+(i.width||0)*(i.height||0)*4,0)/1048576,geometryMiB:[...arrays].reduce((s,a)=>s+(a?.byteLength||0),0)/1048576,token:window.__safariTestToken,errors:window.__safariTestErrors,dimensions:[innerWidth,innerHeight,devicePixelRatio],navType:performance.getEntriesByType('navigation')[0]?.type};''')
    assert data and data['token']==TOKEN, 'Document replaced/reloaded or engine lost'
    assert data['memoryConstrained'] and data['canvasPixels']<=1500000,data
    proc=processes(); row={'stage':stage,'page':data,'newWebKitProcesses':{k:v for k,v in proc.items() if k not in prior},'allWebKitProcesses':proc}
    report['samples'].append(row);save()
    print(stage,json.dumps({k:data[k] for k in ['backend','residentCars','detailCars','decodedImageMiB','geometryMiB','textures','geometries','canvasPixels','errors']}),'newProcesses',row['newWebKitProcesses'],flush=True)
    return data
try:
    for _ in range(20):
        try:req('/status');break
        except Exception:time.sleep(.25)
    session=req('/session',{'capabilities':{'alwaysMatch':{'browserName':'safari'}}});sid=session['sessionId'];report['capabilities']=session.get('capabilities');save()
    print('Native Safari session',report['capabilities'],flush=True)
    call('/window/rect',{'width':1280,'height':800,'x':0,'y':0})
    call('/url',{'url':ORIGIN+'/index.html?nointro'})
    wait('window.__VELANCE_QA__?.engine?.initialReady',60)
    js('''window.__safariTestToken=arguments[0];window.__safariTestErrors=[];window.addEventListener('error',e=>window.__safariTestErrors.push(String(e.message||e.type)));window.addEventListener('unhandledrejection',e=>window.__safariTestErrors.push(String(e.reason)));''',TOKEN)
    sample('initial')
    # WebDriver explicitly bypasses the entry gate; use the same entrance engine
    # with stayOverview:true and observe each lit bay on native Safari.
    start=time.monotonic()
    js('''const e=window.__VELANCE_QA__.engine;window.__revealViolations=[];e.entrance({stayOverview:true});const tick=()=>{if(!e.cinema)return;for(let i=0;i<16;i++)if(e.bayLightLevel(i)>0&&(!e.cars.has(i)||!e.cars.get(i).visible))window.__revealViolations.push(i);requestAnimationFrame(tick);};requestAnimationFrame(tick);''')
    wait('window.__VELANCE_QA__.engine.overview&&!window.__VELANCE_QA__.engine.flight&&window.__VELANCE_QA__.engine.cars.size===16&&!window.__VELANCE_QA__.engine.loading',90)
    report['entranceSeconds']=round(time.monotonic()-start,3);report['revealViolations']=js('return window.__revealViolations');assert not report['revealViolations'];baseline=sample('overview');shot('overview')
    E='window.__VELANCE_QA__.engine'
    for i in [15,14,1,0,7,13,4,15]:
        activate(f'.bay-label[data-index="{i}"]')
        wait(f'{E}.detailResident?.index==={i}&&{E}.controls?.enabled',60)
        detail=sample(f'detail-{i+1}');assert detail['residentCars']==17 and detail['detailCars']==1;assert detail['decodedImageMiB']-baseline['decodedImageMiB']<=33
        if i==15 and not report['cycles']:
            wait(f'{E}.autoShot?.elapsed>16.4',60);sample('auto-full-rotation');shot('valkyrie-auto')
            wait('window.__VELANCE_QA__.boardCount>0&&!document.querySelector("#navBoard").hidden');activate('#navBoard')
            wait('document.querySelector("#board").getBoundingClientRect().top<innerHeight*.65')
            js('document.querySelector(".archive-tile").scrollIntoView({block:"center",behavior:"instant"})')
            wait('document.querySelector(".archive-tile img")?.naturalWidth>0');activate('.archive-tile')
            wait('document.querySelector("#archiveViewer").open&&!document.querySelector("#viewerImage").hidden&&document.querySelector("#viewerImage").naturalWidth>0')
            report['archivePixels']=js('return [document.querySelector("#viewerImage").naturalWidth,document.querySelector("#viewerImage").naturalHeight]');sample('archive-full');shot('archive-full')
            activate('#viewerNext');wait('document.querySelector("#viewerCount").textContent.startsWith("02")&&!document.querySelector("#viewerImage").hidden');activate('#viewerClose');wait('!document.querySelector("#archiveViewer").open');js('document.querySelector("#boardBack").scrollIntoView({block:"center",behavior:"instant"})');activate('#boardBack')
        else:activate('#backToGarageTop')
        wait(f'{E}.overview&&!{E}.flight&&!{E}.returning&&!{E}.detailResident&&!{E}.pendingDetail',60)
        back=sample(f'back-{i+1}');assert back['residentCars']==16 and back['detailCars']==0 and back['decodedImageMiB']==baseline['decodedImageMiB'] and back['geometryMiB']==baseline['geometryMiB']
        report['cycles'].append(i+1);save()
    activate('.bay-label[data-index="13"]');wait(f'{E}.flight?.selection&&getComputedStyle(document.querySelector("#cancelApproach")).visibility==="visible"&&Number(getComputedStyle(document.querySelector("#cancelApproach")).opacity)>0');activate('#cancelApproach');wait(f'{E}.overview&&!{E}.flight&&!{E}.returning&&!{E}.detailResident&&!{E}.pendingDetail',60);sample('canceled-approach')
    for i in range(3):time.sleep(8);sample(f'idle-{(i+1)*8}s')
    assert not report['samples'][-1]['page']['errors'];shot('final-overview');report['status']='PASS';save();print('PASS native Safari',len(report['cycles']),'cycles; no document replacement observed',flush=True)
except Exception as e:
    report['status']='FAIL';report['error']=str(e);save();print('FAIL',str(e),flush=True)
    if sid:
        try:shot('failure')
        except Exception:pass
    raise
finally:
    if sid:
        try:call('',method='DELETE')
        except Exception:pass
    driver.terminate()
    try:driver.wait(timeout=3)
    except subprocess.TimeoutExpired:driver.kill()
