// Render neutral, procedurally generated "photos" for README screenshots and demos.
// Usage: node scripts/demo-photos.mjs <outDir>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const out = path.resolve(process.argv[2] || 'demo-photos');
fs.mkdirSync(out, { recursive: true });
const W = 1500, H = 1000;

// ---- tiny PNG encoder ----
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
function png(w, h, px) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) px.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---- helpers ----
let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const grad = (stops, t) => { t = Math.max(0, Math.min(1, t)); const n = stops.length - 1, i = Math.min(n - 1, Math.floor(t * n)); return mix(stops[i], stops[i + 1], t * n - i); };
function noise1(x, s) { // smooth 1-D value noise
  const i = Math.floor(x), f = x - i, h = (k) => { const v = Math.sin((k + s * 97.3) * 127.1) * 43758.5453; return v - Math.floor(v); };
  const u = f * f * (3 - 2 * f); return h(i) * (1 - u) + h(i + 1) * u;
}
const ridge = (x, s, oct = 5) => { let v = 0, a = 0.5, fr = 1; for (let o = 0; o < oct; o++) { v += a * noise1(x * fr, s + o); a *= 0.5; fr *= 2.1; } return v; };

function scene({ sky, sun, layers, water, stars, bokeh, seedN }) {
  seed = seedN;
  const px = Buffer.alloc(W * H * 3);
  const skyStops = sky.map(hex);
  const starList = stars ? Array.from({ length: 500 }, () => [rnd() * W, rnd() * H * 0.6, rnd()]) : [];
  const bokehList = bokeh ? Array.from({ length: 70 }, () => [rnd() * W, rnd() * H, 15 + rnd() * 60, hex(bokeh[Math.floor(rnd() * bokeh.length)]), 0.15 + rnd() * 0.35]) : [];
  const horizon = water ? water.at * H : H;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let yy = y, refl = false;
      if (y > horizon) { yy = 2 * horizon - y + Math.sin(x * 0.05 + y * 0.3) * 2; refl = true; }
      let c = grad(skyStops, yy / horizon);
      if (sun) {
        const d = Math.hypot(x - sun.x * W, yy - sun.y * H);
        const r = sun.r * H;
        c = mix(c, hex(sun.glow), Math.max(0, 1 - d / (r * 6)) ** 2 * 0.8);
        if (d < r) c = mix(c, hex(sun.color), Math.min(1, (r - d) / 3));
      }
      for (const [sx, sy, b] of starList) if (Math.abs(x - sx) < 1 && Math.abs(yy - sy) < 1) c = mix(c, [255, 255, 255], b);
      for (const l of layers) {
        const top = (l.base - l.amp * ridge(x / W * l.freq, l.s)) * H;
        if (yy >= top) { const depth = Math.min(1, (yy - top) / (H * 0.25)); c = mix(hex(l.color), hex(l.color2 || l.color), depth); }
      }
      if (refl) c = mix(c, hex(water.tint), 0.35);
      for (const [bx, by, br, bc, ba] of bokehList) { const d = Math.hypot(x - bx, y - by); if (d < br) c = mix(c, bc, ba * Math.min(1, (br - d) / 4)); }
      const i = (y * W + x) * 3;
      const vig = 1 - 0.35 * (((x / W - 0.5) ** 2 + (y / H - 0.5) ** 2) * 2);
      px[i] = c[0] * vig; px[i + 1] = c[1] * vig; px[i + 2] = c[2] * vig;
    }
  }
  return px;
}

const SCENES = [
  ['Mountain sunset', { sky: ['#1b1f4b', '#7b3f7a', '#f2785c', '#ffd39a'], sun: { x: 0.62, y: 0.62, r: 0.06, color: '#fff3c4', glow: '#ffb46b' }, layers: [{ base: 0.72, amp: 0.3, freq: 3, s: 1, color: '#5a3a63' }, { base: 0.86, amp: 0.25, freq: 5, s: 2, color: '#2d1f3d', color2: '#1a1226' }], seedN: 3 }, '2024-07-14T20:41:00'],
  ['Lake at dawn', { sky: ['#f7c9a9', '#f6e3c2', '#b9d6e8'], sun: { x: 0.3, y: 0.52, r: 0.05, color: '#fffaf0', glow: '#ffd7a8' }, layers: [{ base: 0.58, amp: 0.12, freq: 4, s: 7, color: '#6f8aa3' }, { base: 0.6, amp: 0.06, freq: 9, s: 8, color: '#3f5568' }], water: { at: 0.6, tint: '#5b8bb0' }, seedN: 5 }, '2024-07-15T06:12:00'],
  ['Northern lights', { sky: ['#020617', '#0b2b3a', '#1c8c6c', '#071a26'], stars: true, layers: [{ base: 0.82, amp: 0.18, freq: 6, s: 11, color: '#06121c' }], seedN: 9 }, '2024-02-03T23:05:00'],
  ['Desert dunes', { sky: ['#5fa8d3', '#bfe3f2', '#ffe9c7'], sun: { x: 0.8, y: 0.2, r: 0.04, color: '#ffffff', glow: '#fff4d6' }, layers: [{ base: 0.68, amp: 0.15, freq: 2, s: 13, color: '#e9a95f', color2: '#c97b3d' }, { base: 0.85, amp: 0.18, freq: 2.6, s: 14, color: '#d88b45', color2: '#a65a2a' }], seedN: 11 }, '2024-04-21T16:30:00'],
  ['Misty forest', { sky: ['#cfd8d3', '#e8ece8', '#f5f5f0'], layers: [{ base: 0.55, amp: 0.25, freq: 14, s: 17, color: '#9fb2a7' }, { base: 0.7, amp: 0.25, freq: 16, s: 18, color: '#6d8678' }, { base: 0.86, amp: 0.25, freq: 18, s: 19, color: '#34473d', color2: '#1d2a23' }], seedN: 13 }, '2024-10-02T09:15:00'],
  ['City lights', { sky: ['#0f0c29', '#302b63', '#24243e'], bokeh: ['#ffcf5c', '#ff7a59', '#5cc8ff', '#ff5ca8', '#ffffff'], layers: [], seedN: 15 }, '2024-12-24T19:48:00'],
  ['Ocean evening', { sky: ['#2b5876', '#4e4376', '#f7797d', '#fbd786'], sun: { x: 0.5, y: 0.66, r: 0.07, color: '#ffe3a3', glow: '#ff9a76' }, layers: [], water: { at: 0.66, tint: '#2b4f73' }, seedN: 17 }, '2024-08-30T19:58:00'],
  ['Snow peaks', { sky: ['#1d4e89', '#5f9bd1', '#dbeeff'], sun: { x: 0.18, y: 0.18, r: 0.035, color: '#ffffff', glow: '#e8f4ff' }, layers: [{ base: 0.6, amp: 0.4, freq: 4, s: 21, color: '#f4f8ff', color2: '#9fb7d1' }, { base: 0.82, amp: 0.2, freq: 6, s: 22, color: '#46607a', color2: '#2b3c4f' }], seedN: 19 }, '2025-01-11T11:20:00'],
  ['Lavender hills', { sky: ['#ffd3e0', '#f6e6ff', '#d5ecff'], layers: [{ base: 0.6, amp: 0.15, freq: 3, s: 25, color: '#b39ddb' }, { base: 0.75, amp: 0.15, freq: 4, s: 26, color: '#8e6cc2' }, { base: 0.9, amp: 0.12, freq: 5, s: 27, color: '#5e3f99', color2: '#3d2768' }], seedN: 21 }, '2025-06-18T18:05:00'],
  ['Golden field', { sky: ['#ff9966', '#ffd194', '#fff3d6'], sun: { x: 0.75, y: 0.5, r: 0.05, color: '#fffbe8', glow: '#ffc773' }, bokeh: ['#ffe9a8', '#fff6d5'], layers: [{ base: 0.62, amp: 0.05, freq: 5, s: 29, color: '#d9a441', color2: '#9c6b1f' }], seedN: 23 }, '2025-06-19T19:40:00'],
  ['Starry night', { sky: ['#000814', '#001d3d', '#003566'], stars: true, layers: [{ base: 0.78, amp: 0.25, freq: 3, s: 31, color: '#000a14' }], seedN: 25 }, '2025-06-20T23:55:00'],
  ['Autumn valley', { sky: ['#7fb3d5', '#d6eaf8', '#fdebd0'], layers: [{ base: 0.55, amp: 0.2, freq: 5, s: 33, color: '#d35400' }, { base: 0.7, amp: 0.2, freq: 7, s: 34, color: '#a04000' }, { base: 0.88, amp: 0.15, freq: 9, s: 35, color: '#6e2c00', color2: '#3b1700' }], seedN: 27 }, '2025-10-05T14:10:00'],
];

for (const [name, cfg, date] of SCENES) {
  const file = path.join(out, name + '.png');
  fs.writeFileSync(file, png(W, H, scene(cfg)));
  const t = new Date(date);
  fs.utimesSync(file, t, t); // the library dates photos by file time when there is no EXIF
  console.log('wrote', path.basename(file));
}
