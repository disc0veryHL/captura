// Captura screenshot editor: annotate, redact and crop screenshots.
// Tool set follows ShareX's editor (rectangle, ellipse, line, arrow, freehand, text,
// speech balloon, step, highlight, blur, pixelate, magnify, spotlight, smart eraser, crop);
// this implementation is Captura's own.
import { state, h, icon, toast, modal, applyAppearance } from './store.js';
import { isKey, keysFor, prettyCombo } from './keys.js';
import { t, setLanguage, translateDom } from './i18n.js';

const $ = (s) => document.querySelector(s);
const cv = $('#cv');
const ctx = cv.getContext('2d');
const native = window.lumenNative;

// ---------------- tools ----------------
const P = (d) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const TOOLS = [
  ['select', 'V', t('Select / move'), P('<path d="M5 3l14 8-6 2-2 6z"/>')],
  '|',
  ['rect', 'R', t('Rectangle'), P('<rect x="4" y="6" width="16" height="12" rx="1.5"/>')],
  ['ellipse', 'E', t('Ellipse'), P('<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>')],
  ['line', 'L', t('Line'), P('<path d="M5 19 19 5"/>')],
  ['arrow', 'A', t('Arrow'), P('<path d="M5 19 19 5M10 5h9v9"/>')],
  ['pen', 'P', t('Freehand'), P('<path d="M4 17c3-6 5 2 8-3s4-7 8-6"/>')],
  ['text', 'T', t('Text'), P('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>')],
  ['balloon', 'B', t('Speech balloon'), P('<path d="M4 5h16v10H10l-4 4v-4H4z"/>')],
  ['step', 'S', t('Step number'), P('<circle cx="12" cy="12" r="8"/><path d="M11 9l2-1v8"/>')],
  '|',
  ['highlight', 'H', t('Highlight'), P('<path d="m9 15-4 4h6l2-2M14 4l6 6-8 8-6-6z"/>')],
  ['blur', 'U', t('Blur'), P('<circle cx="12" cy="12" r="8" stroke-dasharray="2 3"/><circle cx="12" cy="12" r="3.5"/>')],
  ['pixelate', 'X', t('Pixelate'), P('<path d="M4 4h5v5H4zM15 4h5v5h-5zM9 9h6v6H9zM4 15h5v5H4zM15 15h5v5h-5z"/>')],
  ['magnify', 'M', t('Magnify'), P('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M11 8v6M8 11h6"/>')],
  ['spotlight', 'O', t('Spotlight'), P('<path d="M12 3v2M12 19v2M3 12h2M19 12h2"/><circle cx="12" cy="12" r="5"/>')],
  ['eraser', 'Z', t('Smart eraser (fills with the surrounding color)'), P('<path d="m4 15 9-9 7 7-7 7H8z"/><path d="M14 20h6"/>')],
  '|',
  ['crop', 'C', t('Crop'), P('<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>')],
];
const BOX = new Set(['rect', 'ellipse', 'highlight', 'blur', 'pixelate', 'magnify', 'spotlight', 'eraser', 'balloon']);
const COLORS = ['#ff3b5c', '#ff9f1a', '#ffd23f', '#2ecc71', '#1fb5ff', '#7c5cff', '#ffffff', '#111111'];

const E = {
  photo: null, base: null, shapes: [], sel: -1, tool: 'arrow', zoom: 1, fitted: true,
  color: '#ff3b5c', width: 4, fill: false, shadow: true, arrow: 'modern', stepStyle: 'num', font: 32, strength: 12,
  states: [], si: -1, saved: 0, drag: null, crop: null, editing: null,
};
const dirty = () => E.si !== E.saved;

// ---------------- load ----------------
(async function boot() {
  const id = new URLSearchParams(location.search).get('id');
  const r = await fetch(`/api/photo/${id}/info`);
  if (!r.ok) { document.body.innerHTML = '<div class="empty">This image is no longer available.</div>'; return; }
  const { photo, settings } = await r.json();
  state.settings = settings || {};
  applyAppearance(state.settings);
  E.photo = photo;
  document.title = photo.name + ' — Captura Editor';
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = `/api/photo/${id}/original?m=${Math.round(photo.mtime)}`; });
  E.base = document.createElement('canvas');
  E.base.width = img.naturalWidth; E.base.height = img.naturalHeight;
  E.base.getContext('2d').drawImage(img, 0, 0);
  record(); E.saved = E.si;
  buildToolbar(); setTool(E.tool); fit(); render();
})();

// ---------------- history ----------------
const snapshot = () => ({ base: E.base, shapes: JSON.stringify(E.shapes) });
function record() {
  E.states = E.states.slice(0, E.si + 1);
  E.states.push(snapshot());
  E.si = E.states.length - 1;
  updateActions();
}
function restore(i) {
  E.si = i;
  const s = E.states[i];
  E.base = s.base; E.shapes = JSON.parse(s.shapes); E.sel = -1;
  sizeCanvas(); render(); updateActions();
}
const undo = () => { finishText(); if (E.si > 0) restore(E.si - 1); };
const redo = () => { if (E.si < E.states.length - 1) restore(E.si + 1); };

// ---------------- toolbar & options ----------------
function buildToolbar() {
  const tools = $('#tools');
  for (const item of TOOLS) {
    if (item === '|') { tools.append(h('span', { class: 'sep' })); continue; }
    const [id, key, label, svg] = item;
    const k = keysFor('sx.' + id)[0];
    tools.append(h('button', { class: 'tbtn', 'data-tool': id, title: t(label) + (k ? ` (${prettyCombo(k)})` : ''), html: svg, onclick: () => setTool(id) }));
  }
  const act = $('#actions');
  const ab = (ic, title, run, id) => h('button', { class: 'tbtn', title, html: icon(ic), onclick: run, id });
  act.append(
    ab('undo', t('Undo (Ctrl+Z)'), undo, 'b-undo'), ab('redo', t('Redo (Ctrl+Y)'), redo, 'b-redo'),
    h('span', { class: 'sep' }),
    ab('copy', t('Copy image (Ctrl+C)'), copyImage),
    ab('pin', t('Pin to screen'), pinImage),
    ab('reveal', t('Show in folder'), () => fetch('/api/reveal', { method: 'POST', headers: { 'x-lumen': '1', 'content-type': 'application/json' }, body: JSON.stringify({ id: E.photo.id }) })),
    h('span', { class: 'sep' }),
    h('button', { class: 'btn', onclick: () => save('copy'), title: t('Save as a new file next to the original') }, t('Save copy')),
    h('button', { class: 'btn primary', onclick: () => save(), title: t('Save (Ctrl+S)') }, t('Save')));
  updateActions();
}
function updateActions() {
  const u = $('#b-undo'), r = $('#b-redo');
  if (u) u.disabled = E.si <= 0;
  if (r) r.disabled = E.si >= E.states.length - 1;
  status();
}

function setTool(t) {
  finishText();
  if (E.tool === 'crop' && t !== 'crop') E.crop = null;
  E.tool = t;
  if (t !== 'select') E.sel = -1;
  document.querySelectorAll('.tbtn[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  cv.style.cursor = t === 'select' ? 'default' : t === 'text' ? 'text' : 'crosshair';
  buildOptions();
  render();
}

function buildOptions() {
  const o = $('#opts');
  o.innerHTML = '';
  const kind = E.tool === 'select' && E.shapes[E.sel] ? E.shapes[E.sel].type : E.tool;
  const apply = (k, v) => { E[k] = v; const s = E.shapes[E.sel]; if (s && k in KEYMAP) { s[KEYMAP[k]] = v; record(); } render(); };
  const grp = (...kids) => h('div', { class: 'grp' }, ...kids);
  const range = (label, k, min, max) => {
    const val = h('span', { class: 'val' }, E[k]);
    const r = h('input', { type: 'range', min, max, value: E[k] });
    r.oninput = () => { val.textContent = r.value; E[k] = Number(r.value); const s = E.shapes[E.sel]; if (s) { s[KEYMAP[k]] = E[k]; render(); } };
    r.onchange = () => { if (E.shapes[E.sel]) record(); };
    return grp(h('span', { class: 'lbl' }, label), r, val);
  };
  const seg = (k, items) => {
    const el = h('div', { class: 'seg' });
    const draw = () => { el.innerHTML = ''; for (const [v, l] of items) el.append(h('button', { class: E[k] === v ? 'on' : '', onclick: () => { apply(k, v); draw(); } }, l)); };
    draw(); return el;
  };
  const check = (label, k) => {
    const c = h('input', { type: 'checkbox', checked: E[k] });
    c.onchange = () => apply(k, c.checked);
    return h('label', { class: 'chk' }, c, label);
  };
  if (kind === 'crop') {
    o.append(h('span', { class: 'hint' }, t('Drag to choose the area to keep, then press Enter or ✓. Esc cancels.')),
      h('button', { class: 'btn sm primary', onclick: applyCrop }, t('✓ Apply crop')), h('button', { class: 'btn sm', onclick: () => { E.crop = null; render(); } }, t('Reset')));
    return;
  }
  if (kind === 'select' && E.sel < 0) { o.append(h('span', { class: 'hint' }, t('Click a shape to select it. Drag to move, drag handles to resize, Delete removes it.'))); return; }
  const usesColor = !['blur', 'pixelate', 'magnify', 'spotlight', 'eraser'].includes(kind);
  if (usesColor) {
    const sw = h('div', { class: 'grp' });
    const drawSw = () => {
      sw.innerHTML = '';
      for (const c of COLORS) sw.append(h('button', { class: 'sw' + (E.color === c ? ' on' : ''), style: { background: c }, title: c, onclick: () => { apply('color', c); drawSw(); } }));
      const pick = h('input', { type: 'color', value: E.color });
      pick.oninput = () => apply('color', pick.value);
      sw.append(h('label', { class: 'sw custom' + (COLORS.includes(E.color) ? '' : ' on'), title: t('Custom color') }, pick));
    };
    drawSw();
    o.append(sw);
  }
  if (['rect', 'ellipse', 'line', 'arrow', 'pen', 'magnify'].includes(kind)) o.append(range(t('Width'), 'width', 1, 30));
  if (['rect', 'ellipse'].includes(kind)) o.append(check(t('Fill'), 'fill'));
  if (kind === 'arrow') o.append(seg('arrow', [['modern', t('Modern')], ['classic', t('Classic')], ['double', t('Double')], ['line', t('Line')]]));
  if (['text', 'balloon', 'step'].includes(kind)) o.append(range(t('Size'), 'font', 12, 120));
  if (kind === 'text') o.append(check(t('Background'), 'fill'));
  if (kind === 'step') o.append(seg('stepStyle', [['num', '1 2 3'], ['ABC', 'A B C'], ['abc', 'a b c'], ['ROM', 'I II III'], ['rom', 'i ii iii']]));
  if (['blur', 'pixelate'].includes(kind)) o.append(range(t('Strength'), 'strength', 2, 40));
  if (['rect', 'ellipse', 'line', 'arrow', 'pen', 'text', 'balloon', 'step'].includes(kind)) o.append(check(t('Shadow'), 'shadow'));
  // a selected annotation can be deleted from the bar (kind is the shape type here, not 'select')
  if (E.tool === 'select' && E.sel >= 0) o.append(h('button', { class: 'btn sm', onclick: deleteSelected }, t('Delete')));
}
const KEYMAP = { color: 'color', width: 'width', fill: 'fill', shadow: 'shadow', arrow: 'arrow', stepStyle: 'style', font: 'font', strength: 'strength' };

// ---------------- geometry helpers ----------------
const normBox = (s) => ({ x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) });
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, l = vx * vx + vy * vy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l));
  return Math.hypot(px - ax - vx * t, py - ay - vy * t);
}
function stepLabel(n, style) {
  if (style === 'ABC' || style === 'abc') { let s = ''; let k = n; while (k > 0) { k--; s = String.fromCharCode(65 + (k % 26)) + s; k = Math.floor(k / 26); } return style === 'abc' ? s.toLowerCase() : s; }
  if (style === 'ROM' || style === 'rom') {
    const map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
    let s = '', k = n; for (const [v, r] of map) while (k >= v) { s += r; k -= v; }
    return style === 'rom' ? s.toLowerCase() : s;
  }
  return String(n);
}
const contrast = (hex) => { const n = parseInt(hex.slice(1), 16); return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 > 150 ? '#111' : '#fff'; };
const fontOf = (s) => `600 ${s.font}px "Segoe UI Variable Text", "Segoe UI", sans-serif`;

// ---------------- drawing ----------------
function withShadow(c, s, fn) {
  c.save();
  if (s.shadow) { c.shadowColor = 'rgba(0,0,0,.45)'; c.shadowBlur = 6; c.shadowOffsetX = 1; c.shadowOffsetY = 2; }
  fn(); c.restore();
}

function drawArrowHead(c, x1, y1, x2, y2, s) {
  const ang = Math.atan2(y2 - y1, x2 - x1), L = 10 + s.width * 3, W = 0.5;
  const p1 = [x2 - L * Math.cos(ang - W), y2 - L * Math.sin(ang - W)];
  const p2 = [x2 - L * Math.cos(ang + W), y2 - L * Math.sin(ang + W)];
  if (s.arrow === 'line') { c.beginPath(); c.moveTo(...p1); c.lineTo(x2, y2); c.lineTo(...p2); c.stroke(); return; }
  c.beginPath(); c.moveTo(x2, y2); c.lineTo(...p1);
  if (s.arrow === 'modern') c.lineTo(x2 - L * 0.6 * Math.cos(ang), y2 - L * 0.6 * Math.sin(ang));
  c.lineTo(...p2); c.closePath(); c.fill();
}

function drawShape(c, s) {
  const color = s.color;
  c.lineCap = 'round'; c.lineJoin = 'round';
  switch (s.type) {
    case 'rect': case 'ellipse': {
      const b = normBox(s);
      withShadow(c, s, () => {
        c.strokeStyle = color; c.fillStyle = color; c.lineWidth = s.width;
        c.beginPath();
        if (s.type === 'rect') c.roundRect(b.x, b.y, b.w, b.h, Math.min(4, b.w / 2, b.h / 2)); else c.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
        s.fill ? c.fill() : c.stroke();
      });
      break;
    }
    case 'line': case 'arrow': {
      withShadow(c, s, () => {
        c.strokeStyle = color; c.fillStyle = color; c.lineWidth = s.width;
        const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1), L = (10 + s.width * 3) * (s.arrow === 'line' ? 0 : 0.55);
        const ex = s.type === 'arrow' ? s.x2 - L * Math.cos(ang) : s.x2, ey = s.type === 'arrow' ? s.y2 - L * Math.sin(ang) : s.y2;
        const sx = s.type === 'arrow' && s.arrow === 'double' ? s.x1 + L * Math.cos(ang) : s.x1, sy = s.type === 'arrow' && s.arrow === 'double' ? s.y1 + L * Math.sin(ang) : s.y1;
        c.beginPath(); c.moveTo(sx, sy); c.lineTo(ex, ey); c.stroke();
        if (s.type === 'arrow') { drawArrowHead(c, s.x1, s.y1, s.x2, s.y2, s); if (s.arrow === 'double') drawArrowHead(c, s.x2, s.y2, s.x1, s.y1, s); }
      });
      break;
    }
    case 'pen': {
      withShadow(c, s, () => {
        c.strokeStyle = color; c.lineWidth = s.width;
        const p = s.pts; c.beginPath(); c.moveTo(p[0][0], p[0][1]);
        for (let i = 1; i < p.length - 1; i++) c.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
        const l = p[p.length - 1]; c.lineTo(l[0], l[1]); c.stroke();
      });
      break;
    }
    case 'text': {
      c.font = fontOf(s); c.textBaseline = 'top';
      const lines = (s.text || '').split('\n');
      const lh = s.font * 1.2, w = Math.max(...lines.map((l) => c.measureText(l).width), 4), hh = lines.length * lh;
      s.bw = w; s.bh = hh;
      withShadow(c, s, () => {
        if (s.fill) { c.fillStyle = color; c.beginPath(); c.roundRect(s.x - s.font * 0.3, s.y - s.font * 0.2, w + s.font * 0.6, hh + s.font * 0.4, s.font * 0.25); c.fill(); }
        c.fillStyle = s.fill ? contrast(color) : color;
        lines.forEach((l, i) => c.fillText(l, s.x, s.y + i * lh));
      });
      break;
    }
    case 'balloon': {
      const b = normBox(s), r = Math.min(18, b.w / 4, b.h / 4);
      withShadow(c, s, () => {
        c.fillStyle = color;
        c.beginPath(); c.roundRect(b.x, b.y, b.w, b.h, r); c.fill();
        // tail toward (tx, ty)
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2, tw = Math.min(b.w, b.h) * 0.18;
        const ang = Math.atan2(s.ty - cy, s.tx - cx) + Math.PI / 2;
        c.beginPath(); c.moveTo(cx + Math.cos(ang) * tw, cy + Math.sin(ang) * tw); c.lineTo(s.tx, s.ty); c.lineTo(cx - Math.cos(ang) * tw, cy - Math.sin(ang) * tw); c.fill();
      });
      if (s.text) {
        c.save(); c.beginPath(); c.rect(b.x, b.y, b.w, b.h); c.clip();
        c.font = fontOf(s); c.fillStyle = contrast(color); c.textBaseline = 'middle'; c.textAlign = 'center';
        const lines = s.text.split('\n'), lh = s.font * 1.2;
        lines.forEach((l, i) => c.fillText(l, b.x + b.w / 2, b.y + b.h / 2 + (i - (lines.length - 1) / 2) * lh));
        c.restore();
      }
      break;
    }
    case 'step': {
      const r = s.font * 0.62;
      withShadow(c, s, () => { c.fillStyle = color; c.beginPath(); c.arc(s.x, s.y, r, 0, Math.PI * 2); c.fill(); });
      c.font = `700 ${s.font * 0.62}px "Segoe UI", sans-serif`; c.fillStyle = contrast(color); c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(stepLabel(s.n, s.style), s.x, s.y + 1);
      c.textAlign = 'start';
      break;
    }
    case 'highlight': {
      const b = normBox(s);
      c.save(); c.globalCompositeOperation = 'multiply'; c.fillStyle = color; c.fillRect(b.x, b.y, b.w, b.h); c.restore();
      break;
    }
    case 'blur': case 'pixelate': {
      const b = normBox(s); if (b.w < 1 || b.h < 1) break;
      c.save(); c.beginPath(); c.rect(b.x, b.y, b.w, b.h); c.clip();
      if (s.type === 'blur') {
        const pad = s.strength * 3;
        c.filter = `blur(${s.strength}px)`;
        c.drawImage(E.base, b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2, b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
      } else {
        const k = Math.max(2, s.strength), tw = Math.max(1, Math.round(b.w / k)), th = Math.max(1, Math.round(b.h / k));
        const t = document.createElement('canvas'); t.width = tw; t.height = th;
        t.getContext('2d').drawImage(E.base, b.x, b.y, b.w, b.h, 0, 0, tw, th);
        c.imageSmoothingEnabled = false; c.drawImage(t, 0, 0, tw, th, b.x, b.y, b.w, b.h);
      }
      c.restore();
      break;
    }
    case 'magnify': {
      const b = normBox(s); if (b.w < 2 || b.h < 2) break;
      const z = 2, sw = b.w / z, sh = b.h / z;
      c.save(); c.beginPath(); c.roundRect(b.x, b.y, b.w, b.h, 8); c.clip();
      c.imageSmoothingEnabled = false;
      c.drawImage(E.base, b.x + b.w / 2 - sw / 2, b.y + b.h / 2 - sh / 2, sw, sh, b.x, b.y, b.w, b.h);
      c.restore();
      c.strokeStyle = '#fff'; c.lineWidth = Math.max(2, s.width / 2); c.beginPath(); c.roundRect(b.x, b.y, b.w, b.h, 8); c.stroke();
      break;
    }
    case 'spotlight': {
      const b = normBox(s);
      c.save(); c.fillStyle = 'rgba(0,0,0,.6)';
      c.beginPath(); c.rect(0, 0, E.base.width, E.base.height);
      c.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
      c.fill('evenodd'); c.restore();
      break;
    }
    case 'eraser': {
      const b = normBox(s);
      c.fillStyle = s.fillColor || '#fff'; c.fillRect(b.x, b.y, b.w, b.h);
      break;
    }
  }
}

function hitTest(x, y) {
  const tol = 8 / E.zoom;
  for (let i = E.shapes.length - 1; i >= 0; i--) {
    const s = E.shapes[i];
    if (s.type === 'line' || s.type === 'arrow') { if (segDist(x, y, s.x1, s.y1, s.x2, s.y2) < s.width / 2 + tol) return i; }
    else if (s.type === 'pen') { for (let k = 1; k < s.pts.length; k++) if (segDist(x, y, ...s.pts[k - 1], ...s.pts[k]) < s.width / 2 + tol) return i; }
    else if (s.type === 'text') { if (x >= s.x - tol && y >= s.y - tol && x <= s.x + (s.bw || 20) + tol && y <= s.y + (s.bh || 20) + tol) return i; }
    else if (s.type === 'step') { if (Math.hypot(x - s.x, y - s.y) < s.font * 0.62 + tol) return i; }
    else if (BOX.has(s.type)) {
      const b = normBox(s);
      if (s.type === 'spotlight' ? Math.hypot((x - b.x - b.w / 2) / (b.w / 2 || 1), (y - b.y - b.h / 2) / (b.h / 2 || 1)) <= 1.05
        : x >= b.x - tol && y >= b.y - tol && x <= b.x + b.w + tol && y <= b.y + b.h + tol) return i;
    }
  }
  return -1;
}

function handlesOf(s) {
  if (!s) return [];
  if (s.type === 'line' || s.type === 'arrow') return [['p1', s.x1, s.y1], ['p2', s.x2, s.y2]];
  if (BOX.has(s.type)) {
    const out = [['nw', Math.min(s.x1, s.x2), Math.min(s.y1, s.y2)], ['ne', Math.max(s.x1, s.x2), Math.min(s.y1, s.y2)],
      ['sw', Math.min(s.x1, s.x2), Math.max(s.y1, s.y2)], ['se', Math.max(s.x1, s.x2), Math.max(s.y1, s.y2)]];
    if (s.type === 'balloon') out.push(['tail', s.tx, s.ty]);
    return out;
  }
  return [];
}

function render() {
  if (!E.base) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(E.base, 0, 0);
  for (let i = 0; i < E.shapes.length; i++) if (!(E.editing && E.editing.index === i)) drawShape(ctx, E.shapes[i]);
  // selection outline + handles (screen-size independent)
  const s = E.shapes[E.sel];
  if (s && E.tool === 'select') {
    const hs = 7 / E.zoom;
    ctx.save(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1 / E.zoom; ctx.setLineDash([4 / E.zoom, 3 / E.zoom]);
    const bb = bbox(s); ctx.strokeRect(bb.x - 4 / E.zoom, bb.y - 4 / E.zoom, bb.w + 8 / E.zoom, bb.h + 8 / E.zoom);
    ctx.setLineDash([]);
    for (const [, hx, hy] of handlesOf(s)) { ctx.fillStyle = '#fff'; ctx.strokeStyle = '#5b6bff'; ctx.lineWidth = 2 / E.zoom; ctx.beginPath(); ctx.rect(hx - hs / 2, hy - hs / 2, hs, hs); ctx.fill(); ctx.stroke(); }
    ctx.restore();
  }
  if (E.tool === 'crop' && E.crop) {
    const b = normBox(E.crop);
    ctx.save(); ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.beginPath(); ctx.rect(0, 0, cv.width, cv.height); ctx.rect(b.x, b.y, b.w, b.h); ctx.fill('evenodd');
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 / E.zoom; ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.restore();
  }
  status();
}

function bbox(s) {
  if (s.type === 'line' || s.type === 'arrow') return { x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
  if (s.type === 'pen') { const xs = s.pts.map((p) => p[0]), ys = s.pts.map((p) => p[1]); return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }; }
  if (s.type === 'text') return { x: s.x, y: s.y, w: s.bw || 20, h: s.bh || 20 };
  if (s.type === 'step') { const r = s.font * 0.62; return { x: s.x - r, y: s.y - r, w: r * 2, h: r * 2 }; }
  return normBox(s);
}

// ---------------- pointer interaction ----------------
const pos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / E.zoom, (e.clientY - r.top) / E.zoom]; };

function newShape(type, x, y) {
  const s = { type, color: E.color, width: E.width, fill: E.fill, shadow: E.shadow, font: E.font, strength: E.strength, arrow: E.arrow, style: E.stepStyle };
  if (type === 'highlight') s.color = E.color === '#ff3b5c' ? '#ffd23f' : E.color;
  if (BOX.has(type) || type === 'line' || type === 'arrow') Object.assign(s, { x1: x, y1: y, x2: x, y2: y });
  if (type === 'pen') s.pts = [[x, y]];
  if (type === 'balloon') { s.tx = x - 10; s.ty = y + 60; s.text = ''; }
  if (type === 'eraser') { const d = E.base.getContext('2d').getImageData(Math.max(0, Math.round(x) - 1), Math.max(0, Math.round(y) - 1), 1, 1).data; s.fillColor = `rgb(${d[0]},${d[1]},${d[2]})`; }
  return s;
}

cv.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  finishText();
  cv.setPointerCapture(e.pointerId);
  const [x, y] = pos(e);
  const tool = E.tool;
  if (tool === 'crop') { E.crop = { x1: x, y1: y, x2: x, y2: y }; E.drag = { mode: 'crop' }; return; }
  if (tool === 'select') {
    const s = E.shapes[E.sel];
    const hs = 9 / E.zoom;
    const hnd = handlesOf(s).find(([, hx, hy]) => Math.abs(x - hx) < hs && Math.abs(y - hy) < hs);
    if (hnd) { E.drag = { mode: 'handle', h: hnd[0], moved: false }; return; }
    E.sel = hitTest(x, y);
    buildOptions();
    if (E.sel >= 0) E.drag = { mode: 'move', x, y, orig: JSON.stringify(E.shapes[E.sel]), moved: false };
    render(); return;
  }
  if (tool === 'text') {
    const hit = hitTest(x, y);
    if (hit >= 0 && E.shapes[hit].type === 'text') return editText(hit);
    E.shapes.push({ ...newShape('text', x, y), x, y, text: '' });
    return editText(E.shapes.length - 1, true);
  }
  if (tool === 'step') {
    const n = E.shapes.filter((s) => s.type === 'step').length + 1;
    E.shapes.push({ ...newShape('step', x, y), x, y, n });
    record(); render(); return;
  }
  const s = newShape(tool, x, y);
  E.shapes.push(s);
  E.drag = { mode: 'draw', s, sx: x, sy: y };
  render();
});

cv.addEventListener('pointermove', (e) => {
  if (!E.drag) {
    if (E.tool === 'select') cv.style.cursor = hitTest(...pos(e)) >= 0 ? 'move' : 'default';
    return;
  }
  let [x, y] = pos(e);
  x = Math.max(0, Math.min(E.base.width, x)); y = Math.max(0, Math.min(E.base.height, y));
  const d = E.drag;
  if (d.mode === 'crop') { E.crop.x2 = x; E.crop.y2 = y; render(); return; }
  if (d.mode === 'draw') {
    const s = d.s;
    if (s.type === 'pen') s.pts.push([x, y]);
    else {
      if (e.shiftKey && (s.type === 'line' || s.type === 'arrow')) { // snap to 45°
        const a = Math.round(Math.atan2(y - s.y1, x - s.x1) / (Math.PI / 4)) * (Math.PI / 4), l = Math.hypot(x - s.x1, y - s.y1);
        x = s.x1 + l * Math.cos(a); y = s.y1 + l * Math.sin(a);
      } else if (e.shiftKey) { const m = Math.max(Math.abs(x - s.x1), Math.abs(y - s.y1)); x = s.x1 + Math.sign(x - s.x1 || 1) * m; y = s.y1 + Math.sign(y - s.y1 || 1) * m; }
      s.x2 = x; s.y2 = y;
      if (s.type === 'balloon') { s.tx = Math.min(s.x1, s.x2) + 20; s.ty = Math.max(s.y1, s.y2) + 40; }
    }
    render(); return;
  }
  const s = E.shapes[E.sel];
  if (!s) return;
  if (d.mode === 'move') {
    const o = JSON.parse(d.orig), dx = x - d.x, dy = y - d.y;
    d.moved = true;
    for (const k of ['x', 'x1', 'x2', 'tx']) if (k in o) s[k] = o[k] + dx;
    for (const k of ['y', 'y1', 'y2', 'ty']) if (k in o) s[k] = o[k] + dy;
    if (o.pts) s.pts = o.pts.map(([px, py]) => [px + dx, py + dy]);
  } else if (d.mode === 'handle') {
    d.moved = true;
    if (d.h === 'p1') { s.x1 = x; s.y1 = y; } else if (d.h === 'p2') { s.x2 = x; s.y2 = y; } else if (d.h === 'tail') { s.tx = x; s.ty = y; }
    else {
      const b = normBox(s);
      let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
      if (d.h.includes('w')) x0 = x; if (d.h.includes('e')) x1 = x; if (d.h.includes('n')) y0 = y; if (d.h.includes('s')) y1 = y;
      Object.assign(s, { x1: x0, y1: y0, x2: x1, y2: y1 });
    }
  }
  render();
});

cv.addEventListener('pointerup', () => {
  const d = E.drag; E.drag = null;
  if (!d) return;
  if (d.mode === 'crop') { const b = normBox(E.crop); if (b.w < 4 || b.h < 4) E.crop = null; render(); return; }
  if (d.mode === 'draw') {
    const s = d.s, b = s.type === 'pen' ? null : normBox(s);
    const tiny = s.type === 'pen' ? s.pts.length < 2 : (s.type === 'line' || s.type === 'arrow') ? Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < 4 : b.w < 4 || b.h < 4;
    if (tiny) { E.shapes.pop(); render(); return; }
    record();
    if (s.type === 'balloon') return editText(E.shapes.length - 1, true);
    render(); return;
  }
  if (d.moved) record();
});

cv.addEventListener('dblclick', (e) => {
  const i = hitTest(...pos(e));
  if (i >= 0 && ['text', 'balloon'].includes(E.shapes[i].type)) editText(i);
});

// ---------------- text editing ----------------
function editText(index, isNew = false) {
  finishText();
  const s = E.shapes[index];
  const ta = h('textarea', { class: 'ed-text', spellcheck: 'false' });
  ta.value = s.text || '';
  const z = E.zoom;
  if (s.type === 'balloon') {
    const b = normBox(s);
    Object.assign(ta.style, { left: b.x * z + 'px', top: b.y * z + 'px', width: b.w * z + 'px', height: b.h * z + 'px', textAlign: 'center', paddingTop: Math.max(0, (b.h * z - s.font * 1.2 * z) / 2) + 'px' });
  } else Object.assign(ta.style, { left: s.x * z + 'px', top: s.y * z + 'px', minWidth: '60px' });
  Object.assign(ta.style, { fontSize: s.font * z + 'px', color: s.type === 'balloon' || s.fill ? contrast(s.color) : s.color });
  const autosize = () => { if (s.type !== 'balloon') { ta.style.width = '0'; ta.style.height = '0'; ta.style.width = ta.scrollWidth + 12 + 'px'; ta.style.height = ta.scrollHeight + 'px'; } };
  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finishText(); }
    if (e.key === 'Escape') { finishText(); }
  });
  ta.addEventListener('blur', () => setTimeout(finishText, 0));
  $('#wrap').append(ta);
  E.editing = { index, ta, isNew };
  render();
  autosize();
  ta.focus();
}
function finishText() {
  const ed = E.editing;
  if (!ed) return;
  E.editing = null;
  const s = E.shapes[ed.index];
  if (s) {
    s.text = ed.ta.value;
    if (s.type === 'text' && !s.text.trim()) E.shapes.splice(ed.index, 1);
    else record();
  }
  ed.ta.remove();
  render();
}

function deleteSelected() {
  if (E.sel < 0) return;
  E.shapes.splice(E.sel, 1); E.sel = -1;
  record(); buildOptions(); render();
}

// ---------------- crop ----------------
function applyCrop() {
  if (!E.crop) return;
  const b = normBox(E.crop);
  const x = Math.round(b.x), y = Math.round(b.y), w = Math.round(b.w), hh = Math.round(b.h);
  if (w < 2 || hh < 2) return;
  // bake effect shapes that sample the base? keep them live: shift everything instead
  const nb = document.createElement('canvas'); nb.width = w; nb.height = hh;
  nb.getContext('2d').drawImage(E.base, x, y, w, hh, 0, 0, w, hh);
  E.base = nb;
  for (const s of E.shapes) {
    for (const k of ['x', 'x1', 'x2', 'tx']) if (k in s) s[k] -= x;
    for (const k of ['y', 'y1', 'y2', 'ty']) if (k in s) s[k] -= y;
    if (s.pts) s.pts = s.pts.map(([px, py]) => [px - x, py - y]);
  }
  E.crop = null;
  record(); sizeCanvas(); fit(); setTool('select');
}

// ---------------- zoom ----------------
function sizeCanvas() {
  cv.width = E.base.width; cv.height = E.base.height;
  cv.style.width = E.base.width * E.zoom + 'px'; cv.style.height = E.base.height * E.zoom + 'px';
}
function setZoom(z) { finishText(); E.zoom = Math.max(0.05, Math.min(8, z)); sizeCanvas(); render(); }
function fit() {
  const st = $('#stage').getBoundingClientRect();
  setZoom(Math.min(1, (st.width - 64) / E.base.width, (st.height - 64) / E.base.height));
}
$('#stage').addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); setZoom(E.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)); } }, { passive: false });
window.addEventListener('resize', () => { if (E.fitted) fit(); });

function status() {
  const st = $('#status');
  if (!E.base) return;
  st.innerHTML = '';
  const zb = (label, run, title) => h('button', { class: 'tbtn', title, onclick: run }, label);
  st.append(h('span', {}, `${E.base.width} × ${E.base.height}`), h('span', {}, t('{n} annotations', { n: E.shapes.length })),
    h('span', { class: 'grow' }), dirty() ? h('span', {}, t('Unsaved changes')) : h('span', {}, t('Saved')),
    zb('−', () => setZoom(E.zoom / 1.25), t('Zoom out')), h('span', {}, Math.round(E.zoom * 100) + '%'), zb('+', () => setZoom(E.zoom * 1.25), t('Zoom in')),
    zb(t('Fit'), () => { E.fitted = true; fit(); }, t('Fit to window (0)')), zb('1:1', () => { E.fitted = false; setZoom(1); }, t('Actual size (1)')));
}

// ---------------- output ----------------
function flatten() {
  const out = document.createElement('canvas');
  out.width = E.base.width; out.height = E.base.height;
  const c = out.getContext('2d');
  c.drawImage(E.base, 0, 0);
  for (const s of E.shapes) drawShape(c, s);
  return out;
}
const toBlob = (c) => new Promise((r) => c.toBlob(r, 'image/png'));

async function copyImage() {
  finishText();
  const blob = await toBlob(flatten());
  try {
    if (native?.copyImage) await native.copyImage(await blob.arrayBuffer());
    else await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Image copied to clipboard');
  } catch { toast('Could not copy the image'); }
}

async function pinImage() {
  finishText();
  if (!native?.pinImage) return toast('Pin to screen works in the Captura app');
  native.pinImage(await (await toBlob(flatten())).arrayBuffer());
}

async function save(mode) {
  finishText();
  const canOverwrite = E.photo.captured && E.photo.ext === '.png';
  const m = mode || (canOverwrite ? 'overwrite' : 'copy');
  const blob = await toBlob(flatten());
  const r = await fetch(`/api/annotate-save?id=${E.photo.id}&mode=${m}`, { method: 'POST', headers: { 'x-lumen': '1' }, body: blob });
  const res = await r.json().catch(() => ({}));
  if (!r.ok) return toast(res.error || t('Save failed'));
  E.saved = E.si; status();
  native?.win?.('refresh-library');
  if (!res.overwritten && res.photo) {
    // later saves go to the new copy
    E.photo = res.photo;
    history.replaceState(null, '', `?id=${res.photo.id}`);
    document.title = res.photo.name + ' — Captura Editor';
  }
  toast(res.overwritten ? t('Saved') : t('Saved as {name}', { name: res.path.split(/[\\/]/).pop() }));
}

if (native?.on) {
  // the native window asks before closing; unsaved annotations get a choice
  native.on('close-request', () => {
    finishText();
    if (!dirty()) return native.win('close-force');
    modal({ title: t('Discard changes?'), body: h('p', {}, t('Your edits to this photo have not been saved.')),
      actions: [{ label: t('Keep editing') }, { label: t('Discard'), danger: true, run: () => native.win('close-force') },
        { label: t('Save'), primary: true, run: async () => { await save(); if (!dirty()) native.win('close-force'); } }] });
  });
} else {
  window.addEventListener('beforeunload', (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });
}

// ---------------- keyboard ----------------
document.addEventListener('keydown', (e) => {
  if (E.editing || $('#modal').classList.contains('show')) return;
  const k = e.key;
  const run = (fn) => { e.preventDefault(); fn(); };
  if (k === 'Escape') { if (E.tool === 'crop' && E.crop) { E.crop = null; render(); } else { E.sel = -1; buildOptions(); render(); } return; }
  if (k === 'Enter' && E.tool === 'crop') return run(applyCrop);
  if (isKey(e, 'sx.redo')) return run(redo);
  if (isKey(e, 'sx.undo')) return run(undo);
  if (isKey(e, 'sx.copy')) return run(copyImage);
  if (isKey(e, 'sx.saveCopy')) return run(() => save('copy'));
  if (isKey(e, 'sx.save')) return run(() => save());
  if (isKey(e, 'sx.delete')) return run(deleteSelected);
  if (isKey(e, 'sx.fit')) return run(() => { E.fitted = true; fit(); });
  if (isKey(e, 'sx.actual')) return run(() => { E.fitted = false; setZoom(1); });
  if (k === '+' || k === '=') return run(() => setZoom(E.zoom * 1.25));
  if (k === '-') return run(() => setZoom(E.zoom / 1.25));
  const tool = TOOLS.find((x) => x !== '|' && isKey(e, 'sx.' + x[0]));
  if (tool) run(() => setTool(tool[0]));
});
