// Screen capture for Captura: region (with window snapping), active window, full screen,
// last region, delayed capture. Modeled on ShareX's capture modes; implementation is our own.
import { BrowserWindow, desktopCapturer, screen, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------- visible window rectangles (for snapping) ----------------
// A long-lived PowerShell host with a tiny C# helper, so each query takes ~20 ms.
const HELPER_SRC = `
using System; using System.Text; using System.Runtime.InteropServices;
public static class CapturaWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  public struct RECT { public int L, T, R, B; }
  static string Row(IntPtr h) {
    RECT r; if (DwmGetWindowAttribute(h, 9, out r, 16) != 0) return null;
    if (r.R - r.L < 30 || r.B - r.T < 30) return null;
    var t = new StringBuilder(256); GetWindowText(h, t, 256);
    return r.L + "\\t" + r.T + "\\t" + (r.R - r.L) + "\\t" + (r.B - r.T) + "\\t" + t.ToString().Replace("\\t", " ").Replace("\\n", " ");
  }
  public static string List() {
    var sb = new StringBuilder();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      int cloaked; DwmGetWindowAttribute(h, 14, out cloaked, 4); if (cloaked != 0) return true;
      var row = Row(h); if (row != null) sb.Append(row).Append("\\n");
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
  public static string Foreground() { return Row(GetForegroundWindow()) ?? ""; }
}`;

let helper = null, helperBuf = '', helperWaiters = [];
function startHelper() {
  if (process.platform !== 'win32' || helper) return;
  // The script runs from a file so stdin stays free for the query loop.
  const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8\nAdd-Type -TypeDefinition @'\n${HELPER_SRC}\n'@\n` +
    `while (($l = [Console]::In.ReadLine()) -ne $null) { if ($l -eq 'fg') { [CapturaWin]::Foreground() } else { [CapturaWin]::List() }; '<<END>>' }\n`;
  const file = path.join(os.tmpdir(), 'captura-windows-helper.ps1');
  fs.writeFileSync(file, '﻿' + script);
  helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true });
  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (d) => {
    helperBuf += d;
    let i;
    while ((i = helperBuf.indexOf('<<END>>')) >= 0) {
      const chunk = helperBuf.slice(0, i); helperBuf = helperBuf.slice(i + 7);
      helperWaiters.shift()?.(chunk);
    }
  });
  helper.on('exit', () => { helper = null; helperWaiters.splice(0).forEach((w) => w('')); });
}
function helperQuery(cmd, timeout = 2500) {
  startHelper();
  if (!helper) return Promise.resolve('');
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    helperWaiters.push(finish);
    helper.stdin.write(cmd + '\n');
    setTimeout(() => finish(''), timeout);
  });
}
const parseRows = (txt) => txt.split('\n').map((l) => l.trim().split('\t')).filter((c) => c.length >= 4)
  .map(([x, y, w, h, ...t]) => ({ x: +x, y: +y, width: +w, height: +h, title: t.join(' ') }));
export const listWindows = async () => parseRows(await helperQuery('list'));
export const foregroundWindow = async () => parseRows(await helperQuery('fg'))[0] || null;
export function warmUp() { startHelper(); }
export function shutdown() { try { helper?.stdin.end(); helper?.kill(); } catch {} }

// ---------------- grabbing pixels ----------------
const physBounds = (d) => ({ x: Math.round(d.bounds.x * d.scaleFactor), y: Math.round(d.bounds.y * d.scaleFactor), width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) });

// One NativeImage per display, at physical resolution.
export async function grabDisplays(displays = screen.getAllDisplays()) {
  const maxW = Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor)));
  const maxH = Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor)));
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: maxW, height: maxH } });
  const out = new Map();
  displays.forEach((d, i) => {
    const src = sources.find((s) => String(s.display_id) === String(d.id)) || sources[i];
    if (src) out.set(d.id, { display: d, image: src.thumbnail });
  });
  return out;
}

// Crop a physical-pixel rectangle (virtual-screen coordinates) out of the grabbed displays.
function cropPhysical(grabs, rect) {
  for (const { display, image } of grabs.values()) {
    const pb = physBounds(display);
    const sz = image.getSize();
    const kx = sz.width / pb.width, ky = sz.height / pb.height; // thumbnail may differ slightly
    const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
    if (cx < pb.x || cy < pb.y || cx >= pb.x + pb.width || cy >= pb.y + pb.height) continue;
    const x = Math.max(0, Math.round((rect.x - pb.x) * kx)), y = Math.max(0, Math.round((rect.y - pb.y) * ky));
    const w = Math.min(sz.width - x, Math.round(rect.width * kx)), h = Math.min(sz.height - y, Math.round(rect.height * ky));
    if (w > 0 && h > 0) return image.crop({ x, y, width: w, height: h });
  }
  return null;
}

// ---------------- region selection overlay ----------------
let lastRegion = null; // { displayId, rect (DIP, display-relative) }
const pending = new Map(); // overlay webContents id -> { grab, windows }

ipcMain.handle('capture:init', (e) => {
  const st = pending.get(e.sender.id);
  if (!st) return null;
  const { display, image } = st.grab;
  return { width: display.bounds.width, height: display.bounds.height, scale: display.scaleFactor,
    image: image.toDataURL(), windows: st.windows, last: lastRegion?.displayId === display.id ? lastRegion.rect : null };
});

export function regionSelect({ preload, url }) {
  return new Promise(async (resolve) => {
    const grabs = await grabDisplays();
    // window rectangles, converted to DIP relative to each display (top-most first)
    const rows = await listWindows().catch(() => []);
    const overlays = [];
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      for (const w of overlays) { pending.delete(w.webContents.id); if (!w.isDestroyed()) w.destroy(); }
      ipcMain.removeListener('capture:done', onDone);
      resolve(result);
    };
    const onDone = (e, res) => {
      const st = pending.get(e.sender.id);
      if (!st) return;
      if (!res) return finish(null);
      const { display, image } = st.grab;
      const sz = image.getSize();
      const k = sz.width / display.bounds.width;
      const r = { x: Math.round(res.x * k), y: Math.round(res.y * k), width: Math.round(res.width * k), height: Math.round(res.height * k) };
      const r2 = { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(sz.width - Math.max(0, r.x), r.width), height: Math.min(sz.height - Math.max(0, r.y), r.height) };
      if (r2.width < 2 || r2.height < 2) return finish(null);
      lastRegion = { displayId: display.id, rect: res };
      finish({ image: image.crop(r2), kind: res.window ? 'window' : 'region', title: res.title || '' });
    };
    ipcMain.on('capture:done', onDone);
    for (const { display, image } of grabs.values()) {
      const pb = physBounds(display);
      const windows = rows.map((w) => ({
        x: (w.x - pb.x) / display.scaleFactor, y: (w.y - pb.y) / display.scaleFactor,
        width: w.width / display.scaleFactor, height: w.height / display.scaleFactor, title: w.title,
      })).filter((w) => w.x < display.bounds.width && w.y < display.bounds.height && w.x + w.width > 0 && w.y + w.height > 0 && !/^Captura (capture|pin)$/.test(w.title));
      const win = new BrowserWindow({
        ...display.bounds, frame: false, show: false, resizable: false, movable: false, skipTaskbar: true,
        alwaysOnTop: true, fullscreenable: false, hasShadow: false, enableLargerThanScreen: true, backgroundColor: '#000000',
        title: 'Captura capture', webPreferences: { preload, contextIsolation: true, sandbox: true },
      });
      win.setAlwaysOnTop(true, 'screen-saver');
      pending.set(win.webContents.id, { grab: { display, image }, windows });
      overlays.push(win);
      win.on('closed', () => finish(null));
      win.once('ready-to-show', () => { win.setBounds(display.bounds); win.show(); win.focus(); });
      win.loadURL(url);
    }
  });
}

// ---------------- other capture modes ----------------
export async function captureScreenAtCursor() {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const grabs = await grabDisplays([d]);
  const g = grabs.get(d.id);
  return g ? { image: g.image, kind: 'screen', title: '' } : null;
}

export async function captureActiveWindow() {
  const [fg, grabs] = await Promise.all([foregroundWindow(), grabDisplays()]);
  if (!fg) return null;
  const image = cropPhysical(grabs, fg);
  return image ? { image, kind: 'window', title: fg.title } : null;
}

export async function captureLastRegion() {
  if (!lastRegion) return null;
  const d = screen.getAllDisplays().find((x) => x.id === lastRegion.displayId);
  if (!d) return null;
  const g = (await grabDisplays([d])).get(d.id);
  if (!g) return null;
  const sz = g.image.getSize(), k = sz.width / d.bounds.width, r = lastRegion.rect;
  return { image: g.image.crop({ x: Math.round(r.x * k), y: Math.round(r.y * k), width: Math.round(r.width * k), height: Math.round(r.height * k) }), kind: 'region', title: '' };
}
