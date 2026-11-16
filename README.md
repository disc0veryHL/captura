# Captura

A Windows photo library, a fast Picasa-style photo viewer and a screenshot tool in one Electron app.
Everything runs locally; original photos are never modified.

## Features

- **Library** — watched folders, month timeline, favorites, albums, tags, captions, hidden photos,
  search (names, places, cameras, tags, dates), Memories, Places map, duplicate finder.
- **Photo viewer** — opens full screen with the cached preview first, then the full image; wheel zoom,
  1:1, rotate, 3D filmstrip, slideshow. `Captura.exe photo.jpg` opens just the viewer.
- **Non-destructive editor** — auto enhance, light/color/detail sliders, crop and straighten, 17 filters,
  copy/paste edits, export.
- **Screen capture** — region (with window snapping and pixel magnifier), active window, full screen,
  last region, delayed capture; global hotkeys and a tray icon.
- **Screenshot editor** — rectangle, ellipse, line, arrow, freehand, text, speech balloon, step numbers,
  highlight, blur, pixelate, magnify, spotlight, smart eraser, crop; copy, save, pin to screen.
- **Customization** — themes, accent color, thumbnail shapes (incl. squircle), spacing, viewer options,
  fully remappable keyboard shortcuts (layout independent).
- **Languages** — English, Español, Français, Русский, 中文（简体）.

## Develop

Requires Node.js 22.23.4+ / 24.22.1+.

```bash
npm install
npm run vendor   # copy map libraries into public/vendor
npm run icon     # render the app icon
npm start        # run the app
```

`npm run serve` runs only the local server (open http://127.0.0.1:4826 in a browser; capture
features need the app).

## Build

```bash
npm run pack       # portable folder: dist/Captura-win32-x64
npm run installer  # Windows installer: dist/installer/Captura-Setup-<version>.exe
```

The installer is per-user (no admin rights), adds Start menu and desktop shortcuts and adds Captura to
Explorer's **Open with** list for images without changing your default app.

> NSIS cannot handle very long paths. If `npm run installer` fails with
> `!include: could not open file`, build from a folder with a shorter path.

## Layout

| Path | What |
| --- | --- |
| `electron/` | main process: windows, tray, hotkeys, capture, IPC |
| `lib/` | local HTTP server: library index, EXIF, thumbnails cache, exports |
| `public/` | UI pages (library, viewer, editors, region overlay) |
| `public/locales/` | translations |
| `scripts/` | icon renderer, vendor copy |
| `build/installer.nsh` | installer additions (Open with registration) |

Library data lives in `%APPDATA%\Captura`.
