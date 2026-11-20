/* The Portal: inexpensive animated atmospheric fog and registered lamp layers.
   This is a 2D cinematic scene, not a second 3D renderer. */
const clamp = x => Math.max(0, Math.min(1, x));
const smooth = x => x * x * (3 - 2 * x);
const IGNITION_TIMING = Object.freeze({ first: 1200, on: 4200, off: 1800 });
function random(seed) {
  return () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

// Generate coherent, feathered fractal density fields once. The full
// resolution scene remains sharp; only the atmospheric medium is low res.
function cloudTexture(seed) {
  const rng = random(seed);
  const w = 288, h = 128;
  const sprite = document.createElement('canvas');
  sprite.width = w; sprite.height = h;
  const ctx = sprite.getContext('2d');
  if (!ctx) return null;
  const levels = [5, 10, 20, 40].map(n => ({
    n, a: Float32Array.from({ length: (n + 1) * (n + 1) }, rng)
  }));
  function noise(level, x, y) {
    const { n, a } = level;
    const nx = clamp(x) * (n - .001), ny = clamp(y) * (n - .001);
    const ix = Math.floor(nx), iy = Math.floor(ny);
    const fx = smooth(nx - ix), fy = smooth(ny - iy);
    const row = iy * (n + 1) + ix;
    const top = a[row] + (a[row + 1] - a[row]) * fx;
    const bottom = a[row + n + 1] + (a[row + n + 2] - a[row + n + 1]) * fx;
    return top + (bottom - top) * fy;
  }
  const pixels = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = x / (w - 1), v = y / (h - 1);
    const wave = Math.sin(u * 8 + seed) * .12;
    const yy = clamp(v + wave);
    const n = .48 * noise(levels[0], u, yy) + .27 * noise(levels[1], u, yy) +
      .16 * noise(levels[2], u, yy) + .09 * noise(levels[3], u, yy);
    const envelope = Math.pow(Math.max(0, 1 - ((u - .5) / .5) ** 2 -
      ((v - .5) / .5) ** 2), 1.4);
    const density = Math.pow(clamp((n - .16) / .62), 1.1) * envelope;
    const i = (y * w + x) * 4;
    pixels.data[i] = 210; pixels.data[i + 1] = 188; pixels.data[i + 2] = 161;
    pixels.data[i + 3] = Math.round(245 * density);
  }
  ctx.putImageData(pixels, 0, 0);
  return sprite;
}

export function bootPortal(gate, reduced = false) {
  const canvas = gate.querySelector('#portalFog');
  if (!canvas) return { ignite() {}, dispose() {} };
  const ctx = canvas.getContext('2d');
  const abort = new AbortController();
  let disposed = false, timer, raf = 0, prev = -Infinity, elapsed = 0;
  let lit = false, intensity = 0;
  let automatic = !reduced, remaining = IGNITION_TIMING.first, deadline = 0;
  const setLight = value => {
    if (disposed) return;
    lit = !!value;
    gate.dataset.ignited = String(lit);
  };
  // Slow cinematic pulse (6 s per cycle), rather than rapid strobing.
  // Pause the countdown while hidden; no burst of missed pulses on return.
  function pauseCycle() {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    remaining = Math.max(0, deadline - performance.now());
  }
  function scheduleCycle() {
    if (disposed || !automatic || document.hidden || timer !== undefined) return;
    deadline = performance.now() + remaining;
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || !automatic) return;
      if (document.hidden) { remaining = 0; return; }
      setLight(!lit);
      remaining = lit ? IGNITION_TIMING.on : IGNITION_TIMING.off;
      scheduleCycle();
    }, remaining);
  }
  // ENTER holds the lamps on during the transition.
  const ignite = value => {
    automatic = false;
    pauseCycle();
    setLight(value);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseCycle();
    else scheduleCycle();
  }, { signal: abort.signal });
  if (reduced) setLight(true);
  else scheduleCycle();

  if (ctx) {
    const width = matchMedia('(max-width:620px)').matches ? 640 : 960;
    canvas.width = width; canvas.height = Math.round(width * 941 / 1672);
    const sprites = [9, 73, 201, 467].map(cloudTexture).filter(Boolean);
    // Independent wind layers along the floor and at the edges of the tunnel.
    // x/y is the sprite centre in the same coordinates as the scene plate.
    const layers = [
      [-.02,.67,.46,.24,.95,0,0.19], [.12,.71,.39,.19,.82,1,.16],
      [.43,.81,.52,.14,.71,2,.12], [.72,.82,.50,.17,.83,3,.13],
      [1.03,.69,.45,.28,.95,1,.18], [.94,.61,.31,.27,.83,2,.11],
      [.06,.58,.31,.26,.82,3,.14], [.23,.84,.54,.13,.77,0,.10],
      [.82,.89,.60,.15,.85,2,.12], [.50,.94,.70,.13,.67,1,.09],
      [.13,.93,.53,.20,.80,3,.10], [.67,.76,.32,.13,.60,0,.15],
      [.04,.74,.39,.15,.84,2,.16], [.96,.78,.40,.15,.84,0,.14]
    ];
    function draw(time, light) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!sprites.length) return;
      ctx.globalCompositeOperation = 'screen';
      for (let i = 0; i < layers.length; i++) {
        const [x,y,w,h,a,s,speed] = layers[i], phase = i * 1.91;
        const drift = Math.sin(time * speed * 2.6 + phase) * .125
          + Math.sin(time * speed * 1.35 + phase * .7) * .025;
        const rise = Math.cos(time * speed * 1.65 + phase) * .030;
        const size = 1 + .16 * Math.sin(time * .42 + phase);
        const ww = w * canvas.width * size, hh = h * canvas.height;
        ctx.globalAlpha = a * (.60 + .16 * Math.sin(time * .43 + phase) + light * .20);
        ctx.drawImage(sprites[s % sprites.length],
          (x + drift) * canvas.width - ww/2, (y + rise) * canvas.height - hh/2, ww, hh);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    const interval = width === 640 ? 1000 / 30 : 1000 / 60;
    function frame(now) {
      raf = 0;
      if (disposed || document.hidden) return;
      if (now - prev >= interval - 1) {
        const dt = Number.isFinite(prev) ? Math.min(.05, (now - prev) / 1000) : 0;
        elapsed += dt; prev = now;
        intensity += ((lit ? 1 : 0) - intensity) * (1 - Math.exp(-dt * 5));
        draw(elapsed, intensity);
      }
      raf = requestAnimationFrame(frame);
    }
    const resume = () => {
      cancelAnimationFrame(raf); raf = 0; prev = -Infinity;
      if (!disposed && !reduced && !document.hidden) raf = requestAnimationFrame(frame);
    };
    document.addEventListener('visibilitychange', resume, { signal: abort.signal });
    draw(0, reduced ? 1 : 0);
    resume();
  }
  return {
    ignite,
    dispose() {
      disposed = true;
      pauseCycle();
      cancelAnimationFrame(raf);
      abort.abort();
      canvas.width=canvas.height=1;
    }
  };
}
