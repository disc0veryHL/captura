// Full-screen viewer with info panel, zoom, filmstrip and the non-destructive editor.
import {
  state, api, patchPhotos, loadBitmap, originalUrl, thumbUrl, $, h, icon, toast, modal, fmtBytes, fmtDate, fmtExposure,
} from './store.js';
import {
  normalizeEdits, isIdentity, renderEdited, downscale, computeAuto, renderGeometry, histogram, FILTERS, frameSize, emptyEdits,
} from './pipeline.js';
import { startSlideshow, exportDialog } from './tools.js';
import { openPhotoViewer } from './photoviewer.js';
import { isKey, keysFor, comboOf } from './keys.js';
import { t } from './i18n.js';

const V = { list: [], i: 0, panel: null, zoomed: false, ed: null, token: 0 };
const root = $('#viewer');

const cur = () => V.list[V.i];

export function openViewer(list, index = 0, { edit = false } = {}) {
  if (!list.length) return;
  if (!edit) { openPhotoViewer(list, index); return; } // fast Picasa-style viewer
  V.closeAfterEdit = true; // editor opened on its own: return to where the user came from
  V.list = list; V.i = Math.max(0, Math.min(index, list.length - 1));
  V.panel = V.panel === 'edit' ? null : V.panel; V.zoomed = false; V.ed = null;
  root.classList.add('show');
  build();
  show();
  if (edit) enterEdit();
}

function close() {
  if (V.ed && V.ed.dirty()) return confirmDiscard(() => { V.ed = null; close(); });
  root.classList.remove('show');
  root.innerHTML = '';
  V.ed = null;
  V.token++;
}

// ---------------- layout ----------------
let els = {};
function build() {
  root.innerHTML = '';
  const ib = (ic, title, run, id) => h('button', { class: 'icon-btn', title, html: icon(ic), onclick: run, id });
  els.stage = h('div', { class: 'v-stage' });
  els.name = h('div', { class: 'name' });
  els.star = ib('star', t('Favorite (S)'), () => toggleStar());
  els.top = h('div', { class: 'v-top' },
    ib('left', t('Back (Esc)'), close), els.name,
    els.star,
    ib('rotateR', t('Rotate (R)'), () => quickRotate(1)),
    ib('edit', t('Edit (E)'), () => (V.ed ? exitEdit() : enterEdit())),
    ib('play', t('Slideshow from here (Space)'), () => { const l = V.list, i = V.i; close(); startSlideshow(l, i); }),
    ib('export', t('Export'), () => exportDialog([cur()])),
    ib('reveal', t('Show in Explorer'), () => api.reveal(cur().id)),
    ib('info', t('Info (I)'), () => togglePanel('info')),
    ib('fullscreen', t('Full screen (F)'), () => (document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen())));
  els.prev = h('button', { class: 'v-nav prev', html: icon('left'), title: t('Previous (←)'), onclick: () => go(-1) });
  els.next = h('button', { class: 'v-nav next', html: icon('right'), title: t('Next (→)'), onclick: () => go(1) });
  els.film = h('div', { class: 'filmstrip' });
  els.panel = h('div', { class: 'v-panel' });
  els.zoomPill = h('div', { class: 'zoom-pill' });
  els.beforeTag = h('div', { class: 'before-tag' }, t('Original'));
  root.append(els.stage, els.top, els.prev, els.next, els.film, els.panel, els.zoomPill, els.beforeTag);
  els.stage.addEventListener('click', onStageClick);
  enableDragPan(els.stage);
}

function setPanelLayout() {
  const on = !!V.panel;
  for (const el of [els.stage, els.top, els.film, els.next]) el.classList.toggle('with-panel', on);
  els.panel.classList.toggle('show', on);
  els.panel.classList.toggle('ed-panel', V.panel === 'edit');
}

function togglePanel(kind) {
  if (V.ed) return;
  V.panel = V.panel === kind ? null : kind;
  setPanelLayout();
  if (V.panel === 'info') renderInfo();
  show(true);
}

function go(d) {
  if (V.ed) return;
  const n = V.i + d;
  if (n < 0 || n >= V.list.length) return;
  V.i = n; V.zoomed = false;
  show();
}

// ---------------- display ----------------
async function show(keepImage = false) {
  const p = cur();
  const token = ++V.token;
  els.name.innerHTML = '';
  els.name.append(p.caption || p.name, h('small', {}, `${V.i + 1} / ${V.list.length} · ${fmtDate(p.ts, { dateStyle: 'medium', timeStyle: 'short' })}`));
  els.star.classList.toggle('star-on', p.star);
  els.prev.style.visibility = V.i > 0 && !V.ed ? '' : 'hidden';
  els.next.style.visibility = V.i < V.list.length - 1 && !V.ed ? '' : 'hidden';
  setPanelLayout();
  renderFilm();
  if (V.panel === 'info') renderInfo();
  if (V.ed) return;
  els.stage.classList.toggle('zoomed', V.zoomed);
  if (keepImage && els.stage.firstChild) return;

  // low-res first, then full quality
  els.stage.innerHTML = '';
  if (p.thumb) {
    const t = h('img', { src: thumbUrl(p), alt: '' });
    t.style.width = '100%'; t.style.height = '100%'; t.style.filter = 'blur(6px)';
    els.stage.append(t);
  }
  let el;
  if (isIdentity(p.edits)) {
    el = h('img', { alt: p.name, src: originalUrl(p) });
    try { await el.decode(); } catch { if (token === V.token) els.stage.innerHTML = '<div class="empty">This file cannot be displayed.</div>'; return; }
  } else {
    try {
      const bm = await loadBitmap(p);
      const max = Math.max(innerWidth, innerHeight) * devicePixelRatio;
      el = renderEdited(bm, normalizeEdits(p.edits), V.zoomed ? 8000 : Math.min(4096, max));
    } catch { if (token === V.token) els.stage.innerHTML = '<div class="empty">This file cannot be displayed.</div>'; return; }
  }
  if (token !== V.token) return;
  els.stage.innerHTML = '';
  els.stage.append(el);
  preloadNeighbors();
}

function preloadNeighbors() {
  for (const d of [1, -1]) {
    const q = V.list[V.i + d];
    if (q && isIdentity(q.edits)) { const im = new Image(); im.src = originalUrl(q); }
  }
}

function renderFilm() {
  const f = els.film;
  f.innerHTML = '';
  const lo = Math.max(0, V.i - 40), hi = Math.min(V.list.length, V.i + 41);
  for (let i = lo; i < hi; i++) {
    const p = V.list[i];
    const img = h('img', { alt: '', loading: 'lazy' });
    if (p.thumb) img.src = thumbUrl(p);
    const d = h('div', { class: 'fs' + (i === V.i ? ' cur' : ''), title: p.name, onclick: () => { if (!V.ed) { V.i = i; V.zoomed = false; show(); } } }, img);
    f.append(d);
  }
  const c = f.querySelector('.cur');
  if (c) c.scrollIntoView({ inline: 'center', block: 'nearest' });
}

function onStageClick(e) {
  if (V.ed || V.dragged) return;
  const el = els.stage.querySelector('img:last-child, canvas');
  if (!el || e.target !== el) return;
  const rect = el.getBoundingClientRect();
  const fx = (e.clientX - rect.left) / rect.width, fy = (e.clientY - rect.top) / rect.height;
  V.zoomed = !V.zoomed;
  els.stage.classList.toggle('zoomed', V.zoomed);
  const pill = els.zoomPill;
  pill.textContent = V.zoomed ? '100%' : t('Fit');
  pill.classList.add('show'); setTimeout(() => pill.classList.remove('show'), 900);
  if (V.zoomed) {
    if (el.tagName === 'CANVAS' && !isIdentity(cur().edits)) { show(); return; }
    requestAnimationFrame(() => {
      const w = el.naturalWidth || el.width, hh = el.naturalHeight || el.height;
      els.stage.style.overflow = 'auto';
      els.stage.scrollLeft = fx * w - els.stage.clientWidth / 2;
      els.stage.scrollTop = fy * hh - els.stage.clientHeight / 2;
    });
  } else els.stage.style.overflow = '';
}

function enableDragPan(stage) {
  let sx, sy, sl, st, down = false;
  stage.addEventListener('mousedown', (e) => {
    V.dragged = false;
    if (!V.zoomed || V.ed) return;
    down = true; sx = e.clientX; sy = e.clientY; sl = stage.scrollLeft; st = stage.scrollTop;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!down) return;
    if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 4) V.dragged = true;
    stage.scrollLeft = sl - (e.clientX - sx); stage.scrollTop = st - (e.clientY - sy);
  });
  window.addEventListener('mouseup', () => { down = false; setTimeout(() => (V.dragged = false), 0); });
}

async function toggleStar() {
  const p = cur();
  await patchPhotos([p.id], { star: !p.star });
  els.star.classList.toggle('star-on', p.star);
}

async function quickRotate(dir) {
  if (V.ed) { V.ed.rotate(dir); return; }
  const p = cur();
  const e = normalizeEdits(p.edits);
  e.rot = (e.rot + dir + 4) % 4;
  if (e.crop) { const c = e.crop; e.crop = dir > 0 ? { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w }; }
  await patchPhotos([p.id], { edits: isIdentity(e) ? null : e });
  show();
}

// ---------------- info panel ----------------
function renderInfo() {
  const p = cur();
  const P = els.panel;
  P.innerHTML = '';
  const kv = (ic, main, sub) => h('div', { class: 'kv', html: icon(ic) }, h('div', {}, h('b', {}, main), sub ? h('span', {}, sub) : null));
  const caption = h('textarea', { class: 'input', placeholder: t('Add a caption…'), rows: 2 });
  caption.value = p.caption;
  caption.addEventListener('change', () => patchPhotos([p.id], { caption: caption.value }));
  caption.addEventListener('keydown', (e) => e.stopPropagation());
  P.append(h('h3', {}, t('Info')), caption);

  P.append(kv('memories', fmtDate(p.ts, { dateStyle: 'full' }), fmtDate(p.ts, { timeStyle: 'short' }) + (p.dated ? '' : ' · ' + t('from file date'))));
  const mp = p.w && p.h ? ((p.w * p.h) / 1e6).toFixed(1) + ' MP' : '';
  P.append(kv('photos', p.name, [mp, p.w && p.h ? `${p.w} × ${p.h}` : '', fmtBytes(p.size)].filter(Boolean).join(' · ')));
  if (p.camera || p.lens) {
    const ex = [p.fnumber && 'ƒ/' + Number(p.fnumber).toFixed(1).replace(/\.0$/, ''), fmtExposure(p.exposure), p.focal && Math.round(p.focal) + ' mm', p.iso && t('ISO ') + p.iso].filter(Boolean).join(' · ');
    P.append(kv('zoom', p.camera || t('Camera'), [p.lens, ex].filter(Boolean).join(' — ')));
  }
  if (p.gps && !window.LUMEN_STANDALONE) {
    const loc = kv('map', `${p.gps.lat.toFixed(5)}, ${p.gps.lon.toFixed(5)}`, '');
    loc.querySelector('span')?.remove();
    loc.lastChild.append(h('button', { class: 'link', style: { padding: 0 }, onclick: async () => {
      const { setView } = await import('./app.js'); close(); setView({ kind: 'map', focus: p.id });
    } }, t('Show on map')));
    P.append(loc);
  }
  const folderKv = kv('folder', p.folder.split(/[\\/]/).pop(), p.folder);
  folderKv.lastChild.append(h('div', {}, h('button', { class: 'link', style: { padding: 0 }, onclick: () => api.reveal(p.id) }, t('Show in Explorer'))));
  P.append(folderKv);

  // tags
  const tagIn = h('input', { class: 'input', placeholder: t('Add tag and press Enter') });
  tagIn.addEventListener('keydown', async (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && tagIn.value.trim()) { await patchPhotos([p.id], { addTag: tagIn.value.trim() }); renderInfo(); }
  });
  P.append(h('div', { class: 'ed-group' }, t('Tags')), tagIn,
    h('div', { class: 'chips' }, p.tags.map((t) => h('span', { class: 'chip' }, t,
      h('button', { title: t('Remove'), onclick: async () => { await patchPhotos([p.id], { tags: p.tags.filter((x) => x !== t) }); renderInfo(); } }, '×')))));

  // albums
  const sel = h('select', { class: 'select', style: { width: '100%' } }, h('option', { value: '' }, t('Add to album…')),
    state.albums.filter((a) => !p.albums.includes(a.id)).map((a) => h('option', { value: a.id }, a.name)));
  sel.addEventListener('change', async () => { if (sel.value) { await patchPhotos([p.id], { addAlbum: sel.value }); renderInfo(); } });
  P.append(h('div', { class: 'ed-group' }, t('Albums')), sel,
    h('div', { class: 'chips' }, p.albums.map((id) => state.albums.find((a) => a.id === id)).filter(Boolean).map((a) => h('span', { class: 'chip' }, a.name,
      h('button', { title: t('Remove from album'), onclick: async () => { await patchPhotos([p.id], { removeAlbum: a.id }); renderInfo(); } }, '×')))));

  if (!isIdentity(p.edits)) {
    P.append(h('div', { class: 'ed-group' }, t('Edits')),
      h('div', { style: { display: 'flex', gap: '8px' } },
        h('button', { class: 'btn sm', html: icon('copy') + t('Copy edits'), onclick: () => { state.editClipboard = p.edits; toast('Edits copied — paste on other photos with Ctrl+V'); } }),
        h('button', { class: 'btn sm', html: icon('undo') + t('Revert'), onclick: async () => { await patchPhotos([p.id], { edits: null }); show(); } })));
  }
}

// ---------------- editor ----------------
const SLIDERS = [
  [t('Light'), [['exposure', t('Exposure')], ['contrast', t('Contrast')], ['highlights', t('Highlights')], ['shadows', t('Shadows')], ['whites', t('Whites')], ['blacks', t('Blacks')], ['fill', t('Fill light'), 0, 100]]],
  [t('Color'), [['temp', t('Temperature'), -100, 100, 'temp'], ['tint', t('Tint'), -100, 100, 'tint'], ['vibrance', t('Vibrance')], ['saturation', t('Saturation'), -100, 100, 'sat']]],
  [t('Effects'), [['clarity', t('Clarity')], ['sharpen', t('Sharpen'), 0, 100], ['vignette', t('Vignette')], ['grain', t('Grain'), 0, 100]]],
];
const RATIOS = [[t('Free'), null], [t('Original'), 'orig'], ['1:1', 1], ['4:3', 4 / 3], ['3:2', 3 / 2], ['16:9', 16 / 9], ['4:5', 4 / 5], ['9:16', 9 / 16]];

async function enterEdit() {
  const p = cur();
  if (V.ed) return;
  els.stage.innerHTML = '<div class="empty">Loading…</div>';
  let bm;
  try { bm = await loadBitmap(p); } catch { toast('Cannot open this file for editing'); return show(); }
  const work = downscale(bm, 2200);
  const original = JSON.stringify(normalizeEdits(p.edits));
  const ed = {
    p, bm, work, tab: 'adjust', edits: normalizeEdits(p.edits),
    hist: [original], hi: 0, ratio: null, compare: false, fxCache: null,
    dirty: () => JSON.stringify(ed.edits) !== original,
    rotate: (d) => { rotateEdits(ed.edits, d); commit(); },
  };
  V.ed = ed; V.panel = 'edit'; V.zoomed = false;
  els.stage.classList.remove('zoomed'); els.stage.style.overflow = '';
  els.canvasWrap = h('div', { style: { position: 'relative', display: 'grid', placeItems: 'center', width: '100%', height: '100%' } });
  els.stage.innerHTML = '';
  els.stage.append(els.canvasWrap);
  setPanelLayout();
  show();
  renderEditPanel();
  draw();
}

function rotateEdits(e, d) {
  e.rot = (e.rot + d + 4) % 4;
  if (e.crop) { const c = e.crop; e.crop = d > 0 ? { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w }; }
}

function confirmDiscard(then) {
  modal({ title: t('Discard changes?'), body: h('p', {}, t('Your edits to this photo have not been saved.')),
    actions: [{ label: t('Keep editing') }, { label: t('Discard'), danger: true, run: then }] });
}

function exitEdit(force = false) {
  if (!V.ed) return;
  if (!force && V.ed.dirty()) return confirmDiscard(() => exitEdit(true));
  V.ed = null; V.panel = null;
  if (V.closeAfterEdit) return close();
  setPanelLayout();
  show();
}

async function saveEdit() {
  const ed = V.ed;
  const e = ed.edits;
  await patchPhotos([ed.p.id], { edits: isIdentity(e) ? null : e });
  V.ed = null; V.panel = null;
  toast('Saved. Your original file is unchanged.');
  if (V.closeAfterEdit) return close();
  setPanelLayout();
  show();
}

function commit() {
  const ed = V.ed;
  const s = JSON.stringify(ed.edits);
  if (s === ed.hist[ed.hi]) return draw();
  ed.hist = ed.hist.slice(0, ed.hi + 1);
  ed.hist.push(s); ed.hi = ed.hist.length - 1;
  ed.fxCache = null;
  draw(); renderEditPanel();
}
function undo() { const ed = V.ed; if (ed.hi > 0) { ed.edits = JSON.parse(ed.hist[--ed.hi]); ed.fxCache = null; draw(); renderEditPanel(); } }
function redo() { const ed = V.ed; if (ed.hi < ed.hist.length - 1) { ed.edits = JSON.parse(ed.hist[++ed.hi]); ed.fxCache = null; draw(); renderEditPanel(); } }

let rafPending = false;
function draw() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; drawNow(); });
}

function drawNow() {
  const ed = V.ed;
  if (!ed) return;
  const wrap = els.canvasWrap;
  const box = els.stage.getBoundingClientRect();
  const max = Math.min(2200, Math.max(box.width, box.height) * devicePixelRatio);
  let cv;
  const cropping = ed.tab === 'crop';
  if (ed.compare) cv = renderGeometry(ed.work, emptyEdits(), max);
  else cv = renderEdited(ed.work, ed.edits, max, { ignoreCrop: cropping });
  cv.style.maxWidth = '100%'; cv.style.maxHeight = '100%';
  wrap.innerHTML = '';
  wrap.append(cv);
  els.beforeTag.classList.toggle('show', ed.compare);
  if (cropping && !ed.compare) requestAnimationFrame(() => cropOverlay(cv));
  if (els.hist) drawHist(cv);
}

function drawHist(cv) {
  const hc = els.hist, ctx = hc.getContext('2d');
  const W = (hc.width = hc.clientWidth * devicePixelRatio), H = (hc.height = hc.clientHeight * devicePixelRatio);
  const hs = histogram(cv);
  let max = 1;
  for (const c of hs) for (let i = 2; i < 62; i++) max = Math.max(max, c[i]);
  ctx.clearRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  ['rgba(255,70,70,.75)', 'rgba(70,220,90,.7)', 'rgba(70,120,255,.8)'].forEach((col, c) => {
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let i = 0; i < 64; i++) ctx.lineTo((i / 63) * W, H - Math.min(1, hs[c][i] / max) * (H - 4));
    ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
  });
  ctx.globalCompositeOperation = 'source-over';
}

function renderEditPanel() {
  const ed = V.ed;
  const P = els.panel;
  P.innerHTML = '';
  const tab = (id, ic, label) => h('button', { class: ed.tab === id ? 'on' : '', html: icon(ic) + label,
    onclick: () => { ed.tab = id; renderEditPanel(); draw(); } });
  const tb = (ic, title, run, disabled) => h('button', { class: 'icon-btn', title, html: icon(ic), onclick: run, disabled });
  const cmp = tb('compare', 'Hold to compare with original (\\)', null);
  cmp.addEventListener('pointerdown', () => { ed.compare = true; draw(); });
  cmp.addEventListener('pointerup', () => { ed.compare = false; draw(); });
  cmp.addEventListener('pointerleave', () => { if (ed.compare) { ed.compare = false; draw(); } });

  P.append(
    h('div', { class: 'ed-tabs' }, tab('adjust', 'sliders', t('Adjust')), tab('crop', 'crop', t('Crop')), tab('filters', 'filter', t('Filters'))),
    h('div', { class: 'ed-tools' },
      tb('undo', t('Undo (Ctrl+Z)'), undo, ed.hi === 0), tb('redo', t('Redo (Ctrl+Y)'), redo, ed.hi >= ed.hist.length - 1), cmp,
      h('span', { class: 'spacer' }),
      tb('copy', t('Copy edits'), () => { state.editClipboard = JSON.parse(JSON.stringify(ed.edits)); toast('Edits copied'); }),
      tb('paste', t('Paste edits'), () => { if (state.editClipboard) { ed.edits = normalizeEdits(JSON.parse(JSON.stringify(state.editClipboard))); commit(); } }, !state.editClipboard),
      tb('refresh', t('Reset all'), () => { ed.edits = emptyEdits(); commit(); })));

  const body = h('div', { class: 'ed-body' });
  els.hist = h('canvas', { class: 'hist' });
  body.append(els.hist);
  if (ed.tab === 'adjust') adjustTab(body);
  if (ed.tab === 'crop') cropTab(body);
  if (ed.tab === 'filters') filtersTab(body);
  P.append(body, h('div', { class: 'ed-foot' },
    h('button', { class: 'btn', onclick: () => exitEdit() }, t('Cancel')),
    h('button', { class: 'btn', title: t('Export an edited copy'), onclick: () => exportDialog([{ ...ed.p, edits: ed.edits }]) }, t('Export')),
    h('button', { class: 'btn primary', onclick: saveEdit }, t('Save'))));
}

function slider(label, val, min, max, onInput, onCommit, cls = '') {
  const out = h('output', { title: t('Double-click to reset') }, String(Math.round(val)));
  const input = h('input', { type: 'range', min, max, step: 1, value: val });
  input.addEventListener('input', () => { out.textContent = input.value; onInput(Number(input.value)); });
  input.addEventListener('change', () => onCommit());
  const reset = () => { input.value = 0; out.textContent = '0'; onInput(0); onCommit(); };
  input.addEventListener('dblclick', reset); out.addEventListener('dblclick', reset);
  input.addEventListener('keydown', (e) => e.stopPropagation());
  return h('div', { class: 'slider ' + cls }, h('label', {}, label), out, input);
}

function adjustTab(body) {
  const ed = V.ed, e = ed.edits;
  body.append(h('button', { class: 'btn auto-btn', html: icon('wand') + (e.auto ? t('Auto enhance — on') : t('Auto enhance')), onclick: () => {
    if (e.auto) e.auto = null;
    else {
      const g = renderGeometry(ed.work, { ...e, angle: e.angle }, 600);
      e.auto = computeAuto(g.getContext('2d').getImageData(0, 0, g.width, g.height));
    }
    commit();
  } }));
  for (const [group, items] of SLIDERS) {
    body.append(h('div', { class: 'ed-group' }, group));
    for (const [key, label, min = -100, max = 100, cls] of items) {
      body.append(slider(label, e.adj[key] * 100, min, max, (v) => { e.adj[key] = v / 100; draw(); }, commit, cls));
    }
  }
}

function cropTab(body) {
  const ed = V.ed, e = ed.edits;
  body.append(h('div', { class: 'ed-group' }, t('Aspect ratio')),
    h('div', { class: 'crop-ratios' }, RATIOS.map(([label, r]) => h('button', { class: ed.ratio === r ? 'on' : '', onclick: () => { ed.ratio = r; applyRatio(); renderEditPanel(); } }, label))),
    h('div', { class: 'ed-group' }, t('Rotate & flip')),
    h('div', { class: 'crop-actions' },
      h('button', { class: 'btn', html: icon('rotate'), title: t('Rotate left'), onclick: () => { rotateEdits(e, -1); commit(); } }),
      h('button', { class: 'btn', html: icon('rotateR'), title: t('Rotate right'), onclick: () => { rotateEdits(e, 1); commit(); } }),
      h('button', { class: 'btn', html: icon('flip'), title: t('Flip horizontal'), onclick: () => { e.flip = !e.flip; if (e.crop) e.crop.x = 1 - e.crop.x - e.crop.w; commit(); } })),
    slider(t('Straighten'), e.angle * 10, -150, 150, (v) => { e.angle = v / 10; draw(); }, commit),
    h('button', { class: 'btn sm', style: { marginTop: '8px' }, onclick: () => { e.crop = null; ed.ratio = null; commit(); } }, t('Clear crop')));
}

function applyRatio() {
  const ed = V.ed, e = ed.edits;
  if (!ed.ratio) return;
  const [W, H] = frameSize(ed.work.width, ed.work.height, e);
  const R = ed.ratio === 'orig' ? W / H : ed.ratio;
  let w = 1, hh = (W / H) / R;
  if (hh > 1) { w = 1 / hh; hh = 1; }
  e.crop = { x: (1 - w) / 2, y: (1 - hh) / 2, w, h: hh };
  commit();
}

function cropOverlay(cv) {
  const ed = V.ed, e = ed.edits;
  els.canvasWrap.querySelector('.crop-layer')?.remove();
  const wrapRect = els.canvasWrap.getBoundingClientRect(), r = cv.getBoundingClientRect();
  const layer = h('div', { class: 'crop-layer', style: { left: r.left - wrapRect.left + 'px', top: r.top - wrapRect.top + 'px', width: r.width + 'px', height: r.height + 'px' } });
  const c = e.crop || { x: 0, y: 0, w: 1, h: 1 };
  const box = h('div', { class: 'crop-box' }, ['nw', 'ne', 'sw', 'se'].map((k) => h('div', { class: 'crop-h ' + k, 'data-h': k })));
  const place = (q) => Object.assign(box.style, { left: q.x * 100 + '%', top: q.y * 100 + '%', width: q.w * 100 + '%', height: q.h * 100 + '%' });
  place(c);
  layer.append(box);
  els.canvasWrap.append(layer);
  const [W, H] = frameSize(ed.work.width, ed.work.height, e);
  const R = ed.ratio === 'orig' ? W / H : ed.ratio;

  box.addEventListener('pointerdown', (ev) => {
    ev.preventDefault(); box.setPointerCapture(ev.pointerId);
    const mode = ev.target.dataset.h || 'move';
    const start = { ...(e.crop || c) }, sx = ev.clientX, sy = ev.clientY;
    const move = (m) => {
      const dx = (m.clientX - sx) / r.width, dy = (m.clientY - sy) / r.height;
      let q = { ...start };
      if (mode === 'move') { q.x = Math.min(1 - q.w, Math.max(0, q.x + dx)); q.y = Math.min(1 - q.h, Math.max(0, q.y + dy)); }
      else {
        let x0 = q.x, y0 = q.y, x1 = q.x + q.w, y1 = q.y + q.h;
        if (mode.includes('w')) x0 = Math.min(x1 - 0.05, Math.max(0, x0 + dx));
        if (mode.includes('e')) x1 = Math.max(x0 + 0.05, Math.min(1, x1 + dx));
        if (mode.includes('n')) y0 = Math.min(y1 - 0.05, Math.max(0, y0 + dy));
        if (mode.includes('s')) y1 = Math.max(y0 + 0.05, Math.min(1, y1 + dy));
        q = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        if (R) { // keep aspect: derive height from width (in pixel space)
          let nh = (q.w * W) / R / H;
          if (nh > 1) { nh = 1; q.w = (R * H) / W; }
          if (mode.includes('n')) q.y = Math.max(0, y1 - nh); q.h = nh;
          if (q.y + q.h > 1) q.y = 1 - q.h;
          if (mode.includes('w')) q.x = Math.max(0, x1 - q.w);
        }
      }
      e.crop = q; place(q);
    };
    const up = () => { box.removeEventListener('pointermove', move); box.removeEventListener('pointerup', up); commit(); };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', up);
  });
}

function filtersTab(body) {
  const ed = V.ed, e = ed.edits;
  const grid = h('div', { class: 'fx-grid' });
  const g = renderGeometry(ed.work, e, 240);
  const side = Math.min(g.width, g.height);
  const base = document.createElement('canvas');
  base.width = base.height = Math.min(side, 140);
  base.getContext('2d').drawImage(g, (g.width - side) / 2, (g.height - side) / 2, side, side, 0, 0, base.width, base.height);
  const opts = [{ id: null, name: t('Original') }, ...FILTERS];
  for (const f of opts) {
    const cv = renderEdited(base, { ...emptyEdits(), filter: f.id ? { id: f.id, amount: 1 } : null }, 160);
    grid.append(h('button', { class: 'fx' + ((e.filter?.id || null) === f.id ? ' on' : ''), onclick: () => {
      e.filter = f.id ? { id: f.id, amount: e.filter?.amount ?? 1 } : null; commit();
    } }, cv, t(f.name)));
  }
  body.append(h('div', { class: 'ed-group' }, t('Filters')), grid);
  if (e.filter) body.append(slider(t('Strength'), e.filter.amount * 100, 0, 100, (v) => { e.filter.amount = v / 100; draw(); }, commit));
}

window.addEventListener('resize', () => { if (V.ed) draw(); });

// ---------------- keyboard ----------------
document.addEventListener('keydown', (e) => {
  if (!root.classList.contains('show') || $('#modal').classList.contains('show')) return;
  if (e.target.matches('input, textarea, select') && e.key !== 'Escape') return;
  const ed = V.ed;
  if (e.key === 'Escape') { if (document.fullscreenElement) return; ed ? exitEdit() : close(); }
  else if (ed && isKey(e, 'ed.redo')) { e.preventDefault(); redo(); }
  else if (ed && isKey(e, 'ed.undo')) { e.preventDefault(); undo(); }
  else if (ed && isKey(e, 'ed.compare')) { if (!ed.compare) { ed.compare = true; draw(); } }
  else if (ed && isKey(e, 'ed.save')) { e.preventDefault(); saveEdit(); }
  else if (ed) return;
  else if (e.key === 'ArrowRight') go(1);
  else if (e.key === 'ArrowLeft') go(-1);
  else if (e.key === 'Home') { V.i = 0; show(); }
  else if (e.key === 'End') { V.i = V.list.length - 1; show(); }
  else if (e.key === 's') toggleStar();
  else if (e.key === 'i') togglePanel('info');
  else if (e.key === 'e') enterEdit();
  else if (e.key === 'r') quickRotate(1);
  else if (e.key === 'R') quickRotate(-1);
  else if (e.key === 'f') els.top.querySelector('[title^="Full"]').click();
  else if (e.key === 'h') { const p = cur(); patchPhotos([p.id], { hidden: !p.hidden }).then(() => toast(p.hidden ? t('Hidden') : t('Unhidden'))); }
  else if (e.ctrlKey && e.key === 'c') { const p = cur(); if (!isIdentity(p.edits)) { state.editClipboard = p.edits; toast('Edits copied'); } }
  else if (e.ctrlKey && e.key === 'v' && state.editClipboard) { patchPhotos([cur().id], { edits: state.editClipboard }).then(() => show()); }
  else if (e.key === ' ' || e.key === 'F5') { e.preventDefault(); const l = V.list, i = V.i; close(); startSlideshow(l, i); }
});
document.addEventListener('keyup', (e) => {
  // releasing the compare key (any modifier state) shows the edit again
  if (V.ed?.compare && keysFor('ed.compare').some((c) => c.split('+').pop() === comboOf({ ...e, key: e.key, code: e.code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }))) { V.ed.compare = false; draw(); }
});
