/* VÉLANCE / V11
 * Home + Selected Machine = one real perspective WebGPU gallery with a WebGL2
 * fallback (engine/showroom.js).
 * Below the showroom: a single photographic archive or labeled 3D study.
 */
import { VEHICLES } from '../data/vehicles.js';
import { createArchive } from './archive.js?v=12.7-cinematic';
import { bootPortal } from '../motion/portal.js?v=12.5-memory';
import { bootVelanceMotion, refreshVelanceMotion, motionScrollTo, playSelectedMotion, resetSelectedMotion } from '../motion/motion.js?v=12.6-safari';
const $ = id => document.getElementById(id);
const clamp = (n, min = 0, max = 1) => Math.min(max, Math.max(min, n));
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const IMG_FILES = ['01-front-three-quarter.webp', '02-near-front.webp', '03-side-profile.webp', '04-rear-three-quarter.webp', '05-signature.webp'];
const SHOTS = [
  { title: 'FRONT', emphasis: '¾', label: 'FRONT ¾' },
  { title: 'FRONT', emphasis: 'CLOSE.', label: 'FRONT' },
  { title: 'SIDE', emphasis: 'PROFILE.', label: 'PROFILE' },
  { title: 'REAR', emphasis: '¾', label: 'REAR ¾' },
  { title: 'DETAIL', emphasis: '05.', label: 'DETAIL' }
];
const state = {
  focus: Math.max(0, VEHICLES.findIndex(v => v.id === (new URLSearchParams(location.search).get('car') || 'mclarenp1'))),
  selected: null, engine: null, engineError: null, visibleImages: 0, fallback: false,
  booting: true, pendingSelect: null, selectionGeneration: 0, reviewTimer: null, reviewReady: false, pendingScroll: null
};
const archive = createArchive(() => state.visibleImages++);
function toast(text) { $('noticeText').textContent = text; $('notice').hidden = false; }
function modelStatus(text) { $('selectedModelStatus').textContent = text; }
function readout(text) { $('stageReadout').textContent = text; }
function pendingPreview(index) {
  const host = $('selectedModelHost');
  host.querySelector('.model-loading-preview')?.remove();
  const vehicle = VEHICLES[index];
  if (!vehicle || state.engine?.cars.has(index)) return;
  const img = document.createElement('img');
  img.className = 'model-loading-preview';
  img.alt = `${vehicle.make} ${vehicle.name} preview while 3D loads`;
  img.decoding = 'async';
  img.src = `./assets/images/${encodeURIComponent(vehicle.id)}/${IMG_FILES[0]}`;
  host.appendChild(img);
}

/* ------------------------------------------------------------ 3D boot */
async function boot3D() {
  try {
    const { GarageShowroom } = await import('../engine/showroom.js?v=12.5-memory');
    const engine = await GarageShowroom.create({
      stage: $('carStage'),
      labelHost: $('carLineup'),
      vehicles: VEHICLES,
      focus: state.focus,
      reduced: reduceMotion,
      preloadEntrance: !!state.fullEntrance,
      onProgress: (loaded, total, index) => {
        $('showroom').classList.add('is-3d');
        $('loaderBar').style.width = `${Math.round(loaded / total * 100)}%`;
        $('loaderCount').textContent = `${pad(loaded)} / ${pad(total)}`;
        readout(`${loaded}/${total} LOADED`);
        if (!state.fullEntrance || loaded === total) $('garageLoader').classList.add('is-done');
        if (state.selected === index && state.engine) {
          $('selectedModelHost').querySelectorAll('.model-loading-preview,.fallback-selected-img').forEach(el => el.remove());
          modelStatus('DRAG TO EXPLORE · REAL GLB');
          $('selectedModelStatus').classList.add('is-ready');
          $('selectedAsset').textContent = `${(state.engine.cars.get(index)?.userData.triangles || 0).toLocaleString()} TRIANGLES`;
        }
      },
      onReady: () => { if (!state.fullEntrance) { readout('3D READY'); $('garageLoader').classList.add('is-done'); } },
      onDetailReady: i => {
        if(state.selected!==i||!state.engine)return;
        $('selectedAsset').textContent=`${(state.engine.cars.get(i)?.userData.triangles||0).toLocaleString()} TRIANGLES`;
        modelStatus('DRAG TO EXPLORE · REAL GLB');
      },
      onDetailError: (i,msg) => {
        console.warn('[VÉLANCE / DETAIL]',i,msg);
        if(state.selected===i&&state.engine?.cars.has(i))modelStatus('DRAG TO EXPLORE · GALLERY GLB');
      },
      onError: (i, msg) => {
        console.warn('[VÉLANCE / BAY]', i, msg);
        readout(`BAY ${pad(i + 1)} ASSET UNAVAILABLE`);
        // In on-demand mode there might be no next machine to clear loader.
        if (!state.fullEntrance) $('garageLoader').classList.add('is-done');
        if (state.selected === i) {
          const v = VEHICLES[i];
          const host = $('selectedModelHost');
          host.querySelector('.model-loading-preview')?.remove();
          host.innerHTML = `<img class="fallback-selected-img" src="./assets/images/${encodeURIComponent(v.id)}/${IMG_FILES[0]}" alt="${esc(v.make)} ${esc(v.name)}">`;
          modelStatus('ASSET UNAVAILABLE · EDITORIAL ANGLES BELOW');
          $('selectedModelStatus').classList.remove('is-ready');
        }
      },
      onFocus: i => { state.focus = i; $('activeCount').textContent = pad(i + 1); syncRow(i); },
      onSelect: i => selectVehicle(i),
      onOverview: on => {
        const btn = $('overviewBtn');
        btn.setAttribute('aria-pressed', String(on));
        btn.innerHTML = on ? 'CLOSE <span>✕</span>' : 'ALL 16 <span>⛶</span>';
        $('interactionHint').innerHTML = on ? 'DRAG · TAP <span>↔</span>' : 'DRAG <span>↔</span>';
        $('rowBtn').disabled = on;
        $('lightShowBtn').disabled = on;
        btn.disabled = !!state.engine?.cinema;
        if (state.fullEntrance && on && !state.engine?.cinema) {
          state.fullEntrance = false;
          $('garageLoader').classList.add('is-done');
          readout(`${state.engine.cars.size}/${VEHICLES.length} LOADED`);
        }
      }
    });
    state.engine = engine;
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
  $('selectedEdition').textContent = v.edition;
  $('selectedAsset').textContent = `GLB · ${v.mb.toFixed(1)} MB`;
  $('selectedSpecs').innerHTML = v.stats.slice(0, 4).map(([k, value]) => `<div class="selected-spec"><span>${esc(k)}</span><strong>${esc(value)}</strong></div>`).join('');
}
function selectVehicle(index) {
  if (state.engine?.cinema || state.engine?.returning || !VEHICLES[index]) return;
  if (state.booting) { state.pendingSelect = index; return; }
  if (state.selected !== null) return;
  state.selected = index;
  const generation = ++state.selectionGeneration;
  const current = () => state.selected === index && state.selectionGeneration === generation;
  state.reviewReady = false; state.pendingScroll = null;
  $('selectedModelHost').replaceChildren();
  $('selectedModelStatus').classList.remove('is-ready');
  const v = VEHICLES[index % VEHICLES.length];
  populateSelected(v, index);
  $('selectionCinemaBay').textContent = `BAY ${pad(index + 1)}`;
  $('selectionCinemaMake').textContent = v.make;
  $('selectionCinemaName').textContent = v.name;
  syncPaintRow();
  $('paintRow').hidden = !state.engine;
  $('showroom').classList.add('is-selected');
  $('navReview').hidden = true; $('navBoard').hidden = true;
  if (state.engine) {
    $('showroom').classList.add('is-approaching');
    modelStatus('APPROACHING THE MACHINE');
    const reveal = () => {
      if (!current()) return;
      $('showroom').classList.add('reveal-selected');
      $('selectedView').setAttribute('aria-hidden', 'false');
      $('selectedView').inert = false;
      const failed = document.querySelector(`.bay-label[data-index="${index}"]`)?.classList.contains('is-error');
      modelStatus(state.engine.cars.has(index) ? 'DRAG TO EXPLORE · REAL GLB' : failed ? 'ASSET UNAVAILABLE · EDITORIAL ANGLES BELOW' : 'LOADING REAL GLB');
      $('selectedModelStatus').classList.toggle('is-ready', state.engine.cars.has(index));
      if (state.engine.cars.has(index)) $('selectedAsset').textContent = `${(state.engine.cars.get(index).userData.triangles || 0).toLocaleString()} TRIANGLES`;
      else if (failed) $('selectedModelHost').innerHTML = `<img class="fallback-selected-img" src="./assets/images/${v.id}/${IMG_FILES[0]}" alt="${esc(v.make)} ${esc(v.name)}">`;
      else pendingPreview(index);
      playSelectedMotion();
    };
    const landed = () => {
      if (!current()) return;
      if (!$('showroom').classList.contains('reveal-selected')) reveal();
      $('showroom').classList.remove('is-approaching');
      $('autoOrbit').disabled = reduceMotion;
      // Prepare the responsive editorial gallery after the camera stops moving.
      // Their image uploads previously caused hitches during the last approach.
      state.reviewTimer = setTimeout(() => {
        state.reviewTimer = null;
        if (current()) openReviews(v);
      }, 120);
    };
    state.engine.select(index, $('selectedModelHost'), reveal, landed);
  } else {
    const host = $('selectedModelHost');
    host.innerHTML = `<img class="fallback-selected-img" src="./assets/images/${v.id}/${IMG_FILES[0]}" alt="${esc(v.make)} ${esc(v.name)}">`;
    modelStatus('EDITORIAL IMAGE MODE');
    $('showroom').classList.add('reveal-selected');
    $('selectedView').setAttribute('aria-hidden', 'false');
    $('selectedView').inert = false;
    openReviews(v);
    playSelectedMotion();
  }
  const params = new URLSearchParams(location.search);
  params.set('car', v.id);
  history.replaceState({}, '', `?${params}`);
}
function backHome() {
  if (state.selected === null) return;
  state.selected = null;
  state.selectionGeneration++;
  clearTimeout(state.reviewTimer); state.reviewTimer = null;
  state.pendingScroll = null; state.reviewReady = false; state.visibleImages = 0;
  state.engine?.clearSelection();
  $('showroom').classList.remove('is-selected', 'is-approaching', 'reveal-selected');
  $('navReview').hidden = true; $('navBoard').hidden = true;
  $('selectedView').setAttribute('aria-hidden', 'true');
  $('selectedView').inert = true;
  $('selectedModelStatus').classList.remove('is-ready');
  $('autoOrbit').disabled = true;
  $('selectedModelHost').replaceChildren();
  $('review').hidden = true;
  resetSelectedMotion();
  refreshVelanceMotion();
  archive.clear();
  motionScrollTo($('showroom'), true);
  const params = new URLSearchParams(location.search);
  params.delete('car');
  history.replaceState({}, '', `./index.html${params.size ? `?${params}` : ''}`);
}

/* ------------------------------------------- editorial archive */
async function openReviews(v) {
  const generation = state.selectionGeneration;
  state.visibleImages = 0;
  const fallback = SHOTS.map((shot,i) => {
    const path = `./assets/images/${encodeURIComponent(v.id)}/${IMG_FILES[i]}`;
    return {label:shot.label,alt:`${v.make} ${v.name} — ${shot.label} (3D render)`,thumb:path,medium:path,full:path};
  });
  if (!await archive.render(v,fallback) || generation !== state.selectionGeneration) return;
  $('review').hidden = false;
  state.reviewReady = true;
  $('navBoard').hidden = false;
  requestAnimationFrame(() => refreshVelanceMotion());
  const pending = state.pendingScroll; state.pendingScroll = null;
  if (pending) motionScrollTo($(pending));
}
function scrollToReview(target = 'review') {
  if (typeof target !== 'string') target = 'review';
  if (state.selected === null) return;
  if (!state.reviewReady) { state.pendingScroll = target; return; }
  motionScrollTo($(target));
}

/* --------------------------------------------------------- entrance gate */
function bootGate() {
  const gate = $('gate');
  if (!gate) return;
  // Automated sessions and ?nointro go straight to the gallery.
  if (navigator.webdriver || new URLSearchParams(location.search).has('nointro')) { gate.remove(); return; }
  // The portal is a modal even while the gallery initializes behind it.
  const background = [$('topbar'), document.querySelector('main'), $('notice')].filter(Boolean);
  const previousInert = background.map(el => el.inert);
  background.forEach(el => { el.inert = true; });
  gate.tabIndex = -1;
  const button = $('gateEnter');
  button.focus({ preventScroll: true });
  document.body.classList.add('gate-open');
  state.fullEntrance = true;
  const portal = bootPortal(gate, reduceMotion);
  let leaving = false;
  const enter = async () => {
    if (leaving) return;
    leaving = true;
    portal.ignite(true);
    // Keep the live portal visible until the renderer can show the garage.
    // Do not wait for all sixteen transfers: the reveal clock handles that.
    button.disabled = true;
    button.textContent = 'PREPARING…';
    gate.focus({ preventScroll: true });
    await state.bootPromise;
    playEntrance({ stayOverview: true });
    gate.classList.add('is-leaving');
    document.body.classList.remove('gate-open');
    window.scrollTo(0, 0);
    setTimeout(() => {
      portal.dispose(); gate.remove();
      background.forEach((el, i) => { el.inert = previousInert[i]; });
      $('brandLink').focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }, reduceMotion ? 0 : 950);
  };
  button.addEventListener('click', enter);
}
/* First visit stays above the entire collection. LIGHTS replays the crane. */
function playEntrance({ stayOverview = false } = {}) {
  const run = () => {
    if (!state.engine) return;
    if (!state.engine.entrance({ stayOverview })) return;
    $('showroom').classList.add('is-entering');
    setTimeout(() => $('showroom').classList.remove('is-entering'), 1250);
  };
  if (state.engine) run();
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
  $('lightShowBtn').addEventListener('click', playEntrance);
  $('rowBtn').addEventListener('click', () => { const e = state.engine; if (!e) return; e.toggleRow(); });
  $('discoverImages').addEventListener('click', scrollToReview);
  $('zoomReset').addEventListener('click', () => state.engine?.resetView());
  $('autoOrbit').addEventListener('click', () => state.engine?.setAutoShot(!state.engine.autoShot));
  $('carStage').addEventListener('velance:auto-shot', e => $('autoOrbit').setAttribute('aria-pressed', String(e.detail)));
  $('backToGarageTop').addEventListener('click', backHome);
  $('cancelApproach').addEventListener('click', backHome);
  $('boardBack').addEventListener('click', backHome);
  $('brandLink').addEventListener('click', e => { e.preventDefault(); if (state.selected !== null) backHome(); else motionScrollTo($('showroom')); });
  $('navReview').addEventListener('click', e => { e.preventDefault(); scrollToReview(); });
  $('navBoard').addEventListener('click', e => { e.preventDefault(); scrollToReview('board'); });
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
  window.addEventListener('keydown', e => {
    const gate = $('gate');
    if (gate) {
      if (e.key === 'Tab') {
        e.preventDefault();
        const button = $('gateEnter');
        (button.disabled ? gate : button).focus({ preventScroll: true });
      }
      return;
    }
    if (archive.isOpen() || e.defaultPrevented) return;
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
  bootVelanceMotion();
  state.bootPromise = boot3D();
  window.__VELANCE_QA__ = {
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
    motion: () => window.__VELANCE_MOTION_QA__
  };
}
function scrollFallback(dir) {
  const host = $('carLineup');
  host.scrollBy({ left: dir * host.clientWidth * .8, behavior: reduceMotion ? 'instant' : 'smooth' });
}
installHandlers();
