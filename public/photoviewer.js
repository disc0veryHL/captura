// Fast, simple photo viewer modeled on Picasa 3 Photo Viewer:
// dimmed/transparent backdrop, photo with shadow, 3D filmstrip, round action bar,
// mouse-wheel zoom (Ctrl+wheel navigates), cached preview first then full image,
// neighbors decoded ahead of time.
import {
  state, api, patchPhotos, onChange, enqueueThumb, prioritize, thumbUrl, originalUrl, loadBitmap,
  h, icon, toast, modal, fmtBytes, fmtDate, fmtExposure,
} from './store.js';
import { normalizeEdits, isIdentity, renderEdited, canvasToBlob, ADJ_DEFAULTS } from './pipeline.js';
import { isKey } from './keys.js';
import { t } from './i18n.js';

const PV = {
  root: null, list: [], i: 0, opts: {},
  s: 1, fit: 1, tx: 0, ty: 0, dw: 1, dh: 1, rot: 0, mode: 'fit',
  cache: new Map(), token: 0, info: false, idle: null, film: new Map(),
};

// Only rotation/flip → show the original with a CSS transform (instant, full resolution).
function rotOnly(e) {
  if (!e) return true;
  const n = normalizeEdits(e);
  return !n.crop && !n.angle && !n.auto && !n.filter && Object.keys(ADJ_DEFAULTS).every((k) => !n.adj[k]);
}
const cur = () => PV.list[PV.i];
const settings = () => state.settings || {};
const wheelZooms = () => settings().wheelZoom !== false;
const autoHide = () => settings().autoHideBar !== false;

// Resolve when the image is loaded, decoding it off the main thread when possible.
// decode() can stall while a window is not painting, so the load event is the fallback.
function ready(img) {
  return new Promise((resolve, reject) => {
    if (img.complete && img.naturalWidth) { img.decode().catch(() => {}); return resolve(); }
    img.addEventListener('load', () => { Promise.race([img.decode().catch(() => {}), new Promise((r) => setTimeout(r, 250))]).then(resolve); }, { once: true });
    img.addEventListener('error', () => reject(new Error('load failed')), { once: true });
  });
}

// ---------------- image cache / prefetch ----------------
function cacheKey(p) { return p.id + ':' + (p.editsV || 0) + ':' + Math.round(p.mtime); }

function loadFull(p) {
  const key = cacheKey(p);
  if (PV.cache.has(key)) { const v = PV.cache.get(key); PV.cache.delete(key); PV.cache.set(key, v); return v; }
  const prom = (async () => {
    const e = normalizeEdits(p.edits);
    const img = new Image();
    img.decoding = 'async';
    let blobUrl = null;
    if (rotOnly(p.edits)) {
      img.src = originalUrl(p);
    } else {
      const bm = await loadBitmap(p);
      const cap = Math.min(4096, Math.round(Math.max(screen.width, screen.height) * devicePixelRatio * 1.5));
      const cv = renderEdited(bm, e, cap);
      blobUrl = URL.createObjectURL(await canvasToBlob(cv, 'image/jpeg', 0.93));
      img.src = blobUrl;
    }
    await ready(img);
    return { img, w: img.naturalWidth, h: img.naturalHeight, rot: rotOnly(p.edits) ? e.rot : 0, flip: rotOnly(p.edits) && e.flip, blobUrl };
  })();
  prom.catch(() => PV.cache.delete(key));
  PV.cache.set(key, prom);
  while (PV.cache.size > 7) {
    const [k, v] = PV.cache.entries().next().value;
    PV.cache.delete(k);
    v.then((r) => r.blobUrl && URL.revokeObjectURL(r.blobUrl)).catch(() => {});
  }
  return prom;
}

function prefetch() {
  for (const d of [1, -1, 2]) {
    const q = PV.list[PV.i + d];
    if (q) setTimeout(() => loadFull(q).catch(() => {}), d === 1 ? 0 : 120);
  }
}

// ---------------- layout ----------------
let E = {};
export function openPhotoViewer(list, index = 0, opts = {}) {
  if (!list.length) return;
  closePhotoViewer(true);
  PV.list = list; PV.i = Math.max(0, Math.min(index, list.length - 1)); PV.opts = opts;
  const root = PV.root = h('div', { class: 'pv' + (opts.standalone ? ' standalone' : ''), tabindex: '-1' });
  const btn = (ic, title, run, cls = '') => h('button', { class: 'pv-btn ' + cls, title, 'aria-label': title, html: typeof ic === 'string' && ic.startsWith('<') ? ic : icon(ic), onclick: (e) => { e.stopPropagation(); run(e); } });

  E.stage = h('div', { class: 'pv-stage' });
  E.frame = h('div', { class: 'pv-frame' });
  E.low = h('img', { class: 'pv-low', alt: '', draggable: 'false' });
  E.full = h('img', { class: 'pv-full', alt: '', draggable: 'false' });
  E.frame.append(E.low, E.full);
  E.stage.append(E.frame);

  E.status = h('div', { class: 'pv-status' });
  E.zoomText = h('div', { class: 'pv-zoomtext' });
  E.infoBox = h('div', { class: 'pv-info' });
  E.film = h('div', { class: 'pv-film' });
  E.star = btn('star', t('Star (S)'), toggleStar, 'small');
  E.more = btn('more', t('More options'), openMore, 'small');
  E.actions = h('div', { class: 'pv-actions' },
    btn('left', t('Previous photo (←)'), () => go(-1), 'nav'),
    btn('right', t('Next photo (→)'), () => go(1), 'nav'),
    h('span', { class: 'pv-gap' }),
    btn('<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11h6"/></svg>', t('Zoom out (−)'), () => zoomBy(1 / 1.25), 'small'),
    btn('<span class="pv-11">1:1</span>', t('Zoom to 1:1 (1)'), () => (PV.mode === 'actual' ? setFit() : setActual()), 'small'),
    btn('zoom', t('Zoom in (+)'), () => zoomBy(1.25), 'small'),
    h('span', { class: 'pv-gap' }),
    btn('rotate', t('Rotate counter-clockwise ([)'), () => rotate(-1), 'small'),
    btn('rotateR', t('Rotate clockwise (])'), () => rotate(1), 'small'),
    h('span', { class: 'pv-gap' }),
    btn('play', t('Play slideshow (F5)'), playSlideshow, 'small'),
    E.star,
    btn('edit', t('Edit (E)'), editPhoto, 'small'),
    E.more);
  E.skirt = h('div', { class: 'pv-skirt' }, E.film, h('div', { class: 'pv-bar' }, E.status, E.actions, E.zoomText));
  E.fsBtn = btn('restore', t('Window mode (F11)'), toggleFullscreen, 'small');
  E.top = h('div', { class: 'pv-top' },
    opts.standalone ? btn('photos', t('Open Captura library'), openLibrary, 'small') : null,
    E.fsBtn,
    btn('close', t('Exit (Esc)'), () => closePhotoViewer(), 'small'));
  E.menu = h('div', { class: 'pv-menu' });
  E.drag = h('div', { class: 'pv-drag' }); // window-mode title strip (standalone): drag to move
  root.append(E.stage, E.drag, E.top, E.infoBox, E.skirt, E.menu);
  document.body.append(root);

  // events
  root.addEventListener('wheel', onWheel, { passive: false });
  E.stage.addEventListener('pointerdown', onPointerDown);
  E.stage.addEventListener('dblclick', onDblClick);
  root.addEventListener('mousemove', poke);
  document.addEventListener('keydown', onKey);
  document.addEventListener('fullscreenchange', onFsChange);
  window.addEventListener('resize', onResize);
  root.focus();
  requestAnimationFrame(() => root.classList.add('show'));
  // Opens full screen; the standalone window already covers the whole display.
  if (opts.standalone) setFs(opts.fullscreen !== false);
  else if (settings().viewerFullscreen !== false) enterFs();
  else setFs(false);
  poke();
  show();
}

// ---------------- full screen / window mode ----------------
function setFs(on) {
  PV.fs = on;
  if (!PV.root) return;
  PV.root.classList.toggle('windowed', !on);
  E.fsBtn.innerHTML = icon(on ? 'restore' : 'fullscreen');
  E.fsBtn.title = on ? t('Window mode (F11)') : t('Full screen (F11)');
  requestAnimationFrame(onResize);
}

async function toggleFullscreen() {
  if (!PV.root) return;
  if (PV.opts.standalone) {
    const full = await window.lumenNative?.win?.('fullscreen');
    if (typeof full === 'boolean') setFs(full);
    return;
  }
  if (!PV.fs) return enterFs();
  if (document.fullscreenElement === PV.root) { PV.selfExit = true; document.exitFullscreen().catch(() => setFs(false)); }
  else setFs(false);
}

// Show full screen right away; fall back to window mode if the request is refused or never lands.
function enterFs() {
  const root = PV.root;
  setFs(true);
  root.requestFullscreen({ navigationUI: 'hide' }).catch(() => { if (PV.root === root) setFs(false); });
  setTimeout(() => { if (PV.root === root && PV.fs && document.fullscreenElement !== root) setFs(false); }, 900);
}

function onFsChange() {
  if (!PV.root || PV.opts.standalone) return;
  const now = document.fullscreenElement === PV.root;
  // Esc pressed in full screen (the browser leaves full screen itself): close, don't shrink
  if (PV.fs && !now && !document.fullscreenElement && !PV.selfExit) { closePhotoViewer(); return; }
  PV.selfExit = false;
  setFs(now);
}

export function closePhotoViewer(silent = false) {
  if (!PV.root) return;
  const root = PV.root;
  PV.root = null; PV.token++;
  window.removeEventListener('resize', onResize);
  document.removeEventListener('keydown', onKey);
  document.removeEventListener('fullscreenchange', onFsChange);
  clearTimeout(PV.idle);
  PV.film.clear();
  root.classList.remove('show');
  setTimeout(() => root.remove(), silent ? 0 : 160);
  if (document.fullscreenElement === root) document.exitFullscreen().catch(() => {});
  if (!silent) PV.opts.onClose?.();
}
export const photoViewerOpen = () => !!PV.root;

// ---------------- showing ----------------
async function show() {
  const p = cur();
  const token = ++PV.token;
  PV.shownKey = cacheKey(p);
  renderStatus();
  renderFilm();
  if (PV.info) renderInfo();

  // 1) instant: cached preview (thumbnail) sized to the final layout
  const e = normalizeEdits(p.edits);
  const ro = rotOnly(p.edits);
  const odd = ro && e.rot % 2;
  let dw = p.w ? (odd ? p.h : p.w) : 0, dh = p.h ? (odd ? p.w : p.h) : 0;
  E.full.classList.remove('on');
  E.full.removeAttribute('src');
  E.low.style.visibility = 'hidden';
  if (p.thumb) {
    E.low.src = thumbUrl(p);
    ready(E.low).then(() => {
      if (token !== PV.token || E.full.classList.contains('on')) return;
      if (!ro || !dw) { // size from preview ratio when real size is unknown (edited/cropped)
        const r = E.low.naturalWidth / E.low.naturalHeight;
        const k = Math.max(p.w || 0, p.h || 0, 1600);
        dw = r >= 1 ? k : k * r; dh = r >= 1 ? k / r : k;
      }
      layout(dw, dh, 0, false, true, true); // new photo: snap into place, no zoom animation
      E.low.style.visibility = 'visible';
    }).catch(() => {});
  } else {
    enqueueThumb(p, true); prioritize(p.id);
  }

  // 2) full quality
  let r;
  try { r = await loadFull(p); } catch {
    if (token === PV.token) { E.low.style.visibility = 'hidden'; toast('This file cannot be displayed'); }
    return;
  }
  if (token !== PV.token) return;
  E.full.src = r.img.src;
  const odd2 = r.rot % 2;
  layout(odd2 ? r.h : r.w, odd2 ? r.w : r.h, r.rot, r.flip, true, true);
  E.full.style.width = r.w + 'px'; E.full.style.height = r.h + 'px';
  PV.rotVisual = r.rot * 90;
  E.full.style.transform = `translate(-50%, -50%) rotate(${PV.rotVisual}deg)${r.flip ? ' scaleX(-1)' : ''}`;
  E.full.classList.add('on');
  renderStatus(r);
  prefetch();
}

// dw/dh: displayed (rotated) pixel size of the photo
function layout(dw, dh, rot, flip, refit, quiet = false) {
  PV.dw = dw; PV.dh = dh; PV.rot = rot;
  E.frame.style.width = dw + 'px'; E.frame.style.height = dh + 'px';
  E.frame.style.marginLeft = -dw / 2 + 'px'; E.frame.style.marginTop = -dh / 2 + 'px';
  computeFit();
  if (refit || PV.mode === 'fit') { PV.mode = 'fit'; PV.s = PV.fit; PV.tx = PV.ty = 0; }
  apply(quiet);
}

function avail() {
  const r = E.stage.getBoundingClientRect();
  const bottom = 158, top = 54, side = 40;
  return { w: Math.max(100, r.width - side * 2), h: Math.max(100, r.height - top - bottom), cx: r.left + r.width / 2, cy: r.top + top + (r.height - top - bottom) / 2 };
}
function computeFit() {
  const a = avail();
  // like Picasa: never upscale small photos beyond 100% when fitting
  PV.fit = Math.min(1, a.w / PV.dw, a.h / PV.dh);
}

function apply(quiet = false) {
  const a = avail();
  const r = E.stage.getBoundingClientRect();
  const ox = a.cx - (r.left + r.width / 2), oy = a.cy - (r.top + r.height / 2);
  E.frame.style.transition = quiet ? 'none' : '';
  E.frame.style.transform = `translate(${PV.tx + ox}px, ${PV.ty + oy}px) scale(${PV.s})`;
  E.frame.classList.toggle('pannable', PV.dw * PV.s > a.w + 1 || PV.dh * PV.s > a.h + 1);
  E.frame.classList.toggle('pixel', PV.s * devicePixelRatio >= 3);
  E.zoomText.textContent = Math.round(PV.s * devicePixelRatio * 100) + '%';
}

function onResize() { if (!PV.root) return; computeFit(); if (PV.mode === 'fit') PV.s = PV.fit; clampPan(); apply(true); }

function clampPan() {
  const a = avail();
  const w = PV.dw * PV.s, hh = PV.dh * PV.s;
  const mx = Math.max(0, (w - a.w) / 2 + 20), my = Math.max(0, (hh - a.h) / 2 + 20);
  PV.tx = w <= a.w ? 0 : Math.max(-mx, Math.min(mx, PV.tx));
  PV.ty = hh <= a.h ? 0 : Math.max(-my, Math.min(my, PV.ty));
}

// ---------------- zoom & pan ----------------
function zoomTo(s, clientX, clientY) {
  const a = avail();
  const min = Math.min(PV.fit, 0.05), max = 16 / devicePixelRatio;
  s = Math.max(min, Math.min(max, s));
  const px = (clientX ?? a.cx) - a.cx, py = (clientY ?? a.cy) - a.cy;
  PV.tx = px - ((px - PV.tx) * s) / PV.s;
  PV.ty = py - ((py - PV.ty) * s) / PV.s;
  PV.s = s;
  PV.mode = Math.abs(s - PV.fit) < 1e-3 ? 'fit' : Math.abs(s * devicePixelRatio - 1) < 1e-3 ? 'actual' : 'free';
  clampPan();
  apply();
}
function zoomBy(f, x, y) { zoomTo(PV.s * f, x, y); }
function setFit() { PV.mode = 'fit'; PV.s = PV.fit; PV.tx = PV.ty = 0; apply(); }
function setActual(x, y) { zoomTo(1 / devicePixelRatio, x, y); PV.mode = 'actual'; }

function onWheel(e) {
  if (e.target.closest('.pv-skirt, .pv-menu, .pv-info')) {
    if (e.target.closest('.pv-film')) { e.preventDefault(); go(e.deltaY > 0 || e.deltaX > 0 ? 1 : -1); }
    return;
  }
  e.preventDefault();
  const navigate = wheelZooms() ? e.ctrlKey : !e.ctrlKey;
  if (navigate) {
    const now = performance.now();
    if (now - (PV.lastWheelNav || 0) < 120) return;
    PV.lastWheelNav = now;
    go(e.deltaY > 0 ? 1 : -1);
  } else {
    zoomBy(Math.pow(1.0018, -e.deltaY), e.clientX, e.clientY);
  }
}

function onPointerDown(e) {
  if (e.button !== 0) return;
  const onPhoto = e.target.closest('.pv-frame');
  const sx = e.clientX, sy = e.clientY, tx = PV.tx, ty = PV.ty;
  let moved = false;
  const pannable = E.frame.classList.contains('pannable');
  const move = (m) => {
    if (Math.abs(m.clientX - sx) + Math.abs(m.clientY - sy) > 4) moved = true;
    if (moved && pannable) { PV.tx = tx + (m.clientX - sx); PV.ty = ty + (m.clientY - sy); clampPan(); apply(true); E.frame.classList.add('grabbing'); }
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    E.frame.classList.remove('grabbing');
    // a plain click on the dark backdrop exits, like Picasa Photo Viewer
    // a plain click on the empty backdrop: zoomed → fit; full screen → window mode
    if (!moved && !onPhoto) { if (PV.mode !== 'fit') setFit(); else if (PV.fs) toggleFullscreen(); }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function onDblClick(e) {
  if (!e.target.closest('.pv-frame')) return;
  if (PV.mode === 'fit') setActual(e.clientX, e.clientY); else setFit();
}

// ---------------- navigation ----------------
function go(d) {
  const n = PV.i + d;
  if (n < 0 || n >= PV.list.length) { bump(d); return; }
  PV.i = n; PV.mode = 'fit';
  show();
}
function goTo(i) { if (i === PV.i || i < 0 || i >= PV.list.length) return; PV.i = i; PV.mode = 'fit'; show(); }
function bump(d) { E.frame.animate([{ translate: '0 0' }, { translate: `${-d * 18}px 0` }, { translate: '0 0' }], { duration: 220 }); }

// ---------------- 3D filmstrip ----------------
function renderFilm() {
  const N = 9;
  const keep = new Set();
  for (let o = -N; o <= N; o++) {
    const idx = PV.i + o;
    const p = PV.list[idx];
    if (!p) continue;
    keep.add(idx);
    let el = PV.film.get(idx);
    if (!el) {
      const img = h('img', { alt: '', draggable: 'false' });
      if (p.thumb) img.src = thumbUrl(p); else enqueueThumb(p);
      el = h('div', { class: 'pv-fs', title: p.name, 'data-id': p.id, onclick: (ev) => { ev.stopPropagation(); goTo(idx); } }, img);
      const ar = p.w && p.h ? p.w / p.h : 1.33;
      el.style.width = Math.round(Math.max(36, Math.min(110, 62 * ar))) + 'px';
      PV.film.set(idx, el);
      E.film.append(el);
      el.style.transition = 'none';
    }
    const a = Math.abs(o), sign = Math.sign(o);
    const flat = settings().filmstrip === 'flat';
    const x = flat ? o * 80 : sign * (a <= 1 ? a * 92 : 92 + (a - 1) * 58);
    const ry = flat ? 0 : -sign * Math.min(55, a * 28);
    const z = flat ? 0 : -Math.min(a, 5) * 26;
    el.style.transform = `translateX(calc(${x}px - 50%)) translateZ(${z}px) rotateY(${ry}deg) scale(${o === 0 ? (flat ? 1.12 : 1.22) : 1})`;
    el.style.opacity = String(Math.max(0, 1 - Math.max(0, a - 5) * 0.25));
    el.style.zIndex = String(100 - a);
    el.classList.toggle('cur', o === 0);
    if (el.style.transition === 'none') requestAnimationFrame(() => (el.style.transition = ''));
  }
  for (const [idx, el] of PV.film) if (!keep.has(idx)) { el.remove(); PV.film.delete(idx); }
}

// ---------------- status / info ----------------
function renderStatus(r) {
  const p = cur();
  E.status.innerHTML = '';
  const dims = r ? `${r.rot % 2 ? r.h : r.w} × ${r.rot % 2 ? r.w : r.h}` : p.w ? `${p.w} × ${p.h}` : '';
  E.status.append(h('b', {}, p.caption || p.name), h('span', {}, [t('{i} of {n}', { i: PV.i + 1, n: PV.list.length }), dims, fmtBytes(p.size)].filter(Boolean).join('  ·  ')));
  E.star.classList.toggle('on', !!p.star);
}

function renderInfo() {
  const p = cur();
  E.infoBox.innerHTML = '';
  const row = (k, v) => v ? h('div', {}, h('span', {}, k), h('b', {}, v)) : null;
  const ex = [p.fnumber && 'ƒ/' + Number(p.fnumber).toFixed(1).replace(/\.0$/, ''), fmtExposure(p.exposure), p.focal && Math.round(p.focal) + ' mm', p.iso && t('ISO ') + p.iso].filter(Boolean).join('  ');
  E.infoBox.append(
    row(t('File'), p.name), row(t('Taken'), fmtDate(p.ts, { dateStyle: 'medium', timeStyle: 'short' })),
    row(t('Size'), [p.w && `${p.w} × ${p.h}`, fmtBytes(p.size)].filter(Boolean).join(' · ')),
    row(t('Camera'), p.camera), row(t('Lens'), p.lens), row(t('Exposure'), ex),
    row(t('Location'), p.gps && `${p.gps.lat.toFixed(5)}, ${p.gps.lon.toFixed(5)}`),
    row(t('Folder'), p.folder));
  E.infoBox.classList.add('show');
}
function toggleInfo() { PV.info = !PV.info; if (PV.info) renderInfo(); else E.infoBox.classList.remove('show'); }

// ---------------- auto-hide action bar ----------------
function poke() {
  if (!PV.root) return;
  PV.root.classList.remove('idle');
  clearTimeout(PV.idle);
  if (!autoHide()) return;
  PV.idle = setTimeout(() => {
    if (PV.root && !PV.root.querySelector('.pv-skirt:hover, .pv-top:hover, .pv-menu.show')) PV.root.classList.add('idle');
  }, 2600);
}

// ---------------- actions ----------------
async function toggleStar() {
  const p = cur();
  await patchPhotos([p.id], { star: !p.star });
  E.star.classList.toggle('on', !!p.star);
  toast(p.star ? t('Starred') : t('Star removed'));
}

async function rotate(d) {
  const p = cur();
  const e = normalizeEdits(p.edits);
  e.rot = (e.rot + d + 4) % 4;
  if (e.crop) { const c = e.crop; e.crop = d > 0 ? { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w }; }
  const simple = rotOnly(p.edits);
  // animate immediately, persist in background (non-destructive, like Picasa's .picasa.ini)
  const animated = simple && E.full.classList.contains('on');
  if (animated) {
    const w = parseFloat(E.full.style.width), hh = parseFloat(E.full.style.height);
    E.low.style.visibility = 'hidden';
    const odd = e.rot % 2;
    layout(odd ? hh : w, odd ? w : hh, e.rot, e.flip, true);
    PV.rotVisual += d * 90; // accumulate so 270° → 360° turns the short way
    E.full.style.transform = `translate(-50%, -50%) rotate(${PV.rotVisual}deg)${e.flip ? ' scaleX(-1)' : ''}`;
  }
  PV.skipReload = animated;
  await patchPhotos([p.id], { edits: isIdentity(e) ? null : e });
  PV.skipReload = false;
  if (animated) PV.shownKey = cacheKey(p); else show();
}

function playSlideshow() {
  import('./tools.js').then(({ startSlideshow }) => startSlideshow(PV.list, PV.i));
}

function editPhoto() {
  import('./viewer.js').then(({ openViewer }) => openViewer(PV.list, PV.i, { edit: true }));
}


function openLibrary() { window.lumenNative?.win?.('library'); }

async function trash() {
  const p = cur();
  modal({
    title: t('Move to Recycle Bin?'), body: h('p', {}, p.path),
    actions: [{ label: t('Cancel') }, { label: t('Move to Recycle Bin'), danger: true, run: async () => {
      const ok = await window.lumenNative?.win?.('trash', p.path);
      if (!ok) { toast('Could not move the file'); return; }
      PV.list.splice(PV.i, 1);
      PV.film.forEach((el) => el.remove()); PV.film.clear();
      if (!PV.list.length) return closePhotoViewer();
      PV.i = Math.min(PV.i, PV.list.length - 1);
      show();
      toast('Moved to Recycle Bin');
    } }],
  });
}

function openMore(e) {
  const m = E.menu;
  if (m.classList.contains('show')) { m.classList.remove('show'); return; }
  const p = cur();
  const item = (label, run, checked) => h('button', { onclick: (ev) => { ev.stopPropagation(); m.classList.remove('show'); run(); } },
    h('span', { class: 'pv-check' }, checked === undefined ? '' : checked ? '✓' : ''), label);
  m.innerHTML = '';
  // Element.append() would print null as the text "null", so drop hidden entries first
  m.append(...[
    item(t('Photo info  (I)'), toggleInfo, PV.info),
    item(t('Show in Explorer'), () => api.reveal(p.id)),
    item(t('Export…'), () => import('./tools.js').then(({ exportDialog }) => exportDialog([p]))),
    h('hr'),
    item(t('Zoom with mouse wheel (hold Ctrl to navigate)'), () => saveSetting('wheelZoom', !wheelZooms()), wheelZooms()),
    item(t('Auto-hide action bar'), () => { saveSetting('autoHideBar', !autoHide()); poke(); }, autoHide()),
    PV.opts.standalone ? h('hr') : null,
    PV.opts.standalone && !PV.opts.inLibrary ? item(t('Add this folder to Captura'), async () => {
      try { await api.addFolder(PV.opts.folder); PV.opts.inLibrary = true; toast('Folder added to your library'); } catch (err) { toast(err.message); }
    }) : null,
    PV.opts.standalone ? item(t('Open Captura library'), openLibrary) : null,
    PV.opts.standalone ? item(t('Move to Recycle Bin  (Del)'), trash) : null,
  ].filter(Boolean));
  const r = e.currentTarget.getBoundingClientRect();
  m.style.left = Math.min(r.left, innerWidth - 330) + 'px';
  m.style.bottom = innerHeight - r.top + 10 + 'px';
  m.classList.add('show');
}

function saveSetting(k, v) { state.settings = { ...state.settings, [k]: v }; api.settings({ [k]: v }).catch(() => {}); }

function onKey(e) {
  if (!PV.root || document.querySelector('#modal.show, #viewer.show, #slideshow.show')) return;
  if (e.target.matches('input, textarea, select')) return;
  let handled = true;
  if (e.key === 'Escape') { if (E.menu.classList.contains('show')) E.menu.classList.remove('show'); else if (PV.mode !== 'fit') setFit(); else closePhotoViewer(); }
  else if (isKey(e, 'pv.next')) go(1);
  else if (isKey(e, 'pv.prev')) go(-1);
  else if (isKey(e, 'pv.first')) goTo(0);
  else if (isKey(e, 'pv.last')) goTo(PV.list.length - 1);
  else if (isKey(e, 'pv.zoomIn')) zoomBy(1.25);
  else if (isKey(e, 'pv.zoomOut')) zoomBy(1 / 1.25);
  else if (isKey(e, 'pv.fit')) setFit();
  else if (isKey(e, 'pv.actual')) setActual();
  else if (isKey(e, 'pv.rotateCW')) rotate(1);
  else if (isKey(e, 'pv.rotateCCW')) rotate(-1);
  else if (isKey(e, 'pv.star')) toggleStar();
  else if (isKey(e, 'pv.info')) toggleInfo();
  else if (isKey(e, 'pv.edit')) editPhoto();
  else if (isKey(e, 'pv.slideshow')) playSlideshow();
  else if (isKey(e, 'pv.fullscreen')) toggleFullscreen();
  else if (isKey(e, 'pv.delete') && PV.opts.standalone) trash();
  else handled = false;
  if (handled) { e.preventDefault(); e.stopPropagation(); poke(); }
}

onChange((what, id) => {
  if (!PV.root) return;
  if (what === 'thumb') {
    const p = state.byId.get(id);
    PV.film.forEach((el) => { if (el.dataset.id === id && p) el.firstChild.src = thumbUrl(p); });
    return;
  }
  if (what === 'photos' && !PV.skipReload) {
    // redraw only when the current photo's pixels changed (edits saved in the editor)
    if (cacheKey(cur()) !== PV.shownKey) show(); else renderStatus();
  }
});
