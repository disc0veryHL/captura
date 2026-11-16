import {
  state, api, loadLibrary, patchPhotos, onChange, enqueueThumb, prioritize, thumbProgress,
  thumbUrl, $, $$, h, icon, toast, modal, prompt, fmtDate, applyAppearance, ACCENTS, emptyBox,
} from './store.js';
import { openViewer } from './viewer.js';
import { isKey, comboOf, ACTIONS, SCOPES, keysFor, defaultKeys, prettyCombo, conflicts } from './keys.js';
import { t, setLanguage, translateDom, LANGS } from './i18n.js';
import { startSlideshow, exportDialog, collageDialog, renderMap, renderDuplicates } from './tools.js';
import { isIdentity } from './pipeline.js';

const MONTH = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });

// ---------------- view selection ----------------
function visiblePhotos() {
  const v = state.view;
  let list = state.photos;
  switch (v.kind) {
    case 'hidden': list = list.filter((p) => p.hidden); break;
    case 'favorites': list = list.filter((p) => p.star && !p.hidden); break;
    case 'album': list = list.filter((p) => p.albums.includes(v.key)); break;
    case 'folder': list = list.filter((p) => p.folder === v.key); break;
    case 'screenshots': list = list.filter((p) => p.captured && !p.hidden); break;
    case 'set': { const ids = new Set(v.ids); list = list.filter((p) => ids.has(p.id)); break; }
    default: list = list.filter((p) => !p.hidden);
  }
  const q = state.search.trim().toLowerCase();
  if (q) {
    const albumName = new Map(state.albums.map((a) => [a.id, a.name.toLowerCase()]));
    const toks = q.split(/\s+/);
    list = list.filter((p) => {
      const hay = [p.name, p.folder, p.camera, p.lens, p.caption, ...p.tags, ...p.albums.map((a) => albumName.get(a)),
        MONTH.format(p.ts), new Date(p.ts).getFullYear()].filter(Boolean).join(' ').toLowerCase();
      return toks.every((t) => {
        if (t === 'is:fav' || t === 'is:favorite') return p.star;
        if (t === 'is:edited') return !isIdentity(p.edits);
        if (t === 'has:gps' || t === 'has:location') return !!p.gps;
        if (t === 'is:video') return false;
        return hay.includes(t);
      });
    });
  }
  const s = state.sort;
  list = [...list];
  if (s === 'date-desc') list.sort((a, b) => b.ts - a.ts);
  else if (s === 'date-asc') list.sort((a, b) => a.ts - b.ts);
  else if (s === 'name') list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  else if (s === 'size') list.sort((a, b) => b.size - a.size);
  return list;
}

function viewTitle() {
  const v = state.view;
  return {
    photos: t('Photos'), favorites: t('Favorites'), hidden: t('Hidden'), memories: t('Memories'), map: t('Places'), duplicates: t('Duplicates'), screenshots: t('Screenshots'),
    album: state.albums.find((a) => a.id === v.key)?.name || t('Album'),
    folder: v.key?.split(/[\\/]/).pop() || t('Folder'), set: v.title || t('Collection'),
  }[v.kind];
}

export function setView(view) {
  state.view = view;
  state.sel.clear();
  $('#content').scrollTop = 0;
  render();
}

// ---------------- sidebar ----------------
function navItem({ ic, label, count, active, onclick, cls = '', drop, title, ctx }) {
  const b = h('button', { class: `nav-item ${active ? 'active' : ''} ${cls}`, onclick, title: title || label, html: icon(ic) },
    h('span', { class: 'label' }, label), count != null ? h('span', { class: 'count' }, count) : null);
  if (drop) {
    b.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-lumen')) { e.preventDefault(); b.classList.add('drop'); } });
    b.addEventListener('dragleave', () => b.classList.remove('drop'));
    b.addEventListener('drop', (e) => { e.preventDefault(); b.classList.remove('drop'); drop(JSON.parse(e.dataTransfer.getData('application/x-lumen'))); });
  }
  if (ctx) b.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, ctx); });
  return b;
}

function renderSidebar() {
  const nav = $('#nav');
  const v = state.view;
  const all = state.photos.filter((p) => !p.hidden);
  const is = (k, key) => v.kind === k && (key === undefined || v.key === key);
  nav.innerHTML = '';

  nav.append(h('div', { class: 'nav-sec' },
    navItem({ ic: 'photos', label: t('Photos'), count: all.length, active: is('photos'), onclick: () => setView({ kind: 'photos' }) }),
    navItem({ ic: 'star', label: t('Favorites'), count: all.filter((p) => p.star).length, active: is('favorites'), onclick: () => setView({ kind: 'favorites' }),
      drop: (ids) => patchPhotos(ids, { star: true }).then(() => toast(t('Added {n} to Favorites', { n: ids.length }))) }),
    navItem({ ic: 'camera', label: t('Screenshots'), count: all.filter((p) => p.captured).length || null, active: is('screenshots'), onclick: () => setView({ kind: 'screenshots' }) }),
    navItem({ ic: 'memories', label: t('Memories'), active: is('memories'), onclick: () => setView({ kind: 'memories' }) }),
    navItem({ ic: 'map', label: t('Places'), count: all.filter((p) => p.gps).length || null, active: is('map'), onclick: () => setView({ kind: 'map' }) }),
    navItem({ ic: 'dup', label: t('Duplicates'), active: is('duplicates'), onclick: () => setView({ kind: 'duplicates' }) }),
    navItem({ ic: 'hidden', label: t('Hidden'), count: state.photos.length - all.length || null, active: is('hidden'), onclick: () => setView({ kind: 'hidden' }) }),
  ));

  const albums = h('div', { class: 'nav-sec' },
    h('div', { class: 'nav-head' }, h('span', {}, t('Albums')), h('button', { title: t('New album'), html: icon('plus'), onclick: () => newAlbum([]) })));
  if (!state.albums.length) albums.append(h('div', { class: 'nav-empty' }, t('Drag photos here or press + to create an album.')));
  for (const a of [...state.albums].sort((x, y) => x.name.localeCompare(y.name))) {
    albums.append(navItem({
      ic: 'album', label: a.name, count: state.photos.filter((p) => p.albums.includes(a.id)).length, active: is('album', a.id),
      onclick: () => setView({ kind: 'album', key: a.id }),
      drop: (ids) => patchPhotos(ids, { addAlbum: a.id }).then(() => toast(t('Added {n} to “{name}”', { n: ids.length, name: a.name }))),
      ctx: [
        { ic: 'edit', label: t('Rename'), run: async () => { const n = await prompt('Rename album', a.name); if (n) { await api.updateAlbum(a.id, { name: n }); await loadLibrary(); } } },
        { ic: 'play', label: t('Slideshow'), run: () => startSlideshow(state.photos.filter((p) => p.albums.includes(a.id)), 0) },
        { ic: 'collage', label: t('Make collage'), run: () => collageDialog(state.photos.filter((p) => p.albums.includes(a.id)).slice(0, 12)) },
        { ic: 'export', label: t('Export album…'), run: () => exportDialog(state.photos.filter((p) => p.albums.includes(a.id)), a.name) },
        '-',
        { ic: 'trash', label: t('Delete album'), danger: true, run: () => confirmDeleteAlbum(a) },
      ],
    }));
  }
  albums.append(navItem({ ic: 'plus', label: t('New album'), cls: 'muted', onclick: () => newAlbum([]), drop: (ids) => newAlbum(ids) }));
  nav.append(albums);

  const folders = h('div', { class: 'nav-sec' },
    h('div', { class: 'nav-head' }, h('span', {}, t('Folders')),
      h('span', {}, h('button', { title: t('Rescan folders'), html: icon('refresh'), onclick: rescan }), ' ',
        h('button', { title: t('Add folder'), html: icon('plus'), onclick: addFolder }))));
  const byFolder = new Map();
  for (const p of state.photos) {
    const f = byFolder.get(p.folder) || { root: p.root, n: 0, latest: 0 };
    f.n++; f.latest = Math.max(f.latest, p.ts); byFolder.set(p.folder, f);
  }
  if (!state.folders.length) folders.append(h('div', { class: 'nav-empty' }, t('No folders watched yet.')));
  for (const root of state.folders) {
    folders.append(h('div', { class: 'nav-root', title: root }, h('span', {}, root),
      h('button', { title: t('Stop watching this folder'), html: icon('close'), onclick: () => removeFolder(root) })));
    const subs = [...byFolder.entries()].filter(([, f]) => f.root === root).sort((a, b) => b[1].latest - a[1].latest);
    for (const [folder, f] of subs) {
      const rel = folder === root ? folder.split(/[\\/]/).pop() : folder.slice(root.length + 1);
      folders.append(navItem({ ic: 'folder', label: rel, count: f.n, cls: 'sub', title: folder, active: is('folder', folder),
        onclick: () => setView({ kind: 'folder', key: folder }),
        ctx: [
          { ic: 'reveal', label: t('Show in Explorer'), run: () => api.revealPath(folder) },
          { ic: 'play', label: t('Slideshow'), run: () => startSlideshow(state.photos.filter((p) => p.folder === folder && !p.hidden), 0) },
        ] }));
    }
  }
  nav.append(folders);
}

async function confirmDeleteAlbum(a) {
  modal({ title: t('Delete “{name}”?', { name: a.name }), body: h('p', {}, t('The album is removed. Your photos stay where they are.')),
    actions: [{ label: t('Cancel') }, { label: t('Delete album'), danger: true, run: async () => {
      await api.deleteAlbum(a.id); if (state.view.key === a.id) state.view = { kind: 'photos' }; await loadLibrary();
    } }] });
}

async function newAlbum(ids) {
  const name = await prompt('New album', '', t('Album name'));
  if (!name) return;
  const a = await api.createAlbum(name, ids);
  await loadLibrary();
  toast(ids.length ? t('Created “{name}” with {n} photos', { name: a.name, n: ids.length }) : t('Created “{name}”', { name: a.name }),
    { label: t('Open'), run: () => setView({ kind: 'album', key: a.id }) });
}

async function addFolder(pathArg) {
  const p = typeof pathArg === 'string' ? pathArg : await api.pickFolder();
  if (!p) return;
  try { await api.addFolder(p); toast('Scanning ' + p); await loadLibrary(); pollScan(); }
  catch (e) { toast(e.message); }
}
async function removeFolder(root) {
  modal({ title: t('Stop watching folder?'), body: h('p', {}, root, h('br'), h('small', { style: { color: 'var(--text-3)' } }, t('Files on disk are not touched. Albums, stars and edits for these photos are forgotten.'))),
    actions: [{ label: t('Cancel') }, { label: t('Remove'), danger: true, run: async () => { await api.removeFolder(root); await loadLibrary(); } }] });
}
async function rescan() { await api.rescan(); pollScan(); }

let pollTimer = null;
async function pollScan() {
  clearTimeout(pollTimer);
  const s = await api.scanStatus().catch(() => null);
  if (!s) return;
  state.scan = s;
  renderStatus();
  if (s.running) pollTimer = setTimeout(pollScan, 900);
  else { await loadLibrary(); queueMissingThumbs(); }
}

function renderStatus() {
  const el = $('#scan-status');
  const s = state.scan;
  el.innerHTML = '';
  if (s.running) {
    el.append(h('span', {}, t('Scanning… {n} photos', { n: s.done.toLocaleString() })));
    el.append(h('div', { class: 'progress' }, h('i', { style: { width: '35%' } })));
  } else if (thumbProgress.total) {
    const pct = Math.round((thumbProgress.done / thumbProgress.total) * 100);
    el.append(h('span', {}, t('Preparing previews {done} / {total}', { done: thumbProgress.done.toLocaleString(), total: thumbProgress.total.toLocaleString() })));
    el.append(h('div', { class: 'progress' }, h('i', { style: { width: pct + '%' } })));
  } else {
    el.append(h('span', {}, t('{n} photos · {f} folders', { n: state.photos.length.toLocaleString(), f: state.folders.length })));
    el.append(h('button', { class: 'btn ghost sm settings-btn', html: icon('gear') + t('Settings'), onclick: () => settingsDialog() }));
  }
}

function queueMissingThumbs() {
  for (const p of visiblePhotos()) if (!p.thumb) enqueueThumb(p);
  for (const p of state.photos) if (!p.thumb) enqueueThumb(p);
}

// ---------------- grid ----------------
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const id = e.target.dataset.id;
    const p = state.byId.get(id);
    if (p && !p.thumb) { enqueueThumb(p, true); prioritize(id); }
    io.unobserve(e.target);
  }
}, { root: null, rootMargin: '600px' });

export function tile(p, { selectable = true } = {}) {
  const ar = p.w && p.h ? Math.min(3, Math.max(0.4, p.w / p.h)) : 1.4;
  const t = h('div', {
    class: 'tile' + (state.sel.has(p.id) ? ' selected' : '') + (p.thumb ? ' has-thumb' : ''),
    'data-id': p.id, draggable: 'true',
    style: { width: `calc(${ar} * var(--thumb-h))`, flexGrow: ar },
  });
  const img = h('img', { class: 'thumb', alt: '', loading: 'lazy', decoding: 'async' });
  img.onload = () => { img.classList.add('ready'); t.classList.add('has-thumb'); };
  if (p.thumb) img.src = thumbUrl(p); else io.observe(t);
  t.append(img, h('div', { class: 'shade' }));
  if (selectable) t.append(h('div', { class: 'check', html: icon('check') }));
  t.append(h('button', { class: 'fav' + (p.star ? ' on' : ''), title: p.star ? t('Unfavorite') : t('Favorite'), html: icon('star'),
    onclick: (e) => { e.stopPropagation(); patchPhotos([p.id], { star: !p.star }); } }));
  const badges = [];
  if (!isIdentity(p.edits)) badges.push(h('span', { class: 'b', html: icon('edit') }));
  if (p.albums.length) badges.push(h('span', { class: 'b', html: icon('album') + p.albums.length }));
  if (badges.length) t.append(h('div', { class: 'badges' }, badges));
  t.append(h('div', { class: 'cap' }, p.caption || p.name));
  return t;
}

function renderGrid(list, content) {
  const grouped = state.sort.startsWith('date') && state.view.kind !== 'folder';
  const groups = [];
  if (grouped) {
    let cur = null;
    for (const p of list) {
      const d = new Date(p.ts), key = d.getFullYear() * 12 + d.getMonth();
      if (!cur || cur.key !== key) { cur = { key, title: MONTH.format(d), items: [] }; groups.push(cur); }
      cur.items.push(p);
    }
  } else {
    const title = state.view.kind === 'folder' ? state.view.key : '';
    for (let i = 0; i < list.length; i += 300) groups.push({ title: i ? '' : title, items: list.slice(i, i + 300) });
  }
  for (const g of groups) {
    const head = g.title !== undefined && (g.title || grouped) ? h('div', { class: 'group-head' },
      h('h3', {}, g.title),
      h('span', { class: 'meta' }, t('{n} photos', { n: g.items.length })),
      h('button', { class: 'btn sm ghost sel-all', onclick: () => { g.items.forEach((p) => state.sel.add(p.id)); refreshSelection(); } }, t('Select all'))) : null;
    content.append(h('div', { class: 'group', style: { containIntrinsicSize: `auto ${Math.ceil(g.items.length / 5) * 210 + 50}px` } },
      head, h('div', { class: 'grid' }, g.items.map((p) => tile(p)))));
  }
}

function emptyState(content) {
  const kind = state.view.kind;
  const [ic, title, text] = state.search ? ['search', t('No matches'), t('Nothing matches “{q}”. Try a year, month, camera, folder or tag.', { q: state.search })]
    : !state.folders.length ? ['photos', t('Welcome to Captura'), t('Add a folder with your photos. Captura indexes it locally and never changes your originals.')]
      : kind === 'favorites' ? ['star', t('No favorites yet'), t('Press S or click the star on any photo.')]
        : kind === 'album' ? ['album', t('This album is empty'), t('Drag photos onto the album in the sidebar, or use “Add to album”.')]
          : kind === 'hidden' ? ['hidden', t('Nothing hidden'), t('Hidden photos stay on disk but are kept out of your library views.')]
            : kind === 'screenshots' ? ['camera', t('No screenshots yet'), t('Press {key} to capture a region, or use the Capture button at the top.', { key: hotkeyLabel('region') || 'Ctrl + PrtSc' })]
              : kind === 'folder' ? ['folder', t('No photos in this folder'), '']
                : state.scan.running ? ['refresh', t('Scanning…'), t('Your photos will appear here in a moment.')] : ['photos', t('No photos here'), ''];
  const actions = !state.folders.length ? [h('button', { class: 'btn primary', onclick: addFolder, html: icon('plus') + t('Add folder') })]
    : kind === 'screenshots' && window.lumenNative ? [h('button', { class: 'btn primary', onclick: () => startCapture('region'), html: icon('region') + t('Capture region') })] : [];
  content.append(emptyBox(ic, title, text, actions));
}

// ---------------- memories ----------------
function renderMemories(content) {
  const photos = state.photos.filter((p) => !p.hidden && p.thumb !== undefined);
  const now = new Date();
  const cards = [];
  const byYear = new Map();
  for (const p of photos) {
    const d = new Date(p.ts);
    if (d.getFullYear() === now.getFullYear()) continue;
    const diff = Math.abs((new Date(now.getFullYear(), d.getMonth(), d.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5);
    if (diff <= 3) { const y = d.getFullYear(); if (!byYear.has(y)) byYear.set(y, []); byYear.get(y).push(p); }
  }
  for (const [y, ps] of [...byYear.entries()].sort((a, b) => b[0] - a[0])) {
    const n = now.getFullYear() - y;
    cards.push({ title: t(n > 1 ? '{n} years ago' : '1 year ago', { n }), sub: t('This week in {y} · {n} photos', { y, n: ps.length }), ps });
  }
  const sec1 = h('div', {}, h('div', { class: 'section-title' }, t('On this day')),
    h('p', { class: 'section-sub' }, t('Photos taken around this date in past years.')));
  content.append(sec1);
  if (cards.length) content.append(h('div', { class: 'mem-row' }, cards.map(memCard)));
  else content.append(h('p', { class: 'section-sub', style: { marginTop: '10px' } }, t('Nothing from this week in earlier years.')));

  // trips/events: clusters of photos dense in time (≥ 12 photos within 4 days)
  const sorted = [...photos].sort((a, b) => a.ts - b.ts);
  const events = [];
  let cur = [];
  for (const p of sorted) {
    if (cur.length && p.ts - cur[cur.length - 1].ts > 2 * 864e5) { if (cur.length >= 12) events.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length >= 12) events.push(cur);
  events.sort((a, b) => b[0].ts - a[0].ts);
  content.append(h('div', { class: 'section-title' }, t('Moments')), h('p', { class: 'section-sub' }, t('Days with lots of photos, grouped automatically.')));
  if (events.length) {
    content.append(h('div', { class: 'mem-row' }, events.slice(0, 24).map((ps) => {
      const a = ps[0].ts, b = ps[ps.length - 1].ts;
      const folder = mostCommon(ps.map((p) => p.folder.split(/[\\/]/).pop()));
      const range = fmtDate(a) === fmtDate(b) ? fmtDate(a) : `${fmtDate(a, { month: 'short', day: 'numeric' })} – ${fmtDate(b)}`;
      return memCard({ title: folder, sub: `${range} · ${t('{n} photos', { n: ps.length })}`, ps });
    })));
  } else content.append(h('p', { class: 'section-sub', style: { marginTop: '10px' } }, t('No moments yet.')));

  const favs = photos.filter((p) => p.star);
  // nothing to show at all: same empty state as every other view
  if (!cards.length && !events.length && favs.length < 3) {
    content.innerHTML = '';
    content.append(emptyBox('memories', t('No memories yet'), t('Memories appear when you have photos from past years, days with many photos, or at least 3 favorites.')));
    return;
  }
  if (favs.length >= 3) {
    content.append(h('div', { class: 'section-title' }, t('Highlights')), h('p', { class: 'section-sub' }, t('A shuffle of your favorites.')));
    const shuffled = [...favs].sort(() => Math.random() - 0.5);
    content.append(h('div', { class: 'mem-row' }, memCard({ title: t('Best of your library'), sub: t('{n} favorites', { n: favs.length }), ps: shuffled })));
  }
}
function mostCommon(arr) { const m = new Map(); let best = arr[0], n = 0; for (const x of arr) { const c = (m.get(x) || 0) + 1; m.set(x, c); if (c > n) { n = c; best = x; } } return best; }
function memCard({ title, sub, ps }) {
  const cover = ps.find((p) => p.star && p.thumb) || ps.find((p) => p.thumb) || ps[0];
  const img = h('img', { alt: '', loading: 'lazy' });
  if (cover.thumb) img.src = thumbUrl(cover);
  return h('div', { class: 'mem-card', onclick: () => setView({ kind: 'set', title, ids: ps.map((p) => p.id) }) }, img,
    h('div', { class: 'mem-text' }, h('b', {}, title), h('span', {}, sub)),
    h('button', { class: 'icon-btn', style: { position: 'absolute', top: '10px', right: '10px', color: '#fff' }, title: t('Play as slideshow'), html: icon('play'),
      onclick: (e) => { e.stopPropagation(); startSlideshow(ps, 0); } }));
}

// ---------------- render ----------------
export function render() {
  renderSidebar();
  renderStatus();
  const content = $('#content');
  content.innerHTML = '';
  content.classList.toggle('selecting', state.sel.size > 0);
  $('#view-title').textContent = viewTitle();
  const kind = state.view.kind;
  if (kind === 'memories') { state.current = []; $('#view-sub').textContent = t('Rediscover your photos'); renderMemories(content); }
  else if (kind === 'map') { state.current = visiblePhotos().filter((p) => p.gps); $('#view-sub').textContent = t('{n} photos with location', { n: state.current.length }); renderMap(content, state.current); }
  else if (kind === 'duplicates') { state.current = []; $('#view-sub').textContent = t('Similar and identical photos'); renderDuplicates(content); }
  else {
    const list = visiblePhotos();
    state.current = list;
    const sz = list.reduce((s, p) => s + p.size, 0);
    $('#view-sub').textContent = list.length ? `${t('{n} photos', { n: list.length.toLocaleString() })} · ${(sz / 1048576).toFixed(sz > 1048576 * 1024 ? 0 : 1)} MB` : '';
    if (!list.length) emptyState(content); else renderGrid(list, content);
  }
  renderSelbar();
}

// ---------------- selection ----------------
function refreshSelection() {
  $$('.tile[data-id]', $('#content')).forEach((t) => t.classList.toggle('selected', state.sel.has(t.dataset.id)));
  $('#content').classList.toggle('selecting', state.sel.size > 0);
  renderSelbar();
}
function selected() { return [...state.sel].map((id) => state.byId.get(id)).filter(Boolean); }

function renderSelbar() {
  const bar = $('#selbar');
  const n = state.sel.size;
  bar.classList.toggle('show', n > 0);
  if (!n) return;
  const ps = selected();
  const allStar = ps.every((p) => p.star), allHidden = ps.every((p) => p.hidden);
  const ib = (ic, title, run, cls = '') => h('button', { class: 'icon-btn ' + cls, title, html: icon(ic), onclick: run });
  bar.innerHTML = '';
  bar.append(...[h('span', { class: 'count' }, t('{n} selected', { n })),
    ib('star', allStar ? t('Unfavorite') : t('Favorite (S)'), () => patchPhotos([...state.sel], { star: !allStar }), allStar ? 'star-on' : ''),
    ib('album', t('Add to album'), () => albumPicker([...state.sel])),
    ib('tag', t('Add tag'), async () => { const tag = await prompt(t('Add tag'), '', t('Tag')); if (tag) { await patchPhotos([...state.sel], { addTag: tag }); toast(t('Tagged {n} photos “{tag}”', { n, tag })); } }),
    h('span', { class: 'sep' }),
    ib('play', t('Slideshow'), () => startSlideshow(ps, 0)),
    ib('collage', t('Make collage'), () => collageDialog(ps.slice(0, 16))),
    ib('export', t('Export'), () => exportDialog(ps)),
    state.editClipboard ? ib('paste', t('Paste edits'), () => pasteEdits([...state.sel])) : null,
    ib(allHidden ? 'photos' : 'hidden', allHidden ? t('Unhide') : t('Hide (H)'), () => toggleHidden([...state.sel], !allHidden)),
    h('span', { class: 'sep' }),
    ib('close', t('Clear selection (Esc)'), () => { state.sel.clear(); refreshSelection(); })].filter(Boolean));
}

async function toggleHidden(ids, hidden) {
  await patchPhotos(ids, { hidden });
  state.sel.clear();
  toast(t(hidden ? 'Hid {n} photos' : 'Unhid {n} photos', { n: ids.length }), { label: t('Undo'), run: () => patchPhotos(ids, { hidden: !hidden }) });
}

export async function pasteEdits(ids) {
  if (!state.editClipboard) return;
  await patchPhotos(ids, { edits: state.editClipboard });
  toast(t('Pasted edits to {n} photos', { n: ids.length }));
}

export function albumPicker(ids) {
  const list = h('div', { class: 'album-pick' });
  let close;
  for (const a of state.albums) {
    list.append(h('button', { class: 'btn ghost', html: icon('album') + a.name, onclick: async () => {
      close(); await patchPhotos(ids, { addAlbum: a.id }); toast(t('Added {n} to “{name}”', { n: ids.length, name: a.name }));
    } }));
  }
  if (!state.albums.length) list.append(h('p', { class: 'section-sub' }, t('No albums yet.')));
  close = modal({ title: t('Add to album'), body: list, actions: [{ label: t('New album…'), primary: true, run: () => { setTimeout(() => newAlbum(ids), 0); } }] });
}

// ---------------- context menu ----------------
function showMenu(x, y, items) {
  const m = $('#ctxmenu');
  m.innerHTML = '';
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { m.append(h('hr')); continue; }
    m.append(h('button', { html: icon(it.ic) + `<span>${it.label}</span>` + (it.k ? `<span class="k">${it.k}</span>` : ''),
      style: it.danger ? { color: 'var(--danger)' } : null, onclick: () => { hideMenu(); it.run(); } }));
  }
  m.classList.add('show');
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}
function hideMenu() { $('#ctxmenu').classList.remove('show'); }
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctxmenu')) hideMenu(); });

function tileMenu(p, x, y) {
  if (!state.sel.has(p.id)) { state.sel.clear(); state.sel.add(p.id); refreshSelection(); }
  const ids = [...state.sel], many = ids.length > 1;
  const ps = selected();
  const idx = state.current.indexOf(p);
  showMenu(x, y, [
    !many && { ic: 'zoom', label: t('Open'), k: 'Enter', run: () => openViewer(state.current, idx) },
    !many && { ic: 'edit', label: t('Edit'), k: 'E', run: () => openViewer(state.current, idx, { edit: true }) },
    { ic: 'star', label: ps.every((q) => q.star) ? t('Unfavorite') : t('Favorite'), k: 'S', run: () => patchPhotos(ids, { star: !ps.every((q) => q.star) }) },
    { ic: 'album', label: t('Add to album…'), run: () => albumPicker(ids) },
    '-',
    { ic: 'play', label: many ? t('Slideshow of selection') : t('Slideshow from here'), run: () => (many ? startSlideshow(ps, 0) : startSlideshow(state.current, idx)) },
    many && { ic: 'collage', label: t('Make collage'), run: () => collageDialog(ps.slice(0, 16)) },
    { ic: 'export', label: t('Export…'), run: () => exportDialog(ps) },
    !many && { ic: 'reveal', label: t('Show in Explorer'), run: () => api.reveal(p.id) },
    !many && window.lumenNative && { ic: 'pin', label: t('Annotate in screenshot editor'), run: () => window.lumenNative.win('editor', p.id) },
    '-',
    !many && !isIdentity(p.edits) && { ic: 'copy', label: t('Copy edits'), run: () => { state.editClipboard = p.edits; toast('Edits copied'); renderSelbar(); } },
    state.editClipboard && { ic: 'paste', label: many ? t('Paste edits to {n}', { n: ids.length }) : t('Paste edits'), run: () => pasteEdits(ids) },
    !isIdentity(p.edits) && { ic: 'undo', label: t('Revert to original'), run: () => patchPhotos(ids, { edits: null }) },
    { ic: p.hidden ? 'photos' : 'hidden', label: p.hidden ? t('Unhide') : t('Hide'), k: 'H', run: () => toggleHidden(ids, !p.hidden) },
  ]);
}

// ---------------- events ----------------
const content = $('#content');
content.addEventListener('click', (e) => {
  const t = e.target.closest('.tile[data-id]');
  if (!t || e.target.closest('.fav')) return;
  const id = t.dataset.id;
  const p = state.byId.get(id);
  const inSet = state.current.includes(p);
  if (e.shiftKey && state.lastSel && inSet) {
    const a = state.current.findIndex((x) => x.id === state.lastSel), b = state.current.indexOf(p);
    if (a >= 0) { const [lo, hi] = a < b ? [a, b] : [b, a]; for (let i = lo; i <= hi; i++) state.sel.add(state.current[i].id); }
  } else if (e.ctrlKey || e.metaKey || e.target.closest('.check') || state.sel.size) {
    state.sel.has(id) ? state.sel.delete(id) : state.sel.add(id);
    state.lastSel = id;
  } else {
    const list = inSet ? state.current : t.closest('.dup-items') ? [...t.closest('.dup-items').querySelectorAll('.tile')].map((x) => state.byId.get(x.dataset.id)) : [p];
    return openViewer(list, list.indexOf(p));
  }
  refreshSelection();
});
content.addEventListener('dblclick', (e) => {
  const t = e.target.closest('.tile[data-id]');
  if (t && state.sel.size) { const p = state.byId.get(t.dataset.id); openViewer(state.current, state.current.indexOf(p)); }
});
content.addEventListener('contextmenu', (e) => {
  const t = e.target.closest('.tile[data-id]');
  if (!t) return;
  e.preventDefault();
  tileMenu(state.byId.get(t.dataset.id), e.clientX, e.clientY);
});
content.addEventListener('dragstart', (e) => {
  const t = e.target.closest('.tile[data-id]');
  if (!t) return;
  const ids = state.sel.has(t.dataset.id) ? [...state.sel] : [t.dataset.id];
  e.dataTransfer.setData('application/x-lumen', JSON.stringify(ids));
  e.dataTransfer.effectAllowed = 'copy';
});

// drop a folder from Explorer to add it
let dragDepth = 0;
const isFileDrag = (e) => e.dataTransfer?.types.includes('Files');
window.addEventListener('dragenter', (e) => { if (isFileDrag(e)) { dragDepth++; $('#drop-hint').classList.add('show'); } });
window.addEventListener('dragleave', (e) => { if (isFileDrag(e) && --dragDepth <= 0) { dragDepth = 0; $('#drop-hint').classList.remove('show'); } });
window.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault(); dragDepth = 0; $('#drop-hint').classList.remove('show');
  const f = e.dataTransfer.files[0];
  const p = f && (window.lumenNative?.pathForFile?.(f) || f.path);
  if (!p) return toast('Use the + next to Folders to add a folder.');
  addFolder(/\.[a-z0-9]{2,5}$/i.test(p) ? p.replace(/[\\/][^\\/]+$/, '') : p);
});

let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = e.target.value;
    if (['memories', 'map', 'duplicates'].includes(state.view.kind) && state.search) state.view = { kind: 'photos' };
    render();
  }, 160);
});
$('.search-ic').innerHTML = icon('search');
$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });

function applyZoom(v) { document.documentElement.style.setProperty('--thumb-h', v + 'px'); }
$('#zoom').addEventListener('input', (e) => { applyZoom(e.target.value); });
$('#zoom').addEventListener('change', (e) => api.settings({ thumbSize: Number(e.target.value) }));

function syncThemeButton() { $('#btn-theme').innerHTML = icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon'); }
$('#btn-theme').addEventListener('click', () => {
  setSetting('theme', document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

// ---------------- settings ----------------
function langSelect() {
  const sel = h('select', { class: 'select' }, LANGS.map(([code, name]) =>
    h('option', { value: code, selected: (state.settings.language || 'auto') === code }, code === 'auto' ? t(name) : name)));
  sel.addEventListener('change', async () => {
    await setSetting('language', sel.value === 'auto' ? null : sel.value);
    await window.lumenNative?.win('language');
    location.reload();
  });
  return sel;
}
function setSetting(k, v) {
  state.settings = { ...state.settings, [k]: v };
  if (v === null) delete state.settings[k];
  applyAppearance(state.settings);
  syncThemeButton();
  return api.settings({ [k]: v }).catch(() => toast('Could not save settings'));
}

export function settingsDialog(section = 'appearance') {
  const s = () => state.settings;
  const body = h('div', { class: 'settings' });
  const nav = h('div', { class: 'settings-nav' });
  const pane = h('div', {});
  const sections = [['appearance', 'sun', t('Appearance')], ['viewer', 'photos', t('Photo viewer')], ['capture', 'camera', t('Screenshots')], ['library', 'folder', t('Library')], ['keys', 'keyboard', t('Shortcuts')]];
  const row = (title, sub, control, stack = false) => h('div', { class: 'set-row' + (stack ? ' stack' : '') }, h('div', { class: 'lbl' }, h('b', {}, title), sub ? h('span', {}, sub) : null), control);
  const seg = (key, items, def) => {
    const el = h('div', { class: 'seg' });
    const draw = () => { el.innerHTML = ''; for (const [v, l] of items) el.append(h('button', { class: (s()[key] ?? def) === v ? 'on' : '', onclick: () => { setSetting(key, v); draw(); } }, l)); };
    draw(); return el;
  };
  const sw = (key, def = true) => {
    const b = h('button', { class: 'switch' + ((s()[key] ?? def) ? ' on' : ''), role: 'switch' });
    b.onclick = () => { const v = !(s()[key] ?? def); setSetting(key, v); b.classList.toggle('on', v); };
    return b;
  };

  const draw = {
    appearance() {
      const swatches = h('div', { class: 'swatches' });
      const drawSw = () => {
        swatches.innerHTML = '';
        const cur = s().accent || null;
        swatches.append(h('button', { class: 'swatch' + (!cur ? ' on' : ''), title: t('Default'), style: { background: 'linear-gradient(135deg,#7c8cff,#b48cff)' }, onclick: () => { setSetting('accent', null); drawSw(); } }));
        for (const c of ACCENTS.slice(1)) swatches.append(h('button', { class: 'swatch' + (cur === c ? ' on' : ''), title: c, style: { background: c }, onclick: () => { setSetting('accent', c); drawSw(); } }));
        const pick = h('input', { type: 'color', value: cur || '#7c8cff' });
        pick.addEventListener('input', () => { setSetting('accent', pick.value); });
        pick.addEventListener('change', drawSw);
        swatches.append(h('label', { class: 'swatch custom' + (cur && !ACCENTS.includes(cur) ? ' on' : ''), title: t('Custom color') }, pick));
      };
      drawSw();
      const shapes = h('div', { class: 'shape-pick' });
      const SHAPES = [
        ['justified', t('Original'), t('Real proportions')], ['square', t('Square'), t('Even grid')], ['rounded', t('Rounded'), t('Soft corners')],
        ['squircle', t('Squircle'), t('Apple-style')], ['bevel', t('Bevel'), t('Cut corners')], ['custom', t('Custom'), t('Roundness slider')],
      ];
      const styleDemo = (el, v) => {
        el.style.borderRadius = { justified: '4px', square: '3px', rounded: '16%', squircle: '34%', bevel: '0', custom: 'var(--tile-radius, 18%)' }[v];
        if (v === 'squircle') el.style.setProperty('corner-shape', 'squircle');
        if (v === 'bevel') el.style.clipPath = 'polygon(14% 0,86% 0,100% 14%,100% 86%,86% 100%,14% 100%,0 86%,0 14%)';
      };
      const radiusOut = h('output', {}, (s().thumbRadius ?? 18) + '%');
      const radiusIn = h('input', { type: 'range', min: 0, max: 50, value: s().thumbRadius ?? 18 });
      radiusIn.addEventListener('input', () => {
        radiusOut.textContent = radiusIn.value + '%';
        state.settings.thumbRadius = Number(radiusIn.value);
        applyAppearance(state.settings);
      });
      radiusIn.addEventListener('change', () => setSetting('thumbRadius', Number(radiusIn.value)));
      const radiusRow = h('div', { class: 'radius-row' }, h('span', {}, t('Corner roundness')), radiusIn, radiusOut);
      const drawShapes = () => {
        shapes.innerHTML = '';
        const cur = s().thumbShape || 'justified';
        for (const [v, l, sub] of SHAPES) {
          const widths = v === 'justified' ? [18, 32, 24] : [24, 24, 24];
          const demoEl = h('div', { class: 'shape-demo' }, widths.map((w) => { const i = h('i', { style: { width: w + 'px' } }); styleDemo(i, v); return i; }));
          shapes.append(h('button', { class: cur === v ? 'on' : '', onclick: () => { setSetting('thumbShape', v); drawShapes(); } }, demoEl, l, h('small', {}, sub)));
        }
        radiusRow.style.display = cur === 'custom' ? '' : 'none';
      };
      drawShapes();
      const size = h('input', { type: 'range', min: 120, max: 360, step: 10, value: s().thumbSize || 200 });
      size.addEventListener('input', () => { $('#zoom').value = size.value; applyZoom(size.value); });
      size.addEventListener('change', () => setSetting('thumbSize', Number(size.value)));
      pane.append(
        row(t('Language'), t('Captura restarts its window to switch language'), langSelect()),
        row(t('Theme'), t('Follow Windows or pick one'), seg('theme', [['dark', t('Dark')], ['light', t('Light')], ['system', t('System')]], 'dark')),
        row(t('Accent color'), t('Used for buttons, selection and highlights'), swatches, true),
        row(t('Thumbnail shape'), t('How previews look in the photo grid'), h('div', {}, shapes, radiusRow), true),
        row(t('Thumbnail size'), null, size),
        row(t('Spacing'), t('Gap between thumbnails'), seg('gridGap', [['compact', t('Compact')], ['comfortable', t('Normal')], ['spacious', t('Spacious')]], 'comfortable')),
        row(t('Show badges'), t('Edited / album markers on thumbnails'), sw('showBadges')),
        h('div', { style: { marginTop: '14px' } }, h('button', { class: 'btn sm', onclick: () => {
          for (const k of ['theme', 'accent', 'thumbShape', 'gridGap', 'showBadges']) setSetting(k, null);
          render(); open('appearance');
        } }, t('Reset appearance'))));
    },
    viewer() {
      const op = h('input', { type: 'range', min: 50, max: 100, value: Math.round((s().viewerOpacity ?? 0.92) * 100) });
      op.addEventListener('input', () => { state.settings.viewerOpacity = op.value / 100; applyAppearance(state.settings); });
      op.addEventListener('change', () => setSetting('viewerOpacity', op.value / 100));
      const secs = h('select', { class: 'select' }, [3, 5, 8, 12].map((n) => h('option', { value: n, selected: (s().slideSeconds || 5) === n }, t('{n} seconds', { n }))));
      secs.addEventListener('change', () => setSetting('slideSeconds', Number(secs.value)));
      pane.append(
        row(t('Open photos in full screen'), t('Click the empty area or the window button to switch to window mode'), sw('viewerFullscreen')),
        row(t('Mouse wheel'), t('The other action works while holding Ctrl'), seg('wheelZoom', [[true, t('Zooms')], [false, t('Changes photo')]], true)),
        row(t('Filmstrip'), null, seg('filmstrip', [['3d', '3D'], ['flat', t('Flat')]], '3d')),
        row(t('Backdrop darkness'), null, op),
        row(t('Auto-hide action bar'), t('Hide controls when the mouse is still'), sw('autoHideBar')),
        row(t('Slideshow speed'), null, secs));
    },
    library() {
      const dir = h('input', { class: 'input', value: s().exportDir || '' });
      dir.addEventListener('change', () => setSetting('exportDir', dir.value));
      pane.append(
        row(t('Export folder'), t('Where exports and collages are saved'), h('div', { class: 'dir-row', style: { minWidth: '360px' } }, dir,
          h('button', { class: 'btn', onclick: async () => { const p = await api.pickFolder(); if (p) { dir.value = p; setSetting('exportDir', p); } } }, t('Browse…')))),
        row(t('Watched folders'), state.folders.join('\n') || t('None'), h('div', { style: { display: 'flex', gap: '8px' } },
          h('button', { class: 'btn', html: icon('plus') + t('Add folder'), onclick: addFolder }),
          h('button', { class: 'btn', html: icon('refresh') + t('Rescan'), onclick: rescan }))),
        row(t('Your originals'), t('Captura never changes your photo files. Edits, stars and albums are stored in Captura’s own library.'), h('span')));
    },
    async capture() {
      const nat = window.lumenNative;
      if (!nat) { pane.append(h('p', { class: 'section-sub' }, t('Screen capture settings are available in the Captura app.'))); return; }
      // after-capture tasks
      const after = () => ({ save: true, copy: true, editor: true, notify: true, ...(s().afterCapture || {}) });
      const afterSw = (key) => {
        const b = h('button', { class: 'switch' + (after()[key] ? ' on' : ''), role: 'switch' });
        b.onclick = () => { const a = after(); a[key] = !a[key]; setSetting('afterCapture', a); b.classList.toggle('on', a[key]); };
        return b;
      };
      const dir = h('input', { class: 'input', value: s().screenshotDir || '', placeholder: 'Pictures\\Captura\\Screenshots' });
      dir.addEventListener('change', () => setSetting('screenshotDir', dir.value.trim() || null));
      // hotkeys with a recorder
      const { status, defaults } = await nat.win('hotkey-status');
      const hkRows = h('div', {});
      const names = { region: t('Capture region'), window: t('Capture active window'), screen: t('Capture full screen'), last: t('Repeat last region') };
      const KEYNAME = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc' };
      const drawHk = (st) => {
        hkRows.innerHTML = '';
        const hk = { ...defaults, ...(s().hotkeys || {}) };
        for (const mode of Object.keys(names)) {
          const inp = h('input', { class: 'input', readonly: true, value: hk[mode] ? hotkeyLabel(mode) : t('None'), style: { width: '210px', textAlign: 'center', cursor: 'pointer' } });
          const commit = async (acc) => {
            await setSetting('hotkeys', { ...(s().hotkeys || {}), [mode]: acc });
            drawHk(await nat.win('hotkeys'));
          };
          const rec = (e) => {
            e.preventDefault(); e.stopPropagation();
            if (e.key === 'Escape') return inp.blur();
            if (e.key === 'Backspace' || e.key === 'Delete') return commit('');
            if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
            const k = KEYNAME[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
            commit([e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super', k].filter(Boolean).join('+'));
          };
          // pause global hotkeys while recording, or they would fire instead of reaching this box
          inp.addEventListener('focus', () => { inp.value = t('Press keys…'); nat.win('hotkeys-off'); });
          inp.addEventListener('blur', async () => drawHk(await nat.win('hotkeys')));
          inp.addEventListener('keydown', rec);
          inp.addEventListener('keyup', (e) => { if (e.key === 'PrintScreen') rec(e); }); // Windows sends Print Screen on key-up only
          const badge = st?.[mode] === 'ok' ? h('span', { class: 'pill green' }, 'active') : st?.[mode] === 'taken' ? h('span', { class: 'pill', style: { color: 'var(--danger)' } }, 'in use by another app') : h('span', { class: 'pill' }, 'off');
          hkRows.append(row(names[mode], null, h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, badge, inp,
            h('button', { class: 'btn sm', title: t('Restore default'), onclick: () => commit(defaults[mode]) }, t('Default')))));
        }
      };
      drawHk(status);
      const login = h('button', { class: 'switch' + ((await nat.win('login-item')) ? ' on' : ''), role: 'switch' });
      login.onclick = async () => login.classList.toggle('on', await nat.win('login-item', !login.classList.contains('on')));
      pane.append(
        row(t('Save folder'), t('Screenshots are saved here in monthly folders and appear under Screenshots'), h('div', { class: 'dir-row', style: { minWidth: '360px' } }, dir,
          h('button', { class: 'btn', onclick: async () => { const p = await api.pickFolder(); if (p) { dir.value = p; setSetting('screenshotDir', p); } } }, t('Browse…')))),
        row(t('Copy to clipboard'), t('After every capture'), afterSw('copy')),
        row(t('Open in editor'), t('Annotate, blur and crop right after capturing'), afterSw('editor')),
        row(t('Show notification'), t('Click it to open the editor'), afterSw('notify')),
        row(t('Keep the file'), t('Off: clipboard only (when the editor is off too)'), afterSw('save')),
        h('div', { class: 'ed-group', style: { margin: '18px 0 0', color: 'var(--text-3)' } }, t('Hotkeys — click a box and press the keys, Backspace clears')),
        hkRows,
        h('p', { class: 'section-sub', style: { marginTop: '8px' } }, t('If Print Screen does nothing: Windows Settings → Accessibility → Keyboard → turn off “Use the Print screen key to open screen capture”.')),
        row(t('Keep running in the tray'), t('Hotkeys keep working after the window is closed'), sw('trayOnClose')),
        row(t('Start with Windows'), t('Starts quietly in the tray'), login));
    },
    keys() {
      pane.append(shortcutsTable());
    },
  };
  function open(id) {
    section = id;
    nav.innerHTML = '';
    for (const [k, ic, label] of sections) nav.append(h('button', { class: k === id ? 'on' : '', html: icon(ic) + label, onclick: () => open(k) }));
    pane.innerHTML = '';
    draw[id]();
  }
  body.append(nav, pane);
  open(section);
  modal({ title: t('Settings'), body, wide: true });
}
$('#btn-slideshow').innerHTML = icon('play');

// ---------------- capture (ShareX-style) ----------------
const CAPTURE_MODES = [
  ['region', 'region', t('Region'), t('Drag an area or click a window')], ['window', 'window', t('Active window'), ''],
  ['screen', 'monitor', t('Full screen'), t('The screen under the mouse')], ['last', 'repeat', t('Last region'), ''],
];
function hotkeyLabel(mode) {
  const hk = { region: 'Control+PrintScreen', screen: 'PrintScreen', window: 'Alt+PrintScreen', last: 'Control+Shift+PrintScreen', ...(state.settings.hotkeys || {}) }[mode];
  return hk ? hk.replace('Control', 'Ctrl').replace('PrintScreen', 'PrtSc').replace(/\+/g, ' + ') : '';
}
function startCapture(mode, delay = 0) {
  if (!window.lumenNative) return toast('Screen capture works in the Captura app');
  window.lumenNative.win('capture', { mode, delay });
}
{
  const btn = h('button', { class: 'btn primary capture-btn', title: t('Take a screenshot'), html: icon('camera') + t('Capture') });
  btn.addEventListener('click', (e) => {
    const r = btn.getBoundingClientRect();
    showMenu(r.left, r.bottom + 6, [
      ...CAPTURE_MODES.map(([m, ic, label]) => ({ ic, label, k: hotkeyLabel(m), run: () => startCapture(m) })),
      '-',
      { ic: 'timer', label: t('Region in 3 seconds'), run: () => startCapture('region', 3) },
      { ic: 'timer', label: t('Full screen in 5 seconds'), run: () => startCapture('screen', 5) },
      '-',
      { ic: 'folder', label: t('Open screenshots folder'), run: () => window.lumenNative?.win('open-path', 'screenshots') },
    ]);
    e.stopPropagation();
  });
  $('.top-actions').prepend(btn);
}
window.lumenNative?.on?.('library-changed', () => loadLibrary().then(queueMissingThumbs));
$('#btn-slideshow').addEventListener('click', () => {
  const list = state.sel.size ? selected() : state.current.length ? state.current : state.photos.filter((p) => !p.hidden);
  if (list.length) startSlideshow(list, 0);
});

function shortcutsDialog() { settingsDialog('keys'); }
// Shortcut editor: every action, its keys as chips, "+" records a new key, × removes one.
function shortcutsTable() {
  const wrap = h('div', { class: 'keymap' });
  const keymap = () => ({ ...(state.settings.keymap || {}) });
  const saveKeys = (id, list) => {
    const km = keymap();
    const def = defaultKeys(id);
    if (list.length === def.length && list.every((c, i) => c === def[i])) delete km[id]; else km[id] = list;
    setSetting('keymap', Object.keys(km).length ? km : null);
  };
  const draw = () => {
    wrap.innerHTML = '';
    wrap.append(h('div', { class: 'keymap-top' },
      h('span', { class: 'section-sub' }, t('Click + and press a key combination. Shortcuts follow the physical key, so they work in any keyboard layout.')),
      h('button', { class: 'btn sm', onclick: () => { setSetting('keymap', null); draw(); } }, t('Reset all'))));
    for (const [scope, scopeLabel] of SCOPES) {
      wrap.append(h('div', { class: 'ed-group', style: { margin: '16px 0 4px', color: 'var(--text-3)' } }, t(scopeLabel)));
      for (const [id, sc, label] of ACTIONS) {
        if (sc !== scope) continue;
        const list = keysFor(id);
        const custom = !!state.settings.keymap?.[id];
        const chips = h('div', { class: 'key-chips' });
        list.forEach((c, i) => chips.append(h('span', { class: 'kbd key-chip' }, prettyCombo(c),
          h('button', { title: t('Remove'), onclick: () => { saveKeys(id, list.filter((_, j) => j !== i)); draw(); } }, '×'))));
        const add = h('button', { class: 'kbd key-add', title: t('Add a shortcut') }, '+');
        add.addEventListener('click', () => {
          add.textContent = t('Press keys…'); add.classList.add('rec');
          const onKey = (e) => {
            e.preventDefault(); e.stopPropagation();
            if (e.key === 'Escape') return stop();
            const c = comboOf(e);
            if (!c) return;
            stop();
            if (list.includes(c)) return;
            const clash = conflicts(scope, id, c);
            if (clash.length) toast(t('{key} is also used for: {what}', { key: prettyCombo(c), what: clash.map((x) => t(x)).join(', ') }));
            saveKeys(id, [...list, c]); draw();
          };
          const stop = () => { document.removeEventListener('keydown', onKey, true); draw(); };
          document.addEventListener('keydown', onKey, true);
        });
        chips.append(add);
        wrap.append(h('div', { class: 'key-row' + (custom ? ' custom' : '') }, h('span', { class: 'key-label' }, t(label)), chips,
          custom ? h('button', { class: 'btn sm ghost', title: t('Restore default'), onclick: () => { saveKeys(id, defaultKeys(id)); draw(); } }, t('Default')) : h('span')));
      }
    }
    wrap.append(h('p', { class: 'section-sub', style: { marginTop: '14px' } },
      t('Esc always closes or cancels. Global screenshot hotkeys are set in the Screenshots tab.')));
  };
  draw();
  return wrap;
}

document.addEventListener('keydown', (e) => {
  if ($('.pv') || $('#viewer').classList.contains('show') || $('#slideshow').classList.contains('show') || $('#modal').classList.contains('show')) return;
  const typing = e.target.matches('input, textarea, select');
  const searchKey = isKey(e, 'lib.search');
  if (searchKey && (!typing || /^Ctrl\+/.test(comboOf(e)))) { e.preventDefault(); $('#search').focus(); $('#search').select(); return; }
  if (typing) { if (e.key === 'Escape') e.target.blur(); return; }
  const ids = [...state.sel];
  let handled = true;
  if (e.key === 'Escape') { if (state.sel.size) { state.sel.clear(); refreshSelection(); } else if (state.search) { $('#search').value = ''; state.search = ''; render(); } }
  else if (isKey(e, 'lib.selectAll')) { state.current.forEach((p) => state.sel.add(p.id)); refreshSelection(); }
  else if (isKey(e, 'lib.copyEdits') && ids.length === 1) { const p = state.byId.get(ids[0]); if (!isIdentity(p.edits)) { state.editClipboard = p.edits; toast(t('Edits copied')); renderSelbar(); } }
  else if (isKey(e, 'lib.pasteEdits') && ids.length) pasteEdits(ids);
  else if (isKey(e, 'lib.star') && ids.length) { const all = selected().every((p) => p.star); patchPhotos(ids, { star: !all }); }
  else if (isKey(e, 'lib.hide') && ids.length) toggleHidden(ids, !selected().every((p) => p.hidden));
  else if (isKey(e, 'lib.open') && ids.length) { const p = state.byId.get(ids[ids.length - 1]); openViewer(state.current, Math.max(0, state.current.indexOf(p))); }
  else if (isKey(e, 'lib.slideshow')) $('#btn-slideshow').click();
  else if (isKey(e, 'lib.help')) shortcutsDialog();
  else if (isKey(e, 'lib.settings')) settingsDialog();
  else if (isKey(e, 'lib.capture')) startCapture('region');
  else if (isKey(e, 'lib.zoomIn')) { const z = $('#zoom'); z.value = Number(z.value) + 20; applyZoom(z.value); }
  else if (isKey(e, 'lib.zoomOut')) { const z = $('#zoom'); z.value = Number(z.value) - 20; applyZoom(z.value); }
  else handled = false;
  if (handled) e.preventDefault();
});

onChange((what) => {
  if (what === 'thumbs') { renderStatus(); return; }
  if (what === 'library' || what === 'photos') render();
});

// ---------------- boot ----------------
(async function boot() {
  try {
    await loadLibrary();
  } catch (e) {
    $('#content').append(emptyBox('info', t('Could not load library'), String(e.message)));
    return;
  }
  applyAppearance(state.settings);
  syncThemeButton();
  const z = state.settings.thumbSize || 200;
  $('#zoom').value = z; applyZoom(z);
  queueMissingThumbs();
  if (state.scan.running) pollScan();
})();
