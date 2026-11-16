// Captura local server: library index, metadata scan, thumbnails cache,
// originals streaming, exports. Binds to 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readMeta, exifDateToTs } from './exif.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', 'public');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.jfif']);
const SKIP_DIRS = new Set(['windows', 'winnt', 'temp', 'tmp', 'program files', 'program files (x86)',
  'programdata', 'appdata', 'node_modules', '$recycle.bin', 'system volume information', 'originals', '.picasaoriginals']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.bmp': 'image/bmp', '.avif': 'image/avif', '.json': 'application/json',
};

// Thumbnail generation version: bump to invalidate cached thumbnails (2 = 600 px tall).
const THUMB_GEN = 2;
const idFor = (p) => crypto.createHash('sha1').update(p.toLowerCase()).digest('hex').slice(0, 16);
const newId = () => crypto.randomBytes(6).toString('hex');

function defaultPicturesDir() {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetFolderPath('MyPictures')"],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 }).trim();
      if (out && fs.existsSync(out)) return out;
    } catch { /* fall through */ }
  }
  const p = path.join(os.homedir(), 'Pictures');
  return fs.existsSync(p) ? p : null;
}

export async function startServer({ dataDir, port = 0, pickFolder, openPath, autoScan = true } = {}) {
  dataDir ||= path.join(os.homedir(), '.lumen');
  const thumbsDir = path.join(dataDir, 'thumbs');
  const libFile = path.join(dataDir, 'library.json');
  await fsp.mkdir(thumbsDir, { recursive: true });

  let lib;
  try { lib = JSON.parse(await fsp.readFile(libFile, 'utf8')); } catch { lib = null; }
  if (!lib || lib.version !== 1) {
    const pics = defaultPicturesDir();
    lib = { version: 1, folders: pics ? [pics] : [], albums: [], photos: {}, settings: {} };
    lib.settings.exportDir = path.join(pics || os.homedir(), 'Captura Exports');
  }

  // ---------- persistence ----------
  let saveTimer = null, saving = Promise.resolve();
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saving = saving.then(async () => {
        const tmp = libFile + '.tmp';
        await fsp.writeFile(tmp, JSON.stringify(lib));
        await fsp.rename(tmp, libFile);
      }).catch((e) => console.error('save failed', e));
    }, 400);
  }
  async function flush() {
    clearTimeout(saveTimer);
    await saving;
    const tmp = libFile + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(lib));
    await fsp.rename(tmp, libFile);
  }

  // ---------- scanning ----------
  const scan = { running: false, found: 0, done: 0, root: '' };

  async function readHead(file, size) {
    const fh = await fsp.open(file, 'r');
    try {
      const n = Math.min(size, 512 * 1024);
      const buf = Buffer.alloc(n);
      await fh.read(buf, 0, n, 0);
      return buf;
    } finally { await fh.close(); }
  }

  async function indexFile(file, st, root) {
    const id = idFor(file);
    const prev = lib.photos[id];
    if (prev && prev.mtime === st.mtimeMs && prev.size === st.size && !prev.loose) return id;
    lib.photos[id] = await buildRecord(file, st, root, prev);
    return id;
  }

  async function buildRecord(file, st, root, prev) {
    const id = idFor(file);
    let meta = {};
    try { meta = readMeta(await readHead(file, st.size), path.extname(file)); } catch { /* unreadable */ }
    const rotated = meta.orientation >= 5 && meta.orientation <= 8;
    const w = meta.width || 0, h = meta.height || 0;
    const ts = exifDateToTs(meta.taken) ?? st.mtimeMs;
    return {
      id, path: file, root, folder: path.dirname(file), name: path.basename(file),
      ext: path.extname(file).toLowerCase(), size: st.size, mtime: st.mtimeMs,
      w: rotated ? h : w, h: rotated ? w : h, ts, dated: !!exifDateToTs(meta.taken),
      camera: [meta.make, meta.model].filter(Boolean).join(' ').replace(/^(\w+) \1/i, '$1') || null,
      lens: meta.lens || null, iso: meta.iso || null, fnumber: meta.fnumber || null,
      exposure: meta.exposure || null, focal: meta.focal || null, gps: meta.gps || null,
      user: prev?.user || {},
    };
  }

  // Index one new/changed file right away (screen captures, editor saves).
  // Files outside every watched folder are kept as `loose` records.
  async function addFileRecord(file, { captured = false } = {}) {
    const st = await fsp.stat(file);
    const root = lib.folders.find((f) => (file + path.sep).toLowerCase().startsWith((f + path.sep).toLowerCase())) || '';
    const id = idFor(file);
    const prev = lib.photos[id] || temp.get(id);
    const rec = await buildRecord(file, st, root, prev);
    if (!root) rec.loose = true;
    if (captured) rec.user = { ...rec.user, captured: true };
    lib.photos[id] = rec; temp.delete(id);
    save();
    return rec;
  }
  function ensureFolder(dir) {
    const abs = path.resolve(dir);
    const inside = lib.folders.some((f) => (abs + path.sep).toLowerCase().startsWith((f + path.sep).toLowerCase()));
    if (!inside) { lib.folders.push(abs); save(); }
  }

  // Photos opened directly (Explorer "Open with") from folders outside the library.
  // Kept in memory; promoted to lib.photos as `loose` once the user stars/rotates/edits one.
  const temp = new Map();
  const getPhoto = (id) => lib.photos[id] || temp.get(id);

  async function browseFolder(file) {
    const dir = path.dirname(file);
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()))
      .map((e) => path.join(dir, e.name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const out = await Promise.all(files.map(async (f) => {
      const id = idFor(f);
      try {
        const st = await fsp.stat(f);
        const known = lib.photos[id];
        if (known && known.mtime === st.mtimeMs && known.size === st.size) return known;
        const t = temp.get(id);
        if (t && t.mtime === st.mtimeMs && t.size === st.size) return t;
        const rec = await buildRecord(f, st, known?.root ?? '', known || t);
        if (known) { lib.photos[id] = { ...rec, loose: known.loose }; return lib.photos[id]; }
        temp.set(id, rec); return rec;
      } catch { return null; }
    }));
    const list = out.filter(Boolean);
    return { folder: dir, index: Math.max(0, list.findIndex((p) => p.path.toLowerCase() === file.toLowerCase())), photos: list };
  }

  async function walk(dir, root, seen) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name.toLowerCase())) continue;
        await walk(full, root, seen);
      } else if (e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase())) {
        scan.found++;
        try {
          const st = await fsp.stat(full);
          if (st.size < 1024) continue;
          seen.add(await indexFile(full, st, root));
        } catch { /* vanished */ }
        scan.done++;
      }
    }
    return true;
  }

  async function runScan(only) {
    if (scan.running) return;
    scan.running = true; scan.found = 0; scan.done = 0;
    try {
      for (const root of lib.folders) {
        if (only && root !== only) continue;
        scan.root = root;
        const seen = new Set();
        const ok = await walk(root, root, seen);
        if (ok) {
          for (const [id, p] of Object.entries(lib.photos)) {
            if (p.root === root && !seen.has(id)) delete lib.photos[id];
          }
        }
      }
      // drop photos of removed roots
      const roots = new Set(lib.folders);
      for (const [id, p] of Object.entries(lib.photos)) if (!p.loose && !roots.has(p.root)) delete lib.photos[id];
      lib.scannedAt = Date.now();
      save();
    } finally { scan.running = false; scan.root = ''; scan.version = (scan.version || 0) + 1; }
  }

  // ---------- helpers ----------
  const thumbPath = (id) => path.join(thumbsDir, id + '.jpg');
  function thumbValid(p) {
    const t = p.user.thumb;
    return !!t && t.mtime === p.mtime && t.v === (p.user.editsV || 0) && t.g === THUMB_GEN;
  }
  function publicPhoto(p) {
    const { path: _p, root: _r, user, ...rest } = p;
    return { ...rest, loose: !!p.loose, path: p.path, root: p.root, star: !!user.star, hidden: !!user.hidden,
      caption: user.caption || '', tags: user.tags || [], albums: user.albums || [],
      edits: user.edits || null, editsV: user.editsV || 0, hash: user.hash || null,
      captured: !!user.captured,
      thumb: thumbValid(p) ? `${THUMB_GEN}-${user.editsV || 0}-${Math.round(p.mtime)}` : null };
  }

  function readBody(req, limit = 512 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = []; let n = 0;
      req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };

  async function defaultPick() {
    if (process.platform !== 'win32') return null;
    const script = "Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
      "$f=New-Object System.Windows.Forms.Form -Property @{TopMost=$true};" +
      "$d=New-Object System.Windows.Forms.FolderBrowserDialog; if($d.ShowDialog($f) -eq 'OK'){ $d.SelectedPath }";
    return new Promise((resolve) => {
      const ps = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true });
      let out = ''; ps.stdout.on('data', (d) => (out += d)); ps.on('close', () => resolve(out.trim() || null));
    });
  }
  pickFolder ||= defaultPick;
  openPath ||= (p) => spawn('explorer.exe', [`/select,"${p}"`], { windowsVerbatimArguments: true, detached: true });

  async function uniqueFile(dir, base, ext) {
    let name = base + ext, i = 1;
    while (fs.existsSync(path.join(dir, name))) name = `${base} (${i++})${ext}`;
    return path.join(dir, name);
  }

  // ---------- routes ----------
  async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const m = req.method;
    const body = async () => { const b = await readBody(req, 8 * 1024 * 1024); return b.length ? JSON.parse(b.toString('utf8')) : {}; };

    if (parts[1] === 'library' && m === 'GET') {
      return json(res, 200, { folders: lib.folders, albums: lib.albums, settings: lib.settings,
        photos: Object.values(lib.photos).filter((p) => !p.loose).map(publicPhoto), scan: { ...scan } });
    }
    if (parts[1] === 'browse' && m === 'GET') {
      const file = path.resolve(url.searchParams.get('file') || '');
      if (!IMAGE_EXT.has(path.extname(file).toLowerCase()) || !fs.existsSync(file)) return json(res, 404, { error: 'File not found' });
      const r = await browseFolder(file);
      const inLibrary = lib.folders.some((f) => (r.folder + path.sep).toLowerCase().startsWith((f + path.sep).toLowerCase()));
      return json(res, 200, { folder: r.folder, index: r.index, inLibrary, settings: lib.settings, albums: lib.albums, photos: r.photos.map(publicPhoto) });
    }
    if (parts[1] === 'scan') {
      if (m === 'POST') { runScan(); return json(res, 200, { ok: true }); }
      return json(res, 200, { ...scan });
    }
    if (parts[1] === 'folders') {
      if (m === 'POST') {
        const { path: p } = await body();
        const abs = p && path.resolve(p);
        if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return json(res, 400, { error: 'Folder not found' });
        const inside = lib.folders.find((f) => (abs + path.sep).toLowerCase().startsWith((f + path.sep).toLowerCase()));
        if (inside) return json(res, 409, { error: `Already watched inside ${inside}` });
        // a parent replaces child roots
        lib.folders = lib.folders.filter((f) => !(f + path.sep).toLowerCase().startsWith((abs + path.sep).toLowerCase()));
        lib.folders.push(abs); save(); runScan();
        return json(res, 200, { folders: lib.folders });
      }
      if (m === 'DELETE') {
        const p = url.searchParams.get('path');
        lib.folders = lib.folders.filter((f) => f !== p);
        for (const [id, ph] of Object.entries(lib.photos)) if (ph.root === p) delete lib.photos[id];
        save(); return json(res, 200, { folders: lib.folders });
      }
    }
    if (parts[1] === 'pick-folder' && m === 'POST') return json(res, 200, { path: await pickFolder() });
    if (parts[1] === 'reveal' && m === 'POST') {
      const { id, path: p } = await body();
      const target = id ? getPhoto(id)?.path : p;
      if (target && fs.existsSync(target)) openPath(target);
      return json(res, 200, { ok: !!target });
    }
    if (parts[1] === 'settings' && m === 'GET') return json(res, 200, lib.settings);
    if (parts[1] === 'settings' && m === 'PATCH') {
      const b = await body();
      const KEYS = ['exportDir', 'theme', 'accent', 'thumbSize', 'slideSeconds', 'wheelZoom', 'autoHideBar',
        'thumbShape', 'thumbRadius', 'gridGap', 'showBadges', 'viewerFullscreen', 'viewerOpacity', 'filmstrip',
        'screenshotDir', 'afterCapture', 'hotkeys', 'captureCursor', 'trayOnClose', 'startWithWindows', 'keymap', 'language'];
      for (const k of KEYS) if (k in b) { if (b[k] === null) delete lib.settings[k]; else lib.settings[k] = b[k]; }
      save(); return json(res, 200, lib.settings);
    }
    if (parts[1] === 'albums') {
      if (m === 'POST') {
        const { name, ids = [] } = await body();
        const a = { id: newId(), name: String(name || 'New album').slice(0, 120), created: Date.now() };
        lib.albums.push(a);
        for (const id of ids) { const p = lib.photos[id]; if (p) p.user.albums = [...new Set([...(p.user.albums || []), a.id])]; }
        save(); return json(res, 200, a);
      }
      const a = lib.albums.find((x) => x.id === parts[2]);
      if (!a) return json(res, 404, { error: 'No album' });
      if (m === 'PATCH') { const b = await body(); if (b.name) a.name = String(b.name).slice(0, 120); if ('cover' in b) a.cover = b.cover; save(); return json(res, 200, a); }
      if (m === 'DELETE') {
        lib.albums = lib.albums.filter((x) => x !== a);
        for (const p of Object.values(lib.photos)) if (p.user.albums) p.user.albums = p.user.albums.filter((x) => x !== a.id);
        save(); return json(res, 200, { ok: true });
      }
    }
    if (parts[1] === 'photos' && m === 'PATCH') {
      const { ids = [], patch = {} } = await body();
      const out = [];
      for (const id of ids) {
        let p = lib.photos[id];
        if (!p && temp.has(id)) { p = lib.photos[id] = { ...temp.get(id), loose: true }; temp.delete(id); }
        if (!p) continue;
        const u = p.user;
        if ('star' in patch) u.star = !!patch.star;
        if ('hidden' in patch) u.hidden = !!patch.hidden;
        if ('caption' in patch) u.caption = String(patch.caption).slice(0, 2000);
        if ('tags' in patch) u.tags = [...new Set(patch.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 64);
        if (patch.addTag) u.tags = [...new Set([...(u.tags || []), String(patch.addTag).trim()])];
        if (patch.addAlbum) u.albums = [...new Set([...(u.albums || []), patch.addAlbum])];
        if (patch.removeAlbum) u.albums = (u.albums || []).filter((x) => x !== patch.removeAlbum);
        if ('edits' in patch) { u.edits = patch.edits; u.editsV = (u.editsV || 0) + 1; }
        out.push(publicPhoto(p));
      }
      save(); return json(res, 200, { photos: out });
    }
    if (parts[1] === 'photo' && parts[2]) {
      const p = getPhoto(parts[2]);
      if (!p) return json(res, 404, { error: 'No photo' });
      if (parts[3] === 'info' && m === 'GET') return json(res, 200, { photo: publicPhoto(p), settings: lib.settings });
      if (parts[3] === 'original' && m === 'GET') {
        try {
          const st = await fsp.stat(p.path);
          res.writeHead(200, { 'content-type': MIME[p.ext] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'private, max-age=60' });
          fs.createReadStream(p.path).pipe(res);
        } catch { json(res, 404, { error: 'File missing' }); }
        return;
      }
      if (parts[3] === 'thumb') {
        if (m === 'GET') {
          if (!thumbValid(p)) return json(res, 404, { error: 'No thumb' });
          res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable' });
          return fs.createReadStream(thumbPath(p.id)).on('error', () => res.end()).pipe(res);
        }
        if (m === 'PUT') {
          const buf = await readBody(req, 4 * 1024 * 1024);
          if (buf[0] !== 0xff || buf[1] !== 0xd8) return json(res, 400, { error: 'JPEG expected' });
          const v = Number(url.searchParams.get('v') || 0);
          if (v !== (p.user.editsV || 0)) return json(res, 409, { error: 'stale' });
          await fsp.writeFile(thumbPath(p.id), buf);
          p.user.thumb = { v, mtime: p.mtime, g: THUMB_GEN };
          // hash is computed from the unedited original, for duplicate detection
          const hash = url.searchParams.get('hash');
          if (hash && /^[0-9a-f]{16}$/.test(hash)) p.user.hash = hash;
          save(); return json(res, 200, { thumb: publicPhoto(p).thumb, hash: p.user.hash || null });
        }
      }
    }
    // Screenshot editor: save the annotated PNG. Overwrite is only allowed for files Captura
    // captured itself; anything else is saved as a new "(edited)" copy next to the original.
    if (parts[1] === 'annotate-save' && m === 'POST') {
      const p = getPhoto(url.searchParams.get('id') || '');
      if (!p) return json(res, 404, { error: 'No photo' });
      const buf = await readBody(req, 256 * 1024 * 1024);
      if (buf.toString('latin1', 1, 4) !== 'PNG') return json(res, 400, { error: 'PNG expected' });
      const overwrite = url.searchParams.get('mode') === 'overwrite' && p.user.captured && p.ext === '.png';
      const file = overwrite ? p.path : await uniqueFile(p.folder, p.name.replace(/\.[^.]+$/, '').replace(/ \(edited( \d+)?\)$/, '') + ' (edited)', '.png');
      await fsp.writeFile(file, buf);
      const rec = await addFileRecord(file, { captured: true });
      return json(res, 200, { path: file, overwritten: overwrite, photo: rec ? publicPhoto(rec) : null });
    }
    if (parts[1] === 'export' && m === 'POST') {
      const name = (url.searchParams.get('name') || 'export').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 150);
      const ext = { jpeg: '.jpg', png: '.png', webp: '.webp' }[url.searchParams.get('format')] || '.jpg';
      const dir = path.resolve(url.searchParams.get('dir') || lib.settings.exportDir);
      const buf = await readBody(req);
      await fsp.mkdir(dir, { recursive: true });
      const file = await uniqueFile(dir, name, ext);
      await fsp.writeFile(file, buf);
      return json(res, 200, { path: file });
    }
    return json(res, 404, { error: 'Unknown route' });
  }

  async function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.join(PUBLIC, path.normalize(rel));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    try {
      const data = await fsp.readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(data);
    } catch { res.writeHead(404); res.end('Not found'); }
  }

  let actualPort = port;
  const server = http.createServer(async (req, res) => {
    try {
      // Reject DNS-rebinding and cross-site requests.
      const host = (req.headers.host || '').split(':')[0];
      if (host !== '127.0.0.1' && host !== 'localhost') { res.writeHead(403); return res.end(); }
      const url = new URL(req.url, `http://127.0.0.1:${actualPort}`);
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.headers['x-lumen'] !== '1') { res.writeHead(403); return res.end(); }
        return await api(req, res, url);
      }
      return await serveStatic(req, res, url);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: String(e.message || e) }); else res.end();
    }
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  actualPort = server.address().port;
  if (autoScan) runScan();
  let scannedOnce = autoScan;
  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}/`,
    scanOnce() { if (!scannedOnce) { scannedOnce = true; runScan(); } },
    settings: () => lib.settings,
    picturesDir: () => defaultPicturesDir() || os.homedir(),
    // a new screen capture: make sure its folder is in the library, then index it
    async addCapture(file, baseDir) { ensureFolder(baseDir); return publicPhoto(await addFileRecord(file, { captured: true })); },
    async close() { server.close(); await saving; await flush(); },
  };
}

// Standalone: node lib/server.mjs [port]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startServer({ port: Number(process.argv[2] || 4826), dataDir: process.env.LUMEN_DATA });
  console.log('Captura running at', s.url);
}
