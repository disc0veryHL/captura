// Shared state, API client, thumbnail generation queue, small helpers.
import { t } from './i18n.js';
import { renderEdited, downscale, dHash, canvasToBlob, normalizeEdits } from './pipeline.js';

export const state = {
  photos: [],          // all photos (array)
  byId: new Map(),
  folders: [],
  albums: [],
  settings: {},
  view: { kind: 'photos', key: null },
  search: '',
  sort: 'date-desc',
  sel: new Set(),
  lastSel: null,
  scan: { running: false },
  current: [],         // photos in the current view, in display order
};

const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
export const emit = (what, data) => listeners.forEach((fn) => fn(what, data));

// ---------------- API ----------------
async function req(method, url, body, raw = false) {
  const opts = { method, headers: { 'x-lumen': '1' } };
  if (body instanceof Blob) { opts.body = body; }
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  const r = await fetch(url, opts);
  if (raw) return r;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
export const api = {
  library: () => req('GET', '/api/library'),
  scanStatus: () => req('GET', '/api/scan'),
  rescan: () => req('POST', '/api/scan', {}),
  addFolder: (p) => req('POST', '/api/folders', { path: p }),
  removeFolder: (p) => req('DELETE', '/api/folders?path=' + encodeURIComponent(p)),
  pickFolder: async () => (window.lumenNative?.pickFolder ? window.lumenNative.pickFolder() : (await req('POST', '/api/pick-folder', {})).path),
  reveal: (id) => (req('POST', '/api/reveal', { id })),
  revealPath: (p) => (req('POST', '/api/reveal', { path: p })),
  patch: (ids, patch) => req('PATCH', '/api/photos', { ids, patch }),
  settings: (s) => req('PATCH', '/api/settings', s),
  createAlbum: (name, ids) => req('POST', '/api/albums', { name, ids }),
  updateAlbum: (id, p) => req('PATCH', '/api/albums/' + id, p),
  deleteAlbum: (id) => req('DELETE', '/api/albums/' + id),
  putThumb: (id, v, hash, blob) => req('PUT', `/api/photo/${id}/thumb?v=${v}${hash ? '&hash=' + hash : ''}`, blob),
  exportBlob: (blob, { name, format, dir }) => req('POST', `/api/export?name=${encodeURIComponent(name)}&format=${format}${dir ? '&dir=' + encodeURIComponent(dir) : ''}`, blob),
};

export async function loadLibrary() {
  const lib = await api.library();
  state.folders = lib.folders;
  state.albums = lib.albums;
  state.settings = lib.settings || {};
  state.scan = lib.scan;
  state.photos = lib.photos;
  state.byId = new Map(lib.photos.map((p) => [p.id, p]));
  for (const id of [...state.sel]) if (!state.byId.has(id)) state.sel.delete(id);
  emit('library');
}

export async function patchPhotos(ids, patch) {
  if (!ids.length) return;
  const { photos } = await api.patch(ids, patch);
  for (const p of photos) {
    const old = state.byId.get(p.id);
    if (old) Object.assign(old, p);
  }
  if ('edits' in patch) for (const p of photos) enqueueThumb(p, true);
  emit('photos');
}

// ---------------- image loading ----------------
const bitmapCache = new Map(); // id -> Promise<ImageBitmap>
export function originalUrl(p) { return `/api/photo/${p.id}/original?m=${Math.round(p.mtime)}`; }
export function thumbUrl(p) { return p.thumb ? `/api/photo/${p.id}/thumb?v=${p.thumb}` : null; }

export function loadBitmap(p) {
  if (bitmapCache.has(p.id)) {
    const v = bitmapCache.get(p.id); bitmapCache.delete(p.id); bitmapCache.set(p.id, v); return v;
  }
  const prom = fetch(originalUrl(p)).then((r) => { if (!r.ok) throw new Error('Cannot read file'); return r.blob(); })
    .then((b) => createImageBitmap(b));
  prom.catch(() => bitmapCache.delete(p.id));
  bitmapCache.set(p.id, prom);
  while (bitmapCache.size > 4) {
    const [k, v] = bitmapCache.entries().next().value;
    bitmapCache.delete(k); v.then((bm) => bm.close?.()).catch(() => {});
  }
  return prom;
}

// ---------------- thumbnail queue ----------------
const THUMB_H = 600; // must match THUMB_GEN 2 in lib/server.mjs
const queue = [];
const queued = new Set();
let active = 0;
export const thumbProgress = { done: 0, total: 0, failed: new Set() };

export function enqueueThumb(p, front = false) {
  if (queued.has(p.id) || thumbProgress.failed.has(p.id)) return;
  queued.add(p.id);
  thumbProgress.total++;
  front ? queue.unshift(p.id) : queue.push(p.id);
  pump();
}
export function prioritize(id) {
  const i = queue.indexOf(id);
  if (i > 0) { queue.splice(i, 1); queue.unshift(id); }
}

function pump() {
  while (active < 3 && queue.length) {
    const id = queue.shift();
    active++;
    makeThumb(id).catch(() => thumbProgress.failed.add(id)).finally(() => {
      active--; queued.delete(id); thumbProgress.done++;
      if (!queue.length && !active) { thumbProgress.done = 0; thumbProgress.total = 0; }
      emit('thumbs');
      pump();
    });
  }
}

async function makeThumb(id) {
  const p = state.byId.get(id);
  if (!p) return;
  const r = await fetch(originalUrl(p));
  if (!r.ok) throw new Error('read failed');
  const bm = await createImageBitmap(await r.blob());
  try {
    if (!p.w || !p.h) { p.w = bm.width; p.h = bm.height; }
    // Thumbnails are sized by height (the grid is justified rows up to 360 px tall,
    // so 600 px keeps them sharp on high-DPI screens); panoramas capped at 1800 px wide.
    const small = downscale(bm, 2400);
    const hash = p.hash ? null : dHash(small);
    const v = p.editsV || 0;
    const e = normalizeEdits(p.edits);
    const ar = (e.rot % 2 ? small.height / small.width : small.width / small.height) * (e.crop ? e.crop.w / e.crop.h : 1);
    const cv = renderEdited(small, e, ar >= 1 ? Math.min(1800, Math.round(THUMB_H * ar)) : THUMB_H);
    const blob = await canvasToBlob(cv, 'image/jpeg', 0.86);
    const res = await api.putThumb(p.id, v, hash, blob);
    p.thumb = res.thumb; if (res.hash) p.hash = res.hash;
    document.querySelectorAll(`[data-id="${p.id}"] img.thumb`).forEach((img) => { img.src = thumbUrl(p); img.classList.add('ready'); });
    emit('thumb', p.id);
  } finally { bm.close(); }
}

// ---------------- helpers ----------------
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}
// One empty-state design for every view: centered icon tile, title, text, optional buttons.
export function emptyBox(ic, title, text, actions = []) {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-inner' },
    h('div', { class: 'art', html: icon(ic) }),
    h('div', { class: 'big' }, title),
    text ? h('div', { class: 'empty-text' }, text) : null,
    actions.length ? h('div', { class: 'row' }, actions) : null));
}
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ICONS = {
  photos: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  star: '<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z"/>',
  memories: '<path d="M12 8v4l3 2"/><circle cx="12" cy="12" r="9"/>',
  map: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  dup: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  hidden: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.1 3.9M6.6 6.6C3.9 8.3 2 12 2 12s4 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  album: '<path d="M4 5h16v14H4z"/><path d="M4 9h16"/><path d="M9 5v4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  pause: '<path d="M7 4h4v16H7zM14 4h4v16h-4z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m14 6 4 4"/>',
  rotate: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  rotateR: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  flip: '<path d="M12 3v18"/><path d="M8 7 3 12l5 5V7zM16 7l5 5-5 5V7z"/>',
  export: '<path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  reveal: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5 12 16l2.5-2.5"/>',
  collage: '<rect x="3" y="3" width="8" height="10" rx="1"/><rect x="13" y="3" width="8" height="6" rx="1"/><rect x="13" y="11" width="8" height="10" rx="1"/><rect x="3" y="15" width="8" height="6" rx="1"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 12A9 9 0 0 1 18.5 5.8L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  paste: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="M9 10h6M9 14h4"/>',
  wand: '<path d="m4 20 11-11"/><path d="m14 4 1 2 2 1-2 1-1 2-1-2-2-1 2-1zM19 11l.7 1.3L21 13l-1.3.7L19 15l-.7-1.3L17 13l1.3-.7z"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  filter: '<circle cx="9" cy="9" r="6"/><circle cx="15" cy="15" r="6"/>',
  compare: '<path d="M12 3v18"/><rect x="3" y="5" width="18" height="14" rx="2"/>',
  zoom: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M11 8v6M8 11h6"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  logo: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18" fill="currentColor"/>',
  restore: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  pin: '<path d="M9 3h6l-1 6 4 3v2H6v-2l4-3z"/><path d="M12 14v7"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  region: '<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><rect x="8" y="8" width="8" height="8" rx="1" stroke-dasharray="2 2"/>',
  window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/>',
  repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
};

// ---------------- appearance ----------------
export const ACCENTS = ['#7c8cff', '#4f9dff', '#22b8cf', '#2fbf71', '#f5b041', '#ff7a45', '#ff4f7b', '#b07cff'];

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let hh = 0, s = 0;
  if (d) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    hh = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hh *= 60;
  }
  return [hh, s, l];
}
const hsl = ([hh, s, l]) => `hsl(${Math.round(hh)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;

// Apply theme, accent color, thumbnail shape, spacing and viewer backdrop from settings.
export function applyAppearance(s = state.settings || {}) {
  const root = document.documentElement;
  let theme = s.theme || 'dark';
  if (theme === 'system') theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  root.dataset.theme = theme;
  const acc = /^#[0-9a-f]{6}$/i.test(s.accent || '') ? s.accent : null;
  if (acc) {
    const [hh, sat, l] = hexToHsl(acc);
    root.style.setProperty('--accent', acc);
    root.style.setProperty('--accent-2', hsl([(hh + 35) % 360, sat, l]));
    root.style.setProperty('--accent-ink', l > 0.62 ? '#0b0d1a' : '#ffffff');
  } else ['--accent', '--accent-2', '--accent-ink'].forEach((v) => root.style.removeProperty(v));
  root.dataset.shape = ['justified', 'square', 'rounded', 'squircle', 'bevel', 'custom'].includes(s.thumbShape) ? s.thumbShape : 'justified';
  root.style.setProperty('--tile-radius', (s.thumbRadius ?? 18) + '%');
  root.style.setProperty('--grid-gap', { compact: '2px', comfortable: '4px', spacious: '12px' }[s.gridGap] || '4px');
  root.dataset.badges = s.showBadges === false ? 'off' : 'on';
  root.style.setProperty('--pv-alpha', String(s.viewerOpacity ?? 0.92));
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (state.settings?.theme === 'system') applyAppearance(); });
export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < 2);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}
export const fmtDate = (ts, opts = { dateStyle: 'medium' }) => new Intl.DateTimeFormat(undefined, opts).format(new Date(ts));
export function fmtExposure(s) { if (!s) return null; return s >= 1 ? s + 's' : '1/' + Math.round(1 / s); }

let toastTimer;
export function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = '';
  t.append(h('span', {}, msg));
  if (action) t.append(h('button', { class: 'link', onclick: () => { action.run(); t.classList.remove('show'); } }, action.label));
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 7000 : 3500);
}

export function modal({ title, body, actions = [], wide = false, onClose }) {
  const root = $('#modal');
  root.innerHTML = '';
  const close = () => { root.classList.remove('show'); root.innerHTML = ''; onClose?.(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  const card = h('div', { class: 'modal-card' + (wide ? ' wide' : '') },
    h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', title: t('Close'), html: icon('close'), onclick: close })),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-foot' }, actions.map((a) => h('button', {
      class: 'btn ' + (a.primary ? 'primary' : a.danger ? 'danger' : ''),
      onclick: async () => { if ((await a.run?.()) !== false) close(); },
    }, a.label))) : null);
  root.append(card);
  root.onclick = (e) => { if (e.target === root) close(); };
  root.classList.add('show');
  setTimeout(() => card.querySelector('input,select,textarea')?.focus(), 30);
  return close;
}

export function prompt(title, value = '', label = t('Name')) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input', value, placeholder: label });
    let done = false;
    const close = modal({
      title, body: h('label', { class: 'field' }, h('span', {}, label), input),
      actions: [{ label: t('Cancel'), run: () => { done = true; resolve(null); } },
        { label: t('OK'), primary: true, run: () => { done = true; resolve(input.value.trim() || null); } }],
      onClose: () => { if (!done) resolve(null); },
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { done = true; resolve(input.value.trim() || null); close(); } });
  });
}
