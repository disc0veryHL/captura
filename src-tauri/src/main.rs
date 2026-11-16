// Captura — native shell (Rust + Tauri). The UI pages run in the system WebView2 and are
// served by the local server in server.rs; this file owns windows, tray, hotkeys, capture.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capture;
mod i18n;
mod meta;
mod server;

use serde_json::{json, Value};
use server::Server;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;

/// `window.lumenNative` — the same API the pages used under Electron, now over Tauri IPC.
const BRIDGE: &str = r#"
(() => {
  const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  window.lumenNative = {
    win: (action, arg) => inv('lumen_win', { action, arg: arg === undefined ? null : arg }),
    captureInit: () => inv('capture_init'),
    captureDone: (result) => { inv('capture_done', { result: result || null }); },
    copyImage: (buf) => inv('copy_image', new Uint8Array(buf)),
    pinImage: (buf) => inv('pin_image', new Uint8Array(buf)),
    pinData: () => inv('pin_data'),
    pathForFile: () => null,
    on: (event, cb) => {
      if (!['library-changed', 'close-request'].includes(event)) return;
      const go = () => window.__TAURI__.event.getCurrentWindow
        ? window.__TAURI__.event.listen('lumen:' + event, (e) => cb(e.payload))
        : window.__TAURI__.event.listen('lumen:' + event, (e) => cb(e.payload));
      if (window.__TAURI__) go(); else window.addEventListener('DOMContentLoaded', go);
    },
  };
})();
"#;

const DEFAULT_HOTKEYS: [(&str, &str); 4] = [("region", "Control+PrintScreen"), ("screen", "PrintScreen"), ("window", "Alt+PrintScreen"), ("last", "Control+Shift+PrintScreen")];

struct Pin { blob: String, w0: f64, h0: f64, scale: f64 }
struct RegionSession { grabs: HashMap<String, capture::Grab>, init: HashMap<String, Value>, tx: Sender<Option<(String, Value)>> }
struct LastRegion { mx: i32, my: i32, rect: Value }

struct AppState {
    srv: Arc<Server>,
    pins: Mutex<HashMap<String, Pin>>,
    region: Mutex<Option<RegionSession>>,
    last_region: Mutex<Option<LastRegion>>,
    capturing: AtomicBool,
    hotkey_status: Mutex<Value>,
    force_close: Mutex<HashSet<String>>,
    counter: AtomicU64,
}

fn st(app: &AppHandle) -> tauri::State<'_, AppState> { app.state::<AppState>() }
fn next_label(app: &AppHandle, prefix: &str) -> String { format!("{prefix}-{}", st(app).counter.fetch_add(1, Ordering::SeqCst)) }
fn page_url(app: &AppHandle, rel: &str) -> WebviewUrl { WebviewUrl::External(format!("{}{rel}", st(app).srv.url()).parse().unwrap()) }

// ---------------- windows ----------------
fn open_library(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize(); let _ = w.show(); let _ = w.set_focus();
        return;
    }
    st(app).srv.scan_once();
    let Ok(w) = WebviewWindowBuilder::new(app, "main", page_url(app, ""))
        .title("Captura").inner_size(1440.0, 900.0).min_inner_size(900.0, 600.0).visible(false)
        .disable_drag_drop_handler() // keeps HTML5 drag & drop (photos onto albums) working
        .initialization_script(BRIDGE).build() else { return };
    let _ = w.maximize();
    let _ = w.show();
    let _ = w.set_focus();
}

fn cursor_monitor(app: &AppHandle) -> Option<tauri::Monitor> {
    let c = app.cursor_position().ok()?;
    app.available_monitors().ok()?.into_iter().find(|m| {
        let (p, s) = (m.position(), m.size());
        c.x >= p.x as f64 && c.y >= p.y as f64 && c.x < (p.x + s.width as i32) as f64 && c.y < (p.y + s.height as i32) as f64
    }).or_else(|| app.primary_monitor().ok().flatten())
}

/// Picasa-style viewer: borderless transparent window over the whole screen.
fn open_viewer(app: &AppHandle, file: &str) {
    let label = next_label(app, "viewer");
    let url = format!("view.html?file={}", percent_encoding::utf8_percent_encode(file, percent_encoding::NON_ALPHANUMERIC));
    let Ok(w) = WebviewWindowBuilder::new(app, &label, page_url(app, &url))
        .title(format!("{} — Captura", Path::new(file).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()))
        .decorations(false).transparent(true).shadow(false).resizable(false).visible(false)
        .initialization_script(BRIDGE).build() else { return };
    if let Some(m) = cursor_monitor(app) { let _ = w.set_position(*m.position()); let _ = w.set_size(*m.size()); }
    let _ = w.show(); let _ = w.set_focus();
}

fn open_editor(app: &AppHandle, id: &str) {
    let label = next_label(app, "editor");
    let (mut w0, mut h0) = (1400.0, 900.0);
    if let Some(m) = cursor_monitor(app) { let s = m.scale_factor(); let sz = m.size(); w0 = sz.width as f64 / s * 0.82; h0 = sz.height as f64 / s * 0.82; }
    let Ok(w) = WebviewWindowBuilder::new(app, &label, page_url(app, &format!("editor.html?id={id}")))
        .title("Captura Editor").inner_size(w0, h0).min_inner_size(760.0, 480.0).center()
        .initialization_script(BRIDGE).build() else { return };
    let _ = w.set_focus();
    // closing with unsaved annotations asks first (the page decides)
    let (app2, l2) = (app.clone(), label.clone());
    w.on_window_event(move |e| {
        if let WindowEvent::CloseRequested { api, .. } = e {
            if !st(&app2).force_close.lock().unwrap().contains(&l2) {
                api.prevent_close();
                let _ = app2.emit_to(l2.as_str(), "lumen:close-request", ());
            }
        }
    });
}

fn open_pin(app: &AppHandle, img: image::RgbaImage) {
    let label = next_label(app, "pin");
    let key = format!("pin-{label}");
    let (iw, ih) = (img.width() as f64, img.height() as f64);
    st(app).srv.blobs.lock().unwrap().insert(key.clone(), (capture::encode_png(&img), "image/png"));
    let m = cursor_monitor(app);
    let scale = m.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);
    let (mw, mh) = m.as_ref().map(|m| (m.size().width as f64 / scale, m.size().height as f64 / scale)).unwrap_or((1920.0, 1080.0));
    let (w0, h0) = (iw / scale, ih / scale);
    let k = (mw * 0.6 / w0).min(mh * 0.6 / h0).min(1.0);
    let Ok(w) = WebviewWindowBuilder::new(app, &label, page_url(app, "pin.html"))
        .title("Captura pin").inner_size(w0 * k, h0 * k).decorations(false).transparent(true).always_on_top(true)
        .skip_taskbar(true).resizable(false).shadow(true).center().initialization_script(BRIDGE).build() else { return };
    st(app).pins.lock().unwrap().insert(label.clone(), Pin { blob: key, w0, h0, scale: k });
    let app2 = app.clone();
    w.on_window_event(move |e| {
        if let WindowEvent::Destroyed = e {
            if let Some(p) = st(&app2).pins.lock().unwrap().remove(&label) { st(&app2).srv.blobs.lock().unwrap().remove(&p.blob); }
        }
    });
}

// ---------------- capture ----------------
fn settings(app: &AppHandle) -> Value { st(app).srv.settings() }

fn screenshot_base(app: &AppHandle) -> PathBuf {
    match settings(app)["screenshotDir"].as_str() {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => dirs::picture_dir().or_else(dirs::home_dir).unwrap_or_default().join("Captura").join("Screenshots"),
    }
}

fn run_capture(app: &AppHandle, mode: &str, delay: u64) {
    let state = st(app);
    if state.capturing.swap(true, Ordering::SeqCst) { return; }
    let (app, mode) = (app.clone(), mode.to_string());
    thread::spawn(move || {
        // keep Captura's own windows out of the shot when the capture starts from inside the app
        let ours: Vec<WebviewWindow> = app.webview_windows().into_values()
            .filter(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) && !w.label().starts_with("pin-")).collect();
        let from_app = ours.iter().any(|w| w.is_focused().unwrap_or(false));
        if from_app { for w in &ours { let _ = w.hide(); } thread::sleep(Duration::from_millis(250)); }
        if delay > 0 { thread::sleep(Duration::from_secs(delay)); }
        let img = match mode.as_str() {
            "region" => region_select(&app),
            "window" => capture::active_window(),
            "screen" => app.cursor_position().ok().and_then(|c| capture::grab_at(c.x as i32, c.y as i32)).map(|g| g.image),
            "last" => last_region(&app).or_else(|| region_select(&app)),
            _ => None,
        };
        if from_app { for w in &ours { let _ = w.show(); } }
        if let Some(img) = img { after_capture(&app, img); }
        st(&app).capturing.store(false, Ordering::SeqCst);
    });
}

fn region_select(app: &AppHandle) -> Option<image::RgbaImage> {
    let grabs = capture::grab_all();
    let wins = capture::windows();
    let (tx, rx) = channel();
    let mut session = RegionSession { grabs: HashMap::new(), init: HashMap::new(), tx };
    let last = st(app).last_region.lock().unwrap().as_ref().map(|l| (l.mx, l.my, l.rect.clone()));
    let mut labels = vec![];
    for g in grabs {
        let label = next_label(app, "region");
        let key = format!("cap-{label}");
        st(app).srv.blobs.lock().unwrap().insert(key.clone(), (capture::encode_preview(&g.image), "image/jpeg"));
        let mut init = json!({ "width": g.width as f64 / g.scale, "height": g.height as f64 / g.scale, "scale": g.scale,
            "image": format!("/api/blob/{key}"), "windows": capture::windows_for(&g, &wins), "last": Value::Null });
        if let Some((mx, my, rect)) = &last { if *mx == g.x && *my == g.y { init["last"] = rect.clone(); } }
        session.init.insert(label.clone(), init);
        labels.push((label.clone(), g.x, g.y, g.width, g.height));
        session.grabs.insert(label, g);
    }
    *st(app).region.lock().unwrap() = Some(session);
    for (label, x, y, w, h) in &labels {
        if let Ok(win) = WebviewWindowBuilder::new(app, label, page_url(app, "region.html")).title("Captura capture")
            .decorations(false).resizable(false).always_on_top(true).skip_taskbar(true).shadow(false).visible(false)
            .initialization_script(BRIDGE).build()
        {
            let _ = win.set_position(PhysicalPosition::new(*x, *y));
            let _ = win.set_size(PhysicalSize::new(*w, *h));
            let _ = win.show(); let _ = win.set_focus();
            let tx = st(app).region.lock().unwrap().as_ref().map(|s| s.tx.clone());
            win.on_window_event(move |e| { if let WindowEvent::Destroyed = e { if let Some(tx) = &tx { let _ = tx.send(None); } } });
        }
    }
    let result = rx.recv_timeout(Duration::from_secs(600)).ok().flatten();
    let session = st(app).region.lock().unwrap().take();
    for (label, ..) in &labels {
        st(app).srv.blobs.lock().unwrap().remove(&format!("cap-{label}"));
        if let Some(w) = app.get_webview_window(label) { let _ = w.destroy(); }
    }
    let (label, res) = result?;
    let session = session?;
    let g = session.grabs.get(&label)?;
    let k = g.image.width() as f64 / (g.width as f64 / g.scale);
    let r = |key: &str| res[key].as_f64().unwrap_or(0.0);
    let img = capture::crop(&g.image, (r("x") * k).round() as i64, (r("y") * k).round() as i64, (r("width") * k).round() as i64, (r("height") * k).round() as i64)?;
    *st(app).last_region.lock().unwrap() = Some(LastRegion { mx: g.x, my: g.y, rect: json!({ "x": r("x"), "y": r("y"), "width": r("width"), "height": r("height") }) });
    Some(img)
}

fn last_region(app: &AppHandle) -> Option<image::RgbaImage> {
    let (mx, my, rect) = st(app).last_region.lock().unwrap().as_ref().map(|l| (l.mx, l.my, l.rect.clone()))?;
    let g = capture::grab_at(mx + 1, my + 1)?;
    let k = g.image.width() as f64 / (g.width as f64 / g.scale);
    let r = |key: &str| rect[key].as_f64().unwrap_or(0.0);
    capture::crop(&g.image, (r("x") * k) as i64, (r("y") * k) as i64, (r("width") * k) as i64, (r("height") * k) as i64)
}

fn copy_to_clipboard(img: &image::RgbaImage) -> bool {
    let Ok(mut cb) = arboard::Clipboard::new() else { return false };
    cb.set_image(arboard::ImageData { width: img.width() as usize, height: img.height() as usize, bytes: std::borrow::Cow::Borrowed(img.as_raw()) }).is_ok()
}

/// After-capture tasks (like ShareX): save, copy, notify, open the editor.
fn after_capture(app: &AppHandle, img: image::RgbaImage) {
    let s = settings(app);
    let opt = |k: &str| s["afterCapture"][k].as_bool().unwrap_or(true);
    let (keep, copy, editor, notify) = (opt("save"), opt("copy"), opt("editor"), opt("notify"));
    let base = screenshot_base(app);
    let now = chrono::Local::now();
    let dir = base.join(now.format("%Y-%m").to_string());
    if std::fs::create_dir_all(&dir).is_err() { return fail(app, "cannot create the screenshots folder"); }
    let file = server::unique_file(&dir, &now.format("Captura_%Y-%m-%d_%H-%M-%S").to_string(), ".png");
    if copy { copy_to_clipboard(&img); }
    if std::fs::write(&file, capture::encode_png(&img)).is_err() { return fail(app, "cannot write the file"); }
    let photo = st(app).srv.add_capture(&file, &base);
    let _ = app.emit_to("main", "lumen:library-changed", ());
    let id = photo.as_ref().and_then(|p| p["id"].as_str().map(String::from));
    if editor { if let Some(id) = &id { open_editor(app, id); } }
    if notify {
        let body = format!("{}{}", file.file_name().unwrap_or_default().to_string_lossy(), if copy { format!(" · {}", i18n::t("copied to clipboard")) } else { String::new() });
        let _ = app.notification().builder().title(i18n::t("Screenshot captured")).body(body).show();
    }
    if !keep && !editor {
        let app2 = app.clone();
        thread::spawn(move || { thread::sleep(Duration::from_millis(1500)); let _ = std::fs::remove_file(&file); let _ = app2.emit_to("main", "lumen:library-changed", ()); });
    }
}

fn fail(app: &AppHandle, why: &str) {
    app.dialog().message(format!("{}\n{why}", i18n::t("The screenshot could not be taken."))).title("Captura").show(|_| {});
}

// ---------------- hotkeys & tray ----------------
fn hotkeys(app: &AppHandle) -> Vec<(String, String)> {
    let s = settings(app);
    DEFAULT_HOTKEYS.iter().map(|(m, d)| {
        let v = s["hotkeys"].get(*m).and_then(|v| v.as_str()).unwrap_or(d);
        (m.to_string(), v.to_string())
    }).collect()
}

fn register_hotkeys(app: &AppHandle) -> Value {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut status = serde_json::Map::new();
    for (mode, acc) in hotkeys(app) {
        if acc.is_empty() { status.insert(mode, json!("off")); continue; }
        let m2 = mode.clone();
        let ok = gs.on_shortcut(acc.as_str(), move |app, _sc, ev| { if ev.state == ShortcutState::Pressed { run_capture(app, &m2, 0); } }).is_ok();
        status.insert(mode, json!(if ok { "ok" } else { "taken" }));
    }
    let v = Value::Object(status);
    *st(app).hotkey_status.lock().unwrap() = v.clone();
    v
}

fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let hk: HashMap<String, String> = hotkeys(app).into_iter().collect();
    let label = |text: &str, mode: &str| match hk.get(mode).filter(|a| !a.is_empty()) {
        Some(a) => format!("{text}\t{}", a.replace("Control", "Ctrl").replace("PrintScreen", "PrtSc")),
        None => text.to_string(),
    };
    let item = |id: &str, text: String| MenuItem::with_id(app, id, text, true, None::<&str>);
    Menu::with_items(app, &[
        &item("cap-region", label(i18n::t("Capture region"), "region"))?,
        &item("cap-window", label(i18n::t("Capture active window"), "window"))?,
        &item("cap-screen", label(i18n::t("Capture full screen"), "screen"))?,
        &item("cap-last", label(i18n::t("Repeat last region"), "last"))?,
        &item("cap-delay", i18n::t("Capture region in 3 seconds").to_string())?,
        &PredefinedMenuItem::separator(app)?,
        &item("open", i18n::t("Open Captura").to_string())?,
        &item("folder", i18n::t("Open screenshots folder").to_string())?,
        &PredefinedMenuItem::separator(app)?,
        &item("quit", i18n::t("Quit Captura").to_string())?,
    ])
}

fn refresh_tray(app: &AppHandle) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id("captura"), tray_menu(app)) { let _ = tray.set_menu(Some(menu)); }
}

fn open_folder(p: &Path) {
    let _ = std::fs::create_dir_all(p);
    let _ = std::process::Command::new("explorer.exe").arg(p).spawn();
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "cap-region" => run_capture(app, "region", 0),
        "cap-window" => run_capture(app, "window", 0),
        "cap-screen" => run_capture(app, "screen", 0),
        "cap-last" => run_capture(app, "last", 0),
        "cap-delay" => run_capture(app, "region", 3),
        "open" => open_library(app),
        "folder" => open_folder(&screenshot_base(app)),
        "quit" => { st(app).srv.flush(); app.exit(0); }
        other => {
            // pin context menu: "<action>|<window label>"
            let Some((action, label)) = other.split_once('|') else { return };
            let Some(w) = app.get_webview_window(label) else { return };
            match action {
                "pin-copy" => {
                    let blob = st(app).pins.lock().unwrap().get(label).map(|p| p.blob.clone());
                    if let Some(b) = blob.and_then(|b| st(app).srv.blobs.lock().unwrap().get(&b).map(|x| x.0.clone())) {
                        if let Ok(img) = image::load_from_memory(&b) { copy_to_clipboard(&img.to_rgba8()); }
                    }
                }
                "pin-orig" => {
                    if let Some(p) = st(app).pins.lock().unwrap().get_mut(label) { p.scale = 1.0; let _ = w.set_size(tauri::LogicalSize::new(p.w0, p.h0)); }
                }
                "pin-close" => { let _ = w.destroy(); }
                _ => {}
            }
        }
    }
}

// ---------------- commands ----------------
// async: commands that open windows must not run on the main thread (WebView2 deadlock)
#[tauri::command]
async fn lumen_win(app: AppHandle, window: WebviewWindow, action: String, arg: Option<Value>) -> Value {
    let arg = arg.unwrap_or(Value::Null);
    match action.as_str() {
        "close" => { let _ = window.close(); json!(true) }
        "close-force" => { st(&app).force_close.lock().unwrap().insert(window.label().to_string()); let _ = window.destroy(); json!(true) }
        "minimize" => { let _ = window.minimize(); json!(true) }
        "fullscreen" => {
            if window.label() == "main" {
                let fs = window.is_fullscreen().unwrap_or(false);
                let _ = window.set_fullscreen(!fs);
                return json!(!fs);
            }
            // viewer: whole display ⇄ centered window; returns true when now full screen
            let Ok(Some(m)) = window.current_monitor() else { return json!(false) };
            let (mp, ms) = (*m.position(), *m.size());
            let sz = window.outer_size().unwrap_or(ms);
            if sz.width >= ms.width && sz.height >= ms.height * 9 / 10 {
                let (w, h) = ((ms.width as f64 * 0.72) as u32, (ms.height as f64 * 0.78) as u32);
                let _ = window.set_size(PhysicalSize::new(w, h));
                let _ = window.set_position(PhysicalPosition::new(mp.x + ((ms.width - w) / 2) as i32, mp.y + ((ms.height - h) / 2) as i32));
                json!(false)
            } else {
                let _ = window.set_position(mp); let _ = window.set_size(ms);
                json!(true)
            }
        }
        "library" => { open_library(&app); json!(true) }
        "trash" => {
            let p = PathBuf::from(arg.as_str().unwrap_or(""));
            json!(server::is_image(&p) && p.exists() && trash::delete(&p).is_ok())
        }
        "capture" => {
            let mode = arg["mode"].as_str().unwrap_or("");
            if !["region", "window", "screen", "last"].contains(&mode) { return json!(false); }
            run_capture(&app, mode, arg["delay"].as_u64().unwrap_or(0).min(10));
            json!(true)
        }
        "editor" => { if let Some(id) = arg.as_str() { open_editor(&app, id); } json!(true) }
        "refresh-library" => { let _ = app.emit_to("main", "lumen:library-changed", ()); json!(true) }
        "hotkeys" => { let v = register_hotkeys(&app); refresh_tray(&app); v }
        "hotkeys-off" => { let _ = app.global_shortcut().unregister_all(); json!(true) }
        "hotkey-status" => {
            let defaults: serde_json::Map<String, Value> = DEFAULT_HOTKEYS.iter().map(|(m, a)| (m.to_string(), json!(a))).collect();
            json!({ "status": *st(&app).hotkey_status.lock().unwrap(), "defaults": defaults })
        }
        "login-item" => {
            let al = app.autolaunch();
            if let Some(on) = arg.as_bool() { let _ = if on { al.enable() } else { al.disable() }; }
            json!(al.is_enabled().unwrap_or(false))
        }
        "language" => { i18n::set_language(settings(&app)["language"].as_str()); refresh_tray(&app); json!(true) }
        "open-path" => { if arg.as_str() == Some("screenshots") { open_folder(&screenshot_base(&app)); } json!(true) }
        "pin-zoom" => {
            let f = arg.as_f64().unwrap_or(1.0);
            let state = st(&app);
            let mut pins = state.pins.lock().unwrap();
            let Some(p) = pins.get_mut(window.label()) else { return json!(100) };
            p.scale = (p.scale * f).clamp(0.1, 4.0);
            let sf = window.scale_factor().unwrap_or(1.0);
            let (w, h) = (p.w0 * p.scale, p.h0 * p.scale);
            if let (Ok(pos), Ok(old)) = (window.outer_position(), window.outer_size()) {
                let (ow, oh) = (old.width as f64 / sf, old.height as f64 / sf);
                let _ = window.set_position(PhysicalPosition::new(pos.x + ((ow - w) / 2.0 * sf) as i32, pos.y + ((oh - h) / 2.0 * sf) as i32));
            }
            let _ = window.set_size(tauri::LogicalSize::new(w, h));
            json!(p.scale * 100.0)
        }
        "pin-menu" => {
            let l = window.label().to_string();
            let mk = |id: &str, text: &str| MenuItem::with_id(&app, format!("{id}|{l}"), text, true, None::<&str>);
            if let (Ok(a), Ok(b), Ok(c), Ok(sep)) = (mk("pin-copy", i18n::t("Copy")), mk("pin-orig", i18n::t("Original size")), mk("pin-close", i18n::t("Close")), PredefinedMenuItem::separator(&app)) {
                if let Ok(menu) = Menu::with_items(&app, &[&a, &b, &sep, &c]) { let _ = window.popup_menu(&menu); }
            }
            json!(true)
        }
        _ => json!(false),
    }
}

#[tauri::command]
fn capture_init(app: AppHandle, window: WebviewWindow) -> Value {
    st(&app).region.lock().unwrap().as_ref().and_then(|s| s.init.get(window.label()).cloned()).unwrap_or(Value::Null)
}

#[tauri::command]
fn capture_done(app: AppHandle, window: WebviewWindow, result: Option<Value>) {
    if let Some(s) = st(&app).region.lock().unwrap().as_ref() {
        let _ = s.tx.send(result.map(|r| (window.label().to_string(), r)));
    }
}

fn raw_body(request: &tauri::ipc::Request<'_>) -> Option<Vec<u8>> {
    match request.body() { tauri::ipc::InvokeBody::Raw(b) => Some(b.clone()), _ => None }
}

#[tauri::command]
fn copy_image(request: tauri::ipc::Request<'_>) -> bool {
    raw_body(&request).and_then(|b| image::load_from_memory(&b).ok()).map(|img| copy_to_clipboard(&img.to_rgba8())).unwrap_or(false)
}

#[tauri::command]
fn pin_image(app: AppHandle, request: tauri::ipc::Request<'_>) -> bool {
    match raw_body(&request).and_then(|b| image::load_from_memory(&b).ok()) {
        Some(img) => { let rgba = img.to_rgba8(); thread::spawn(move || open_pin(&app, rgba)); true }
        None => false,
    }
}

#[tauri::command]
fn pin_data(app: AppHandle, window: WebviewWindow) -> Option<String> {
    st(&app).pins.lock().unwrap().get(window.label()).map(|p| format!("/api/blob/{}", p.blob))
}

// ---------------- startup ----------------
fn file_from_args(args: &[String]) -> Option<String> {
    args.iter().skip(1).filter(|a| !a.starts_with('-')).map(PathBuf::from)
        .find(|p| server::is_image(p) && p.exists()).map(|p| p.to_string_lossy().to_string())
}

fn data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("CAPTURA_DATA") { return PathBuf::from(d); }
    let base = dirs::data_dir().unwrap_or_default();
    let dir = base.join("Captura");
    // earlier versions (Lumen) kept the library here
    let old = base.join("Lumen");
    if !dir.join("library.json").exists() && old.join("library.json").exists() {
        let _ = std::fs::create_dir_all(dir.join("thumbs"));
        let _ = std::fs::copy(old.join("library.json"), dir.join("library.json"));
        if let Ok(rd) = std::fs::read_dir(old.join("thumbs")) { for e in rd.flatten() { let _ = std::fs::copy(e.path(), dir.join("thumbs").join(e.file_name())); } }
    }
    dir
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let hidden = args.iter().any(|a| a == "--hidden");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            match file_from_args(&argv) { Some(f) => open_viewer(app, &f), None => open_library(app) }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .invoke_handler(tauri::generate_handler![lumen_win, capture_init, capture_done, copy_image, pin_image, pin_data])
        .setup(move |app| {
            let handle = app.handle().clone();
            let (h1, h2) = (handle.clone(), handle.clone());
            let port = std::env::var("CAPTURA_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(0);
            let srv = Server::start(data_dir(), port, server::Hooks {
                pick_folder: Box::new(move || h1.dialog().file().set_title(i18n::t("Choose a folder")).blocking_pick_folder().map(|p| p.to_string())),
                asset: Box::new(move |path| h2.asset_resolver().get(path.to_string()).map(|a| (a.bytes().to_vec(), a.mime_type().to_string()))),
            });
            app.manage(AppState {
                srv, pins: Mutex::new(HashMap::new()), region: Mutex::new(None), last_region: Mutex::new(None),
                capturing: AtomicBool::new(false), hotkey_status: Mutex::new(json!({})), force_close: Mutex::new(HashSet::new()),
                counter: AtomicU64::new(1),
            });
            i18n::set_language(settings(&handle)["language"].as_str());
            register_hotkeys(&handle);
            let menu = tray_menu(&handle)?;
            TrayIconBuilder::with_id("captura")
                .icon(app.default_window_icon().cloned().unwrap())
                .tooltip("Captura").menu(&menu).show_menu_on_left_click(false)
                .on_menu_event(|app, e| on_menu(app, e.id().as_ref()))
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e { open_library(tray.app_handle()); }
                })
                .build(app)?;
            app.on_menu_event(|app, e| on_menu(app, e.id().as_ref()));
            match file_from_args(&args) {
                Some(f) => open_viewer(&handle, &f),
                None if !hidden => open_library(&handle),
                None => {}
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Captura")
        .run(|app, event| {
            if let RunEvent::ExitRequested { api, code: None, .. } = &event {
                // keep running in the tray (hotkeys stay active) unless turned off in Settings
                if settings(app)["trayOnClose"].as_bool() != Some(false) { api.prevent_exit(); } else { st(app).srv.flush(); }
            }
            if let RunEvent::Exit = event { st(app).srv.flush(); }
        });
}
