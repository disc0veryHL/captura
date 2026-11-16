fn main() {
    // Pages load from the app's own 127.0.0.1 server (a "remote" origin for Tauri), so each
    // app command needs a permission that the default capability grants.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["lumen_win", "capture_init", "capture_done", "copy_image", "pin_image", "pin_data"]),
    ))
    .expect("failed to run tauri-build");
}
