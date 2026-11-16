import { app, BrowserWindow, dialog, shell, Menu, ipcMain, screen, Tray, globalShortcut, clipboard, nativeImage, Notification, ClipboardItem } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../lib/server.mjs';
import * as capture from './capture.mjs';
import { t, setLanguage } from '../public/i18n.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.jfif']);
const preload = path.join(HERE, 'preload.cjs');
const icon = path.join(HERE, '..', 'public', 'icon.png');

// The app was called Lumen before: keep using its library (stars, albums, edits) under the new name.
const dataDir = path.join(app.getPath('appData'), 'Captura');
const oldDir = path.join(app.getPath('appData'), 'Lumen');
if (!fs.existsSync(path.join(dataDir, 'library.json')) && fs.existsSync(path.join(oldDir, 'library.json'))) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(path.join(oldDir, 'library.json'), path.join(dataDir, 'library.json'));
    if (fs.existsSync(path.join(oldDir, 'thumbs'))) fs.cpSync(path.join(oldDir, 'thumbs'), path.join(dataDir, 'thumbs'), { recursive: true });
  } catch (e) { console.error('library migration failed', e); }
}
app.setPath('userData', dataDir);
app.setAppUserModelId('Captura');

let libWin = null, srv = null, srvReady = null, tray = null;
const hidden = process.argv.includes('--hidden'); // started with Windows: tray only

// `Captura.exe "C:\photos\a.jpg"` (Explorer "Open with") opens the photo viewer.
function fileFromArgs(argv) {
  for (const a of argv.slice(1)) {
    if (!a || a.startsWith('-')) continue;
    const p = path.resolve(a);
    if (IMAGE_EXT.has(path.extname(p).toLowerCase()) && fs.existsSync(p)) return p;
  }
  return null;
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_e, argv) => {
  const f = fileFromArgs(argv);
  if (f) openViewerWindow(f); else openLibraryWindow();
});

function server() {
  srvReady ||= startServer({
    dataDir,
    port: 0,
    autoScan: false,
    pickFolder: async () => {
      const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || undefined, { title: t('Choose a folder'), properties: ['openDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    },
    openPath: (p) => shell.showItemInFolder(p),
  }).then((s) => (srv = s));
  return srvReady;
}

function guard(win, base) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(base)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(base)) e.preventDefault(); });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
}
const webPreferences = { preload, contextIsolation: true, sandbox: true, spellcheck: false };

async function openLibraryWindow() {
  if (libWin) { if (libWin.isMinimized()) libWin.restore(); libWin.show(); libWin.focus(); return; }
  const s = await server();
  s.scanOnce();
  libWin = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    title: 'Captura', backgroundColor: '#0e0f13', show: false, autoHideMenuBar: true, icon, webPreferences,
  });
  libWin.once('ready-to-show', () => { libWin.maximize(); libWin.show(); });
  guard(libWin, s.url);
  libWin.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') libWin.setFullScreen(!libWin.isFullScreen());
  });
  libWin.on('closed', () => { libWin = null; });
  await libWin.loadURL(s.url);
}
const notifyLibrary = () => libWin?.webContents.send('lumen:library-changed');

// Picasa-style viewer: borderless, transparent window over the whole screen.
async function openViewerWindow(file) {
  const s = await server();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const win = new BrowserWindow({
    ...display.bounds,
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, resizable: false,
    title: path.basename(file) + ' — Captura', show: false, icon, skipTaskbar: false, webPreferences,
  });
  win.setMenu(null);
  guard(win, s.url);
  win.once('ready-to-show', () => { win.setBounds(display.bounds); win.show(); win.focus(); }); // cover the taskbar too
  await win.loadURL(`${s.url}view.html?file=${encodeURIComponent(file)}`);
}

// Screenshot editor window
async function openEditorWindow(id) {
  const s = await server();
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const win = new BrowserWindow({
    width: Math.round(d.width * 0.82), height: Math.round(d.height * 0.86), minWidth: 760, minHeight: 480,
    title: 'Captura Editor', backgroundColor: '#0f1014', show: false, autoHideMenuBar: true, icon, webPreferences,
  });
  win.setMenu(null);
  guard(win, s.url);
  // closing with unsaved annotations asks first
  win.webContents.on('will-prevent-unload', (e) => {
    const r = dialog.showMessageBoxSync(win, { type: 'question', buttons: [t('Discard changes'), t('Keep editing')], defaultId: 1, cancelId: 1,
      title: 'Captura Editor', message: t('Close without saving?'), detail: t('Your annotations have not been saved.') });
    if (r === 0) e.preventDefault();
  });
  win.once('ready-to-show', () => { win.show(); win.focus(); });
  await win.loadURL(`${s.url}editor.html?id=${encodeURIComponent(id)}`);
}

// Electron 44 replaced clipboard.writeImage with the web-style async clipboard.write([ClipboardItem]).
async function copyImage(img) {
  if (typeof clipboard.writeImage === 'function') return clipboard.writeImage(img);
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([img.toPNG()], { type: 'image/png' }) })]);
}

// ---------------- pin to screen ----------------
const pins = new Map(); // webContents id -> { dataUrl, w, h, scale }
async function pinImage(img) {
  const s = await server();
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const sz = img.getSize();
  let w = sz.width / d.scaleFactor, hh = sz.height / d.scaleFactor;
  const k = Math.min(1, (d.workArea.width * 0.6) / w, (d.workArea.height * 0.6) / hh);
  w = Math.round(w * k); hh = Math.round(hh * k);
  const c = screen.getCursorScreenPoint();
  const win = new BrowserWindow({
    x: Math.round(Math.min(Math.max(d.workArea.x, c.x - w / 2), d.workArea.x + d.workArea.width - w)),
    y: Math.round(Math.min(Math.max(d.workArea.y, c.y - hh / 2), d.workArea.y + d.workArea.height - hh)),
    width: w, height: hh, frame: false, transparent: true, resizable: false, alwaysOnTop: true, skipTaskbar: true,
    hasShadow: true, title: 'Captura pin', show: false, webPreferences,
  });
  pins.set(win.webContents.id, { dataUrl: img.toDataURL(), w0: sz.width / d.scaleFactor, h0: sz.height / d.scaleFactor, scale: k });
  const id = win.webContents.id;
  win.on('closed', () => pins.delete(id));
  win.once('ready-to-show', () => win.show());
  guard(win, s.url);
  await win.loadURL(`${s.url}pin.html`);
}
ipcMain.handle('lumen:pin-data', (e) => pins.get(e.sender.id)?.dataUrl || null);
ipcMain.handle('lumen:pin-image', async (_e, buf) => { await pinImage(nativeImage.createFromBuffer(Buffer.from(buf))); return true; });
ipcMain.handle('lumen:copy-image', async (_e, buf) => { await copyImage(nativeImage.createFromBuffer(Buffer.from(buf))); return true; });

// ---------------- capture flow ----------------
let capturing = false;
let pictures = null;
const settings = () => srv?.settings() || {};
function screenshotBase() {
  const s = settings();
  if (s.screenshotDir) return s.screenshotDir;
  pictures ||= srv.picturesDir();
  return path.join(pictures, 'Captura', 'Screenshots');
}
const pad = (n) => String(n).padStart(2, '0');

async function runCapture(mode, { delay = 0 } = {}) {
  if (capturing) return;
  capturing = true;
  const s = await server();
  // our own windows should not be in the shot when the capture starts from inside Captura
  const visible = BrowserWindow.getAllWindows().filter((w) => w.isVisible() && !w.isMinimized() && !pins.has(w.webContents.id));
  const fromApp = BrowserWindow.getFocusedWindow() && visible.length;
  try {
    if (fromApp) { visible.forEach((w) => w.hide()); await new Promise((r) => setTimeout(r, 220)); }
    if (delay) await new Promise((r) => setTimeout(r, delay * 1000));
    let res = null;
    if (mode === 'region') res = await capture.regionSelect({ preload, url: `${s.url}region.html` });
    else if (mode === 'window') res = await capture.captureActiveWindow();
    else if (mode === 'screen') res = await capture.captureScreenAtCursor();
    else if (mode === 'last') res = (await capture.captureLastRegion()) || (await capture.regionSelect({ preload, url: `${s.url}region.html` }));
    if (res?.image && !res.image.isEmpty()) await afterCapture(res);
  } catch (e) {
    console.error('capture failed', e);
    dialog.showErrorBox('Captura', t('The screenshot could not be taken.') + '\n' + (e.message || e));
  } finally {
    if (fromApp) visible.forEach((w) => { if (!w.isDestroyed()) w.showInactive(); });
    capturing = false;
  }
}

// After-capture tasks (like ShareX): save, copy, notify, open the editor.
async function afterCapture({ image }) {
  const s = settings();
  const after = { save: true, copy: true, editor: true, notify: true, ...(s.afterCapture || {}) };
  const now = new Date();
  const base = screenshotBase();
  const dir = path.join(base, `${now.getFullYear()}-${pad(now.getMonth() + 1)}`);
  fs.mkdirSync(dir, { recursive: true });
  let name = `Captura_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  let file = path.join(dir, name + '.png'), i = 1;
  while (fs.existsSync(file)) file = path.join(dir, `${name}_${i++}.png`);
  if (after.copy) await copyImage(image).catch((e) => console.error('clipboard copy failed', e));
  // the file is always written: the editor and the library work on it
  fs.writeFileSync(file, image.toPNG());
  const photo = await srv.addCapture(file, base);
  notifyLibrary();
  if (after.editor) openEditorWindow(photo.id);
  if (after.notify && Notification.isSupported()) {
    const n = new Notification({ title: t('Screenshot captured'), body: path.basename(file) + (after.copy ? ' · ' + t('copied to clipboard') : '') + '\n' + t('Click to edit'), icon: image.resize({ width: 256 }), silent: true });
    n.on('click', () => openEditorWindow(photo.id));
    n.show();
  }
  if (!after.save && !after.editor) {
    // "don't keep" mode: clipboard only, the file is removed again
    setTimeout(() => { try { fs.unlinkSync(file); notifyLibrary(); } catch {} }, 1500);
  }
}

// ---------------- hotkeys (ShareX-style defaults) ----------------
export const DEFAULT_HOTKEYS = { region: 'Control+PrintScreen', screen: 'PrintScreen', window: 'Alt+PrintScreen', last: 'Control+Shift+PrintScreen' };
let hotkeyStatus = {};
function registerHotkeys() {
  globalShortcut.unregisterAll();
  hotkeyStatus = {};
  const hk = { ...DEFAULT_HOTKEYS, ...(settings().hotkeys || {}) };
  for (const [mode, acc] of Object.entries(hk)) {
    if (!acc) { hotkeyStatus[mode] = 'off'; continue; }
    let ok = false;
    try { ok = globalShortcut.register(acc, () => runCapture(mode)); } catch { ok = false; }
    hotkeyStatus[mode] = ok ? 'ok' : 'taken';
  }
}

// ---------------- tray ----------------
function buildTray() {
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }));
  tray.setToolTip('Captura');
  const hk = () => ({ ...DEFAULT_HOTKEYS, ...(settings().hotkeys || {}) });
  const label = (t, m) => (hk()[m] ? `${t}\t${hk()[m].replace('Control', 'Ctrl')}` : t);
  const menu = () => Menu.buildFromTemplate([
    { label: label(t('Capture region'), 'region'), click: () => runCapture('region') },
    { label: label(t('Capture active window'), 'window'), click: () => runCapture('window') },
    { label: label(t('Capture full screen'), 'screen'), click: () => runCapture('screen') },
    { label: label(t('Repeat last region'), 'last'), click: () => runCapture('last') },
    { label: t('Capture region in 3 seconds'), click: () => runCapture('region', { delay: 3 }) },
    { type: 'separator' },
    { label: t('Open Captura'), click: () => openLibraryWindow() },
    { label: t('Open screenshots folder'), click: () => { const d = screenshotBase(); fs.mkdirSync(d, { recursive: true }); shell.openPath(d); } },
    { type: 'separator' },
    { label: t('Quit Captura'), click: () => { quitting = true; app.quit(); } },
  ]);
  tray.on('click', () => openLibraryWindow());
  tray.on('right-click', () => tray.popUpContextMenu(menu()));
}

// ---------------- IPC from pages ----------------
ipcMain.handle('lumen:win', async (e, action, arg) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  switch (action) {
    case 'close': win?.close(); return true;
    case 'minimize': win?.minimize(); return true;
    case 'fullscreen': {
      if (!win) return false;
      if (win === libWin) { win.setFullScreen(!win.isFullScreen()); return win.isFullScreen(); }
      // viewer: whole display ⇄ centered window; returns true when now full screen
      const d = screen.getDisplayMatching(win.getBounds());
      const b = win.getBounds();
      // Windows may clamp a new frameless window to the work area, so "full" means at least that big
      if (b.width >= d.workArea.width && b.height >= d.workArea.height) {
        const wa = d.workArea, w = Math.round(wa.width * 0.72), hh = Math.round(wa.height * 0.8);
        win.setBounds({ x: wa.x + Math.round((wa.width - w) / 2), y: wa.y + Math.round((wa.height - hh) / 2), width: w, height: hh });
        return false;
      }
      win.setBounds(d.bounds);
      return true;
    }
    case 'library': await openLibraryWindow(); return true;
    case 'trash': {
      const p = typeof arg === 'string' ? path.resolve(arg) : '';
      if (!IMAGE_EXT.has(path.extname(p).toLowerCase()) || !fs.existsSync(p)) return false;
      try { await shell.trashItem(p); return true; } catch { return false; }
    }
    case 'capture': {
      const m = arg?.mode;
      if (!['region', 'window', 'screen', 'last'].includes(m)) return false;
      runCapture(m, { delay: Math.min(10, Math.max(0, Number(arg.delay) || 0)) });
      return true;
    }
    case 'editor': if (typeof arg === 'string') { openEditorWindow(arg); return true; } return false;
    case 'refresh-library': notifyLibrary(); return true;
    case 'hotkeys': registerHotkeys(); return hotkeyStatus;
    case 'language': setLanguage(settings().language || 'auto', app.getLocale()); return true;
    case 'hotkeys-off': globalShortcut.unregisterAll(); return true;
    case 'hotkey-status': return { status: hotkeyStatus, defaults: DEFAULT_HOTKEYS };
    case 'login-item': {
      if (typeof arg === 'boolean') app.setLoginItemSettings({ openAtLogin: arg, args: ['--hidden'] });
      return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
    }
    case 'open-path': { const d = arg === 'screenshots' ? screenshotBase() : null; if (d) { fs.mkdirSync(d, { recursive: true }); shell.openPath(d); } return !!d; }
    case 'pin-zoom': {
      const p = pins.get(e.sender.id);
      if (!p || !win) return 100;
      p.scale = Math.max(0.1, Math.min(4, p.scale * Number(arg || 1)));
      const b = win.getBounds(), w = Math.round(p.w0 * p.scale), hh = Math.round(p.h0 * p.scale);
      win.setBounds({ x: Math.round(b.x + (b.width - w) / 2), y: Math.round(b.y + (b.height - hh) / 2), width: w, height: hh });
      return p.scale * 100;
    }
    case 'pin-menu': {
      if (!win) return false;
      const p = pins.get(e.sender.id);
      Menu.buildFromTemplate([
        { label: t('Copy'), click: () => p && copyImage(nativeImage.createFromDataURL(p.dataUrl)) },
        { label: t('Opacity'), submenu: [100, 80, 60, 40].map((o) => ({ label: o + '%', click: () => win.setOpacity(o / 100) })) },
        { label: t('Original size'), click: () => { if (p) { p.scale = 1; const b = win.getBounds(); win.setBounds({ x: b.x, y: b.y, width: Math.round(p.w0), height: Math.round(p.h0) }); } } },
        { type: 'separator' },
        { label: t('Close'), click: () => win.close() },
      ]).popup({ window: win });
      return true;
    }
    default: return false;
  }
});

// ---------------- lifecycle ----------------
Menu.setApplicationMenu(null);
let quitting = false;
app.whenReady().then(async () => {
  await server();
  setLanguage(settings().language || 'auto', app.getLocale());
  buildTray();
  registerHotkeys();
  capture.warmUp(); // start the window-list helper early so region snapping is instant
  const f = fileFromArgs(process.argv);
  if (f) openViewerWindow(f);
  else if (!hidden) openLibraryWindow();
});
// keep running in the tray (hotkeys stay active) unless turned off in Settings
app.on('window-all-closed', () => { if (settings().trayOnClose === false) app.quit(); });

let closing = false;
app.on('before-quit', (e) => {
  quitting = true;
  if (closing || !srv) return;
  e.preventDefault();
  closing = true;
  globalShortcut.unregisterAll();
  capture.shutdown();
  srv.close().catch(() => {}).finally(() => app.quit());
});
