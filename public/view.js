// Standalone viewer entry: Captura.exe "C:\path\photo.jpg" (Explorer "Open with").
import { t } from './i18n.js';
import { state, h, applyAppearance } from './store.js';
import { openPhotoViewer } from './photoviewer.js';

window.LUMEN_STANDALONE = true;
const close = () => (window.lumenNative?.win ? window.lumenNative.win('close') : window.close());

(async function boot() {
  const file = new URLSearchParams(location.search).get('file');
  const r = await fetch('/api/browse?file=' + encodeURIComponent(file || ''));
  if (!r.ok) {
    document.body.append(h('div', { class: 'pv show standalone', style: { display: 'grid', placeItems: 'center' }, onclick: close },
      h('div', {}, t('Cannot open this file. Click to close.'))));
    return;
  }
  const data = await r.json();
  state.settings = data.settings || {};
  state.albums = data.albums || [];
  state.photos = data.photos;
  state.byId = new Map(data.photos.map((p) => [p.id, p]));
  applyAppearance(state.settings);
  document.title = (data.photos[data.index]?.name || t('Photo')) + ' — Captura';
  const fullscreen = state.settings.viewerFullscreen !== false;
  if (!fullscreen) await window.lumenNative?.win?.('fullscreen'); // window opens full display; shrink it
  openPhotoViewer(data.photos, data.index, { standalone: true, fullscreen, folder: data.folder, inLibrary: data.inLibrary, onClose: close });
})();
