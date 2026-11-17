import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../../src/telemetry/collector.js', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
async function sandbox({ search = '', storage = false, ops = true, beacon = true, transport, head } = {}) {
  let clock = 0, uuidCalls = 0, contextReads = 0, timerId = 0;
  const timers = new Map(), calls = [], beacons = [];
  const target = () => {
    const listeners = new Map();
    return {
      addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
      removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
      dispatch(type, event = {}) { for (const fn of [...(listeners.get(type) || [])]) fn(event); },
      count() { return [...listeners.values()].reduce((n, set) => n + set.size, 0); }
    };
  };
  const element = () => ({ children: [], hidden: false, appendChild(child) { this.children.push(child); return child; },
    setAttribute() {}, addEventListener() {} });
  const document = Object.assign(target(), { hidden: false, body: element(), head: element(),
    createElement: () => element(), getElementById: () => ({ hidden: false }) });
  const window = target();
  const engine = { t0: 0, lastDraw: 0, lastOrbitAt: -1000, mode: 'home', target: 0, position: 0, fades: new Set(), controls: { enabled: false }, stage: { getBoundingClientRect: () => ({ top: 0, bottom: 800 }) } };
  const stats = { backend: 'webgpu', firstFrameMs: null, loaded: 0, total: 16, fps: 120, loadTimes: {}, renderMsAvg: 1, renderMsP95: 2, drawCalls: 3, triangles: 4, pixelRatio: 1, heapMB: null };
  window.__VELANCE_QA__ = { engine, selected: null, overview: false, stats: () => stats };
  const globals = {
    window, document, location: { search, pathname: '/' }, URLSearchParams, TextEncoder, Blob,
    // These P2 post-activation regression cases now explicitly model an
    // existing, valid P7 opt-in; P7's separate tests cover default-deny UX.
    localStorage: {
      getItem: key => key === 'velance_telemetry_off' ? (storage ? '1' : null)
        : key === 'velance_telemetry_consent_v1'
          ? JSON.stringify({ version: 1, decision: 'granted', at: 100000 }) : null,
      setItem() {}, removeItem() {}
    }, performance: { now: () => clock },
    Date: { now: () => 100000 }, crypto: { randomUUID: () => { uuidCalls++; return 'test-session-0000'; } },
    AbortController,
    navigator: { get userAgent() { contextReads++; return 'test browser'; }, gpu: {}, sendBeacon: (url, blob) => { beacons.push({ url, blob }); return beacon; } },
    matchMedia: () => ({ matches: false }), screen: { width: 1440, height: 900 }, devicePixelRatio: 1, innerHeight: 900,
    setInterval: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms, next: clock + ms }); return id; },
    clearInterval: id => timers.delete(id),
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      if (options.method === 'HEAD') return head ? head() : { ok: true, headers: { get: () => ops ? '1' : null } };
      if (transport) return transport(url, options);
      return { ok: true };
    }
  };
  runInNewContext(source, globals); await settle();
  async function tick(ms) {
    const end = clock + ms;
    while (true) {
      const due = [...timers].filter(([, t]) => t.next <= end).sort((a, b) => a[1].next - b[1].next)[0];
      if (!due) break;
      clock = due[1].next; due[1].next += due[1].ms; engine.lastDraw = clock;
      if (engine.controls.enabled) engine.lastOrbitAt = clock;
      due[1].fn(); await settle();
    }
    clock = end; await settle();
  }
  return { window, document, engine, stats, timers, calls, beacons, tick, hook: window.__VELANCE_TELEMETRY__,
    get uuidCalls() { return uuidCalls; }, get contextReads() { return contextReads; }, posts: () => calls.filter(c => c.method === 'POST').map(c => JSON.parse(c.body)) };
}

test('query/storage opt-out has no UUID, context, network, timers or listeners; static is HEAD-only', async () => {
  for (const options of [{ search: '?notelemetry' }, { storage: true }, { ops: false }]) {
    const s = await sandbox(options); await s.tick(30000);
    assert.equal(s.hook.enabled, false); assert.equal(s.hook.session, null); assert.equal(s.uuidCalls, 0); assert.equal(s.contextReads, 0);
    assert.equal(s.timers.size, 0); assert.equal(s.window.count() + s.document.count(), 0); assert.equal(s.posts().length, 0);
    assert.equal(s.calls.length, options.ops === false ? 1 : 0);
  }
});

test('leaving during activation prevents late HEAD from starting collection', async () => {
  let release;
  const s = await sandbox({ head: () => new Promise(r => { release = r; }) });
  s.window.dispatch('pagehide', { persisted: false });
  release({ ok: true, headers: { get: () => '1' } }); await settle();
  assert.equal(s.hook.enabled, false); assert.equal(s.uuidCalls, 0); assert.equal(s.timers.size, 0);
  assert.equal(s.window.count() + s.document.count(), 0); assert.equal(s.posts().length, 0);
});

test('metadata-only checkpoints, immutable snapshot and late gate entry', async () => {
  const s = await sandbox(); await s.hook.flush();
  assert.equal(s.posts().length, 1);
  s.stats.loaded = 16; s.stats.firstFrameMs = 10; s.stats.loadTimes.senna = 42;
  await s.tick(250); await s.hook.flush();
  assert.equal(s.posts().length, 2); assert.equal(s.posts()[1].samples.length, 0); assert.equal(s.posts()[1].milestones.allLoaded, 250);
  s.stats.loadTimes.senna = 99;
  s.document.dispatch('click', { target: { closest: () => ({ id: 'gateEnter' }) } }); await s.hook.flush();
  const last = s.posts().at(-1); assert.equal(last.final.stats.loadTimes.senna, 42); assert.equal(last.milestones.enter, 250);
  assert(s.posts().every(p => p.context.ua === 'test browser')); assert.deepEqual(s.posts().map(p => p.seq), [0, 1, 2]);
});

test('single-flight regular flush, hidden checkpoint and terminal callbacks cannot resurrect', async () => {
  let release;
  const s = await sandbox({ transport: () => new Promise(r => { release = r; }) });
  const pending = s.hook.flush(); await settle(); await s.hook.flush(); assert.equal(s.posts().length, 1);
  s.stats.loaded = 16; await s.tick(250);
  s.document.hidden = true; s.document.dispatch('visibilitychange');
  assert.equal(s.beacons.length, 1); assert.equal(s.timers.size, 0);
  const checkpoint = JSON.parse(await s.beacons[0].blob.text()); assert.equal(checkpoint.seq, 1); assert.equal(checkpoint.milestones.allLoaded, 250);
  s.window.dispatch('pagehide', { persisted: false }); assert.equal(s.hook.enabled, false); assert.equal(s.window.count() + s.document.count(), 0);
  release({ ok: true }); await pending; await s.tick(30000); assert.equal(s.posts().length, 1); assert.equal(s.timers.size, 0);
});

test('hidden/visible and bfcache preserve session with exactly one sampler; false beacon uses keepalive', async () => {
  const s = await sandbox({ beacon: false }); s.stats.loaded = 16; await s.tick(250);
  const id = s.hook.session;
  for (let i = 0; i < 3; i++) {
    s.document.hidden = true; s.document.dispatch('visibilitychange'); await settle(); assert.equal(s.timers.size, 0);
    s.window.dispatch('pagehide', { persisted: true }); await settle();
    s.document.hidden = false; s.window.dispatch('pageshow', { persisted: true }); s.document.dispatch('visibilitychange');
    assert.equal([...s.timers.values()].filter(t => t.ms === 1000).length, 1); assert.equal(s.timers.size, 2);
  }
  assert.equal(s.hook.session, id); assert.equal(s.uuidCalls, 1); assert(s.calls.filter(c => c.method === 'POST').every(c => c.keepalive));
  await s.tick(1000); await s.hook.flush(); assert.equal(s.posts().at(-1).samples.length, 1);
  const seqs = s.posts().map(p => p.seq); assert.equal(new Set(seqs).size, seqs.length);
});

test('failure disables quietly and removes every listener/timer without retry', async () => {
  for (const transport of [async () => { throw new Error('offline'); }, async () => ({ ok: false })]) {
    const s = await sandbox({ transport }); await s.hook.flush();
    assert.equal(s.hook.enabled, false); assert.equal(s.timers.size, 0); assert.equal(s.window.count() + s.document.count(), 0);
    await s.tick(60000); await s.hook.flush(); assert.equal(s.posts().length, 1);
  }
});

test('bounded UTF-8 batches drain queues without truncating JSON; errors redact URLs and tokens', async () => {
  const s = await sandbox();
  for (let i = 0; i < 500; i++) s.window.dispatch('error', { message: '字'.repeat(300) });
  await s.hook.flush();
  assert(s.posts().length > 1); assert.equal(s.posts().reduce((n, p) => n + p.events.length, 0), 500);
  assert(s.calls.filter(c => c.body).every(c => Buffer.byteLength(c.body) <= 48 * 1024));
  s.window.dispatch('error', { message: 'https://private.test/page?token=abc token=abc /path?secret=xyz' }); await s.hook.flush();
  const msg = s.posts().at(-1).events[0].data.msg; assert(!msg.includes('abc')); assert(!msg.includes('xyz')); assert(!msg.includes('private.test'));
});

test('selected orbit, settling, flight and overview use active cadence; idle/offscreen/fallback stay unknown', async () => {
  const s = await sandbox(); s.stats.loaded = 16; await s.tick(250);
  const read = async () => { await s.tick(1000); await s.hook.flush(); return s.posts().at(-1).samples.at(-1); };
  assert.equal((await read()).fps, null);
  s.engine.target = 2; let row = await read(); assert.equal(row.phase, 'browse'); assert.equal(row.fps, 120);
  s.engine.flight = {}; row = await read(); assert.equal(row.phase, 'flight');
  s.engine.flight = null; s.engine.target = 0; s.window.__VELANCE_QA__.selected = 0; s.engine.mode = 'selected'; s.engine.controls.enabled = true;
  row = await read(); assert.equal(row.phase, 'selected-orbit'); assert.equal(row.fps, 120);
  s.engine.controls.enabled = false; row = await read(); assert.equal(row.phase, 'selected-idle'); assert.equal(row.fps, null);
  s.window.__VELANCE_QA__.selected = null; s.window.__VELANCE_QA__.overview = true; row = await read(); assert.equal(row.phase, 'overview'); assert.equal(row.fps, null);
  s.engine.flight = {}; s.engine.stage.getBoundingClientRect = () => ({ top: 1000, bottom: 1800 }); assert.equal((await read()).fps, null);
  const fallback = await sandbox(); fallback.window.__VELANCE_QA__.fallback = true; fallback.window.__VELANCE_QA__.engineError = 'GPU unavailable';
  await fallback.tick(250); await fallback.hook.flush(); const b = fallback.posts()[0]; assert.equal(b.backend, 'images'); assert.equal(b.milestones.allLoaded, null); assert.equal(b.events[0].type, 'engineError'); assert.equal([...fallback.timers.values()].filter(t => t.ms === 1000).length, 0);
});
