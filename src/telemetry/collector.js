// A capability header is not consent. Only a positive, versioned user choice
// permits the HEAD capability probe and subsequent diagnostic collection.
const forcedOff = new URLSearchParams(location.search).has('notelemetry');
const consentKey = 'velance_telemetry_consent_v1';
const consentVersion = 1;
const consentMaxAgeMs = 90 * 24 * 60 * 60 * 1000;
let consentGranted = false;
try {
  const priorOptOut = localStorage.getItem('velance_telemetry_off') === '1';
  const record = JSON.parse(localStorage.getItem(consentKey) || 'null');
  const age = Date.now() - record?.at;
  consentGranted = !forcedOff && !priorOptOut && record?.version === consentVersion &&
    record?.decision === 'granted' && Number.isSafeInteger(record.at) &&
    age >= -60000 && age <= consentMaxAgeMs;
} catch { /* Unavailable or invalid storage must fail closed. */ }

let session = null, enabled = false, activationEpoch = 0, activationAbort = null, stopCollector = null;
const milestones = { gateShown: 0, enter: null, firstFrame: null, firstCar: null, allLoaded: null };
let flush = async () => {};
let renderConsent = () => {};
function resetMilestones() {
  milestones.gateShown = 0;
  for (const key of ['enter', 'firstFrame', 'firstCar', 'allLoaded']) milestones[key] = null;
}
function stopTelemetry() {
  activationEpoch++;
  activationAbort?.abort();
  activationAbort = null;
  stopCollector?.();
  stopCollector = null;
  session = null;
  enabled = false;
  flush = async () => {};
  resetMilestones();
}
function setConsent(granted) {
  if (granted && forcedOff) return;
  // Even with ?notelemetry, allow an explicit withdrawal to clear a saved grant.
  if (granted === consentGranted && !(forcedOff && !granted)) return;
  if (!granted) stopTelemetry();
  consentGranted = granted;
  try {
    if (granted) {
      localStorage.setItem(consentKey, JSON.stringify({ version: consentVersion, decision: 'granted', at: Date.now() }));
      localStorage.removeItem('velance_telemetry_off');
    } else {
      localStorage.removeItem(consentKey);
      localStorage.setItem('velance_telemetry_off', '1');
    }
  } catch { /* Choice applies to this page; no persistence when storage fails. */ }
  renderConsent();
  if (granted) void activate();
}
function mountConsentControls() {
  if (!document.body || typeof document.createElement !== 'function') return;
  const style = document.createElement('style');
  style.textContent = `
    #velance-telemetry-settings { position: relative; flex:none; z-index: 110;
      color: #e8cd9f; font: 10px/1.4 var(--mono, monospace); }
    #velance-telemetry-settings details { position:relative; }
    #velance-telemetry-settings summary { cursor:pointer; min-height:44px; display:flex;
      align-items:center; padding:0 6px; letter-spacing:.08em; list-style:none; }
    #velance-telemetry-settings summary::-webkit-details-marker { display:none; }
    #velance-telemetry-settings .velance-consent-body { position:absolute; right:0; top:100%;
      width:min(330px,calc(100vw - 32px)); padding:16px; border:1px solid #b8956377;
      background:#101619; color:#f5eee3; box-shadow:0 10px 36px #000a; font:13px/1.55 system-ui,sans-serif; }
    #velance-telemetry-settings p { margin: 8px 0; }
    #velance-telemetry-settings button { background: #e8cd9f; color: #161719; border: 0;
      border-radius:0; min-height:44px; padding:9px 12px; margin-top:6px; cursor:pointer; font:inherit; }
    #velance-telemetry-settings button:focus-visible, #velance-telemetry-settings summary:focus-visible {
      outline:2px solid #e8cd9f; outline-offset:2px; }
    #velance-telemetry-settings [hidden] { display: none !important; }
  `;
  (document.head || document.body).appendChild(style);
  const root = document.createElement('aside');
  root.id = 'velance-telemetry-settings';
  root.setAttribute('aria-label', 'Optional diagnostic telemetry settings');
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  const body = document.createElement('div');
  body.className = 'velance-consent-body';
  const explanation = document.createElement('p');
  explanation.textContent = 'Optional diagnostics measure load times, rendering performance, interaction events and redacted errors. Data includes a random session ID and browser/device details (user agent, screen, CPU, memory and network class); combined values may identify a device. Retention, responsible entity and deletion process are pending review. This control is for local preview testing.';
  const allow = document.createElement('button');
  allow.id = 'velance-telemetry-allow';
  allow.type = 'button';
  allow.textContent = 'Allow optional diagnostics';
  const withdraw = document.createElement('button');
  withdraw.id = 'velance-telemetry-withdraw';
  withdraw.type = 'button';
  withdraw.textContent = 'Withdraw permission';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  allow.addEventListener('click', () => setConsent(true));
  withdraw.addEventListener('click', () => setConsent(false));
  body.appendChild(explanation);
  body.appendChild(allow);
  body.appendChild(withdraw);
  body.appendChild(status);
  details.appendChild(summary);
  details.appendChild(body);
  root.appendChild(details);
  (document.querySelector('.topnav') || document.body).appendChild(root);
  details.addEventListener('keydown', event => {
    if (event.key === 'Escape' && details.open) {
      event.preventDefault(); event.stopPropagation(); details.open = false; summary.focus();
    }
  });
  document.addEventListener('pointerdown', event => {
    if (details.open && !root.contains(event.target)) details.open = false;
  });
  renderConsent = () => {
    summary.textContent = 'SETTINGS';
    summary.setAttribute('aria-label', `Settings · Optional diagnostics: ${consentGranted ? 'allowed' : 'off'}`);
    allow.hidden = consentGranted || forcedOff;
    withdraw.hidden = !consentGranted && !forcedOff;
    withdraw.textContent = forcedOff ? 'Keep diagnostics disabled' : 'Withdraw permission';
    status.textContent = forcedOff ? 'Disabled by ?notelemetry in this URL.' :
      consentGranted ? 'Permission granted. You can withdraw at any time.' :
        'Disabled. No diagnostic requests are sent.';
  };
  renderConsent();
}
window.__VELANCE_TELEMETRY__ = {
  get session() { return session; },
  get enabled() { return enabled; },
  get consent() { return forcedOff ? 'forced-off' : consentGranted ? 'granted' : 'off'; },
  get milestones() { return { ...milestones }; },
  flush: () => flush()
};

async function activate() {
  if (!consentGranted || forcedOff) return;
  const epoch = ++activationEpoch;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  activationAbort = controller;
  const permitted = () => consentGranted && !forcedOff && epoch === activationEpoch;
  const t0 = performance.now(), startedAt = Date.now();
  let abandoned = false;
  const retryAfterRestore = event => {
    window.removeEventListener('pageshow', retryAfterRestore);
    if (event.persisted && permitted() && !enabled) void activate();
  };
  const leaveBeforeActivation = event => {
    abandoned = true;
    controller?.abort();
    if (event.persisted) window.addEventListener('pageshow', retryAfterRestore, { once: true });
  };
  window.addEventListener('pagehide', leaveBeforeActivation);
  try {
    const response = await fetch(location.pathname, { method: 'HEAD', cache: 'no-store', ...(controller ? { signal: controller.signal } : {}) });
    if (!permitted() || abandoned || !response.ok || response.headers.get('x-velance-ops') !== '1') return;
  } catch { return; }
  finally {
    window.removeEventListener('pagehide', leaveBeforeActivation);
    if (activationAbort === controller) activationAbort = null;
  }
  if (!permitted()) return;
  session = crypto.randomUUID();
  enabled = true;
  const ua = navigator.userAgent.slice(0, 512);
  const context = {
    ua, mobile: matchMedia('(pointer: coarse)').matches || /Mobi|Android/i.test(ua),
    screen: `${screen.width}x${screen.height}`, dpr: devicePixelRatio,
    cores: navigator.hardwareConcurrency ?? null, memory: navigator.deviceMemory ?? null,
    net: navigator.connection?.effectiveType ?? null, webgpu: !!navigator.gpu,
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches
  };
  const samples = [], events = [], listeners = [], requests = new Set(), encoder = new TextEncoder();
  let backend = null, seq = 0, dirty = true, paused = document.hidden, inFlight = false;
  let probeTimer = null, sampleTimer = null, flushTimer = null, lastStats = null, engineErrorSeen = false;
  const now = () => Math.max(0, Math.round(performance.now() - t0));
  const listen = (target, name, fn) => { target.addEventListener(name, fn); listeners.push(() => target.removeEventListener(name, fn)); };
  const redact = value => String(value).slice(0, 4000)
    .replace(/(?:https?:\/\/|file:\/\/|www\.)[^\s<>"']+/gi, '[url]')
    .replace(/\b(?:token|password|secret|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '[redacted]')
    .replace(/\?[^\s<>"']+/g, '[query]').slice(0, 300);
  function event(type, data) { if (permitted() && enabled && events.length < 500) events.push({ t: now(), type, ...(data ? { data } : {}) }); }
  function mark(key, value) { if (milestones[key] === null && value != null) { milestones[key] = Math.max(0, Math.round(value)); dirty = true; } }
  function pause() {
    clearInterval(probeTimer); clearInterval(sampleTimer); clearInterval(flushTimer);
    probeTimer = sampleTimer = flushTimer = null;
  }
  function disable() {
    enabled = false; pause();
    for (const request of requests) request.abort();
    requests.clear();
    for (const remove of listeners) remove();
    listeners.length = samples.length = events.length = 0;
    if (stopCollector === disable) stopCollector = null;
  }
  stopCollector = disable;
  function activity(qa) {
    const e = qa.engine;
    const orbit = !!e?.controls?.enabled && performance.now() - e.lastOrbitAt < 160;
    const settling = e?.mode === 'home' && (qa.overview ? Math.abs(e.ovTarget - e.ovPan) > .001 : Math.abs(e.target - e.position) > .002);
    const active = !!(e?.flight || e?.drag?.moved || orbit || settling || e?.fades?.size);
    let phase = 'home-idle';
    // P7 demand-loaded gallery may never load all 16 on a normal visit.
    // Once the first model is ready, samples describe the actual user phase.
    if (milestones.firstCar === null) phase = 'boot';
    else if (e?.flight) phase = 'flight';
    else if (qa.overview) phase = 'overview';
    else if (qa.selected != null) phase = orbit ? 'selected-orbit' : 'selected-idle';
    else if (e?.drag?.moved || settling) phase = 'browse';
    const rect = e?.stage?.getBoundingClientRect();
    const visible = !document.hidden && (!rect || (rect.bottom > 0 && rect.top < innerHeight));
    return { phase, active: active && visible && performance.now() - e?.lastDraw < 200 };
  }
  function snapshot(qa, stats) {
    const copy = { ...stats, loadTimes: { ...stats.loadTimes } };
    if (!activity(qa).active) copy.fps = null;
    lastStats = copy;
    if (backend !== stats.backend) { backend = stats.backend; dirty = true; }
  }
  function sample() {
    if (!permitted() || !enabled || paused || document.hidden) return;
    const qa = window.__VELANCE_QA__, stats = qa?.stats();
    if (!stats) return;
    snapshot(qa, stats);
    if (samples.length < 1200) samples.push({
      t: now(), phase: activity(qa).phase, fps: lastStats.fps,
      renderAvg: stats.renderMsAvg, renderP95: stats.renderMsP95,
      drawCalls: stats.drawCalls, triangles: stats.triangles, loaded: stats.loaded,
      heapMB: stats.heapMB, pixelRatio: stats.pixelRatio
    });
  }
  function probe() {
    if (!permitted() || !enabled || paused) return;
    const qa = window.__VELANCE_QA__;
    if (!qa) return;
    if (qa.engineError && !engineErrorSeen) { engineErrorSeen = true; event('engineError', { msg: redact(qa.engineError) }); }
    const gate = document.getElementById('gate');
    if (!gate || gate.hidden) mark('enter', now());
    if (qa.fallback) { backend = 'images'; dirty = true; clearInterval(probeTimer); probeTimer = null; return; }
    const stats = qa.stats();
    if (!stats) return;
    snapshot(qa, stats);
    if (Number.isFinite(stats.firstFrameMs)) mark('firstFrame', stats.firstFrameMs + qa.engine.t0 - t0);
    if (stats.loaded >= 1) {
      mark('firstCar', now());
      if (!document.hidden && !sampleTimer) sampleTimer = setInterval(sample, 1000);
    }
    if (stats.total > 0 && stats.loaded === stats.total) {
      mark('allLoaded', now()); clearInterval(probeTimer); probeTimer = null;
    }
  }
  function resume() {
    if (!permitted() || !enabled || document.hidden) return;
    paused = false;
    if (milestones.firstCar !== null && !sampleTimer) sampleTimer = setInterval(sample, 1000);
    if (milestones.allLoaded === null && backend !== 'images' && !probeTimer) probeTimer = setInterval(probe, 250);
    if (!flushTimer) flushTimer = setInterval(() => flush(), 10000);
  }
  function payload() {
    const value = { id: session, seq: seq++, startedAt, context, milestones: { ...milestones }, backend,
      final: { duration: now(), stats: lastStats }, samples: [], events: [] };
    let bytes = encoder.encode(JSON.stringify(value)).length;
    for (const [queue, key] of [[events, 'events'], [samples, 'samples']]) {
      let n = 0;
      for (const row of queue) {
        const length = encoder.encode(JSON.stringify(row)).length + 1;
        if (bytes + length > 48 * 1024) break;
        value[key].push(row); bytes += length; n++;
      }
      queue.splice(0, n);
    }
    dirty = false;
    return JSON.stringify(value);
  }
  async function post(body, keepalive = false) {
    if (!permitted() || !enabled) return;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    if (controller) requests.add(controller);
    try {
      const response = await fetch('/api/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive, ...(controller ? { signal: controller.signal } : {}) });
      if (permitted() && enabled && !response.ok) disable();
    } catch { if (permitted() && enabled) disable(); }
    finally { if (controller) requests.delete(controller); }
  }
  flush = async () => {
    if (!permitted() || !enabled || paused || inFlight || (!dirty && !samples.length && !events.length)) return;
    inFlight = true;
    try {
      do { await post(payload()); } while (permitted() && enabled && !paused && (samples.length || events.length));
    } finally { inFlight = false; }
  };
  function checkpoint() {
    if (!permitted() || !enabled) return;
    const body = payload();
    let sent = false;
    try { sent = navigator.sendBeacon?.('/api/telemetry', new Blob([body], { type: 'application/json' })) === true; } catch {}
    if (!sent) void post(body, true);
  }
  listen(document, 'click', e => {
    const btn = e.target.closest('#gateEnter, #selectCar, #overviewBtn, #rowBtn, #backToGarageTop, #backToGarage, #zoomReset, #paintSwatches button');
    if (!btn) return;
    if (btn.id === 'gateEnter') mark('enter', now());
    else if (btn.parentElement?.id === 'paintSwatches') event('paint', { i: [...btn.parentElement.children].indexOf(btn) });
    else event(btn.id);
  });
  listen(window, 'error', e => event('error', { msg: redact(e.message) }));
  listen(window, 'unhandledrejection', e => event('error', { msg: redact(e.reason?.message || e.reason) }));
  listen(document, 'visibilitychange', () => {
    if (document.hidden) { checkpoint(); paused = true; pause(); }
    else resume();
  });
  listen(window, 'pagehide', e => {
    checkpoint(); paused = true; pause();
    if (!e.persisted) disable();
  });
  listen(window, 'pageshow', e => { if (e.persisted) resume(); });
  resume();
}

if (document.body) mountConsentControls();
else document.addEventListener('DOMContentLoaded', mountConsentControls, { once: true });
if (consentGranted) void activate();
