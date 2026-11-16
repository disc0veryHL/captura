// Draw the Captura icon procedurally and write public/icon.png, public/icon.svg and build/icon.ico.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Prism inside a camera viewfinder: a white beam enters a white prism and leaves
// as a purple / pink / coral spectrum, on a near-black rounded square.
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const BG = hex('#0c0c0f'), WHITE = [255, 255, 255];
const BANDS = ['#8a4fd0', '#d8458f', '#f07766'].map(hex);

const A = [0.5, 0.29], B = [0.255, 0.715], C = [0.745, 0.715]; // prism
const E = [A[0] + (B[0] - A[0]) * 0.62, A[1] + (B[1] - A[1]) * 0.62]; // beam enters on the left side
const FAN = [0.475, 0.565, 0.655, 0.745]; // spectrum edges where they reach x = 1

function segDist(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(p[0] - a[0] - vx * t, p[1] - a[1] - vy * t);
}
const side = (p, a, b) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
const inTri = (p) => side(p, A, B) <= 0 && side(p, B, C) <= 0 && side(p, C, A) <= 0;
const fanY = (x, i) => E[1] + (FAN[i] - E[1]) * (x - E[0]) / (1 - E[0]);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function sample(u, v) { // u,v in 0..1 -> [r,g,b,a]
  const x = u - 0.5, y = v - 0.5;
  const half = 0.47, rad = 0.2, ax = Math.max(Math.abs(x) - (half - rad), 0), ay = Math.max(Math.abs(y) - (half - rad), 0);
  if (Math.hypot(ax, ay) > rad) return [0, 0, 0, 0];
  const p = [u, v];
  let col = BG;
  // viewfinder corner brackets
  const L = 0.15, W = 0.026, in0 = 0.13, in1 = 0.87;
  for (const [cx, cy, sx, sy] of [[in0, in0, 1, 1], [in1, in0, -1, 1], [in0, in1, 1, -1], [in1, in1, -1, -1]]) {
    const onH = Math.abs(v - cy) < W / 2 && (u - cx) * sx >= -W / 2 && (u - cx) * sx <= L;
    const onV = Math.abs(u - cx) < W / 2 && (v - cy) * sy >= -W / 2 && (v - cy) * sy <= L;
    if (onH || onV) col = WHITE;
  }
  // spectrum: three bands fanning out from the entry point to the right edge
  if (u > E[0]) {
    for (let i = 0; i < 3; i++) if (v >= fanY(u, i) && v < fanY(u, i + 1)) col = BANDS[i];
  }
  // white lower body of the prism, below the spectrum
  if (inTri(p) && u > E[0] - 0.2 && v >= Math.max(fanY(Math.max(u, E[0]), 3), E[1])) col = WHITE;
  // soft glow where light exits the prism
  const g = Math.hypot(u - 0.615, v - 0.555);
  if (g < 0.09) col = mix(col, WHITE, (1 - g / 0.09) ** 2 * 0.55);
  // incoming beam and prism outline
  if (segDist(p, [0.0, 0.66], E) < 0.014) col = WHITE;
  if (Math.min(segDist(p, A, B), segDist(p, B, C), segDist(p, C, A)) < 0.017) col = WHITE;
  return [...col, 255];
}

function render(size) {
  const px = Buffer.alloc(size * size * 4), ss = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const acc = [0, 0, 0, 0];
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const s = sample((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
      acc[0] += s[0] * s[3]; acc[1] += s[1] * s[3]; acc[2] += s[2] * s[3]; acc[3] += s[3];
    }
    const o = (y * size + x) * 4, a = acc[3];
    px[o] = a ? acc[0] / a : 0; px[o + 1] = a ? acc[1] / a : 0; px[o + 2] = a ? acc[2] / a : 0; px[o + 3] = a / (ss * ss);
  }
  return px;
}

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const px = render(size);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map(png);
const header = Buffer.alloc(6); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const dir = Buffer.concat(sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12); offset += pngs[i].length;
  return e;
}));
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build', 'icon.ico'), Buffer.concat([header, dir, ...pngs]));
fs.writeFileSync(path.join(root, 'public', 'icon.png'), pngs[sizes.indexOf(256)]);
fs.writeFileSync(path.join(root, 'public', 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><image href="icon.png" width="64" height="64"/></svg>`);
console.log('icons written');
