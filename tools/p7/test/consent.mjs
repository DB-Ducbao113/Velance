import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../../src/telemetry/collector.js', import.meta.url), 'utf8');
const CONSENT = 'velance_telemetry_consent_v1';
const LEGACY_OFF = 'velance_telemetry_off';
const AT = 1800000000000;
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const grant = (at = AT, version = 1) => JSON.stringify({ version, decision: 'granted', at });

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(name, cb) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(cb);
    },
    removeEventListener(name, cb) { listeners.get(name)?.delete(cb); },
    dispatch(name, event = {}) {
      for (const cb of [...(listeners.get(name) || [])]) cb(event);
    },
    count() { return [...listeners.values()].reduce((total, callbacks) => total + callbacks.size, 0); }
  };
}

function element(tag) {
  const node = Object.assign(eventTarget(), {
    tagName: tag.toUpperCase(), children: [], hidden: false, textContent: '', attributes: {},
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    click() { if (!this.hidden) this.dispatch('click', { target: this }); }
  });
  return node;
}

async function browser({
  search = '', entries = {}, storageThrows = false, ops = true, head, transport,
  browserAvailable = true
} = {}) {
  const stored = new Map(Object.entries(entries));
  const calls = [], beacons = [], timers = new Map();
  let clock = 0, uuidCalls = 0, contextReads = 0, intervalId = 0;
  const document = Object.assign(eventTarget(), {
    body: browserAvailable ? element('body') : null,
    head: browserAvailable ? element('head') : null,
    hidden: false,
    createElement: browserAvailable ? element : undefined,
    getElementById(id) {
      const visit = parent => {
        if (!parent) return null;
        if (parent.id === id) return parent;
        for (const child of parent.children) {
          const match = visit(child);
          if (match) return match;
        }
        return null;
      };
      return visit(this.body) || visit(this.head);
    }
  });
  const window = eventTarget();
  const stats = {
    backend: 'webgpu', firstFrameMs: null, loaded: 0, total: 16, fps: 60, loadTimes: {},
    renderMsAvg: 2, renderMsP95: 4, drawCalls: 4, triangles: 8, pixelRatio: 1, heapMB: null
  };
  window.__VELANCE_QA__ = {
    engine: { t0: 0, lastDraw: 0, lastOrbitAt: -1000, mode: 'home', target: 0, position: 0,
      fades: new Set(), controls: { enabled: false },
      stage: { getBoundingClientRect: () => ({ top: 0, bottom: 800 }) } },
    stats: () => stats, selected: null, overview: false
  };
  const storage = {
    getItem(key) { if (storageThrows) throw new Error('blocked'); return stored.get(key) ?? null; },
    setItem(key, value) { if (storageThrows) throw new Error('blocked'); stored.set(key, String(value)); },
    removeItem(key) { if (storageThrows) throw new Error('blocked'); stored.delete(key); }
  };
  const globals = {
    window, document, location: { pathname: '/', search }, localStorage: storage,
    Date: { now: () => AT }, URLSearchParams, TextEncoder, Blob, AbortController,
    performance: { now: () => clock }, crypto: { randomUUID: () => `session-${++uuidCalls}` },
    navigator: {
      get userAgent() { contextReads++; return 'Fixture Browser'; },
      gpu: {},
      sendBeacon: (url, body) => { beacons.push({ url, body }); return true; }
    },
    matchMedia: () => ({ matches: false }), screen: { width: 1000, height: 700 },
    devicePixelRatio: 1, innerHeight: 700,
    setInterval: (fn, ms) => {
      const id = ++intervalId;
      timers.set(id, { fn, ms, next: clock + ms });
      return id;
    },
    clearInterval: id => timers.delete(id),
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      if (options.method === 'HEAD') return head ? head(options) :
        { ok: true, headers: { get: () => ops ? '1' : null } };
      if (transport) return transport(url, options);
      return { ok: true };
    }
  };
  runInNewContext(source, globals);
  await settle();
  async function tick(ms) {
    const end = clock + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.next <= end)
        .sort((a, b) => a[1].next - b[1].next)[0];
      if (!due) break;
      clock = due[1].next;
      due[1].next += due[1].ms;
      due[1].fn();
      await settle();
    }
    clock = end;
    await settle();
  }
  return {
    document, window, stats, calls, beacons, timers, stored, tick,
    hook: window.__VELANCE_TELEMETRY__,
    click: async id => { const node = document.getElementById(id); assert(node, `Missing ${id}`); node.click(); await settle(); },
    posts: () => calls.filter(call => call.method === 'POST'),
    heads: () => calls.filter(call => call.method === 'HEAD'),
    get uuidCalls() { return uuidCalls; }, get contextReads() { return contextReads; }
  };
}

test('default: no consent means no HEAD, POST, beacon, UUID, context reads or timers', async () => {
  const s = await browser();
  await s.tick(60000);
  await s.hook.flush();
  assert.equal(s.hook.consent, 'off');
  assert.equal(s.hook.enabled, false);
  assert.equal(s.hook.session, null);
  assert.equal(s.calls.length, 0);
  assert.equal(s.beacons.length, 0);
  assert.equal(s.timers.size, 0);
  assert.equal(s.uuidCalls, 0);
  assert.equal(s.contextReads, 0);
  assert.equal(s.document.getElementById('velance-telemetry-allow').type, 'button');
  assert.equal(s.document.getElementById('velance-telemetry-withdraw').hidden, true);
  assert.equal(s.document.getElementById('velance-telemetry-settings').attributes['aria-label'],
    'Optional diagnostic telemetry settings');
});

test('positive UI choice gates HEAD and POST; revocation stops timers, sends nothing further and persists denial', async () => {
  const s = await browser();
  await s.click('velance-telemetry-allow');
  assert.equal(s.hook.consent, 'granted');
  assert.equal(s.heads().length, 1);
  assert.equal(s.hook.enabled, true);
  assert.equal(s.uuidCalls, 1);
  assert.equal(JSON.parse(s.stored.get(CONSENT)).version, 1);
  assert.equal(s.document.getElementById('velance-telemetry-allow').hidden, true);
  assert.equal(s.document.getElementById('velance-telemetry-withdraw').hidden, false);
  await s.hook.flush();
  assert.equal(s.posts().length, 1);
  s.document.hidden = true;
  await s.click('velance-telemetry-withdraw');
  assert.equal(s.hook.consent, 'off');
  assert.equal(s.hook.enabled, false);
  assert.equal(s.hook.session, null);
  assert.equal(s.timers.size, 0);
  assert.equal(s.stored.get(CONSENT), undefined);
  assert.equal(s.stored.get(LEGACY_OFF), '1');
  await s.tick(60000);
  s.document.dispatch('visibilitychange');
  s.window.dispatch('pagehide', { persisted: false });
  await s.hook.flush();
  assert.equal(s.calls.length, 2);
  assert.equal(s.beacons.length, 0);
  assert.equal(s.document.getElementById('velance-telemetry-allow').hidden, false);
});

test('saved valid opt-in resumes; expired, malformed, unknown-version and legacy records do not grant consent', async () => {
  const valid = await browser({ entries: { [CONSENT]: grant() } });
  assert.equal(valid.heads().length, 1);
  assert.equal(valid.hook.consent, 'granted');
  assert.equal(valid.hook.enabled, true);
  for (const entries of [
    { [CONSENT]: 'not-json' },
    { [CONSENT]: grant(AT - 91 * 24 * 3600_000) },
    { [CONSENT]: grant(AT, 2) },
    { [CONSENT]: grant(AT + 60_001) },
    { [CONSENT]: grant(), [LEGACY_OFF]: '1' },
    { [LEGACY_OFF]: '1' }
  ]) {
    const s = await browser({ entries });
    await s.tick(15000);
    assert.equal(s.hook.consent, 'off');
    assert.equal(s.calls.length, 0);
    assert.equal(s.uuidCalls, 0);
  }
});

test('legacy opt-out can only be replaced by an explicit fresh choice; URL override remains absolute', async () => {
  const legacy = await browser({ entries: { [LEGACY_OFF]: '1' } });
  assert.equal(legacy.calls.length, 0);
  await legacy.click('velance-telemetry-allow');
  assert.equal(legacy.heads().length, 1);
  assert.equal(legacy.stored.has(LEGACY_OFF), false);
  const override = await browser({ search: '?notelemetry', entries: { [CONSENT]: grant() } });
  assert.equal(override.hook.consent, 'forced-off');
  assert.equal(override.document.getElementById('velance-telemetry-allow').hidden, true);
  await override.click('velance-telemetry-allow');
  assert.equal(override.calls.length, 0);
  assert.equal(override.document.getElementById('velance-telemetry-withdraw').hidden, false);
  await override.click('velance-telemetry-withdraw');
  assert.equal(override.stored.has(CONSENT), false);
  assert.equal(override.stored.get(LEGACY_OFF), '1');
  assert.equal(override.calls.length, 0);
});

test('revocation while HEAD is in flight prevents late activation, even if response ignores abort', async () => {
  let resolveHead;
  const s = await browser({ head: () => new Promise(resolve => { resolveHead = resolve; }) });
  await s.click('velance-telemetry-allow');
  const pending = s.heads()[0];
  assert.equal(pending.signal.aborted, false);
  await s.click('velance-telemetry-withdraw');
  assert.equal(pending.signal.aborted, true);
  resolveHead({ ok: true, headers: { get: () => '1' } });
  await settle();
  assert.equal(s.hook.enabled, false);
  assert.equal(s.uuidCalls, 0);
  assert.equal(s.posts().length, 0);
  assert.equal(s.timers.size, 0);
});

test('bfcache restore retries an interrupted consented HEAD only once', async () => {
  let resolveFirst, headCount = 0;
  const s = await browser({ head: () => {
    headCount++;
    return headCount === 1 ? new Promise(resolve => { resolveFirst = resolve; }) :
      { ok: true, headers: { get: () => '1' } };
  } });
  await s.click('velance-telemetry-allow');
  s.window.dispatch('pagehide', { persisted: true });
  assert.equal(s.heads()[0].signal.aborted, true);
  s.window.dispatch('pageshow', { persisted: true });
  await settle();
  assert.equal(s.heads().length, 2);
  assert.equal(s.hook.enabled, true);
  resolveFirst({ ok: true, headers: { get: () => '1' } });
  await settle();
  assert.equal(s.uuidCalls, 1);
  assert.equal(s.timers.size, 2);
});

test('in-flight POST is aborted on withdrawal and its stale response cannot affect a newer grant', async () => {
  let finishPost;
  let attempts = 0;
  const s = await browser({ transport: () => {
    attempts++;
    return attempts === 1 ? new Promise(resolve => { finishPost = resolve; }) : Promise.resolve({ ok: true });
  } });
  await s.click('velance-telemetry-allow');
  const oldFlush = s.hook.flush();
  await settle();
  assert.equal(s.posts().length, 1);
  assert.equal(s.posts()[0].signal.aborted, false);
  await s.click('velance-telemetry-withdraw');
  assert.equal(s.posts()[0].signal.aborted, true);
  await s.click('velance-telemetry-allow');
  assert.equal(s.heads().length, 2);
  assert.equal(s.hook.enabled, true);
  const newSession = s.hook.session;
  finishPost({ ok: false });
  await oldFlush;
  assert.equal(s.hook.enabled, true);
  assert.equal(s.hook.session, newSession);
  await s.hook.flush();
  assert.equal(s.posts().length, 2);
  assert.equal(JSON.parse(s.posts()[1].body).id, newSession);
});

test('blocked storage falls back to session-only choice; missing ops capability never enables collection', async () => {
  const deniedStorage = await browser({ storageThrows: true });
  assert.equal(deniedStorage.heads().length, 0);
  await deniedStorage.click('velance-telemetry-allow');
  assert.equal(deniedStorage.hook.enabled, true);
  const nextPage = await browser({ storageThrows: true });
  assert.equal(nextPage.hook.consent, 'off');
  assert.equal(nextPage.calls.length, 0);
  const noOps = await browser({ ops: false });
  await noOps.click('velance-telemetry-allow');
  await noOps.hook.flush();
  assert.equal(noOps.hook.enabled, false);
  assert.equal(noOps.heads().length, 1);
  assert.equal(noOps.posts().length, 0);
  assert.equal(noOps.uuidCalls, 0);
});

test('lazy showroom starts 1Hz samples after the first loaded model without waiting for all 16', async () => {
  const s = await browser();
  await s.click('velance-telemetry-allow');
  s.stats.loaded = 1;
  await s.tick(1250);
  await s.hook.flush();
  const batch = JSON.parse(s.posts().at(-1).body);
  assert.equal(batch.milestones.firstCar, 250);
  assert.equal(batch.milestones.allLoaded, null);
  assert.equal(batch.samples.length, 1);
  assert.equal(batch.samples[0].phase, 'home-idle');
  assert.equal([...s.timers.values()].filter(t => t.ms === 1000).length, 1);
  assert.equal([...s.timers.values()].filter(t => t.ms === 250).length, 1,
    'Milestone probe continues until the gallery is explicitly fully loaded');
});

test('deferred DOM availability creates keyboard-friendly settings after DOMContentLoaded', async () => {
  const s = await browser({ browserAvailable: false });
  assert.equal(s.calls.length, 0);
  s.document.head = element('head');
  s.document.body = element('body');
  s.document.createElement = element;
  s.document.dispatch('DOMContentLoaded');
  const details = s.document.getElementById('velance-telemetry-settings').children[0];
  assert.equal(details.tagName, 'DETAILS');
  assert.equal(details.children[0].tagName, 'SUMMARY');
  const status = details.children[1].children.at(-1);
  assert.equal(status.attributes.role, 'status');
  assert.equal(status.attributes['aria-live'], 'polite');
  await s.click('velance-telemetry-allow');
  assert.equal(s.heads().length, 1);
});
