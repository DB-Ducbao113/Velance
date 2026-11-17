const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ms = v => v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
const clock = ts => new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
const BACKEND_COLOR = { webgpu: '#e8cd9f', webgl2: '#7fa3b8', images: '#8a8578', unknown: '#5a5548' };

let openId = null, detailVersion = 0, refreshing = false, pendingLoad = false, detailController = null;
let listCursor = null, nextListCursor = null, detail = null, expanded = false;

function seriesPath(rows, value, x, y) {
  let connected = false;
  return rows.map((row, i) => {
    const v = value(row);
    if (v == null) { connected = false; return ''; }
    const command = connected ? 'L' : 'M'; connected = true;
    return `${command}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  }).join(' ');
}

function kpis(sum) {
  const total = sum.sessions || 0;
  const webgpu = sum.backends.webgpu || 0;
  const cards = [
    ['Sessions', total, 'started within selected window'],
    ['WebGPU share', total ? `${Math.round(webgpu / total * 100)}%` : '—', `${webgpu} webgpu · ${sum.backends.webgl2 || 0} webgl2 · ${sum.fallback} fallback`],
    ['First car · p50', ms(sum.load.firstCar.p50), `p95 ${ms(sum.load.firstCar.p95)} · n=${sum.load.firstCar.n}`],
    ['All loaded · p50', ms(sum.load.allLoaded.p50), `p95 ${ms(sum.load.allLoaded.p95)} · n=${sum.load.allLoaded.n}`],
    ['Errors', sum.errors, `${sum.fallback} image-fallback sessions`]
  ];
  $('#kpiRow').innerHTML = cards.map(([label, value, sub]) =>
    `<div class="kpi"><span class="eyebrow">${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(sub)}</small></div>`).join('');
}

function trendChart(trend) {
  const pts = trend;
  const host = $('#trendChart');
  if (pts.length < 2) {
    host.innerHTML = '<div class="empty">Not enough sessions yet — open the showroom on this origin to record boots.</div>';
    return;
  }
  const W = 900, H = 220, PAD = 34;
  const maxY = Math.max(0, ...pts.flatMap(t => [t.firstCar, t.allLoaded]).filter(Number.isFinite)) * 1.15 || 1000;
  const x = i => PAD + i / (pts.length - 1) * (W - PAD * 2);
  const y = v => H - PAD - (v / maxY) * (H - PAD * 2);
  const line = key => seriesPath(pts, t => t[key], x, y);
  const dots = key => pts.map((t, i) => t[key] == null ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${y(t[key]).toFixed(1)}" r="2.5" fill="${key === 'firstCar' ? '#e8cd9f' : '#7fa3b8'}"/>`).join('');
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Boot load trend">
    <line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="rgba(232,205,159,.2)"/>
    <line x1="${PAD}" y1="${PAD}" x2="${PAD}" y2="${H - PAD}" stroke="rgba(232,205,159,.2)"/>
    <text x="${PAD - 6}" y="${PAD + 4}" fill="#8a8578" font-size="9" text-anchor="end" font-family="monospace">${Math.round(maxY)}</text>
    <text x="${PAD - 6}" y="${H - PAD + 3}" fill="#8a8578" font-size="9" text-anchor="end" font-family="monospace">0</text>
    <text x="${W - PAD}" y="${H - PAD + 14}" fill="#8a8578" font-size="9" text-anchor="end" font-family="monospace">ms · sessions oldest → newest</text>
    <path d="${line('allLoaded')}" fill="none" stroke="#7fa3b8" stroke-width="1.5"/>
    <path d="${line('firstCar')}" fill="none" stroke="#e8cd9f" stroke-width="1.5"/>
    ${dots('allLoaded')}${dots('firstCar')}
  </svg>`;
}

function phaseTable(phases) {
  const host = $('#phaseTable');
  if (!phases.length) { host.innerHTML = '<div class="empty">No frame samples yet.</div>'; return; }
  host.innerHTML = phases.map(p => `<div class="phase-row">
    <span class="phase-name">${esc(p.phase)}</span>
    <span class="phase-bar"><i style="width:${Math.min(100, (p.fpsP50 ?? 0) / 60 * 100).toFixed(0)}%"></i></span>
    <span class="phase-nums">${p.fpsP50 ?? '—'} fps p50 · ${p.fpsP95 ?? '—'} p95 · active n=${p.fpsN}</span>
  </div>`).join('');
}

function mixChart(sum) {
  const entries = Object.entries(sum.backends).filter(([, n]) => n > 0);
  const total = entries.reduce((n, [, v]) => n + v, 0);
  const host = $('#mixChart');
  if (!total) { host.innerHTML = '<div class="empty">No sessions yet.</div>'; return; }
  const C = 2 * Math.PI * 54;
  let offset = 0;
  const rings = entries.map(([name, n]) => {
    const len = n / total * C;
    const seg = `<circle cx="70" cy="70" r="54" fill="none" stroke="${BACKEND_COLOR[name] || '#5a5548'}" stroke-width="12" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 70 70)"/>`;
    offset += len;
    return seg;
  }).join('');
  const legend = entries.map(([name, n]) =>
    `<span><i style="background:${BACKEND_COLOR[name] || '#5a5548'}"></i>${esc(name)} <small>${n} · ${Math.round(n / total * 100)}%</small></span>`).join('');
  host.innerHTML = `<svg viewBox="0 0 140 140" width="140" height="140" role="img" aria-label="Backend mix">${rings}
    <text x="70" y="66" text-anchor="middle" fill="#e8cd9f" font-size="22" font-family="Georgia,serif">${total}</text>
    <text x="70" y="82" text-anchor="middle" fill="#8a8578" font-size="8" letter-spacing="2">SESSIONS</text></svg>
    <div class="mix-legend">${legend}
      <span><i style="background:#d9d3c7"></i>desktop <small>${sum.desktop}</small></span>
      <span><i style="background:#5a5548"></i>mobile <small>${sum.mobile}</small></span>
    </div>`;
}

function sessionRows(list) {
  const host = $('#sessionRows');
  if (!list.length) { host.innerHTML = '<tr><td colspan="7" class="empty">No sessions yet.</td></tr>'; return; }
  host.innerHTML = list.map(s => `<tr data-id="${esc(s.id)}">
    <td>${clock(s.received_at)}</td>
    <td><span class="chip chip-${esc(s.backend || 'unknown')}">${esc(s.backend || 'unknown')}</span></td>
    <td>${s.mobile == null ? 'unknown' : s.mobile ? 'mobile' : 'desktop'}</td>
    <td>${ms(s.milestones.firstCar)}</td>
    <td>${ms(s.milestones.allLoaded)}</td>
    <td>${s.samples_n}</td>
    <td class="${s.errors_n ? 'err-n' : ''}">${s.errors_n}</td>
  </tr>`).join('');
}

function waterfall(m) {
  const rows = [
    ['first frame', m.firstFrame],
    ['first car', m.firstCar],
    ['enter (gate dwell)', m.enter],
    ['all sixteen loaded', m.allLoaded]
  ].filter(([, v]) => v != null).sort((a, b) => a[1] - b[1]);
  const total = Math.max(1, ...rows.map(([, v]) => v));
  if (!rows.length) return '<div class="empty">No milestones recorded.</div>';
  return rows.map(([label, v]) => `<div class="wf-row">
    <span class="wf-label">${esc(label)}</span>
    <span class="wf-track"><i style="left:0;width:${Math.min(100, v / total * 100).toFixed(1)}%"></i></span>
    <span class="wf-ms">${ms(v)}</span>
  </div>`).join('');
}

function sparkline(samples) {
  if (samples.length < 2) return '<div class="empty">No frame samples.</div>';
  const W = 440, H = 120;
  const yMax = samples.reduce((max, s) => Math.max(max, s.fps ?? 0), 70);
  const x = i => i / (samples.length - 1) * W;
  const y = f => H - Math.min(yMax, Math.max(0, f ?? 0)) / yMax * H;
  const bands = [];
  let start = 0;
  for (let i = 1; i <= samples.length; i++) {
    if (i === samples.length || samples[i].phase !== samples[start].phase) {
      bands.push(`<rect x="${x(start).toFixed(1)}" y="0" width="${(x(i - 1) - x(start)).toFixed(1)}" height="${H}" fill="${samples[start].phase.includes('idle') ? 'rgba(255,255,255,.03)' : 'rgba(232,205,159,.06)'}"/>`);
      start = i;
    }
  }
  const pts = seriesPath(samples, s => s.fps, x, y);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Frame cadence">${bands.join('')}
    <line x1="0" y1="${y(60)}" x2="${W}" y2="${y(60)}" stroke="rgba(232,205,159,.25)" stroke-dasharray="3 3"/>
    <path d="${pts}" fill="none" stroke="#e8cd9f" stroke-width="1.2"/>
    ${samples.map((s, i) => s.fps == null ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${y(s.fps).toFixed(1)}" r="1.5" fill="#e8cd9f"/>`).join('')}
    <text x="2" y="${y(60) - 3}" fill="#8a8578" font-size="8" font-family="monospace">60 fps</text></svg>`;
}

function loadBars(final) {
  const times = final?.stats?.loadTimes;
  if (!times || !Object.keys(times).length) return '<div class="empty">No per-machine load times.</div>';
  const entries = Object.entries(times).sort((a, b) => b[1] - a[1]);
  const max = entries[0][1] || 1;
  return entries.map(([id, t]) => `<div class="load-row">
    <span class="wf-label">${esc(id.replace(/^\d{4}_/, '').replace(/\.glb$/, '').replace(/_/g, ' '))}</span>
    <span class="wf-track"><i style="width:${(t / max * 100).toFixed(1)}%"></i></span>
    <span class="wf-ms">${ms(t)}</span>
  </div>`).join('');
}

function eventLog(events) {
  if (!events.length) return '<div class="empty">No events.</div>';
  return events.map(e => `<div class="${e.type === 'error' || e.type === 'engineError' ? 'ev-error' : ''}">
    <b>${esc(e.type)}</b> @ ${ms(e.t)}${e.data?.msg ? ` · ${esc(e.data.msg)}` : e.data?.i != null ? ` · swatch ${esc(e.data.i)}` : ''}
  </div>`).join('');
}

async function openSession(id, userInitiated = false, older = false) {
  if (!userInitiated && (detailController || (expanded && !older))) return;
  if (userInitiated) { detail = null; expanded = false; }
  openId = id;
  const version = ++detailVersion;
  detailController?.abort();
  const controller = new AbortController();
  detailController = controller;
  try {
    const params = new URLSearchParams();
    if (older) for (const key of ['samples', 'events']) if (detail?.page[key].next) params.set(key, detail.page[key].next);
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}?${params}`, { signal: controller.signal });
    if (!res.ok) throw new Error('api');
    const s = await res.json();
    if (openId !== id || version !== detailVersion) return;
    if (older && detail) {
      for (const key of ['samples', 'events']) {
        const merged = new Map([...s[key], ...detail[key]].map(row => [key === 'samples' ? row.t : `${row.t}:${row.type}`, row]));
        s[key] = [...merged.values()].sort((a, b) => a.t - b.t || (a.type || '').localeCompare(b.type || ''));
        if (!detail.page[key].next) s.page[key].next = null;
      }
      expanded = true;
    }
    detail = s;
    $('#detailCoverage').textContent = `${s.samples.length}/${s.page.samples.total} samples · ${s.events.length}/${s.page.events.total} events${expanded ? ' · historical view, refresh paused' : ' · latest first'} `;
    $('#detailOlder').disabled = !s.page.samples.next && !s.page.events.next;
    $('#drill').hidden = false;
    $('#drillTitle').innerHTML = `Session <em>${esc(id.slice(0, 8))}</em>`;
    const c = s.context || {};
    $('#drillContext').textContent = `${c.ua || 'unknown UA'} · ${c.screen || '?'} @${c.dpr || '?'}x · ${c.cores || '?'} cores · ${c.memory || '?'} GB · net ${c.net || '?'} · webgpu ${c.webgpu == null ? '?' : c.webgpu ? 'yes' : 'no'} · ${s.backend || 'unknown'}`;
    $('#drillWaterfall').innerHTML = waterfall(s.milestones || {});
    $('#drillSpark').innerHTML = sparkline(s.samples);
    $('#drillLoads').innerHTML = loadBars(s.final);
    $('#drillEvents').innerHTML = eventLog(s.events);
    if (userInitiated) $('#drill').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    if (error.name !== 'AbortError' && version === detailVersion) $('#updatedAt').textContent = 'session unavailable';
  } finally {
    if (detailController === controller) detailController = null;
  }
}

async function load(user = false) {
  if (refreshing) { if (user) pendingLoad = true; return; }
  refreshing = true;
  const cursor = listCursor, hours = $('#summaryWindow').value;
  try {
    const [sumRes, listRes] = await Promise.all([fetch(`/api/summary?hours=${hours}`), fetch(`/api/sessions?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)]);
    if (pendingLoad) return;
    if (sumRes.status === 422) throw new Error('WINDOW_TOO_LARGE');
    if (!sumRes.ok || !listRes.ok) throw new Error('api');
    const sum = await sumRes.json();
    const list = await listRes.json();
    if (pendingLoad) return;
    kpis(sum);
    trendChart(sum.trend);
    phaseTable(sum.phases);
    mixChart(sum);
    sessionRows(list);
    nextListCursor = listRes.headers.get('X-Next-Cursor');
    $('#sessionsOlder').disabled = !nextListCursor;
    $('#sessionsLatest').disabled = !cursor;
    $('#windowCoverage').textContent = `${new Date(sum.window.from).toLocaleString()} → ${new Date(sum.window.to).toLocaleString()} · snapshot ${clock(sum.window.snapshotAt)}`;
    $('#trendCoverage').textContent = `Latest ${sum.trend.length} of ${sum.trendTotal} sessions in cohort · KPIs include the entire window`;
    $('#updatedAt').textContent = `live · updated ${clock(Date.now())}`;
    if (openId) await openSession(openId);
  } catch (error) {
    if (!pendingLoad) $('#updatedAt').textContent = error.message === 'WINDOW_TOO_LARGE' ? 'Window too large — select a shorter range' : 'ops server unreachable';
  } finally {
    refreshing = false;
    if (pendingLoad) { pendingLoad = false; void load(); }
  }
}

$('#sessionRows').addEventListener('click', e => {
  const row = e.target.closest('tr[data-id]');
  if (row) void openSession(row.dataset.id, true);
});
$('#drillClose').addEventListener('click', () => {
  openId = null; detailVersion++; detailController?.abort(); detailController = null; $('#drill').hidden = true;
});

$('#summaryWindow').addEventListener('change', () => void load(true));
$('#sessionsOlder').addEventListener('click', () => {
  if (!nextListCursor) return;
  listCursor = nextListCursor; nextListCursor = null; $('#sessionsOlder').disabled = true; void load(true);
});
$('#sessionsLatest').addEventListener('click', () => { listCursor = null; $('#sessionsLatest').disabled = true; void load(true); });
$('#detailOlder').addEventListener('click', () => { if (openId) void openSession(openId, false, true); });
$('#detailLatest').addEventListener('click', () => { if (openId) void openSession(openId, true); });
load();
setInterval(load, 5000);