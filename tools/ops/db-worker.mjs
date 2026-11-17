import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { openStore } from './store.mjs';

const unavailable = () => Object.assign(new Error('DB_UNAVAILABLE'), { status: 503, code: 'DB_UNAVAILABLE' });
export function classify(error) {
  if (error.status) return { status: error.status, code: error.code };
  const primary = error.errcode & 255;
  if ([5, 6].includes(primary)) return { status: 503, code: 'DB_BUSY' };
  if ([8, 10, 11, 13, 14, 26].includes(primary)) return { status: 503, code: 'DB_STORAGE_FAILURE', storageFault: true };
  return { status: 500, code: 'INTERNAL' };
}

if (!isMainThread && workerData?.velanceDatabase) {
  const { dbPath, readOnly } = workerData.velanceDatabase;
  let store;
  try { store = await openStore(dbPath, readOnly); }
  catch (error) { parentPort.postMessage({ initError: classify(error) }); parentPort.close(); }
  if (store) {
    parentPort.postMessage({ ready: true, backupPath: store.backupPath });
    parentPort.on('message', async ({ id, method, value }) => {
      if (method === 'close') { store.close(); parentPort.close(); return; }
      const start = performance.now();
      try { const result = await store.call(method, value); parentPort.postMessage({ id, result, ms: performance.now() - start }); }
      catch (error) { parentPort.postMessage({ id, error: classify(error), ms: performance.now() - start }); }
    });
  }
}

async function connect(dbPath, readOnly, observe, onFailure) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { velanceDatabase: { dbPath, readOnly } }, execArgv: [] });
  const limit = readOnly ? 16 : 128, byteLimit = readOnly ? 65536 : 8 * 1024 * 1024;
  const jobs = new Map(), waiting = [];
  let sequence = 0, bytes = 0, active = null, healthy = false, closing = false, closePromise;
  let readyResolve, readyReject, closeResolve;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const exited = new Promise(resolve => { closeResolve = resolve; });
  function failed(reason) {
    if (healthy && !closing) onFailure(readOnly ? 'reader' : 'writer', reason);
    healthy = false; readyReject(unavailable());
    for (const job of jobs.values()) { clearTimeout(job.timer); job.reject(unavailable()); }
    jobs.clear(); waiting.length = 0; bytes = 0; active = null;
  }
  function pump() {
    if (active || !healthy) return;
    if (!waiting.length) { if (closing) worker.postMessage({ method: 'close' }); return; }
    active = waiting.shift();
    const job = jobs.get(active);
    worker.postMessage({ id: active, method: job.method, value: job.value }); job.value = null;
  }
  worker.on('message', message => {
    if (message.initError) { readyReject(Object.assign(new Error(message.initError.code), message.initError)); return; }
    if (message.ready) { healthy = true; readyResolve(message.backupPath); return; }
    const job = jobs.get(message.id);
    if (!job) return;
    jobs.delete(message.id); bytes -= job.bytes; active = null; clearTimeout(job.timer);
    observe(readOnly ? 'query' : job.method === 'ingest' ? 'commit' : 'maintenance', message.ms, message.error?.code);
    if (message.error) job.reject(Object.assign(new Error(message.error.code), message.error)); else job.resolve(message.result);
    if (message.error?.storageFault) { failed('storage'); void worker.terminate(); } else pump();
  });
  worker.on('error', () => failed('error'));
  worker.on('exit', () => { failed('exit'); closeResolve(); });
  const backupPath = await ready;
  return { backupPath,
    get healthy() { return healthy && !closing; },
    get stats() { return { jobs: jobs.size, bytes, limit, byteLimit }; },
    call(method, value, size = 512) {
      if (!healthy || closing) return Promise.reject(unavailable());
      if (jobs.size >= limit || bytes + size > byteLimit) return Promise.reject(Object.assign(new Error('DB_QUEUE_FULL'), { status: 429, code: 'DB_QUEUE_FULL' }));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        // Timed-out work keeps its reservation until the worker finishes or exits, so the bound stays honest.
        const timer = setTimeout(() => reject(Object.assign(new Error('DB_DEADLINE'), { status: 503, code: 'DB_DEADLINE' })), 10000);
        jobs.set(id, { method, value, bytes: size, resolve, reject, timer }); bytes += size; waiting.push(id); pump();
      });
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      const timer = setTimeout(() => { failed('close-timeout'); void worker.terminate(); }, 10000);
      pump(); closePromise = exited.finally(() => clearTimeout(timer));
      return closePromise;
    },
    async terminate() { failed('terminated'); await worker.terminate(); } };
}

export async function createDatabase(dbPath, observe = () => {}, onFailure = () => {}) {
  const writer = await connect(dbPath, false, observe, onFailure);
  let reader;
  try { reader = await connect(dbPath, true, observe, onFailure); } catch (error) { await writer.close(); throw error; }
  return { writer, reader, backupPath: writer.backupPath,
    get healthy() { return writer.healthy && reader.healthy; },
    close: () => Promise.all([reader.close(), writer.close()]),
    terminate: () => Promise.all([reader.terminate(), writer.terminate()]) };
}
