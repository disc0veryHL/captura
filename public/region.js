// Region capture overlay: frozen screenshot, dimmed outside the selection, crosshair,
// pixel magnifier with color readout, window snapping, size label.
import { t } from './i18n.js';

const cv = document.getElementById('c');
document.getElementById('hint').innerHTML = t('<b>Drag</b> to select · <b>Click</b> a window · <b>Enter</b> whole screen · <b>Shift</b> square · <b>Esc</b> cancel');
const ctx = cv.getContext('2d');
const hint = document.getElementById('hint');
const ACCENT = '#b07cff';

const S = { img: null, w: 0, h: 0, scale: 1, windows: [], mx: -1, my: -1, drag: null, sel: null, hover: null, raw: null };

function done(res) { window.lumenNative?.captureDone?.(res); }

(async function init() {
  const data = await window.lumenNative?.captureInit?.();
  if (!data) return done(null);
  S.w = data.width; S.h = data.height; S.scale = data.scale; S.windows = data.windows || [];
  S.img = new Image();
  await new Promise((res, rej) => { S.img.onload = res; S.img.onerror = rej; S.img.src = data.image; });
  // pixel access for the magnifier color readout
  const off = new OffscreenCanvas(S.img.naturalWidth, S.img.naturalHeight);
  const octx = off.getContext('2d', { willReadFrequently: true });
  octx.drawImage(S.img, 0, 0);
  S.raw = octx;
  S.k = S.img.naturalWidth / S.w; // image pixels per DIP
  resize();
  setTimeout(() => (hint.style.opacity = '0'), 3500);
})();

function resize() {
  cv.width = Math.round(innerWidth * devicePixelRatio);
  cv.height = Math.round(innerHeight * devicePixelRatio);
  draw();
}
window.addEventListener('resize', resize);

const norm = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) });

function windowAt(x, y) {
  for (const w of S.windows) if (x >= w.x && y >= w.y && x < w.x + w.width && y < w.y + w.height) {
    // clip to this display
    const x0 = Math.max(0, w.x), y0 = Math.max(0, w.y);
    return { x: x0, y: y0, width: Math.min(S.w, w.x + w.width) - x0, height: Math.min(S.h, w.y + w.height) - y0, title: w.title };
  }
  return null;
}

function draw() {
  if (!S.img) return;
  const d = devicePixelRatio;
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(S.img, 0, 0, S.w, S.h);
  const r = S.drag ? S.sel : S.hover;
  // dim everything outside the selection
  ctx.fillStyle = 'rgba(0,0,0,.45)';
  ctx.beginPath();
  ctx.rect(0, 0, S.w, S.h);
  if (r && r.width > 0 && r.height > 0) ctx.rect(r.x, r.y, r.width, r.height); // hole
  ctx.fill('evenodd');
  if (r && r.width > 0) {
    ctx.strokeStyle = ACCENT; ctx.lineWidth = 2;
    ctx.strokeRect(r.x + 1, r.y + 1, r.width - 2, r.height - 2);
    const label = `${Math.round(r.width * S.k)} × ${Math.round(r.height * S.k)}` + (!S.drag && r.title ? `   ${r.title.slice(0, 60)}` : '');
    ctx.font = '600 12px "Segoe UI", sans-serif';
    const tw = ctx.measureText(label).width + 14;
    let lx = r.x, ly = r.y - 26;
    if (ly < 4) ly = r.y + 6;
    lx = Math.min(lx, S.w - tw - 4);
    ctx.fillStyle = 'rgba(12,12,15,.85)'; ctx.beginPath(); ctx.roundRect(lx, ly, tw, 20, 6); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText(label, lx + 7, ly + 14);
  }
  if (S.mx >= 0) {
    // crosshair
    ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, S.my + 0.5); ctx.lineTo(S.w, S.my + 0.5); ctx.moveTo(S.mx + 0.5, 0); ctx.lineTo(S.mx + 0.5, S.h); ctx.stroke();
    ctx.setLineDash([]);
    magnifier();
  }
}

function magnifier() {
  const N = 15, Z = 9, size = N * Z; // 15×15 source pixels at 9×
  const px = Math.round(S.mx * S.k), py = Math.round(S.my * S.k);
  let bx = S.mx + 24, by = S.my + 24;
  if (bx + size > S.w) bx = S.mx - size - 24;
  if (by + size + 34 > S.h) by = S.my - size - 58;
  ctx.save();
  ctx.beginPath(); ctx.roundRect(bx, by, size, size, 10); ctx.clip();
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#000'; ctx.fillRect(bx, by, size, size);
  ctx.drawImage(S.img, px - (N >> 1), py - (N >> 1), N, N, bx, by, size, size);
  ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.lineWidth = 1;
  for (let i = 1; i < N; i++) {
    ctx.beginPath(); ctx.moveTo(bx + i * Z + 0.5, by); ctx.lineTo(bx + i * Z + 0.5, by + size);
    ctx.moveTo(bx, by + i * Z + 0.5); ctx.lineTo(bx + size, by + i * Z + 0.5); ctx.stroke();
  }
  ctx.strokeStyle = ACCENT; ctx.lineWidth = 2;
  ctx.strokeRect(bx + (N >> 1) * Z, by + (N >> 1) * Z, Z, Z);
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(bx, by, size, size, 10); ctx.stroke();
  // position + color readout
  const [r, g, b] = S.raw.getImageData(Math.min(S.raw.canvas.width - 1, Math.max(0, px)), Math.min(S.raw.canvas.height - 1, Math.max(0, py)), 1, 1).data;
  const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  const text = `X ${px}  Y ${py}   ${hex}`;
  ctx.font = '600 11.5px "Segoe UI", sans-serif';
  ctx.fillStyle = 'rgba(12,12,15,.88)'; ctx.beginPath(); ctx.roundRect(bx, by + size + 6, size, 22, 6); ctx.fill();
  ctx.fillStyle = hex; ctx.fillRect(bx + 6, by + size + 12, 10, 10);
  ctx.fillStyle = '#fff'; ctx.fillText(text, bx + 22, by + size + 21);
  S.hex = hex;
}

let raf = 0;
const redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };

window.addEventListener('pointermove', (e) => {
  S.mx = e.clientX; S.my = e.clientY;
  if (S.drag) {
    let b = { x: e.clientX, y: e.clientY };
    if (e.shiftKey) { // square selection
      const s = Math.max(Math.abs(b.x - S.drag.x), Math.abs(b.y - S.drag.y));
      b = { x: S.drag.x + Math.sign(b.x - S.drag.x || 1) * s, y: S.drag.y + Math.sign(b.y - S.drag.y || 1) * s };
    }
    S.sel = norm(S.drag, b);
  } else S.hover = windowAt(e.clientX, e.clientY);
  redraw();
});
window.addEventListener('pointerdown', (e) => {
  if (e.button === 2) return done(null);
  if (e.button !== 0) return;
  S.drag = { x: e.clientX, y: e.clientY };
  S.sel = { x: e.clientX, y: e.clientY, width: 0, height: 0 };
});
window.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !S.drag) return;
  const r = S.sel;
  S.drag = null;
  if (r && r.width > 3 && r.height > 3) return done({ ...r });
  const w = windowAt(e.clientX, e.clientY); // a click picks the window under the cursor
  done(w ? { ...w, window: true } : { x: 0, y: 0, width: S.w, height: S.h });
});
window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') done(null);
  else if (e.key === 'Enter') done({ x: 0, y: 0, width: S.w, height: S.h });
  else if (e.key.toLowerCase() === 'c' && e.ctrlKey && S.hex) navigator.clipboard?.writeText(S.hex);
  // arrow keys move the cursor one pixel for precise selection
  else if (e.key.startsWith('Arrow')) {
    const dx = { ArrowLeft: -1, ArrowRight: 1 }[e.key] || 0, dy = { ArrowUp: -1, ArrowDown: 1 }[e.key] || 0;
    S.mx = Math.max(0, Math.min(S.w - 1, S.mx + dx / S.k)); S.my = Math.max(0, Math.min(S.h - 1, S.my + dy / S.k));
    if (S.drag) S.sel = norm(S.drag, { x: S.mx, y: S.my });
    redraw();
  }
});
