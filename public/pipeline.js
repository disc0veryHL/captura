// Non-destructive image pipeline: geometry (rotate, flip, straighten, crop)
// then per-pixel tone, color, detail, filter, vignette and grain.

export const ADJ_DEFAULTS = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, fill: 0,
  temp: 0, tint: 0, vibrance: 0, saturation: 0,
  clarity: 0, sharpen: 0, grain: 0, vignette: 0,
};

export function emptyEdits() {
  return { rot: 0, flip: false, angle: 0, crop: null, auto: null, adj: { ...ADJ_DEFAULTS }, filter: null };
}

export function normalizeEdits(e) {
  const base = emptyEdits();
  if (!e) return base;
  return { ...base, ...e, adj: { ...ADJ_DEFAULTS, ...(e.adj || {}) } };
}

export function isIdentity(e) {
  if (!e) return true;
  const n = normalizeEdits(e);
  return !n.rot && !n.flip && !n.angle && !n.crop && !n.auto && !n.filter &&
    Object.keys(ADJ_DEFAULTS).every((k) => !n.adj[k]);
}

function needsPixels(e) {
  return e.auto || e.filter || Object.keys(ADJ_DEFAULTS).some((k) => e.adj[k]);
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// ---------------- geometry ----------------
export function frameSize(sw, sh, e) {
  return (e.rot % 2) ? [sh, sw] : [sw, sh];
}

export function coverScale(W, H, deg) {
  const a = Math.abs(deg) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return Math.max((W * c + H * s) / W, (W * s + H * c) / H);
}

export function renderGeometry(src, e, maxSize, { ignoreCrop = false } = {}) {
  const sw = src.width, sh = src.height;
  const [W, H] = frameSize(sw, sh, e);
  const crop = (!ignoreCrop && e.crop) || { x: 0, y: 0, w: 1, h: 1 };
  const cw = crop.w * W, ch = crop.h * H;
  const k = Math.min(1, maxSize / Math.max(cw, ch));
  const ow = Math.max(1, Math.round(cw * k)), oh = Math.max(1, Math.round(ch * k));
  const cv = makeCanvas(ow, oh);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.scale(k, k);
  ctx.translate(-crop.x * W, -crop.y * H);
  ctx.translate(W / 2, H / 2);
  if (e.angle) { ctx.rotate(e.angle * Math.PI / 180); const s = coverScale(W, H, e.angle); ctx.scale(s, s); }
  ctx.rotate(e.rot * Math.PI / 2);
  if (e.flip) ctx.scale(-1, 1);
  ctx.drawImage(src, -sw / 2, -sh / 2);
  return cv;
}

// Downscale a large bitmap once (for editing previews / thumbnails).
export function downscale(src, maxSize) {
  const k = Math.min(1, maxSize / Math.max(src.width, src.height));
  if (k === 1) return src;
  const cv = makeCanvas(Math.round(src.width * k), Math.round(src.height * k));
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, cv.width, cv.height);
  return cv;
}

// ---------------- LUT helpers ----------------
const SRGB_TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const LIN_TO_SRGB = new Float32Array(4097);
for (let i = 0; i <= 4096; i++) {
  const c = i / 4096;
  LIN_TO_SRGB[i] = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
const toS = (v) => LIN_TO_SRGB[v <= 0 ? 0 : v >= 1 ? 4096 : (v * 4096) | 0];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (x) => x * x * (3 - 2 * x);
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function curve(points) {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    let j = 0;
    while (j < points.length - 2 && i > points[j + 1][0]) j++;
    const [x0, y0] = points[j], [x1, y1] = points[j + 1];
    const t = x1 === x0 ? 0 : clamp01((i - x0) / (x1 - x0));
    lut[i] = clamp01((y0 + (y1 - y0) * t) / 255);
  }
  return lut;
}
const viaCurve = (lut, v) => lut[v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0];

function toneLut(a) {
  const lut = new Float32Array(1024);
  const b0 = -0.12 * a.blacks, w1 = 1 - 0.12 * a.whites;
  for (let i = 0; i < 1024; i++) {
    let x = i / 1023;
    x = (x - b0) / (w1 - b0);
    x = clamp01(x);
    if (a.fill) x = Math.pow(x, 1 / (1 + 0.9 * a.fill));
    if (a.shadows) x += a.shadows * 1.1 * x * (1 - x) * (1 - x);
    if (a.highlights) x += a.highlights * 1.1 * x * x * (1 - x);
    x = clamp01(x);
    if (a.contrast > 0) x = x + a.contrast * (smooth(x) - x) * 1.4;
    else if (a.contrast < 0) x = 0.5 + (x - 0.5) * (1 + a.contrast * 0.6);
    lut[i] = clamp01(x);
  }
  return lut;
}

// ---------------- blur ----------------
function boxPass(src, dst, w, h, r, horizontal) {
  const n = horizontal ? w : h, lines = horizontal ? h : w;
  const step = horizontal ? 1 : w, lineStep = horizontal ? w : 1;
  const inv = 1 / (2 * r + 1);
  for (let l = 0; l < lines; l++) {
    const base = l * lineStep;
    let acc = src[base] * (r + 1);
    for (let i = 1; i <= r; i++) acc += src[base + Math.min(i, n - 1) * step];
    for (let i = 0; i < n; i++) {
      dst[base + i * step] = acc * inv;
      const add = Math.min(i + r + 1, n - 1), sub = Math.max(i - r, 0);
      acc += src[base + add * step] - src[base + sub * step];
    }
  }
}
function blur(src, w, h, r) {
  r = Math.max(1, Math.round(r));
  const a = new Float32Array(src), b = new Float32Array(src.length);
  for (let k = 0; k < 3; k++) { boxPass(a, b, w, h, r, true); boxPass(b, a, w, h, r, false); }
  return a;
}

// ---------------- filters ----------------
const CROSS = { r: curve([[0, 0], [60, 30], [210, 255], [255, 255]]),
  g: curve([[0, 0], [47, 38], [101, 111], [187, 206], [255, 255]]),
  b: curve([[0, 32], [255, 216]]) };
const MATTE = curve([[0, 32], [64, 72], [190, 200], [255, 236]]);
const FADED = curve([[0, 40], [128, 132], [255, 228]]);
const S_STRONG = curve([[0, 0], [60, 30], [128, 128], [196, 226], [255, 255]]);
const HEAT = [[0, 0, 0.5], [0, 0.6, 1], [0.1, 0.9, 0.3], [1, 0.95, 0.1], [1, 0.35, 0], [0.9, 0, 0]];

export const FILTERS = [
  { id: 'vivid', name: 'Vivid' },
  { id: 'warm', name: 'Warmify' },
  { id: 'cool', name: 'Cool' },
  { id: 'bw', name: 'B&W' },
  { id: 'noir', name: 'Noir' },
  { id: 'sepia', name: 'Sepia' },
  { id: 'cross', name: 'Cross Process' },
  { id: 'cinema', name: 'Teal & Orange' },
  { id: 'lomo', name: 'Lomo' },
  { id: 'faded', name: '1960s' },
  { id: 'matte', name: 'Matte' },
  { id: 'duotone', name: 'Duo-Tone' },
  { id: 'infrared', name: 'Infrared' },
  { id: 'glow', name: 'Glow' },
  { id: 'heatmap', name: 'Heat Map' },
  { id: 'posterize', name: 'Posterize' },
  { id: 'invert', name: 'Invert' },
];
const FILTER_NEEDS_BLUR = new Set(['glow']);

function applyFilter(id, r, g, b, x, y, ctx, out) {
  let L;
  switch (id) {
    case 'vivid': {
      L = lum(r, g, b); const k = 1.4;
      r = L + (r - L) * k; g = L + (g - L) * k; b = L + (b - L) * k;
      r = smooth(clamp01(r)) * 0.4 + r * 0.6; g = smooth(clamp01(g)) * 0.4 + g * 0.6; b = smooth(clamp01(b)) * 0.4 + b * 0.6;
      break;
    }
    case 'warm': r = r * 1.08 + 0.02; g = g * 1.02; b = b * 0.86; break;
    case 'cool': r = r * 0.9; g = g * 0.99; b = b * 1.08 + 0.03; break;
    case 'bw': L = smooth(clamp01(0.3 * r + 0.59 * g + 0.11 * b)) * 0.3 + (0.3 * r + 0.59 * g + 0.11 * b) * 0.7; r = g = b = L; break;
    case 'noir': L = viaCurve(S_STRONG, viaCurve(S_STRONG, lum(r, g, b))); r = g = b = L; break;
    case 'sepia': {
      const nr = 0.393 * r + 0.769 * g + 0.189 * b, ng = 0.349 * r + 0.686 * g + 0.168 * b, nb = 0.272 * r + 0.534 * g + 0.131 * b;
      r = nr * 0.9; g = ng * 0.9; b = nb * 0.9; break;
    }
    case 'cross': {
      r = viaCurve(CROSS.r, r); g = viaCurve(CROSS.g, g); b = viaCurve(CROSS.b, b);
      b *= 0.8; break; // multiply-blend a 20% yellow tint (only blue drops)
    }
    case 'cinema': {
      L = lum(r, g, b); const t = (L - 0.5) * 0.35;
      r += t * 0.9; g += t * 0.15; b -= t * 0.9;
      r = r * 0.95 + 0.02; b = b * 0.95 + 0.03; break;
    }
    case 'lomo': {
      L = lum(r, g, b); const k = 1.35;
      r = viaCurve(S_STRONG, L + (r - L) * k); g = viaCurve(S_STRONG, L + (g - L) * k); b = viaCurve(S_STRONG, L + (b - L) * k) * 0.95;
      const dx = x - 0.5, dy = y - 0.5, v = 1 - Math.min(1, (dx * dx + dy * dy) * 2.2) * 0.75;
      r *= v; g *= v; b *= v; break;
    }
    case 'faded': {
      L = lum(r, g, b);
      r = viaCurve(FADED, L + (r - L) * 0.65) * 1.04; g = viaCurve(FADED, L + (g - L) * 0.65); b = viaCurve(FADED, L + (b - L) * 0.65) * 0.9;
      break;
    }
    case 'matte': r = viaCurve(MATTE, r); g = viaCurve(MATTE, g); b = viaCurve(MATTE, b); break;
    case 'duotone': {
      L = clamp01(lum(r, g, b));
      r = 0.10 + L * (1.0 - 0.10); g = 0.12 + L * (0.84 - 0.12); b = 0.32 + L * (0.56 - 0.32); break;
    }
    case 'infrared': L = clamp01(-0.25 * r + 1.45 * g - 0.2 * b); L = smooth(L) * 0.5 + L * 0.5; r = g = b = L; break;
    case 'glow': {
      const bl = ctx.blurL[ctx.i];
      r = 1 - (1 - r) * (1 - bl * 0.55); g = 1 - (1 - g) * (1 - bl * 0.55); b = 1 - (1 - b) * (1 - bl * 0.55);
      break;
    }
    case 'heatmap': {
      L = clamp01(lum(r, g, b)) * (HEAT.length - 1); const i = Math.min(HEAT.length - 2, L | 0), t = L - i;
      const a = HEAT[i], c = HEAT[i + 1];
      r = a[0] + (c[0] - a[0]) * t; g = a[1] + (c[1] - a[1]) * t; b = a[2] + (c[2] - a[2]) * t; break;
    }
    case 'posterize': { const n = 4; r = Math.round(clamp01(r) * n) / n; g = Math.round(clamp01(g) * n) / n; b = Math.round(clamp01(b) * n) / n; break; }
    case 'invert': r = 1 - r; g = 1 - g; b = 1 - b; break;
  }
  out[0] = r; out[1] = g; out[2] = b;
}

// ---------------- auto ("I'm feeling lucky") ----------------
export function computeAuto(imageData) {
  const d = imageData.data, hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let n = 0;
  for (let i = 0; i < d.length; i += 8) { hist[0][d[i]]++; hist[1][d[i + 1]]++; hist[2][d[i + 2]]++; n++; }
  const pct = (h, p) => { let acc = 0; const t = n * p; for (let i = 0; i < 256; i++) { acc += h[i]; if (acc >= t) return i; } return 255; };
  const lo = [], hi = [];
  for (let c = 0; c < 3; c++) {
    let l = pct(hist[c], 0.005), h = pct(hist[c], 0.995);
    if (h - l < 80) { const m = (h + l) / 2; l = Math.max(0, m - 40); h = Math.min(255, m + 40); }
    lo.push(Math.min(l, 60) / 255); hi.push(Math.max(h, 190) / 255);
  }
  // keep neutral balance gentle: blend channel levels toward their mean
  const mlo = (lo[0] + lo[1] + lo[2]) / 3, mhi = (hi[0] + hi[1] + hi[2]) / 3;
  return { lo: lo.map((v) => v * 0.6 + mlo * 0.4), hi: hi.map((v) => v * 0.6 + mhi * 0.4) };
}

// ---------------- main per-pixel pass ----------------
export function processPixels(imageData, edits) {
  const e = normalizeEdits(edits);
  if (!needsPixels(e)) return imageData;
  const a = e.adj, d = imageData.data, w = imageData.width, h = imageData.height, N = w * h;
  const scale = Math.max(w, h) / 1500;

  // per-channel input LUT: auto levels + sRGB->linear + exposure + white balance
  const expo = Math.pow(2, a.exposure * 1.5);
  const wb = [1 + 0.22 * a.temp - 0.04 * a.tint, 1 - 0.18 * a.tint, 1 - 0.22 * a.temp - 0.04 * a.tint];
  const inLut = [0, 1, 2].map((c) => {
    const lut = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      let v = i / 255;
      if (e.auto) v = clamp01((v - e.auto.lo[c]) / Math.max(0.05, e.auto.hi[c] - e.auto.lo[c]));
      const lin = SRGB_TO_LIN[Math.round(v * 255)] * expo * wb[c];
      lut[i] = toS(lin);
    }
    return lut;
  });
  const tone = toneLut(a);
  const T = (v) => tone[v <= 0 ? 0 : v >= 1 ? 1023 : (v * 1023 + 0.5) | 0];

  const fid = e.filter?.id, famt = e.filter ? (e.filter.amount ?? 1) : 0;
  const wantLuma = a.clarity || a.sharpen || FILTER_NEEDS_BLUR.has(fid);
  let Lt = null, blurBig = null, blurSmall = null;
  if (wantLuma) {
    Lt = new Float32Array(N);
    for (let i = 0, p = 0; i < N; i++, p += 4) Lt[i] = lum(T(inLut[0][d[p]]), T(inLut[1][d[p + 1]]), T(inLut[2][d[p + 2]]));
    if (a.clarity || FILTER_NEEDS_BLUR.has(fid)) blurBig = blur(Lt, w, h, Math.max(2, Math.max(w, h) / 60));
    if (a.sharpen) blurSmall = blur(Lt, w, h, Math.max(1, scale * 1.2));
  }

  const ctx = { blurL: blurBig, i: 0 };
  const out = [0, 0, 0];
  const sat = 1 + a.saturation, vib = a.vibrance;
  const vig = a.vignette, grain = a.grain * 0.22, gscale = Math.max(1, scale);
  for (let y = 0, i = 0, p = 0; y < h; y++) {
    const ny = y / (h - 1 || 1);
    for (let x = 0; x < w; x++, i++, p += 4) {
      let r = T(inLut[0][d[p]]), g = T(inLut[1][d[p + 1]]), b = T(inLut[2][d[p + 2]]);
      if (Lt) {
        let delta = 0;
        if (a.clarity) { const L = Lt[i]; delta += (L - blurBig[i]) * a.clarity * 1.6 * (1 - (2 * L - 1) * (2 * L - 1)); }
        if (a.sharpen) delta += (Lt[i] - blurSmall[i]) * a.sharpen * 2.5;
        r += delta; g += delta; b += delta;
      }
      if (sat !== 1 || vib) {
        const L = lum(r, g, b);
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const f = sat * (1 + vib * (1 - clamp01((mx - mn) * 1.5)));
        r = L + (r - L) * f; g = L + (g - L) * f; b = L + (b - L) * f;
      }
      const nx = x / (w - 1 || 1);
      if (fid) {
        ctx.i = i;
        applyFilter(fid, r, g, b, nx, ny, ctx, out);
        r += (out[0] - r) * famt; g += (out[1] - g) * famt; b += (out[2] - b) * famt;
      }
      if (vig) {
        const dx = nx - 0.5, dy = ny - 0.5;
        const dd = Math.min(1, (dx * dx + dy * dy) * 2);
        const k = Math.abs(vig) * Math.pow(dd, 1.4) * 0.9;
        if (vig > 0) { r *= 1 - k; g *= 1 - k; b *= 1 - k; } // darken edges
        else { r += (1 - r) * k; g += (1 - g) * k; b += (1 - b) * k; } // lighten edges
      }
      if (grain) {
        let s = (Math.floor(x / gscale) * 374761393 + Math.floor(y / gscale) * 668265263) | 0;
        s = Math.imul(s ^ (s >>> 13), 1274126177); s ^= s >>> 16;
        const n = ((s & 0xffff) / 65535 - 0.5) * grain;
        r += n; g += n; b += n;
      }
      d[p] = r * 255 + 0.5; d[p + 1] = g * 255 + 0.5; d[p + 2] = b * 255 + 0.5; // Uint8Clamped clamps
    }
  }
  return imageData;
}

// Render a source (bitmap/canvas) with edits to a canvas no larger than maxSize.
export function renderEdited(src, edits, maxSize, opts = {}) {
  const e = normalizeEdits(edits);
  const cv = renderGeometry(src, e, maxSize, opts);
  if (needsPixels(e)) {
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const id = ctx.getImageData(0, 0, cv.width, cv.height);
    processPixels(id, e);
    ctx.putImageData(id, 0, 0);
  }
  return cv;
}

export function histogram(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const h = [new Uint32Array(64), new Uint32Array(64), new Uint32Array(64)];
  const step = Math.max(4, Math.floor(d.length / 4 / 120000) * 4);
  for (let i = 0; i < d.length; i += step) { h[0][d[i] >> 2]++; h[1][d[i + 1] >> 2]++; h[2][d[i + 2] >> 2]++; }
  return h;
}

// 64-bit difference hash, from the unedited image, for duplicate detection.
export function dHash(src) {
  const cv = makeCanvas(9, 8), ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, 9, 8);
  const d = ctx.getImageData(0, 0, 9, 8).data;
  let hex = '';
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) {
      const p = (y * 9 + x) * 4, q = p + 4;
      const l = d[p] * 0.3 + d[p + 1] * 0.59 + d[p + 2] * 0.11, r = d[q] * 0.3 + d[q + 1] * 0.59 + d[q + 2] * 0.11;
      byte = (byte << 1) | (l > r ? 1 : 0);
    }
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

export function hamming(a, b) {
  let n = 0;
  for (let i = 0; i < 16; i += 4) {
    let x = parseInt(a.slice(i, i + 4), 16) ^ parseInt(b.slice(i, i + 4), 16);
    while (x) { n += x & 1; x >>= 1; }
  }
  return n;
}

export function canvasToBlob(cv, type = 'image/jpeg', quality = 0.9) {
  return new Promise((resolve, reject) => cv.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, quality));
}
