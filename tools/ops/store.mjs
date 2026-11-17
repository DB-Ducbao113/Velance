import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const DAY = 86400000;
export const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const parse = value => value == null ? null : JSON.parse(value);
const percentile = (values, q) => {
  values.sort((a, b) => a - b);
  return values.length ? values[Math.min(values.length - 1, Math.floor(q * values.length))] : null;
};
function mergeKnown(old, fresh, newer) {
  const merged = { ...(old || {}) };
  for (const [key, value] of Object.entries(fresh || {})) if (value != null && (newer || merged[key] == null)) merged[key] = value;
  return merged;
}
const cursor = value => Buffer.from(JSON.stringify(value)).toString('base64url');
export function decodeCursor(value, length) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) fail(400, 'BAD_CURSOR');
  let row;
  try { row = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { fail(400, 'BAD_CURSOR'); }
  if (!Array.isArray(row) || row.length !== length || !Number.isSafeInteger(row[0]) || row[0] < 0 || (length === 2 && (typeof row[1] !== 'string' || row[1].length > 64))) fail(400, 'BAD_CURSOR');
  return row;
}

export async function openStore(dbPath, readOnly = false) {
  const db = new DatabaseSync(dbPath, { readOnly });
  let backupPath = null;
  try {
    db.exec('PRAGMA busy_timeout=200; PRAGMA foreign_keys=ON');
    if (readOnly) db.exec('PRAGMA query_only=ON');
    else {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").get();
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version > 2) fail(503, 'SCHEMA_TOO_NEW');
      if (exists && version < 2) {
        backupPath = `${dbPath}.pre-v2-${Date.now()}-${randomUUID()}.bak`;
        await backup(db, backupPath); chmodSync(backupPath, 0o600);
      }
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
      try {
        db.exec(`CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, started_at INTEGER, received_at INTEGER, context TEXT, milestones TEXT, backend TEXT, mobile INTEGER, final TEXT, last_seq INTEGER NOT NULL DEFAULT -1);
          CREATE TABLE IF NOT EXISTS samples(session_id TEXT,t INTEGER,phase TEXT,fps REAL,render_avg REAL,render_p95 REAL,draw_calls INTEGER,triangles INTEGER,loaded INTEGER,heap_mb REAL,pixel_ratio REAL,PRIMARY KEY(session_id,t));
          CREATE TABLE IF NOT EXISTS events(session_id TEXT,t INTEGER,type TEXT,data TEXT,PRIMARY KEY(session_id,t,type));
          CREATE TABLE IF NOT EXISTS batches(session_id TEXT,seq INTEGER,PRIMARY KEY(session_id,seq));`);
        if (!db.prepare('PRAGMA table_info(sessions)').all().some(c => c.name === 'last_seq')) db.exec('ALTER TABLE sessions ADD COLUMN last_seq INTEGER NOT NULL DEFAULT -1');
        db.exec(`CREATE INDEX IF NOT EXISTS sessions_received ON sessions(received_at,id);
          CREATE INDEX IF NOT EXISTS sessions_started ON sessions(started_at,id);
          PRAGMA user_version=2; COMMIT`);
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      chmodSync(dbPath, 0o600);
    }
  } catch (error) { db.close(); throw error; }
  const getSession = db.prepare('SELECT * FROM sessions WHERE id=?');
  const receipt = db.prepare('SELECT 1 FROM batches WHERE session_id=? AND seq=?');
  const statements = readOnly ? null : {
    receipt: db.prepare('INSERT INTO batches VALUES(?,?)'),
    session: db.prepare(`INSERT INTO sessions(id,started_at,received_at,context,milestones,backend,mobile,final,last_seq) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET received_at=excluded.received_at,context=excluded.context,milestones=excluded.milestones,backend=excluded.backend,mobile=excluded.mobile,final=excluded.final,last_seq=excluded.last_seq`),
    sample: db.prepare('INSERT OR IGNORE INTO samples VALUES(?,?,?,?,?,?,?,?,?,?,?)'),
    event: db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?,?)')
  };
  function ingest(b) {
    const now = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      if (receipt.get(b.id, b.seq)) { db.exec('COMMIT'); return { duplicate: true }; }
      if (b.startedAt < now - 30 * DAY) fail(400, 'SESSION_EXPIRED');
      if (b.startedAt > now + 300000) fail(400, 'SESSION_CLOCK_AHEAD');
      const old = getSession.get(b.id);
      if (old && old.started_at !== b.startedAt) fail(400, 'SESSION_IDENTITY_MISMATCH');
      const newer = !old || b.seq > old.last_seq, priorContext = parse(old?.context);
      if (priorContext && b.context && Object.entries(b.context).some(([k, v]) => v != null && priorContext[k] != null && priorContext[k] !== v)) fail(400, 'SESSION_CONTEXT_MISMATCH');
      const context = mergeKnown(priorContext, b.context, false), milestones = mergeKnown(parse(old?.milestones), b.milestones, newer);
      for (const k of ['gateShown', 'enter', 'firstFrame', 'firstCar', 'allLoaded']) milestones[k] ??= null;
      const previous = parse(old?.final);
      let final = previous;
      if (b.final) {
        final = mergeKnown(previous, b.final, newer);
        const stats = mergeKnown(previous?.stats, b.final.stats, newer);
        if (previous?.stats?.loadTimes || b.final.stats?.loadTimes) stats.loadTimes = mergeKnown(previous?.stats?.loadTimes, b.final.stats?.loadTimes, newer);
        final.stats = Object.keys(stats).length ? stats : null;
      }
      const backend = (newer ? b.backend ?? old?.backend : old?.backend ?? b.backend) ?? null;
      statements.receipt.run(b.id, b.seq);
      statements.session.run(b.id, b.startedAt, now, Object.keys(context).length ? JSON.stringify(context) : null, JSON.stringify(milestones), backend,
        context.mobile == null ? null : Number(context.mobile), final ? JSON.stringify(final) : null, Math.max(old?.last_seq ?? -1, b.seq));
      for (const s of b.samples) statements.sample.run(b.id, s.t, s.phase, s.fps ?? null, s.renderAvg ?? null, s.renderP95 ?? null, s.drawCalls ?? null, s.triangles ?? null, s.loaded ?? null, s.heapMB ?? null, s.pixelRatio ?? null);
      for (const e of b.events) statements.event.run(b.id, e.t, e.type, e.data == null ? null : JSON.stringify(e.data));
      db.exec('COMMIT'); return { duplicate: false };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const cohort = 'FROM sessions s INDEXED BY sessions_started';
  const range = 's.started_at>=? AND s.started_at<?';
  function summary({ from, to }) {
    const count = db.prepare(`SELECT count(*) n FROM (SELECT 1 ${cohort} CROSS JOIN samples p ON p.session_id=s.id WHERE ${range} LIMIT 1000001)`).get(from, to).n;
    if (count > 1000000) fail(422, 'WINDOW_TOO_LARGE');
    const rows = db.prepare(`SELECT s.started_at,s.backend,s.mobile,s.milestones ${cohort} WHERE ${range} ORDER BY s.started_at,s.id`).all(from, to);
    const backends = {}, groups = new Map(), loads = { firstCar: [], allLoaded: [] };
    let mobile = 0, desktop = 0, unknownDevice = 0;
    for (const s of rows) {
      backends[s.backend || 'unknown'] = (backends[s.backend || 'unknown'] || 0) + 1;
      if (s.mobile === 1) mobile++; else if (s.mobile === 0) desktop++; else unknownDevice++;
      s.m = parse(s.milestones) || {};
      for (const k of Object.keys(loads)) if (Number.isFinite(s.m[k])) loads[k].push(s.m[k]);
    }
    for (const r of db.prepare(`SELECT p.phase,p.fps,p.render_p95 ${cohort} CROSS JOIN samples p ON p.session_id=s.id WHERE ${range}`).iterate(from, to)) {
      if (!groups.has(r.phase)) groups.set(r.phase, { n: 0, fps: [], p95: [] });
      const g = groups.get(r.phase); g.n++;
      if (Number.isFinite(r.fps)) g.fps.push(r.fps);
      if (Number.isFinite(r.render_p95)) g.p95.push(r.render_p95);
    }
    return { sessions: rows.length, backends, mobile, desktop, unknownDevice, fallback: backends.images || 0,
      errors: db.prepare(`SELECT count(*) n ${cohort} CROSS JOIN events e ON e.session_id=s.id WHERE ${range} AND e.type IN ('error','engineError')`).get(from, to).n,
      load: Object.fromEntries(Object.entries(loads).map(([k, values]) => [k, { p50: percentile(values, .5), p95: percentile(values, .95), n: values.length }])),
      phases: [...groups].map(([phase, g]) => ({ phase, n: g.n, fpsN: g.fps.length, fpsP50: percentile(g.fps, .5), fpsP95: percentile(g.fps, .95), renderP95P50: percentile(g.p95, .5) })).sort((a, b) => b.n - a.n),
      trend: rows.slice(-500).map(s => ({ startedAt: s.started_at, backend: s.backend, firstCar: s.m.firstCar ?? null, allLoaded: s.m.allLoaded ?? null })),
      trendTotal: rows.length, window: { from, to, snapshotAt: Date.now(), cohort: 'session-start' } };
  }
  function sessions({ limit, cursor: after }) {
    const key = decodeCursor(after, 2);
    const rows = db.prepare(`SELECT s.*,(SELECT count(*) FROM samples p WHERE p.session_id=s.id) samples_n,
      (SELECT count(*) FROM events e WHERE e.session_id=s.id AND e.type IN ('error','engineError')) errors_n
      FROM sessions s ${key ? 'WHERE (s.received_at,s.id)<(?,?)' : ''} ORDER BY s.received_at DESC,s.id DESC LIMIT ?`).all(...(key || []), limit + 1);
    const more = rows.length > limit; rows.length = Math.min(rows.length, limit);
    return { rows: rows.map(s => ({ ...s, context: parse(s.context), milestones: parse(s.milestones), final: parse(s.final) })),
      next: more ? cursor([rows.at(-1).received_at, rows.at(-1).id]) : null };
  }
  function detail({ id, sampleCursor, eventCursor }) {
    const s = getSession.get(id); if (!s) fail(404, 'NOT_FOUND');
    const sk = decodeCursor(sampleCursor, 1), ek = decodeCursor(eventCursor, 2);
    const samples = db.prepare(`SELECT * FROM samples WHERE session_id=? ${sk ? 'AND t<?' : ''} ORDER BY t DESC LIMIT 2001`).all(id, ...(sk || []));
    const events = db.prepare(`SELECT * FROM events WHERE session_id=? ${ek ? 'AND (t,type)<(?,?)' : ''} ORDER BY t DESC,type DESC LIMIT 501`).all(id, ...(ek || []));
    const sampleMore = samples.length > 2000, eventMore = events.length > 500;
    samples.length = Math.min(samples.length, 2000); events.length = Math.min(events.length, 500);
    const page = { samples: { next: sampleMore ? cursor([samples.at(-1).t]) : null, total: db.prepare('SELECT count(*) n FROM samples WHERE session_id=?').get(id).n },
      events: { next: eventMore ? cursor([events.at(-1).t, events.at(-1).type]) : null, total: db.prepare('SELECT count(*) n FROM events WHERE session_id=?').get(id).n } };
    return { ...s, context: parse(s.context), milestones: parse(s.milestones), final: parse(s.final),
      samples: samples.reverse(), events: events.reverse().map(e => ({ ...e, data: parse(e.data) })), page };
  }
  const eligibleCount = db.prepare('SELECT count(*) n FROM sessions WHERE received_at<?');
  const dependentCounts = ['samples', 'events', 'batches'].map(table => [table, db.prepare(`SELECT count(*) n FROM ${table} WHERE session_id IN (SELECT id FROM sessions WHERE received_at<?)`)]);
  const eligibleIds = db.prepare('SELECT id FROM sessions WHERE received_at<? ORDER BY received_at,id LIMIT 100');
  const deletes = readOnly ? null : ['samples', 'events', 'batches', 'sessions'].map(table => db.prepare(`DELETE FROM ${table} WHERE ${table === 'sessions' ? 'id' : 'session_id'}=?`));
  function retention({ apply = false } = {}) {
    const cutoff = Date.now() - 30 * DAY - 300000;
    if (!apply) return { cutoff, eligible: eligibleCount.get(cutoff).n, rows: Object.fromEntries(dependentCounts.map(([table, statement]) => [table, statement.get(cutoff).n])), deleted: 0 };
    if (readOnly) fail(400, 'BAD_OPERATION');
    db.exec('BEGIN IMMEDIATE');
    try {
      const ids = eligibleIds.all(cutoff).map(s => s.id);
      for (const id of ids) for (const statement of deletes) statement.run(id);
      db.exec('COMMIT');
      return { cutoff, deleted: ids.length };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return { db, backupPath, close: () => db.close(), async call(method, value) {
    if (readOnly) {
      if (!['summary', 'sessions', 'detail', 'retention'].includes(method)) fail(400, 'BAD_OPERATION');
      db.exec('BEGIN');
      try { const result = ({ summary, sessions, detail, retention })[method](value); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    if (method === 'ingest') return ingest(value);
    if (method === 'retention') return retention(value);
    fail(400, 'BAD_OPERATION');
  } };
}
