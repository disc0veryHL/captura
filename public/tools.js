// Slideshow, export, collage, places map and duplicate finder.
import { t } from './i18n.js';
import { state, api, patchPhotos, loadBitmap, originalUrl, thumbUrl, $, h, icon, toast, modal, fmtBytes, emptyBox } from './store.js';
import { renderEdited, normalizeEdits, isIdentity, canvasToBlob, makeCanvas, emptyEdits } from './pipeline.js';

// ======================= slideshow =======================
const SS = { list: [], i: 0, timer: null, playing: true, uiTimer: null, layer: 0, shuffle: false, urls: [] };

export function startSlideshow(list, start = 0) {
  if (!list.length) return;
  const root = $('#slideshow');
  SS.list = [...list]; SS.i = start; SS.playing = true; SS.layer = 0;
  SS.secs = state.settings.slideSeconds || 5;
  root.innerHTML = '';
  SS.slides = [h('div', { class: 'ss-slide' }), h('div', { class: 'ss-slide' })];
  SS.cap = h('div', { class: 'ss-cap' });
  SS.meta = h('span', { class: 'meta' });
  SS.playBtn = h('button', { class: 'icon-btn', title: t('Play / pause (Space)'), onclick: togglePlay });
  const speed = h('select', { class: 'select', title: t('Seconds per photo') }, [3, 5, 8, 12].map((s) => h('option', { value: s, selected: s === SS.secs }, s + ' s')));
  speed.addEventListener('change', () => { SS.secs = Number(speed.value); api.settings({ slideSeconds: SS.secs }); restartTimer(); });
  const shuffle = h('button', { class: 'icon-btn' + (SS.shuffle ? ' on' : ''), title: t('Shuffle'), html: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>',
    onclick: () => { SS.shuffle = !SS.shuffle; shuffle.classList.toggle('on', SS.shuffle); if (SS.shuffle) { const cur = SS.list[SS.i]; SS.list.sort(() => Math.random() - 0.5); SS.i = SS.list.indexOf(cur); } } });
  root.append(...SS.slides, SS.cap, h('div', { class: 'ss-bar' },
    h('button', { class: 'icon-btn', title: t('Previous'), html: icon('left'), onclick: () => step(-1) }), SS.playBtn,
    h('button', { class: 'icon-btn', title: t('Next'), html: icon('right'), onclick: () => step(1) }),
    SS.meta, speed, shuffle,
    h('button', { class: 'icon-btn', title: t('Exit (Esc)'), html: icon('close'), onclick: stopSlideshow })));
  root.classList.add('show', 'ui');
  root.onmousemove = () => { root.classList.add('ui'); clearTimeout(SS.uiTimer); SS.uiTimer = setTimeout(() => root.classList.remove('ui'), 2200); };
  root.onclick = (e) => { if (e.target === root || e.target.classList.contains('ss-slide')) togglePlay(); };
  root.requestFullscreen?.().catch(() => {});
  document.addEventListener('keydown', ssKeys, true);
  document.addEventListener('fullscreenchange', ssFsChange);
  updatePlayBtn();
  showSlide();
  root.onmousemove();
}

// Esc in full screen is handled by the browser (it only leaves full screen),
// so leaving full screen ends the slideshow instead of shrinking it to a window.
function ssFsChange() {
  const root = $('#slideshow');
  if (root.classList.contains('show') && document.fullscreenElement !== root) stopSlideshow();
}

function stopSlideshow() {
  clearTimeout(SS.timer);
  document.removeEventListener('keydown', ssKeys, true);
  document.removeEventListener('fullscreenchange', ssFsChange);
  const root = $('#slideshow');
  root.classList.remove('show'); root.innerHTML = '';
  SS.urls.forEach(URL.revokeObjectURL); SS.urls = [];
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}
function ssKeys(e) {
  if (!$('#slideshow').classList.contains('show')) return;
  e.stopPropagation();
  if (e.key === 'Escape') stopSlideshow();
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
}
function togglePlay() { SS.playing = !SS.playing; updatePlayBtn(); restartTimer(); }
function updatePlayBtn() { SS.playBtn.innerHTML = icon(SS.playing ? 'pause' : 'play'); }
function restartTimer() { clearTimeout(SS.timer); if (SS.playing) SS.timer = setTimeout(() => step(1), SS.secs * 1000); }
function step(d) { SS.i = (SS.i + d + SS.list.length) % SS.list.length; showSlide(); }

async function slideUrl(p) {
  if (isIdentity(p.edits)) return originalUrl(p);
  const bm = await loadBitmap(p);
  const cv = renderEdited(bm, normalizeEdits(p.edits), Math.max(innerWidth, innerHeight) * devicePixelRatio);
  const url = URL.createObjectURL(await canvasToBlob(cv, 'image/jpeg', 0.9));
  SS.urls.push(url);
  if (SS.urls.length > 6) URL.revokeObjectURL(SS.urls.shift());
  return url;
}

async function showSlide() {
  clearTimeout(SS.timer);
  const p = SS.list[SS.i];
  const idx = SS.i;
  let url;
  try {
    url = await slideUrl(p);
    await new Promise((res, rej) => { const im = new Image(); im.onload = res; im.onerror = rej; im.src = url; });
  } catch { if (idx === SS.i) restartTimer(); return; }
  if (idx !== SS.i || !$('#slideshow').classList.contains('show')) return;
  const next = SS.slides[SS.layer ^ 1], prev = SS.slides[SS.layer];
  next.style.backgroundImage = `url("${url}")`;
  next.classList.remove('kb'); void next.offsetWidth;
  next.style.setProperty('--dur', SS.secs + 1.5 + 's');
  next.style.setProperty('--kx', (Math.random() * 4 - 2).toFixed(2) + '%');
  next.style.setProperty('--ky', (Math.random() * 4 - 2).toFixed(2) + '%');
  next.classList.add('on', 'kb');
  prev.classList.remove('on');
  SS.layer ^= 1;
  SS.meta.textContent = `${SS.i + 1} / ${SS.list.length}`;
  SS.cap.textContent = p.caption || '';
  SS.cap.classList.toggle('on', !!p.caption);
  restartTimer();
  const n = SS.list[(SS.i + 1) % SS.list.length];
  if (n && isIdentity(n.edits)) { const im = new Image(); im.src = originalUrl(n); }
}

// ======================= export =======================
export function exportDialog(photos, folderName) {
  if (!photos.length) return;
  const opts = { format: 'jpeg', quality: 90, size: 0, edits: true, dir: state.settings.exportDir || '' };
  if (folderName) opts.dir = opts.dir.replace(/[\\/]$/, '') + '\\' + folderName.replace(/[<>:"/\\|?*]/g, '_');
  const seg = (key, items) => {
    const el = h('div', { class: 'seg' });
    const draw = () => { el.innerHTML = ''; for (const [v, l] of items) el.append(h('button', { class: opts[key] === v ? 'on' : '', onclick: () => { opts[key] = v; draw(); q.style.display = opts.format === 'png' ? 'none' : ''; } }, l)); };
    draw(); return el;
  };
  const qOut = h('output', {}, opts.quality);
  const qIn = h('input', { type: 'range', min: 50, max: 100, value: opts.quality, style: { width: '100%' } });
  qIn.addEventListener('input', () => { opts.quality = Number(qIn.value); qOut.textContent = qIn.value; });
  const q = h('label', { class: 'field' }, h('span', {}, t('Quality') + ' ', qOut), qIn);
  const size = h('select', { class: 'select' }, [[0, t('Original size')], [4096, 'Large — 4096 px'], [2560, '2560 px'], [1920, 'Full HD — 1920 px'], [1280, 'Web — 1280 px'], [800, 'Email — 800 px']]
    .map(([v, l]) => h('option', { value: v }, l)));
  size.addEventListener('change', () => (opts.size = Number(size.value)));
  const dirIn = h('input', { class: 'input', value: opts.dir });
  dirIn.addEventListener('input', () => (opts.dir = dirIn.value));
  const edited = photos.filter((p) => !isIdentity(p.edits)).length;
  const editsCb = h('input', { type: 'checkbox', checked: true });
  editsCb.addEventListener('change', () => (opts.edits = editsCb.checked));
  const status = h('div', { class: 'section-sub' });

  const body = h('div', {},
    h('label', { class: 'field' }, h('span', {}, t('Format')), seg('format', [['jpeg', 'JPEG'], ['webp', 'WebP'], ['png', 'PNG']])),
    q,
    h('label', { class: 'field' }, h('span', {}, t('Size (long edge)')), size),
    h('label', { class: 'field' }, h('span', {}, t('Save to')), h('div', { class: 'dir-row' }, dirIn,
      h('button', { class: 'btn', onclick: async () => { const p = await api.pickFolder(); if (p) { dirIn.value = opts.dir = p; } } }, t('Browse…')))),
    edited ? h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', margin: '10px 0' } }, editsCb, t('Apply edits ({n} edited photos)', { n: edited })) : null,
    h('p', { class: 'section-sub' }, t('Originals are never modified. Exports are new files.')),
    status);

  let busy = false;
  modal({ title: t('Export {n} photos', { n: photos.length }), body, actions: [
    { label: t('Cancel'), run: () => { busy = false; } },
    { label: t('Export'), primary: true, run: async () => {
      if (busy) return false;
      busy = true;
      let last = null, failed = 0;
      for (let i = 0; i < photos.length && busy; i++) {
        const p = photos[i];
        status.textContent = t('Exporting {i} of {n}: {name}', { i: i + 1, n: photos.length, name: p.name });
        try {
          const bm = await loadBitmap(p);
          const cv = renderEdited(bm, opts.edits ? normalizeEdits(p.edits) : emptyEdits(), opts.size || 16384);
          const blob = await canvasToBlob(cv, 'image/' + opts.format, opts.quality / 100);
          const base = p.name.replace(/\.[^.]+$/, '');
          last = (await api.exportBlob(blob, { name: base, format: opts.format, dir: opts.dir })).path;
        } catch (e) { failed++; console.error(e); }
      }
      busy = false;
      if (opts.dir !== state.settings.exportDir && !folderName) { state.settings.exportDir = opts.dir; api.settings({ exportDir: opts.dir }); }
      toast(t('Exported {n} photos', { n: photos.length - failed }) + (failed ? ', ' + t('{n} failed', { n: failed }) : ''),
        last ? { label: t('Show in folder'), run: () => api.revealPath(last) } : null);
    } },
  ] });
}

// ======================= collage =======================
export function collageDialog(photos) {
  photos = photos.filter((p) => p.thumb);
  if (photos.length < 2) return toast('Select at least 2 photos with previews for a collage');
  const o = { layout: 'mosaic', ratio: 1.5, gap: 12, bg: '#ffffff', radius: 0, width: 3600 };
  const preview = h('canvas', { class: 'collage-preview' });
  const seg = (key, items) => {
    const el = h('div', { class: 'seg' });
    const draw = () => { el.innerHTML = ''; for (const [v, l] of items) el.append(h('button', { class: o[key] === v ? 'on' : '', onclick: () => { o[key] = v; draw(); redraw(); } }, l)); };
    draw(); return el;
  };
  const range = (key, min, max, label) => {
    const inp = h('input', { type: 'range', min, max, value: o[key], style: { width: '100%' } });
    inp.addEventListener('input', () => { o[key] = Number(inp.value); redraw(); });
    return h('label', { class: 'field' }, h('span', {}, label), inp);
  };
  const thumbs = new Map();
  const loadThumbs = Promise.all(photos.map((p) => new Promise((res) => {
    const im = new Image(); im.onload = () => { thumbs.set(p.id, im); res(); }; im.onerror = res; im.src = thumbUrl(p);
  })));
  async function redraw() {
    await loadThumbs;
    drawCollage(preview, 1200, (p) => thumbs.get(p.id), photos, o);
  }
  const body = h('div', { class: 'collage-layout' }, preview, h('div', {},
    h('label', { class: 'field' }, h('span', {}, t('Layout')), seg('layout', [['mosaic', t('Mosaic')], ['grid', t('Grid')], ['frame', t('Frames')]])),
    h('label', { class: 'field' }, h('span', {}, t('Shape')), seg('ratio', [[1.5, '3:2'], [1, '1:1'], [0.8, '4:5'], [16 / 9, '16:9']])),
    range('gap', 0, 40, t('Spacing')), range('radius', 0, 40, t('Rounded corners')),
    h('label', { class: 'field' }, h('span', {}, t('Background')), seg('bg', [['#ffffff', t('White')], ['#111111', t('Black')], ['#f3ead8', t('Cream')], ['#1f2a44', t('Navy')]])),
    h('p', { class: 'section-sub' }, t('{n} photos · exported at {w} px wide', { n: photos.length, w: o.width }))));
  redraw();
  modal({ title: t('Collage'), wide: true, body, actions: [{ label: t('Cancel') }, { label: t('Export collage'), primary: true, run: async () => {
    toast('Rendering collage…');
    const sources = new Map();
    for (const p of photos) {
      const bm = await loadBitmap(p);
      sources.set(p.id, renderEdited(bm, normalizeEdits(p.edits), 2400));
    }
    const cv = makeCanvas(1, 1);
    drawCollage(cv, o.width, (p) => sources.get(p.id), photos, o);
    const blob = await canvasToBlob(cv, 'image/jpeg', 0.92);
    const { path } = await api.exportBlob(blob, { name: 'Collage ' + new Date().toISOString().slice(0, 10), format: 'jpeg' });
    toast('Collage saved', { label: t('Show in folder'), run: () => api.revealPath(path) });
  } }] });
}

function drawCollage(cv, W, src, photos, o) {
  const H = Math.round(W / o.ratio);
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const k = W / 1200, gap = o.gap * k, rad = o.radius * k;
  ctx.fillStyle = o.bg; ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingQuality = 'high';
  const ar = (p) => { const s = src(p); return s ? (s.naturalWidth || s.width) / (s.naturalHeight || s.height) : 1.5; };
  const cells = [];
  if (o.layout === 'grid') {
    const n = photos.length, cols = Math.max(1, Math.round(Math.sqrt(n * o.ratio))), rows = Math.ceil(n / cols);
    const cw = (W - gap * (cols + 1)) / cols, ch = (H - gap * (rows + 1)) / rows;
    photos.forEach((p, i) => {
      const r = Math.floor(i / cols), inRow = r === rows - 1 ? n - r * cols : cols;
      const off = (W - (inRow * cw + (inRow + 1) * gap)) / 2;
      cells.push([p, off + gap + (i % cols) * (cw + gap), gap + r * (ch + gap), cw, ch]);
    });
  } else if (o.layout === 'mosaic') {
    // justified rows: choose the row count whose natural height best fits H
    const ars = photos.map(ar);
    let best = null;
    for (let rows = 1; rows <= photos.length; rows++) {
      const per = photos.length / rows, split = [];
      for (let r = 0; r < rows; r++) split.push([Math.round(r * per), Math.round((r + 1) * per)]);
      const heights = split.map(([a, b]) => (W - gap * (b - a + 1)) / ars.slice(a, b).reduce((s, x) => s + x, 0));
      const total = heights.reduce((s, x) => s + x, 0) + gap * (rows + 1);
      if (!best || Math.abs(total - H) < Math.abs(best.total - H)) best = { split, heights, total };
    }
    const scaleY = (H - gap * (best.split.length + 1)) / (best.total - gap * (best.split.length + 1));
    let y = gap;
    best.split.forEach(([a, b], r) => {
      const rh = best.heights[r] * scaleY;
      let x = gap;
      for (let i = a; i < b; i++) {
        const w = i === b - 1 ? W - gap - x : best.heights[r] * ars[i];
        cells.push([photos[i], x, y, w, rh]); x += w + gap;
      }
      y += rh + gap;
    });
  } else {
    // frames: scattered polaroid-style prints
    const n = photos.length, cols = Math.ceil(Math.sqrt(n * o.ratio)), rows = Math.ceil(n / cols);
    const cw = W / cols, ch = H / rows;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    photos.forEach((p, i) => {
      const cx = (i % cols + 0.5) * cw, cy = (Math.floor(i / cols) + 0.5) * ch;
      const s = Math.min(cw, ch) * 0.9, pad = s * 0.05;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate((rnd() - 0.5) * 0.25);
      ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 20 * k; ctx.shadowOffsetY = 6 * k;
      ctx.fillStyle = '#fff'; ctx.fillRect(-s / 2, -s / 2, s, s * 1.08);
      ctx.shadowColor = 'transparent';
      drawCover(ctx, src(p), -s / 2 + pad, -s / 2 + pad, s - pad * 2, s - pad * 2, 0);
      ctx.restore();
    });
    return;
  }
  for (const [p, x, y, w, hh] of cells) drawCover(ctx, src(p), x, y, w, hh, rad);
}

function drawCover(ctx, img, x, y, w, h, r) {
  if (!img) return;
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const s = Math.max(w / iw, h / ih), sw = w / s, sh = h / s;
  ctx.save();
  ctx.beginPath();
  if (r) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
  ctx.restore();
}

// ======================= map =======================
let map = null;
export function renderMap(content, photos) {
  if (!window.L) { content.append(emptyBox('map', t('Map unavailable'), t('The map library failed to load.'))); return; }
  if (!photos.length) {
    content.append(emptyBox('map', t('No photos with location'), t('Photos taken with GPS (most phones) appear here on a map.')));
    return;
  }
  const wrap = h('div', { class: 'map-wrap', style: { height: 'calc(100vh - 120px)' } }, h('div', { id: 'map' }));
  content.append(wrap);
  map?.remove();
  map = L.map($('#map'), { zoomControl: true, worldCopyJump: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  const pin = (p, n) => L.divIcon({ className: '', iconSize: [46, 46], iconAnchor: [23, 23],
    html: `<div class="map-pin" style="background-image:url('${p.thumb ? thumbUrl(p) : ''}')">${n > 1 ? `<b>${n}</b>` : ''}</div>` });
  const group = L.markerClusterGroup
    ? L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 60,
      iconCreateFunction: (c) => { const ms = c.getAllChildMarkers(); return pin(ms[0].photo, ms.length); } })
    : L.layerGroup();
  for (const p of photos) {
    const m = L.marker([p.gps.lat, p.gps.lon], { icon: pin(p, 1) });
    m.photo = p;
    m.on('click', async () => { const { openViewer } = await import('./viewer.js'); openViewer(photos, photos.indexOf(p)); });
    group.addLayer(m);
  }
  if (group.on) group.on('clusterclick', (e) => {
    const ps = e.layer.getAllChildMarkers().map((m) => m.photo);
    if (map.getZoom() >= 16) import('./viewer.js').then(({ openViewer }) => openViewer(ps, 0));
  });
  map.addLayer(group);
  const focus = state.view.focus && state.byId.get(state.view.focus);
  if (focus?.gps) map.setView([focus.gps.lat, focus.gps.lon], 15);
  else map.fitBounds(L.latLngBounds(photos.map((p) => [p.gps.lat, p.gps.lon])), { padding: [40, 40], maxZoom: 14 });
  setTimeout(() => map.invalidateSize(), 50);
}

// ======================= duplicates =======================
function popcnt(x) { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; }

export async function renderDuplicates(content) {
  const { tile } = await import('./app.js');
  const ps = state.photos.filter((p) => p.hash && !p.hidden);
  const pending = state.photos.filter((p) => !p.hash && !p.hidden).length;
  const n = ps.length;
  const hi = new Uint32Array(n), lo = new Uint32Array(n);
  ps.forEach((p, i) => { hi[i] = parseInt(p.hash.slice(0, 8), 16); lo[i] = parseInt(p.hash.slice(8), 16); });
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (popcnt(hi[i] ^ hi[j]) + popcnt(lo[i] ^ lo[j]) <= 4) {
        // near-identical hashes; also require similar aspect ratio
        const a = ps[i], b = ps[j];
        if (a.w && b.w && Math.abs(a.w / a.h - b.w / b.h) > 0.08) continue;
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(ps[i]); }
  const dupes = [...groups.values()].filter((g) => g.length > 1)
    .map((g) => g.sort((a, b) => b.w * b.h - a.w * a.h || b.size - a.size))
    .sort((a, b) => b.length - a.length);
  const extra = dupes.reduce((s, g) => s + g.slice(1).reduce((t, p) => t + p.size, 0), 0);

  if (!dupes.length) {
    content.append(emptyBox('dup', t('No duplicates found'), t('Captura compares a visual fingerprint of every photo, so resized and re-saved copies are found too.')
      + (pending ? ' ' + t('{n} photos are still being analyzed.', { n: pending }) : '')));
    return;
  }
  content.append(h('div', { class: 'section-title' }, t('{n} groups of look-alike photos', { n: dupes.length })),
    h('p', { class: 'section-sub' }, t('Extra copies use {size}. The best copy (highest resolution) is marked. Hiding keeps files on disk.', { size: fmtBytes(extra) })),
    pending ? h('p', { class: 'section-sub' }, t('{n} photos are still being analyzed.', { n: pending })) : '');
  if (dupes.length > 1) content.append(h('div', { style: { margin: '12px 0' } }, h('button', { class: 'btn', onclick: async () => {
    const ids = dupes.flatMap((g) => g.slice(1).map((p) => p.id));
    await patchPhotos(ids, { hidden: true });
    toast(t('Hid {n} extra copies', { n: ids.length }), { label: t('Undo'), run: () => patchPhotos(ids, { hidden: false }) });
  } }, t('Hide all extra copies'))));

  for (const g of dupes.slice(0, 200)) {
    content.append(h('div', { class: 'dup-group' },
      h('div', { class: 'dup-head' }, h('b', {}, t('{n} copies', { n: g.length })),
        h('button', { class: 'btn sm', onclick: async () => {
          const ids = g.slice(1).map((p) => p.id);
          await patchPhotos(ids, { hidden: true });
          toast(t('Hid {n} extra copies', { n: ids.length }), { label: t('Undo'), run: () => patchPhotos(ids, { hidden: false }) });
        } }, t('Keep best, hide others'))),
      h('div', { class: 'dup-items' }, g.map((p, i) => h('div', { class: 'dup-item' + (i === 0 ? ' best' : '') },
        tile(p, { selectable: true }),
        h('div', { class: 'dmeta' }, i === 0 ? h('span', { class: 'pill green' }, t('Best')) : null, ' ',
          `${p.w}×${p.h} · ${fmtBytes(p.size)}`, h('br'), p.path))))));
  }
}
