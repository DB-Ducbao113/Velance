"""Native Safari diagnostic, isolated local WebDriver session, existing assets only."""
import json, os, socket, subprocess, time, urllib.request, urllib.error

origin = os.environ['TEST_ORIGIN'].rstrip('/')
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
driver = subprocess.Popen(['/usr/bin/safaridriver', '--port', str(port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
base = f'http://127.0.0.1:{port}'
sid = None

def req(path, body=None, method=None):
    data = None if body is None else json.dumps(body).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(base+path, data=data, headers={'Content-Type':'application/json'}, method=method), timeout=30) as r:
            return json.load(r)['value']
    except urllib.error.HTTPError as e:
        raise RuntimeError(e.read().decode()) from e

def call(path, body=None, method=None): return req('/session/'+sid+path, body, method)
def js(script, *args): return call('/execute/sync', {'script':script,'args':args})
def click(selector):
    el = call('/element', {'using':'css selector','value':selector})
    call('/element/'+el['element-6066-11e4-a52e-4f735466cecf']+'/click', {})
def wait(expr, seconds=60):
    end = time.monotonic()+seconds
    while time.monotonic()<end:
        if js('return Boolean('+expr+')'): return
        time.sleep(.2)
    raise RuntimeError('Timeout '+expr)

def sample(stage):
    value = js('''const nav=document.querySelector('#navBoard'),b=document.querySelector('#board'),r=nav.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {scrollY,scrollTop:document.scrollingElement.scrollTop,scrollHeight:document.scrollingElement.scrollHeight,viewport:innerHeight,boardTop:b.getBoundingClientRect().top,boardHeight:b.getBoundingClientRect().height,navRect:r.toJSON(),hit:hit?.id||hit?.className,reviewHidden:document.querySelector('#review').hidden,htmlOverflow:getComputedStyle(document.documentElement).overflow,bodyOverflow:getComputedStyle(document.body).overflow,bodyClass:document.body.className,motion:window.__VELANCE_MOTION_QA__,clicks:window.__scrollClicks||[]};''')
    print(stage, json.dumps(value), flush=True)
    return value

try:
    for _ in range(20):
        try: req('/status'); break
        except Exception: time.sleep(.25)
    session = req('/session', {'capabilities':{'alwaysMatch':{'browserName':'safari'}}}); sid=session['sessionId']
    print('Native Safari',session.get('capabilities',{}).get('browserVersion'),flush=True)
    call('/window/rect',{'width':1280,'height':800,'x':0,'y':0})
    call('/url',{'url':origin+'/index.html?nointro'})
    wait('window.__VELANCE_QA__?.engine?.initialReady')
    js('''window.__scrollClicks=[];document.addEventListener('click',e=>{const record={target:e.target.id,path:e.composedPath().slice(0,5).map(n=>n.id||n.tagName)};queueMicrotask(()=>{record.prevented=e.defaultPrevented;window.__scrollClicks.push(record)})},true);''')
    js('document.querySelector("#selectCar").click()')
    wait('window.__VELANCE_QA__?.engine?.controls?.enabled&&window.__VELANCE_QA__?.boardCount>0&&!document.querySelector("#navBoard").hidden')
    sample('before')
    click('#navBoard'); time.sleep(2); actual=sample('native click')
    if actual['boardTop']>=actual['viewport']*.65:
        js('document.querySelector("#navBoard").click()');time.sleep(2);sample('DOM click')
        js('document.querySelector("#board").scrollIntoView({behavior:"instant",block:"start"})');time.sleep(.3);sample('native instant align')
        js('window.scrollTo({top:0,behavior:"instant"})');time.sleep(.3)
        js('window.scrollTo({top:scrollY+document.querySelector("#board").getBoundingClientRect().top,behavior:"instant"})');time.sleep(.3);sample('root instant align')
        raise RuntimeError('Native navigation did not scroll on click; diagnostic samples recorded')
    print('PASS native Safari navigation',flush=True)
finally:
    if sid:
        try: call('', method='DELETE')
        except Exception: pass
    driver.terminate()
    try: driver.wait(timeout=3)
    except subprocess.TimeoutExpired: driver.kill()
