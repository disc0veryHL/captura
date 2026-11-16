//! Local HTTP server (127.0.0.1 only): library index, folder scan, thumbnail cache,
//! originals, exports and the UI files. The library is stored as library.json and is
//! compatible with the earlier Electron version.

use crate::meta;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tiny_http::{Header, Method, Request, Response, StatusCode};

pub const IMAGE_EXT: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif", "jfif"];
const SKIP_DIRS: &[&str] = &["windows", "winnt", "temp", "tmp", "program files", "program files (x86)", "programdata", "appdata",
    "node_modules", "$recycle.bin", "system volume information", "originals", ".picasaoriginals"];
/// Thumbnail generation version (2 = 600 px tall); must match the UI.
const THUMB_GEN: i64 = 2;
const SETTINGS_KEYS: &[&str] = &["exportDir", "theme", "accent", "thumbSize", "slideSeconds", "wheelZoom", "autoHideBar",
    "thumbShape", "thumbRadius", "gridGap", "showBadges", "viewerFullscreen", "viewerOpacity", "filmstrip",
    "screenshotDir", "afterCapture", "hotkeys", "captureCursor", "trayOnClose", "startWithWindows", "keymap", "language"];

pub fn is_image(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).map(|e| IMAGE_EXT.contains(&e.to_ascii_lowercase().as_str())).unwrap_or(false)
}
pub fn id_for(p: &str) -> String {
    let mut h = sha1_smol::Sha1::new();
    h.update(p.to_lowercase().as_bytes());
    h.digest().to_string()[..16].to_string()
}
fn new_id() -> String {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    id_for(&format!("{n}-{}", std::process::id()))[..12].to_string()
}
fn now_ms() -> f64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0) }
fn mtime_ms(md: &fs::Metadata) -> f64 {
    md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as f64 * 1000.0 + d.subsec_nanos() as f64 / 1e6).unwrap_or(0.0)
}
fn lower(p: &str) -> String { p.to_lowercase() }
fn inside(child: &str, root: &str) -> bool {
    let sep = std::path::MAIN_SEPARATOR;
    lower(&format!("{child}{sep}")).starts_with(&lower(&format!("{root}{sep}")))
}
fn s(v: &Value, k: &str) -> String { v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string() }
fn f(v: &Value, k: &str) -> f64 { v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0) }

pub struct Hooks {
    pub pick_folder: Box<dyn Fn() -> Option<String> + Send + Sync>,
    pub asset: Box<dyn Fn(&str) -> Option<(Vec<u8>, String)> + Send + Sync>,
}

#[derive(Default, Clone)]
struct ScanState { running: bool, found: u64, done: u64, root: String, version: u64 }

pub struct Server {
    pub port: u16,
    lib: Mutex<Value>,
    temp: Mutex<HashMap<String, Value>>,
    scan: Mutex<ScanState>,
    lib_file: PathBuf,
    thumbs: PathBuf,
    saver: Mutex<Sender<()>>,
    hooks: Hooks,
    /// in-memory images served to capture overlays and pin windows
    pub blobs: Mutex<HashMap<String, (Vec<u8>, &'static str)>>,
    scanned_once: Mutex<bool>,
}

impl Server {
    pub fn start(data_dir: PathBuf, port: u16, hooks: Hooks) -> Arc<Server> {
        let thumbs = data_dir.join("thumbs");
        let _ = fs::create_dir_all(&thumbs);
        let lib_file = data_dir.join("library.json");
        let mut lib: Value = fs::read_to_string(&lib_file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        if lib.get("version").and_then(|v| v.as_i64()) != Some(1) {
            let pics = dirs::picture_dir().filter(|p| p.exists());
            let base = pics.clone().or_else(dirs::home_dir).unwrap_or_default();
            lib = json!({ "version": 1, "folders": pics.map(|p| vec![p.to_string_lossy().to_string()]).unwrap_or_default(),
                "albums": [], "photos": {}, "settings": { "exportDir": base.join("Captura Exports").to_string_lossy() } });
        }
        for k in ["folders", "albums"] { if !lib[k].is_array() { lib[k] = json!([]); } }
        for k in ["photos", "settings"] { if !lib[k].is_object() { lib[k] = json!({}); } }

        let (tx, rx) = channel::<()>();
        let http = tiny_http::Server::http(format!("127.0.0.1:{port}")).expect("cannot start local server");
        let port = http.server_addr().to_ip().map(|a| a.port()).unwrap_or(port);
        let srv = Arc::new(Server {
            port, lib: Mutex::new(lib), temp: Mutex::new(HashMap::new()), scan: Mutex::new(ScanState::default()),
            lib_file, thumbs, saver: Mutex::new(tx), hooks, blobs: Mutex::new(HashMap::new()), scanned_once: Mutex::new(false),
        });
        // debounced saver
        let s2 = srv.clone();
        thread::spawn(move || {
            while rx.recv().is_ok() {
                thread::sleep(Duration::from_millis(400));
                while rx.try_recv().is_ok() {}
                s2.flush();
            }
        });
        // HTTP workers
        let http = Arc::new(http);
        for _ in 0..6 {
            let (h, s3) = (http.clone(), srv.clone());
            thread::spawn(move || {
                while let Ok(req) = h.recv() { s3.handle(req); }
            });
        }
        srv
    }

    pub fn url(&self) -> String { format!("http://127.0.0.1:{}/", self.port) }

    fn save(&self) { let _ = self.saver.lock().unwrap().send(()); }
    pub fn flush(&self) {
        let text = serde_json::to_string(&*self.lib.lock().unwrap()).unwrap_or_default();
        let tmp = self.lib_file.with_extension("json.tmp");
        if fs::write(&tmp, text).is_ok() { let _ = fs::rename(&tmp, &self.lib_file); }
    }
    pub fn settings(&self) -> Value { self.lib.lock().unwrap()["settings"].clone() }
    pub fn scan_once(self: &Arc<Self>) {
        let mut done = self.scanned_once.lock().unwrap();
        if !*done { *done = true; self.run_scan(); }
    }

    // ---------- records ----------
    fn build_record(file: &Path, md: &fs::Metadata, root: &str, prev: Option<&Value>) -> Value {
        let path = file.to_string_lossy().to_string();
        let m = meta::read(file);
        let rotated = (5..=8).contains(&m.orientation);
        let taken_ts = m.taken.as_deref().and_then(meta::exif_date_to_ts);
        let camera = {
            let make = m.make.clone().unwrap_or_default();
            let model = m.model.clone().unwrap_or_default();
            let c = if !make.is_empty() && lower(&model).starts_with(&lower(make.split(' ').next().unwrap_or(""))) { model } else { format!("{make} {model}") };
            let c = c.trim().to_string();
            if c.is_empty() { Value::Null } else { Value::String(c) }
        };
        let opt = |v: Option<f64>| v.filter(|x| *x != 0.0).map(|x| json!(x)).unwrap_or(Value::Null);
        json!({
            "id": id_for(&path), "path": path, "root": root,
            "folder": file.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
            "name": file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            "ext": format!(".{}", file.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase()),
            "size": md.len(), "mtime": mtime_ms(md),
            "w": if rotated { m.height } else { m.width }, "h": if rotated { m.width } else { m.height },
            "ts": taken_ts.unwrap_or_else(|| mtime_ms(md)), "dated": taken_ts.is_some(),
            "camera": camera, "lens": m.lens.map(Value::String).unwrap_or(Value::Null),
            "iso": opt(m.iso), "fnumber": opt(m.fnumber), "exposure": opt(m.exposure), "focal": opt(m.focal),
            "gps": m.gps.map(|(la, lo)| json!({ "lat": la, "lon": lo })).unwrap_or(Value::Null),
            "user": prev.and_then(|p| p.get("user")).cloned().unwrap_or_else(|| json!({})),
        })
    }

    fn thumb_valid(p: &Value) -> bool {
        let t = &p["user"]["thumb"];
        t.is_object() && f(t, "mtime") == f(p, "mtime") && t["v"].as_i64().unwrap_or(-1) == p["user"]["editsV"].as_i64().unwrap_or(0)
            && t["g"].as_i64() == Some(THUMB_GEN)
    }

    fn public(p: &Value) -> Value {
        let u = &p["user"];
        let mut o = p.as_object().cloned().unwrap_or_default();
        o.remove("user");
        let ev = u["editsV"].as_i64().unwrap_or(0);
        o.insert("loose".into(), json!(p["loose"].as_bool().unwrap_or(false)));
        o.insert("star".into(), json!(u["star"].as_bool().unwrap_or(false)));
        o.insert("hidden".into(), json!(u["hidden"].as_bool().unwrap_or(false)));
        o.insert("caption".into(), json!(u["caption"].as_str().unwrap_or("")));
        o.insert("tags".into(), if u["tags"].is_array() { u["tags"].clone() } else { json!([]) });
        o.insert("albums".into(), if u["albums"].is_array() { u["albums"].clone() } else { json!([]) });
        o.insert("edits".into(), u.get("edits").cloned().unwrap_or(Value::Null));
        o.insert("editsV".into(), json!(ev));
        o.insert("hash".into(), u.get("hash").cloned().unwrap_or(Value::Null));
        o.insert("captured".into(), json!(u["captured"].as_bool().unwrap_or(false)));
        o.insert("thumb".into(), if Self::thumb_valid(p) { json!(format!("{THUMB_GEN}-{ev}-{}", f(p, "mtime").round() as i64)) } else { Value::Null });
        Value::Object(o)
    }

    fn get_photo(&self, id: &str) -> Option<Value> {
        self.lib.lock().unwrap()["photos"].get(id).cloned().or_else(|| self.temp.lock().unwrap().get(id).cloned())
    }

    /// Index one new or changed file (captures, editor saves). Outside watched folders → `loose`.
    pub fn add_file_record(&self, file: &Path, captured: bool) -> Option<Value> {
        let md = fs::metadata(file).ok()?;
        let path = file.to_string_lossy().to_string();
        let id = id_for(&path);
        let mut lib = self.lib.lock().unwrap();
        let root = lib["folders"].as_array().unwrap().iter().filter_map(|x| x.as_str()).find(|r| inside(&path, r)).unwrap_or("").to_string();
        let prev = lib["photos"].get(&id).cloned().or_else(|| self.temp.lock().unwrap().get(&id).cloned());
        let mut rec = Self::build_record(file, &md, &root, prev.as_ref());
        if root.is_empty() { rec["loose"] = json!(true); }
        if captured { rec["user"]["captured"] = json!(true); }
        lib["photos"][&id] = rec.clone();
        self.temp.lock().unwrap().remove(&id);
        drop(lib);
        self.save();
        Some(rec)
    }
    pub fn ensure_folder(&self, dir: &Path) {
        let abs = dir.to_string_lossy().to_string();
        let mut lib = self.lib.lock().unwrap();
        let has = lib["folders"].as_array().unwrap().iter().filter_map(|x| x.as_str()).any(|r| inside(&abs, r));
        if !has { lib["folders"].as_array_mut().unwrap().push(json!(abs)); drop(lib); self.save(); }
    }
    pub fn add_capture(&self, file: &Path, base: &Path) -> Option<Value> {
        self.ensure_folder(base);
        self.add_file_record(file, true).map(|r| Self::public(&r))
    }

    // ---------- scanning ----------
    pub fn run_scan(self: &Arc<Self>) {
        {
            let mut sc = self.scan.lock().unwrap();
            if sc.running { return; }
            *sc = ScanState { running: true, version: sc.version, ..Default::default() };
        }
        let me = self.clone();
        thread::spawn(move || {
            let roots: Vec<String> = me.lib.lock().unwrap()["folders"].as_array().unwrap().iter().filter_map(|x| x.as_str().map(String::from)).collect();
            for root in &roots {
                me.scan.lock().unwrap().root = root.clone();
                let mut seen = HashSet::new();
                if me.walk(Path::new(root), root, &mut seen) {
                    let mut lib = me.lib.lock().unwrap();
                    lib["photos"].as_object_mut().unwrap().retain(|id, p| s(p, "root") != *root || seen.contains(id));
                }
            }
            {
                let mut lib = me.lib.lock().unwrap();
                let roots: HashSet<String> = lib["folders"].as_array().unwrap().iter().filter_map(|x| x.as_str().map(String::from)).collect();
                lib["photos"].as_object_mut().unwrap().retain(|_, p| p["loose"].as_bool().unwrap_or(false) || roots.contains(&s(p, "root")));
                lib["scannedAt"] = json!(now_ms());
            }
            me.save();
            let mut sc = me.scan.lock().unwrap();
            sc.running = false; sc.root.clear(); sc.version += 1;
        });
    }

    fn walk(&self, dir: &Path, root: &str, seen: &mut HashSet<String>) -> bool {
        let Ok(rd) = fs::read_dir(dir) else { return false };
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if ft.is_dir() {
                if name.starts_with('.') || SKIP_DIRS.contains(&name.to_lowercase().as_str()) { continue; }
                self.walk(&p, root, seen);
            } else if ft.is_file() && is_image(&p) {
                self.scan.lock().unwrap().found += 1;
                if let Ok(md) = e.metadata() {
                    if md.len() >= 1024 {
                        let path = p.to_string_lossy().to_string();
                        let id = id_for(&path);
                        let unchanged = {
                            let lib = self.lib.lock().unwrap();
                            lib["photos"].get(&id).map(|x| f(x, "mtime") == mtime_ms(&md) && x["size"].as_u64() == Some(md.len()) && !x["loose"].as_bool().unwrap_or(false)).unwrap_or(false)
                        };
                        if !unchanged {
                            let prev = self.lib.lock().unwrap()["photos"].get(&id).cloned();
                            let rec = Self::build_record(&p, &md, root, prev.as_ref());
                            self.lib.lock().unwrap()["photos"][&id] = rec;
                        }
                        seen.insert(id);
                    }
                }
                self.scan.lock().unwrap().done += 1;
            }
        }
        true
    }

    fn browse_folder(&self, file: &Path) -> (String, usize, Vec<Value>) {
        let dir = file.parent().unwrap_or(Path::new("")).to_path_buf();
        let mut files: Vec<PathBuf> = fs::read_dir(&dir).map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_file() && is_image(p)).collect()).unwrap_or_default();
        files.sort_by(|a, b| natural_cmp(&a.to_string_lossy(), &b.to_string_lossy()));
        let mut list = vec![];
        for fp in files {
            let path = fp.to_string_lossy().to_string();
            let id = id_for(&path);
            let Ok(md) = fs::metadata(&fp) else { continue };
            let known = self.lib.lock().unwrap()["photos"].get(&id).cloned();
            let same = |x: &Value| f(x, "mtime") == mtime_ms(&md) && x["size"].as_u64() == Some(md.len());
            if let Some(k) = &known { if same(k) { list.push(k.clone()); continue; } }
            let t = self.temp.lock().unwrap().get(&id).cloned();
            if let Some(t) = &t { if same(t) { list.push(t.clone()); continue; } }
            let root = known.as_ref().map(|k| s(k, "root")).unwrap_or_default();
            let mut rec = Self::build_record(&fp, &md, &root, known.as_ref().or(t.as_ref()));
            if let Some(k) = known {
                if let Some(l) = k.get("loose") { rec["loose"] = l.clone(); }
                self.lib.lock().unwrap()["photos"][&id] = rec.clone();
            } else { self.temp.lock().unwrap().insert(id, rec.clone()); }
            list.push(rec);
        }
        let idx = list.iter().position(|p| lower(&s(p, "path")) == lower(&file.to_string_lossy())).unwrap_or(0);
        (dir.to_string_lossy().to_string(), idx, list)
    }

    // ---------- HTTP ----------
    fn handle(self: &Arc<Self>, mut req: Request) {
        let host = req.headers().iter().find(|h| h.field.equiv("Host")).map(|h| h.value.as_str().to_string()).unwrap_or_default();
        let host = host.split(':').next().unwrap_or("");
        if host != "127.0.0.1" && host != "localhost" { let _ = req.respond(Response::empty(403)); return; }
        let url = req.url().to_string();
        let (path, query) = url.split_once('?').unwrap_or((&url, ""));
        let q: HashMap<String, String> = form_urlencoded::parse(query.as_bytes()).into_owned().collect();
        let path = percent_encoding::percent_decode_str(path).decode_utf8_lossy().to_string();
        if path.starts_with("/api/") {
            let lumen = req.headers().iter().any(|h| h.field.equiv("x-lumen") && h.value.as_str() == "1");
            if *req.method() != Method::Get && !lumen { let _ = req.respond(Response::empty(403)); return; }
            let parts: Vec<String> = path.split('/').filter(|x| !x.is_empty()).map(String::from).collect();
            let res = self.api(&mut req, &parts, &q);
            match res {
                Reply::Json(code, v) => respond_json(req, code, &v),
                Reply::File(file, mime, cache) => match fs::File::open(&file) {
                    Ok(fh) => { let _ = req.respond(Response::from_file(fh).with_header(hdr("Content-Type", mime)).with_header(hdr("Cache-Control", cache))); }
                    Err(_) => respond_json(req, 404, &json!({ "error": "File missing" })),
                },
                Reply::Bytes(b, mime) => { let _ = req.respond(Response::from_data(b).with_header(hdr("Content-Type", mime)).with_header(hdr("Cache-Control", "no-store"))); }
            }
        } else {
            let rel = if path == "/" { "index.html".to_string() } else { path.trim_start_matches('/').to_string() };
            if rel.contains("..") { let _ = req.respond(Response::empty(403)); return; }
            match (self.hooks.asset)(&rel) {
                Some((bytes, mime)) => { let _ = req.respond(Response::from_data(bytes).with_header(hdr("Content-Type", &mime)).with_header(hdr("Cache-Control", "no-cache"))); }
                None => { let _ = req.respond(Response::from_string("Not found").with_status_code(404)); }
            }
        }
    }

    fn api(self: &Arc<Self>, req: &mut Request, parts: &[String], q: &HashMap<String, String>) -> Reply {
        let m = req.method().clone();
        let p1 = parts.get(1).map(|x| x.as_str()).unwrap_or("");
        let body = |req: &mut Request| -> Value {
            let mut b = vec![];
            let _ = req.as_reader().take(8 * 1024 * 1024).read_to_end(&mut b);
            if b.is_empty() { json!({}) } else { serde_json::from_slice(&b).unwrap_or(json!({})) }
        };
        let raw = |req: &mut Request, limit: u64| -> Vec<u8> { let mut b = vec![]; let _ = req.as_reader().take(limit).read_to_end(&mut b); b };
        let ok = |v: Value| Reply::Json(200, v);
        let err = |c: u16, e: &str| Reply::Json(c, json!({ "error": e }));

        match (p1, &m) {
            ("library", Method::Get) => {
                let lib = self.lib.lock().unwrap();
                let photos: Vec<Value> = lib["photos"].as_object().unwrap().values().filter(|p| !p["loose"].as_bool().unwrap_or(false)).map(Self::public).collect();
                let sc = self.scan.lock().unwrap().clone();
                ok(json!({ "folders": lib["folders"], "albums": lib["albums"], "settings": lib["settings"], "photos": photos,
                    "scan": { "running": sc.running, "found": sc.found, "done": sc.done, "root": sc.root, "version": sc.version } }))
            }
            ("browse", Method::Get) => {
                let file = PathBuf::from(q.get("file").cloned().unwrap_or_default());
                if !is_image(&file) || !file.exists() { return err(404, "File not found"); }
                let (folder, index, photos) = self.browse_folder(&file);
                let lib = self.lib.lock().unwrap();
                let in_lib = lib["folders"].as_array().unwrap().iter().filter_map(|x| x.as_str()).any(|r| inside(&folder, r));
                ok(json!({ "folder": folder, "index": index, "inLibrary": in_lib, "settings": lib["settings"], "albums": lib["albums"],
                    "photos": photos.iter().map(Self::public).collect::<Vec<_>>() }))
            }
            ("scan", Method::Post) => { self.run_scan(); ok(json!({ "ok": true })) }
            ("scan", _) => {
                let sc = self.scan.lock().unwrap().clone();
                ok(json!({ "running": sc.running, "found": sc.found, "done": sc.done, "root": sc.root, "version": sc.version }))
            }
            ("folders", Method::Post) => {
                let b = body(req);
                let abs = PathBuf::from(s(&b, "path"));
                if abs.as_os_str().is_empty() || !abs.is_dir() { return err(400, "Folder not found"); }
                let abs = abs.to_string_lossy().to_string();
                {
                    let mut lib = self.lib.lock().unwrap();
                    if let Some(r) = lib["folders"].as_array().unwrap().iter().filter_map(|x| x.as_str()).find(|r| inside(&abs, r)) {
                        return err(409, &format!("Already watched inside {r}"));
                    }
                    let arr = lib["folders"].as_array_mut().unwrap();
                    arr.retain(|r| !inside(r.as_str().unwrap_or(""), &abs));
                    arr.push(json!(abs));
                }
                self.save(); self.run_scan();
                ok(json!({ "folders": self.lib.lock().unwrap()["folders"] }))
            }
            ("folders", Method::Delete) => {
                let p = q.get("path").cloned().unwrap_or_default();
                let mut lib = self.lib.lock().unwrap();
                lib["folders"].as_array_mut().unwrap().retain(|r| r.as_str() != Some(p.as_str()));
                lib["photos"].as_object_mut().unwrap().retain(|_, x| s(x, "root") != p);
                let folders = lib["folders"].clone();
                drop(lib); self.save();
                ok(json!({ "folders": folders }))
            }
            ("pick-folder", Method::Post) => ok(json!({ "path": (self.hooks.pick_folder)() })),
            ("reveal", Method::Post) => {
                let b = body(req);
                let target = if b["id"].is_string() { self.get_photo(&s(&b, "id")).map(|p| s(&p, "path")) } else { b["path"].as_str().map(String::from) };
                if let Some(t) = &target { if Path::new(t).exists() { reveal(t); } }
                ok(json!({ "ok": target.is_some() }))
            }
            ("settings", Method::Get) => ok(self.settings()),
            ("settings", Method::Patch) => {
                let b = body(req);
                let mut lib = self.lib.lock().unwrap();
                for k in SETTINGS_KEYS {
                    if let Some(v) = b.get(*k) {
                        let st = lib["settings"].as_object_mut().unwrap();
                        if v.is_null() { st.remove(*k); } else { st.insert((*k).into(), v.clone()); }
                    }
                }
                let out = lib["settings"].clone();
                drop(lib); self.save();
                ok(out)
            }
            ("albums", Method::Post) => {
                let b = body(req);
                let name: String = b["name"].as_str().unwrap_or("New album").chars().take(120).collect();
                let a = json!({ "id": new_id(), "name": name, "created": now_ms() });
                let mut lib = self.lib.lock().unwrap();
                lib["albums"].as_array_mut().unwrap().push(a.clone());
                for id in b["ids"].as_array().cloned().unwrap_or_default() {
                    if let Some(p) = lib["photos"].get_mut(id.as_str().unwrap_or("")) { add_unique(&mut p["user"], "albums", a["id"].clone()); }
                }
                drop(lib); self.save();
                ok(a)
            }
            ("albums", _) => {
                let aid = parts.get(2).cloned().unwrap_or_default();
                let mut lib = self.lib.lock().unwrap();
                let Some(pos) = lib["albums"].as_array().unwrap().iter().position(|a| s(a, "id") == aid) else { return err(404, "No album") };
                if m == Method::Patch {
                    drop(lib);
                    let b = body(req);
                    let mut lib = self.lib.lock().unwrap();
                    let a = &mut lib["albums"][pos];
                    if let Some(n) = b["name"].as_str() { a["name"] = json!(n.chars().take(120).collect::<String>()); }
                    if let Some(c) = b.get("cover") { a["cover"] = c.clone(); }
                    let out = a.clone();
                    drop(lib); self.save();
                    return ok(out);
                }
                if m == Method::Delete {
                    lib["albums"].as_array_mut().unwrap().remove(pos);
                    for p in lib["photos"].as_object_mut().unwrap().values_mut() {
                        if let Some(arr) = p["user"]["albums"].as_array_mut() { arr.retain(|x| x.as_str() != Some(aid.as_str())); }
                    }
                    drop(lib); self.save();
                    return ok(json!({ "ok": true }));
                }
                err(404, "Unknown route")
            }
            ("photos", Method::Patch) => {
                let b = body(req);
                let patch = b["patch"].clone();
                let mut out = vec![];
                let mut lib = self.lib.lock().unwrap();
                for id in b["ids"].as_array().cloned().unwrap_or_default() {
                    let id = id.as_str().unwrap_or("").to_string();
                    if lib["photos"].get(&id).is_none() {
                        if let Some(mut t) = self.temp.lock().unwrap().remove(&id) { t["loose"] = json!(true); lib["photos"][&id] = t; } else { continue; }
                    }
                    let u = &mut lib["photos"][&id]["user"];
                    if !u.is_object() { *u = json!({}); }
                    if let Some(v) = patch.get("star") { u["star"] = json!(v.as_bool().unwrap_or(false)); }
                    if let Some(v) = patch.get("hidden") { u["hidden"] = json!(v.as_bool().unwrap_or(false)); }
                    if let Some(v) = patch.get("caption") { u["caption"] = json!(v.as_str().unwrap_or("").chars().take(2000).collect::<String>()); }
                    if let Some(v) = patch.get("tags").and_then(|t| t.as_array()) {
                        let mut seen = HashSet::new();
                        let tags: Vec<Value> = v.iter().filter_map(|x| x.as_str()).map(|x| x.trim().to_string()).filter(|x| !x.is_empty() && seen.insert(x.clone())).take(64).map(Value::String).collect();
                        u["tags"] = json!(tags);
                    }
                    if let Some(t) = patch.get("addTag").and_then(|t| t.as_str()) { add_unique(u, "tags", json!(t.trim())); }
                    if let Some(a) = patch.get("addAlbum").filter(|a| a.is_string()) { add_unique(u, "albums", a.clone()); }
                    if let Some(a) = patch.get("removeAlbum").and_then(|a| a.as_str()) { if let Some(arr) = u["albums"].as_array_mut() { arr.retain(|x| x.as_str() != Some(a)); } }
                    if let Some(e) = patch.get("edits") { u["edits"] = e.clone(); u["editsV"] = json!(u["editsV"].as_i64().unwrap_or(0) + 1); }
                    out.push(Self::public(&lib["photos"][&id]));
                }
                drop(lib); self.save();
                ok(json!({ "photos": out }))
            }
            ("photo", _) => {
                let id = parts.get(2).cloned().unwrap_or_default();
                let Some(p) = self.get_photo(&id) else { return err(404, "No photo") };
                match (parts.get(3).map(|x| x.as_str()), &m) {
                    (Some("info"), Method::Get) => ok(json!({ "photo": Self::public(&p), "settings": self.settings() })),
                    (Some("original"), Method::Get) => Reply::File(PathBuf::from(s(&p, "path")), mime_for(&s(&p, "ext")), "private, max-age=60"),
                    (Some("thumb"), Method::Get) => {
                        if !Self::thumb_valid(&p) { return err(404, "No thumb"); }
                        Reply::File(self.thumbs.join(format!("{id}.jpg")), "image/jpeg", "private, max-age=31536000, immutable")
                    }
                    (Some("thumb"), Method::Put) => {
                        let buf = raw(req, 4 * 1024 * 1024);
                        if buf.len() < 2 || buf[0] != 0xff || buf[1] != 0xd8 { return err(400, "JPEG expected"); }
                        let v: i64 = q.get("v").and_then(|x| x.parse().ok()).unwrap_or(0);
                        if v != p["user"]["editsV"].as_i64().unwrap_or(0) { return err(409, "stale"); }
                        if fs::write(self.thumbs.join(format!("{id}.jpg")), &buf).is_err() { return err(500, "write failed"); }
                        let hash = q.get("hash").filter(|h| h.len() == 16 && h.chars().all(|c| c.is_ascii_hexdigit())).cloned();
                        let mut lib = self.lib.lock().unwrap();
                        let mut temp = self.temp.lock().unwrap();
                        let rec = if lib["photos"].get(&id).is_some() { &mut lib["photos"][&id] } else if let Some(t) = temp.get_mut(&id) { t } else { return err(404, "No photo") };
                        rec["user"]["thumb"] = json!({ "v": v, "mtime": rec["mtime"], "g": THUMB_GEN });
                        if let Some(hs) = hash { rec["user"]["hash"] = json!(hs); }
                        let out = Self::public(rec);
                        drop(temp); drop(lib); self.save();
                        ok(json!({ "thumb": out["thumb"], "hash": out["hash"] }))
                    }
                    _ => err(404, "Unknown route"),
                }
            }
            ("annotate-save", Method::Post) => {
                let Some(p) = self.get_photo(q.get("id").map(|x| x.as_str()).unwrap_or("")) else { return err(404, "No photo") };
                let buf = raw(req, 256 * 1024 * 1024);
                if buf.len() < 4 || &buf[1..4] != b"PNG" { return err(400, "PNG expected"); }
                let overwrite = q.get("mode").map(|x| x == "overwrite").unwrap_or(false) && p["user"]["captured"].as_bool().unwrap_or(false) && s(&p, "ext") == ".png";
                let file = if overwrite { PathBuf::from(s(&p, "path")) } else {
                    let name = s(&p, "name");
                    let stem = Path::new(&name).file_stem().map(|x| x.to_string_lossy().to_string()).unwrap_or(name);
                    let stem = strip_edited(&stem);
                    unique_file(Path::new(&s(&p, "folder")), &format!("{stem} (edited)"), ".png")
                };
                if fs::write(&file, &buf).is_err() { return err(500, "Save failed"); }
                let rec = self.add_file_record(&file, true);
                ok(json!({ "path": file.to_string_lossy(), "overwritten": overwrite, "photo": rec.map(|r| Self::public(&r)) }))
            }
            ("export", Method::Post) => {
                let name: String = q.get("name").cloned().unwrap_or_else(|| "export".into()).chars()
                    .map(|c| if "<>:\"/\\|?*".contains(c) || (c as u32) < 32 { '_' } else { c }).take(150).collect();
                let ext = match q.get("format").map(|x| x.as_str()) { Some("png") => ".png", Some("webp") => ".webp", _ => ".jpg" };
                let dir = q.get("dir").filter(|d| !d.is_empty()).cloned().unwrap_or_else(|| s(&self.settings(), "exportDir"));
                let dir = PathBuf::from(dir);
                let buf = raw(req, 512 * 1024 * 1024);
                let _ = fs::create_dir_all(&dir);
                let file = unique_file(&dir, &name, ext);
                if fs::write(&file, &buf).is_err() { return err(500, "Export failed"); }
                ok(json!({ "path": file.to_string_lossy() }))
            }
            ("blob", Method::Get) => {
                let key = parts.get(2).cloned().unwrap_or_default();
                match self.blobs.lock().unwrap().get(&key) { Some((b, mime)) => Reply::Bytes(b.clone(), mime), None => err(404, "gone") }
            }
            _ => err(404, "Unknown route"),
        }
    }
}

enum Reply { Json(u16, Value), File(PathBuf, &'static str, &'static str), Bytes(Vec<u8>, &'static str) }

fn hdr(k: &str, v: &str) -> Header { Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap() }
fn respond_json(req: Request, code: u16, v: &Value) {
    let _ = req.respond(Response::from_string(v.to_string()).with_status_code(StatusCode(code))
        .with_header(hdr("Content-Type", "application/json")).with_header(hdr("Cache-Control", "no-store")));
}
fn mime_for(ext: &str) -> &'static str {
    match ext { ".jpg" | ".jpeg" | ".jfif" => "image/jpeg", ".png" => "image/png", ".webp" => "image/webp", ".gif" => "image/gif",
        ".bmp" => "image/bmp", ".avif" => "image/avif", _ => "application/octet-stream" }
}
fn add_unique(obj: &mut Value, key: &str, v: Value) {
    if !obj[key].is_array() { obj[key] = json!([]); }
    let arr = obj[key].as_array_mut().unwrap();
    if !arr.contains(&v) { arr.push(v); }
}
fn strip_edited(stem: &str) -> String {
    if let Some(i) = stem.rfind(" (edited") { if stem.ends_with(')') { return stem[..i].to_string(); } }
    stem.to_string()
}
pub fn unique_file(dir: &Path, base: &str, ext: &str) -> PathBuf {
    let mut p = dir.join(format!("{base}{ext}"));
    let mut i = 1;
    while p.exists() { p = dir.join(format!("{base} ({i}){ext}")); i += 1; }
    p
}
pub fn reveal(path: &str) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("explorer.exe").raw_arg(format!("/select,\"{path}\"")).spawn();
    }
}
/// "IMG 2" < "IMG 10": compare digit runs by number, the rest case-insensitively.
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (mut ai, mut bi) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, _) => return std::cmp::Ordering::Less,
            (_, None) => return std::cmp::Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut na = String::new(); while let Some(c) = ai.peek().copied().filter(|c| c.is_ascii_digit()) { na.push(c); ai.next(); }
                let mut nb = String::new(); while let Some(c) = bi.peek().copied().filter(|c| c.is_ascii_digit()) { nb.push(c); bi.next(); }
                let o = na.trim_start_matches('0').len().cmp(&nb.trim_start_matches('0').len()).then(na.trim_start_matches('0').cmp(nb.trim_start_matches('0')));
                if o != std::cmp::Ordering::Equal { return o; }
            }
            (Some(x), Some(y)) => {
                let o = x.to_lowercase().cmp(y.to_lowercase());
                if o != std::cmp::Ordering::Equal { return o; }
                ai.next(); bi.next();
            }
        }
    }
}
