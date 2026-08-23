// India-at-night renderer.
//
// Ported from the design handoff (design_handoff_india_night_background), which
// asked for the rendering maths to be carried over rather than rewritten. The
// projection, scatter, two-pass bloom, aurora and cloud noise are unchanged.
//
// Adapted for the app: npm d3-geo/topojson instead of CDN globals, vendored
// geography instead of a runtime fetch, element-relative sizing so it can live
// in a panel, and lifecycle control so it stops when off-screen or hidden.
//
// The palette here is the RENDER's own — the handoff is explicit that these
// canvas values are not design-system tokens.

import { geoMercator, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import topo from '../../assets/geo/countries-110m.json';

// [lon, lat, weight] — real coordinates, weight tracks metro size. Neighbouring
// countries are included at lower weights so India does not float in a void.
const CITIES = [
  [77.21,28.61,1.00],[72.88,19.08,1.00],[88.36,22.57,0.98],[80.27,13.08,0.95],[77.59,12.97,0.95],
  [78.49,17.39,0.90],[72.57,23.03,0.85],[73.86,18.52,0.82],[72.83,21.17,0.75],[75.79,26.91,0.75],
  [80.95,26.85,0.75],[80.35,26.45,0.70],[79.09,21.15,0.70],[75.86,22.72,0.70],[77.41,23.26,0.65],
  [85.14,25.59,0.70],[75.86,30.90,0.65],[78.01,27.18,0.62],[82.97,25.32,0.60],[74.87,31.63,0.60],
  [76.78,30.73,0.60],[77.71,28.98,0.60],[73.18,22.31,0.60],[70.80,22.30,0.55],[73.79,19.99,0.55],
  [76.96,11.02,0.60],[76.27,9.93,0.60],[76.94,8.52,0.55],[78.12,9.93,0.55],[83.30,17.69,0.60],
  [80.65,16.51,0.55],[91.74,26.14,0.50],[85.31,23.34,0.50],[81.63,21.25,0.50],[73.02,26.24,0.50],
  [74.80,34.08,0.45],[78.03,30.32,0.45],[79.95,23.18,0.45],[81.85,25.44,0.55],[78.18,26.22,0.50],
  [86.20,22.80,0.45],[85.82,20.30,0.50],[76.64,12.30,0.45],[74.86,12.91,0.45],[73.83,15.50,0.42],
  [75.34,19.88,0.45],[75.91,17.66,0.40],[80.44,16.31,0.45],[78.70,10.79,0.45],[78.15,11.66,0.45],
  [75.58,31.33,0.50],[79.43,28.37,0.50],[78.09,27.90,0.50],[83.37,26.76,0.50],[88.43,26.72,0.45],
  [85.88,20.46,0.40],[79.99,14.44,0.40],[73.71,24.58,0.40],[74.63,26.45,0.40],[75.84,25.18,0.45],
  [75.12,15.36,0.40],[77.28,23.60,0.35],[84.00,24.80,0.35],[87.32,23.53,0.40],[88.26,23.45,0.40],
  [67.01,24.86,0.70],[74.34,31.55,0.70],[73.05,33.68,0.50],[73.13,31.42,0.50],[71.52,30.20,0.45],
  [71.58,34.02,0.40],[67.00,30.18,0.28],[90.41,23.81,0.80],[91.83,22.36,0.50],[89.56,22.82,0.40],
  [88.60,24.37,0.35],[85.32,27.71,0.45],[79.86,6.93,0.50],[80.63,7.29,0.30],[80.01,9.66,0.25],
  [69.17,34.53,0.32],[96.08,21.98,0.25],[96.16,16.87,0.35],[89.64,27.47,0.18],[73.51,4.17,0.18],
  [91.10,29.65,0.20],[68.37,25.39,0.25],[70.90,32.00,0.22],
];

const fc = feature(topo, topo.objects.countries);
const INDIA = fc.features.find((f) => f.properties?.name === 'India' || String(f.id) === '356');
const LAND = { type: 'FeatureCollection', features: fc.features };

function makeSprite() {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,244,214,1)');
  grd.addColorStop(0.14, 'rgba(255,226,168,0.72)');
  grd.addColorStop(0.42, 'rgba(255,196,116,0.20)');
  grd.addColorStop(1, 'rgba(255,180,90,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  return c;
}

// Tileable fractal value noise -> soft cloud alpha map.
function makeClouds(ctx, size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const field = new Float32Array(size * size);
  const sm = (t) => t * t * (3 - 2 * t);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < 5; o++) {
    const n = 4 << o;
    const grid = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) grid[i] = Math.random();
    const step = size / n;
    for (let y = 0; y < size; y++) {
      const fy = y / step;
      const y0 = Math.floor(fy) % n;
      const y1 = (y0 + 1) % n;
      const ty = sm(fy - Math.floor(fy));
      for (let x = 0; x < size; x++) {
        const fx = x / step;
        const x0 = Math.floor(fx) % n;
        const x1 = (x0 + 1) % n;
        const tx = sm(fx - Math.floor(fx));
        const a = grid[y0 * n + x0];
        const b = grid[y0 * n + x1];
        const cc = grid[y1 * n + x0];
        const d = grid[y1 * n + x1];
        field[y * size + x] +=
          amp * (a + (b - a) * tx + (cc + (d - cc) * tx - (a + (b - a) * tx)) * ty);
      }
    }
    total += amp;
    amp *= 0.52;
  }
  for (let i = 0; i < size * size; i++) {
    let v = field[i] / total;
    v = Math.max(0, Math.min(1, (v - 0.46) / 0.34));
    v = v * v * (3 - 2 * v);
    img.data[i * 4] = 226;
    img.data[i * 4 + 1] = 232;
    img.data[i * 4 + 2] = 245;
    img.data[i * 4 + 3] = v * 255;
  }
  g.putImageData(img, 0, 0);
  return ctx.createPattern(c, 'repeat');
}

/**
 * Mount onto a <canvas>. Returns dispose().
 * `onProject` is called each frame with a lon/lat -> screen projector so React
 * can position HTML annotations over the canvas without duplicating the maths.
 */
export function mount(cv, opts = {}) {
  const ctx = cv.getContext('2d');
  const reduced =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  let W = 0, H = 0, DPR = 1;
  let projection = null;
  let baseCv = null, glowCv = null, glowCtx = null, auroraCv = null, auroraCtx = null;
  let points = [];
  let sprite = null, cloudPat = null;
  let raf = 0, running = false, visible = true, disposed = false, rzTimer = 0;

  function buildScene() {
    const w = W, h = H;
    projection = geoMercator().fitSize([w, h], INDIA);
    const wide = w / h > 1.15;
    projection.scale(projection.scale() * (wide ? 0.8 : 0.95));
    const c0 = projection.translate();

    // On wide viewports India sits right of centre so the left stays open.
    const b = geoPath(projection).bounds(INDIA);
    const cx = w * (wide ? opts.centerX ?? 0.5 : 0.5);
    const cy = h * (wide ? 0.5 : 0.58);
    projection.translate([
      c0[0] + (cx - (b[0][0] + b[1][0]) / 2),
      c0[1] + (cy - (b[0][1] + b[1][1]) / 2),
    ]);

    // Rasterised land masks — far faster than per-point geoContains.
    const mk = (feat) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.beginPath();
      geoPath(projection, g)(feat);
      g.fill();
      return g;
    };
    const mask = mk(LAND).getImageData(0, 0, w, h).data;
    const imask = mk(INDIA).getImageData(0, 0, w, h).data;
    const isLand = (x, y) =>
      x >= 0 && y >= 0 && x < w && y < h && mask[((y | 0) * w + (x | 0)) * 4 + 3] > 100;
    const isIndia = (x, y) => imask[((y | 0) * w + (x | 0)) * 4 + 3] > 100;

    baseCv = document.createElement('canvas');
    baseCv.width = w; baseCv.height = h;
    const bg = baseCv.getContext('2d');
    const og = bg.createLinearGradient(0, 0, w * 0.35, h);
    og.addColorStop(0, '#080a13');
    og.addColorStop(0.55, '#0a0c17');
    og.addColorStop(1, '#070810');
    bg.fillStyle = og;
    bg.fillRect(0, 0, w, h);
    bg.save();
    bg.beginPath();
    geoPath(projection, bg)(LAND);
    bg.fillStyle = '#12141f';
    bg.fill();
    bg.clip();
    const lg = bg.createLinearGradient(0, 0, w * 0.4, h);
    lg.addColorStop(0, 'rgba(38,40,58,0.55)');
    lg.addColorStop(1, 'rgba(20,22,34,0.2)');
    bg.fillStyle = lg;
    bg.fillRect(0, 0, w, h);
    bg.restore();

    const cityPx = CITIES.map(([lon, lat, wgt]) => {
      const p = projection([lon, lat]);
      return p ? [p[0], p[1], wgt] : null;
    }).filter(Boolean);

    points = [];
    const density = (x, y) => {
      let d = 0;
      for (let i = 0; i < cityPx.length; i++) {
        const dx = x - cityPx[i][0], dy = y - cityPx[i][1];
        const r = Math.min(w, h) * (0.02 + 0.1 * cityPx[i][2]);
        d += cityPx[i][2] * Math.exp(-(dx * dx + dy * dy) / (2 * r * r));
      }
      return d;
    };
    const push = (x, y, bb, tint) =>
      points.push({
        x, y, b: bb,
        r: 4 + bb * 17,
        ph: Math.random() * Math.PI * 2,
        sp: 0.25 + Math.random() * 1.5,
        tw: Math.random() < 0.34 ? 0.16 + Math.random() * 0.26 : 0.05,
        tint: tint || 0,
      });

    for (const [x, y, wgt] of cityPx) {
      if (x < -40 || y < -40 || x > w + 40 || y > h + 40) continue;
      push(x, y, 0.55 + wgt * 0.45);
    }

    const target = Math.round((w * h) / (opts.density || 420));
    let tries = 0;
    while (points.length < target && tries < target * 90) {
      tries++;
      const x = Math.random() * w, y = Math.random() * h;
      if (isLand(x, y)) {
        const base = isIndia(x, y) ? 0.075 : 0.046;
        const d = density(x, y);
        if (Math.random() < Math.min(0.96, base + d * 0.55)) {
          push(x, y, Math.min(0.92, 0.1 + Math.random() * 0.24 + d * 0.42));
        }
      } else if (Math.random() < 0.16) {
        const a = Math.random() * Math.PI * 2, rr = 6 + Math.random() * 26;
        if (isLand(x + Math.cos(a) * rr, y + Math.sin(a) * rr)) {
          push(x, y, 0.05 + Math.random() * 0.09, 1);
        }
      }
    }

    if (opts.onProject) opts.onProject(projection);
  }

  function resize() {
    const rect = cv.getBoundingClientRect();
    const w = Math.round(rect.width || cv.clientWidth);
    const h = Math.round(rect.height || cv.clientHeight);
    if (w < 2 || h < 2) return;

    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = w; H = h;
    cv.width = Math.round(W * DPR);
    cv.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    // Bloom at half res, aurora at quarter — deliberate, do not raise.
    glowCv = document.createElement('canvas');
    glowCv.width = Math.max(1, Math.round(W / 2));
    glowCv.height = Math.max(1, Math.round(H / 2));
    glowCtx = glowCv.getContext('2d');

    auroraCv = document.createElement('canvas');
    auroraCv.width = Math.max(1, Math.round(W / 4));
    auroraCv.height = Math.max(1, Math.round(H / 4));
    auroraCtx = auroraCv.getContext('2d');

    buildScene();
  }

  function drawAurora(t) {
    const g = auroraCtx, w = auroraCv.width, h = auroraCv.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    g.globalCompositeOperation = 'lighter';
    const bands = [
      { y: 0.055, amp: 0.03, k: 1.7, sp: 0.055, col: '145,132,217', a: 0.3, th: 0.055 },
      { y: 0.105, amp: 0.026, k: 2.6, sp: -0.038, col: '120,180,190', a: 0.18, th: 0.042 },
      { y: 0.02, amp: 0.038, k: 1.1, sp: 0.026, col: '168,150,235', a: 0.22, th: 0.075 },
    ];
    for (const b of bands) {
      g.beginPath();
      for (let i = 0; i <= 60; i++) {
        const x = (i / 60) * w;
        const y =
          (b.y +
            Math.sin((i / 60) * Math.PI * b.k + t * b.sp * 6) * b.amp +
            Math.sin((i / 60) * Math.PI * b.k * 2.7 + t * b.sp * 3.1) * b.amp * 0.4) * h;
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.lineWidth = b.th * h;
      const pulse = 0.72 + 0.28 * Math.sin(t * 0.31 + b.k);
      g.strokeStyle = `rgba(${b.col},${b.a * pulse})`;
      g.lineCap = 'round';
      g.stroke();
    }
    g.globalCompositeOperation = 'source-over';
  }

  function frame(ms) {
    if (disposed) return;
    const t = reduced ? 8 : ms / 1000;

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    if (baseCv) ctx.drawImage(baseCv, 0, 0, W, H);

    const g = glowCtx, s = 0.5;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, glowCv.width, glowCv.height);
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const a = p.b * (1 - p.tw + p.tw * Math.sin(t * p.sp + p.ph));
      if (a <= 0.01) continue;
      const r = p.r * (0.94 + 0.06 * Math.sin(t * p.sp * 0.7 + p.ph)) * s;
      g.globalAlpha = Math.min(1, a);
      g.drawImage(sprite, p.x * s - r / 2, p.y * s - r / 2, r, r);
    }
    g.globalAlpha = 1;

    // Two-pass bloom — this is what gives the soft glow.
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.6;
    ctx.filter = 'blur(3px)';
    ctx.drawImage(glowCv, 0, 0, W, H);
    ctx.filter = 'blur(14px)';
    ctx.globalAlpha = 0.42;
    ctx.drawImage(glowCv, 0, 0, W, H);
    ctx.filter = 'none';
    ctx.globalAlpha = 1;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.b < 0.14) continue;
      const a = p.b * (1 - p.tw + p.tw * Math.sin(t * p.sp + p.ph));
      ctx.fillStyle = p.tint
        ? `rgba(200,230,255,${a * 0.35})`
        : `rgba(255,247,226,${Math.min(1, a * 0.72)})`;
      const d = p.b > 0.7 ? 1.8 : 1;
      ctx.fillRect(p.x - d / 2, p.y - d / 2, d, d);
    }

    drawAurora(t);
    ctx.globalCompositeOperation = 'lighter';
    ctx.filter = 'blur(18px)';
    ctx.globalAlpha = 0.7;
    ctx.drawImage(auroraCv, 0, 0, W, H);
    ctx.filter = 'none';

    if (cloudPat) {
      ctx.globalCompositeOperation = 'screen';
      ctx.save();
      ctx.globalAlpha = 0.14;
      ctx.translate((t * 7) % 512, (t * 2.2) % 512);
      ctx.fillStyle = cloudPat;
      ctx.fillRect(-512, -512, W + 1024, H + 1024);
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = 0.07;
      ctx.scale(2.1, 2.1);
      ctx.translate((-t * 5.5) % 512, (t * 1.1) % 512);
      ctx.fillStyle = cloudPat;
      ctx.fillRect(-512, -512, W / 2.1 + 1024, H / 2.1 + 1024);
      ctx.restore();
    }

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    const v = ctx.createRadialGradient(
      W * 0.5, H * 0.5, Math.min(W, H) * 0.25,
      W * 0.5, H * 0.5, Math.max(W, H) * 0.78
    );
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.62)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(8,9,17,0.20)';
    ctx.fillRect(0, 0, W, H);

    if (reduced) { running = false; return; }
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (running || disposed || !visible || document.hidden) return;
    running = true;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  const onResize = () => {
    clearTimeout(rzTimer);
    rzTimer = setTimeout(() => {
      if (disposed) return;
      resize();
      if (reduced) { stop(); raf = requestAnimationFrame(frame); }
    }, 180);
  };

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
  if (ro) ro.observe(cv); else window.addEventListener('resize', onResize);

  const onVis = () => (document.hidden ? stop() : start());
  document.addEventListener('visibilitychange', onVis);

  const io =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((entries) => {
          visible = entries.some((e) => e.isIntersecting);
          if (visible) start(); else stop();
        }, { threshold: 0 })
      : null;
  if (io) io.observe(cv);

  sprite = makeSprite();
  resize();
  cloudPat = makeClouds(ctx, 512);
  start();

  return function dispose() {
    disposed = true;
    stop();
    clearTimeout(rzTimer);
    if (ro) ro.disconnect(); else window.removeEventListener('resize', onResize);
    if (io) io.disconnect();
    document.removeEventListener('visibilitychange', onVis);
    baseCv = glowCv = auroraCv = null;
    points = [];
  };
}

export { CITIES };
