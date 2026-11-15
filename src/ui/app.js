/* VÉLANCE / V11
 * Home + Selected Machine = one real perspective WebGPU gallery with a WebGL2
 * fallback (engine/showroom.js).
 * Below the showroom: exactly five STATIC transparent 4K images + editorial board.
 */
import { VEHICLES } from '../data/vehicles.js';
import { bootNoirMotion, refreshNoirMotion, motionScrollTo, setImageLoaded, playSelectedMotion } from '../motion/motion.js';
const $ = id => document.getElementById(id);
const clamp = (n, min = 0, max = 1) => Math.min(max, Math.max(min, n));
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const IMG_FILES = ['01-front-three-quarter.webp', '02-near-front.webp', '03-side-profile.webp', '04-rear-three-quarter.webp', '05-signature.webp'];
const SHOTS = [
  { title: 'First impression.', emphasis: 'Unmistakable.', label: 'FRONT THREE-QUARTER', caption: '01 / THE FIRST IMPRESSION', description: 'The complete identity. Sculpted surfaces, stance, and aerodynamic intent.', angle: 'FRONT 3/4', asset: '01-front-three-quarter.webp' },
  { title: 'The face of', emphasis: 'performance.', label: 'NEAR-FRONT', caption: '02 / THE FRONT', description: 'An intimate view of the nose, lighting signature, and front aerodynamic architecture.', angle: 'NEAR-FRONT', asset: '02-near-front.webp' },
  { title: 'An uncompromising', emphasis: 'silhouette.', label: 'SIDE PROFILE', caption: '03 / THE SILHOUETTE', description: 'A single continuous profile reveals the car’s proportions and surface language.', angle: 'PROFILE', asset: '03-side-profile.webp' },
  { title: 'Beauty from', emphasis: 'behind.', label: 'REAR THREE-QUARTER', caption: '04 / THE AERODYNAMICS', description: 'Rear haunches, aero elements, and engineered airflow become the focal point.', angle: 'REAR 3/4', asset: '04-rear-three-quarter.webp' },
  { title: 'The final', emphasis: 'signature.', label: 'SIGNATURE DETAIL', caption: '05 / THE SIGNATURE', description: 'The last perspective completes a five-frame editorial study of the machine.', angle: 'SIGNATURE', asset: '05-signature.webp' }
];
const state = {
  focus: Math.max(0, VEHICLES.findIndex(v => v.id === (new URLSearchParams(location.search).get('car') || 'mclarenp1'))),
  selected: null, engine: null, engineError: null, visibleImages: 0, fallback: false,
  booting: true, pendingSelect: null
};
function toast(text) { $('noticeText').textContent = text; $('notice').hidden = false; }
function modelStatus(text) { $('selectedModelStatus').textContent = text; }
function readout(text) { $('stageReadout').textContent = text; }

/* ------------------------------------------------------------ 3D boot */
async function boot3D() {
  try {
    const { GarageShowroom } = await import('../engine/showroom.js?v=11.0-webgpu');
    const engine = await GarageShowroom.create({
      stage: $('carStage'),
      labelHost: $('carLineup'),
      vehicles: VEHICLES,
      focus: state.focus,
      reduced: reduceMotion,
      onProgress: (loaded, total, index) => {
        $('showroom').classList.add('is-3d');
        $('loaderBar').style.width = `${Math.round(loaded / total * 100)}%`;
        $('loaderCount').textContent = `${pad(loaded)} / ${pad(total)} MACHINES`;
        readout(`REAL GLB · ${loaded}/${total} PARKED`);
        if (loaded >= 1) $('garageLoader').classList.add('is-done');
        if (state.selected === index && state.engine) {
          modelStatus('DRAG TO EXPLORE · REAL GLB');
          $('selectedModelStatus').classList.add('is-ready');
          $('selectedAsset').textContent = `${(state.engine.cars.get(index)?.userData.triangles || 0).toLocaleString()} TRIANGLES`;
        }
      },
      onReady: () => { readout('SIXTEEN BAYS · SIXTEEN MACHINES · NATIVE GLB'); $('garageLoader').classList.add('is-done'); },
      onError: (i, msg) => { console.warn('[VÉLANCE / BAY]', i, msg); readout(`BAY ${pad(i + 1)} ASSET UNAVAILABLE`); },
      onFocus: i => { state.focus = i; $('activeCount').textContent = pad(i + 1); syncRow(i); },
      onSelect: i => selectVehicle(i),
      onOverview: on => {
        const btn = $('overviewBtn');
        btn.setAttribute('aria-pressed', String(on));
        btn.innerHTML = on ? 'EXIT OVERVIEW <span>✕</span>' : 'FULL GALLERY <span>⛶</span>';
        $('interactionHint').innerHTML = on ? 'DRAG TO PAN · TAP A MACHINE TO ENTER' : 'SWIPE THE GALLERY TO EXPLORE <span>↔</span>';
        $('rowBtn').disabled = on;
      }
    });
    state.engine = engine;
    if (state.pendingEntrance) { state.pendingEntrance = false; playEntrance(); }
    $('showroom').classList.add('is-3d');
    $('activeCount').textContent = pad(state.focus + 1);
    $('totalCount').textContent = pad(VEHICLES.length);
    syncRow(state.focus);
  } catch (error) {
    state.engineError = error;
    console.warn('[VÉLANCE] 3D engine unavailable, image fallback engaged:', error);
    buildFallback();
  }
  // Selections made while the GPU was still compiling replay on the live engine.
  state.booting = false;
  const pending = state.pendingSelect;
  state.pendingSelect = null;
  if (pending !== null) selectVehicle(pending);
}
/* Graceful no-WebGL path: the same journey with the real 4K renders. */
function buildFallback() {
  state.fallback = true;
  $('showroom').classList.add('is-fallback');
  $('garageLoader').classList.add('is-done');
  $('rowBtn').hidden = true;
  $('overviewBtn').disabled = true;
  readout('3D UNAVAILABLE · EDITORIAL IMAGE MODE');
  const host = $('carLineup');
  host.innerHTML = '';
  host.className = 'fallback-bays';
  VEHICLES.forEach((v, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'fallback-bay';
    b.innerHTML = `<span class="bay-label-no">BAY ${pad(i + 1)}</span><img src="./assets/images/${v.id}/${IMG_FILES[0]}" alt="${esc(v.make)} ${esc(v.name)}" loading="lazy"><strong>${esc(v.make)} <em>${esc(v.name)}</em></strong>`;
    b.addEventListener('click', () => selectVehicle(i));
    host.appendChild(b);
  });
  $('totalCount').textContent = pad(VEHICLES.length);
}

/* ------------------------------------------------------- selection */
function populateSelected(v, index) {
  $('selectedBay').textContent = `BAY ${pad(index + 1)} / ${pad(VEHICLES.length)}`;
  $('selectedMaker').textContent = v.make;
  $('selectedName').textContent = v.name;
  $('selectedTag').textContent = v.tag;
  $('selectedEdition').textContent = v.edition;
  $('selectedAsset').textContent = `GLB · ${v.mb.toFixed(1)} MB`;
  $('selectedSpecs').innerHTML = v.stats.slice(0, 4).map(([k, value]) => `<div class="selected-spec"><span>${esc(k)}</span><strong>${esc(value)}</strong></div>`).join('');
}
function selectVehicle(index) {
  if (state.booting) { state.pendingSelect = index; return; }
  if (state.selected !== null) return;
  state.selected = index;
  const v = VEHICLES[index % VEHICLES.length];
  populateSelected(v, index);
  syncPaintRow();
  $('paintRow').hidden = !state.engine;
  $('showroom').classList.add('is-selected');
  $('navReview').hidden = false; $('navBoard').hidden = false;
  $('selectedView').setAttribute('aria-hidden', 'false');
  $('review').hidden = false;
  if (state.engine) {
    modelStatus('APPROACHING THE MACHINE');
    state.engine.select(index, $('selectedModelHost'));
    setTimeout(() => {
      if (state.selected !== index) return;
      $('showroom').classList.add('reveal-selected');
      const failed = document.querySelector(`.bay-label[data-index="${index}"]`)?.classList.contains('is-error');
      modelStatus(state.engine.cars.has(index) ? 'DRAG TO EXPLORE · REAL GLB' : failed ? 'ASSET UNAVAILABLE · EDITORIAL ANGLES BELOW' : 'LOADING REAL GLB');
      $('selectedModelStatus').classList.toggle('is-ready', state.engine.cars.has(index));
      if (state.engine.cars.has(index)) $('selectedAsset').textContent = `${(state.engine.cars.get(index).userData.triangles || 0).toLocaleString()} TRIANGLES`;
      else if (failed) $('selectedModelHost').innerHTML = `<img class="fallback-selected-img" src="./assets/images/${v.id}/${IMG_FILES[0]}" alt="${esc(v.make)} ${esc(v.name)}">`;
      renderReviews(v);
      playSelectedMotion();
    }, reduceMotion ? 60 : 340);
  } else {
    const host = $('selectedModelHost');
    host.innerHTML = `<img class="fallback-selected-img" src="./assets/images/${v.id}/${IMG_FILES[0]}" alt="${esc(v.make)} ${esc(v.name)}">`;
    modelStatus('EDITORIAL IMAGE MODE');
    $('showroom').classList.add('reveal-selected');
    renderReviews(v);
    playSelectedMotion();
  }
  const params = new URLSearchParams(location.search);
  params.set('car', v.id);
  history.replaceState({}, '', `?${params}`);
}
function backHome() {
  if (state.selected === null) return;
  const previous = state.selected;
  state.selected = null;
  state.engine?.clearSelection();
  $('showroom').classList.remove('is-selected', 'reveal-selected');
  $('navReview').hidden = true; $('navBoard').hidden = true;
  $('selectedView').setAttribute('aria-hidden', 'true');
  $('selectedModelStatus').classList.remove('is-ready');
  $('review').hidden = true;
  refreshNoirMotion();
  if (state.fallback) $('selectedModelHost').innerHTML = '';
  state.engine?.setFocus(previous);
  motionScrollTo($('showroom'));
  const params = new URLSearchParams(location.search);
  params.delete('car');
  history.replaceState({}, '', `./index.html${params.size ? `?${params}` : ''}`);
}

/* ------------------------------------------- five static chapters */
function imagePath(id, index) { return `./assets/images/${encodeURIComponent(id)}/${IMG_FILES[index]}`; }
function createPlaceholder(index, carId) {
  const ph = document.createElement('div'); ph.className = 'shot-placeholder';
  ph.innerHTML = `<b aria-hidden="true">${pad(index + 1)}</b><span>AWAITING TRANSPARENT ASSET</span><small>assets/images/${esc(carId)}/${esc(IMG_FILES[index])}</small>`;
  return ph;
}
function attachImage(img, placeholder, carId, index) {
  img.hidden = true;
  const key = `${carId}:${index}:${performance.now()}`; img.dataset.assetKey = key;
  img.onload = async () => {
    if (img.dataset.assetKey !== key) return;
    // Async decode keeps the 4K raster off the main thread during reveals.
    try { await img.decode(); } catch {}
    if (img.dataset.assetKey !== key) return;
    img.hidden = false; placeholder.hidden = true; state.visibleImages++; setImageLoaded(img);
  };
  img.onerror = () => { if (img.dataset.assetKey !== key) return; img.hidden = true; placeholder.hidden = false; };
  img.src = imagePath(carId, index);
}
function createReview(v, index) {
  const shot = SHOTS[index]; const section = document.createElement('section');
  section.id = `image-${index + 1}`; section.dataset.motionChapter = pad(index + 1); section.className = `shot-section${index % 2 ? ' reverse' : ''}`;
  section.setAttribute('aria-label', `Image ${index + 1}: ${shot.label}`);
  section.innerHTML = `<div class="shot-copy"><span class="shot-label">${shot.caption}</span><h3>${shot.title}<br><em>${shot.emphasis}</em></h3><p>${shot.description}</p><dl><div><dt>THE MACHINE</dt><dd>${esc(v.make)}</dd></div><div><dt>VIEW</dt><dd>${shot.angle}</dd></div></dl></div><div class="shot-frame"><div class="shot-slot"><img hidden decoding="async" alt="${esc(v.make)} ${esc(v.name)} — ${esc(shot.label)}"></div><div class="shot-caption"><span>${pad(index + 1)} / 05 — ${shot.label}</span><span>ORIGINAL MODEL / TRANSPARENT IMAGE</span></div></div>`;
  const slot = section.querySelector('.shot-slot'), img = slot.querySelector('img'), placeholder = createPlaceholder(index, v.id);
  slot.appendChild(placeholder); attachImage(img, placeholder, v.id, index);
  return section;
}
function renderReviews(v) {
  state.visibleImages = 0;
  const sections = $('reviewSections'), board = $('boardGrid'); sections.replaceChildren(); board.replaceChildren();
  SHOTS.forEach((shot, i) => {
    sections.append(createReview(v, i));
    const figure = document.createElement('figure'); figure.className = 'board-item'; figure.dataset.no = pad(i + 1); figure.dataset.angle = String(i); figure.setAttribute('tabindex', '0'); figure.setAttribute('role', 'button'); figure.setAttribute('aria-label', `View ${v.make} ${v.name} angle ${i + 1}`);
    const img = document.createElement('img'); img.hidden = true; img.decoding = 'async'; img.alt = `${v.make} ${v.name} — ${shot.label}`;
    const placeholder = createPlaceholder(i, v.id);
    const caption = document.createElement('figcaption'); caption.textContent = shot.label;
    const cta = document.createElement('span'); cta.className = 'board-cta'; cta.innerHTML = '<span class="cta-long">VIEW THIS ANGLE</span><span class="cta-short">VIEW</span> ↗';
    figure.append(img, placeholder, caption, cta); board.append(figure);
    attachImage(img, placeholder, v.id, i);
  });
  $('boardMaker').textContent = `${v.make} / ${v.name}`;
  $('boardEdition').textContent = v.edition;
  requestAnimationFrame(() => refreshNoirMotion());
}
function scrollToReview() {
  if (state.selected === null) { selectVehicle(state.focus); setTimeout(() => scrollToReview(), 460); return; }
  motionScrollTo($('review'));
}

/* --------------------------------------------------------- entrance gate */
function bootGate() {
  const gate = $('gate');
  if (!gate) return;
  // Automated sessions and ?nointro go straight to the gallery.
  if (navigator.webdriver || new URLSearchParams(location.search).has('nointro')) { gate.remove(); return; }
  document.body.classList.add('gate-open');
  const enter = () => {
    gate.classList.add('is-leaving');
    document.body.classList.remove('gate-open');
    window.scrollTo(0, 0);
    setTimeout(() => { gate.remove(); window.scrollTo(0, 0); }, reduceMotion ? 0 : 950);
    playEntrance();
  };
  $('gateEnter').addEventListener('click', enter);
  setTimeout(() => $('gateEnter')?.focus({ preventScroll: true }), reduceMotion ? 0 : 1100);
}
/* Cinematic crane-down reveal when the visitor enters from the gate. */
function playEntrance() {
  const run = () => {
    if (!state.engine) return;
    $('showroom').classList.add('is-entering');
    state.engine.entrance();
    setTimeout(() => $('showroom').classList.remove('is-entering'), reduceMotion ? 0 : 2000);
  };
  if (state.engine) run(); else state.pendingEntrance = true;
}

/* --------------------------------------------------------- body finish */
const FINISHES = [
  { id: 'original', label: 'Original factory finish', hex: null },
  { id: 'champagne', label: 'Champagne', hex: '#c8a468' },
  { id: 'nero', label: 'Nero', hex: '#11151a' },
  { id: 'rosso', label: 'Rosso', hex: '#7c1418' },
  { id: 'blu', label: 'Blu Notte', hex: '#173a5e' },
  { id: 'verde', label: 'Verde', hex: '#1e4d3a' },
  { id: 'argento', label: 'Argento', hex: '#b9bfc7' },
];
function buildPaintRow() {
  const host = $('paintSwatches');
  host.innerHTML = FINISHES.map(f => `<button type="button" class="paint-swatch" data-finish="${f.id}" title="${f.label}" aria-label="${f.label}"${f.hex ? ` style="background:${f.hex}"` : ''}></button>`).join('');
  host.addEventListener('click', e => {
    const btn = e.target.closest('.paint-swatch');
    if (!btn || state.selected === null) return;
    const finish = FINISHES.find(f => f.id === btn.dataset.finish);
    state.engine?.setPaint(state.selected, finish.hex);
    syncPaintRow();
  });
}
function syncPaintRow() {
  const current = state.selected === null ? null : (state.engine?.getPaint(state.selected) || null);
  const active = FINISHES.find(f => f.hex === current)?.id || 'original';
  for (const btn of $('paintSwatches').children) btn.classList.toggle('is-active', btn.dataset.finish === active);
}

/* --------------------------------------------------------- handlers */
function syncRow(i) {
  const rear = i >= 8;
  const btn = $('rowBtn');
  btn.setAttribute('aria-pressed', String(rear));
  btn.innerHTML = rear ? 'FRONT ROW <span>⇅</span>' : 'REAR ROW <span>⇅</span>';
}
function installHandlers() {
  $('totalCount').textContent = pad(VEHICLES.length);
  $('activeCount').textContent = pad(state.focus + 1);
  $('prevCar').addEventListener('click', () => state.engine ? state.engine.prev() : scrollFallback(-1));
  $('nextCar').addEventListener('click', () => state.engine ? state.engine.next() : scrollFallback(1));
  $('selectCar').addEventListener('click', () => selectVehicle(state.engine ? state.engine.focus : state.focus));
  $('overviewBtn').addEventListener('click', () => state.engine?.toggleOverview());
  $('rowBtn').addEventListener('click', () => { const e = state.engine; if (!e) return; e.toggleRow(); });
  $('discoverImages').addEventListener('click', scrollToReview);
  $('zoomReset').addEventListener('click', () => state.engine?.resetView());
  $('backToGarage').addEventListener('click', backHome);
  $('backToGarageTop').addEventListener('click', backHome);
  $('boardBack').addEventListener('click', backHome);
  $('brandLink').addEventListener('click', e => { e.preventDefault(); if (state.selected !== null) backHome(); else motionScrollTo($('showroom')); });
  $('navReview').addEventListener('click', e => { e.preventDefault(); scrollToReview(); });
  $('navBoard').addEventListener('click', e => { e.preventDefault(); const entering = state.selected === null; if (entering) selectVehicle(state.focus); setTimeout(() => motionScrollTo($('board')), entering ? 460 : 0); });
  const NAV_SECTIONS = [['navReview', 'review'], ['navBoard', 'board']];
  function updateNav() {
    let active = 'navReview';
    if (state.selected !== null) {
      const line = innerHeight * .35;
      for (const [id, sec] of NAV_SECTIONS) {
        if (!sec) continue;
        const r = $(sec).getBoundingClientRect();
        if (r.height > 0 && r.top <= line) active = id;
      }
    }
    for (const [id] of NAV_SECTIONS) {
      const on = id === active;
      $(id).classList.toggle('current', on);
      if (on) $(id).setAttribute('aria-current', 'true'); else $(id).removeAttribute('aria-current');
    }
  }
  window.addEventListener('scroll', () => requestAnimationFrame(updateNav), { passive: true });
  updateNav();
  $('noticeDismiss').addEventListener('click', () => $('notice').hidden = true);
  $('boardGrid').addEventListener('keydown', e => { const fig = e.target.closest('.board-item[data-angle]'); if (fig && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); motionScrollTo($(`image-${Number(fig.dataset.angle) + 1}`)); } });
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (state.selected !== null) backHome();
      else if (state.engine?.overview) state.engine.toggleOverview();
    }
    if (state.selected === null && state.engine && document.activeElement === document.body) {
      if (e.key === 'ArrowRight') state.engine.next();
      if (e.key === 'ArrowLeft') state.engine.prev();
    }
  });
  bootGate();
  buildPaintRow();
  bootNoirMotion();
  boot3D();
  window.__NOIR_QA__ = {
    get selected() { return state.selected; },
    get focus() { return state.engine ? state.engine.focus : state.focus; },
    get overview() { return state.engine ? state.engine.overview : false; },
    get row() { return state.engine ? state.engine.row : 0; },
    get fallback() { return state.fallback; },
    get engineError() { return state.engineError ? String(state.engineError.message || state.engineError) : null; },
    get reviewCount() { return document.querySelectorAll('.shot-section').length; },
    get boardCount() { return document.querySelectorAll('.board-item').length; },
    get galleryCanvases() { return document.querySelectorAll('#review canvas').length; },
    get imageCount() { return state.visibleImages; },
    stats: () => state.engine ? state.engine.stats() : null,
    get engine() { return state.engine; },
    motion: () => window.__NOIR_MOTION_QA__
  };
}
function scrollFallback(dir) {
  const host = $('carLineup');
  host.scrollBy({ left: dir * host.clientWidth * .8, behavior: reduceMotion ? 'instant' : 'smooth' });
}
installHandlers();