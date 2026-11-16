const { contextBridge, ipcRenderer, webUtils } = require('electron');

const ACTIONS = new Set(['close', 'minimize', 'fullscreen', 'library', 'trash', 'capture', 'editor', 'refresh-library',
  'hotkeys', 'hotkeys-off', 'hotkey-status', 'language', 'login-item', 'pin-zoom', 'pin-menu', 'open-path']);

contextBridge.exposeInMainWorld('lumenNative', {
  // Real filesystem path of a file or folder dropped from Explorer.
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },
  // Window/app actions: close, fullscreen, open library, trash a file, start a capture, open the editor, …
  win: (action, arg) => (ACTIONS.has(action) ? ipcRenderer.invoke('lumen:win', action, arg) : Promise.resolve(false)),
  // Region capture overlay
  captureInit: () => ipcRenderer.invoke('capture:init'),
  captureDone: (result) => ipcRenderer.send('capture:done', result),
  // Screenshot editor
  copyImage: (pngBuffer) => ipcRenderer.invoke('lumen:copy-image', pngBuffer),
  pinImage: (pngBuffer) => ipcRenderer.invoke('lumen:pin-image', pngBuffer),
  pinData: () => ipcRenderer.invoke('lumen:pin-data'),
  // Main → page notifications (library changed after a capture or a save)
  on: (event, cb) => {
    const ok = ['library-changed'];
    if (!ok.includes(event)) return;
    ipcRenderer.on('lumen:' + event, (_e, data) => cb(data));
  },
});
