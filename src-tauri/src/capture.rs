//! Screen capture with xcap: monitors, visible windows (for snapping), crops.
//! Coordinates from xcap are physical pixels in virtual-screen space.

use image::RgbaImage;
use serde_json::{json, Value};
use xcap::{Monitor, Window};

pub struct Grab {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub image: RgbaImage,
}

pub fn grab_all() -> Vec<Grab> {
    let mut out = vec![];
    for m in Monitor::all().unwrap_or_default() {
        let (Ok(x), Ok(y), Ok(w), Ok(h)) = (m.x(), m.y(), m.width(), m.height()) else { continue };
        let scale = m.scale_factor().unwrap_or(1.0) as f64;
        if let Ok(image) = m.capture_image() {
            out.push(Grab { x, y, width: w, height: h, scale, image });
        }
    }
    out
}

pub fn grab_at(px: i32, py: i32) -> Option<Grab> {
    let m = Monitor::from_point(px, py).ok().or_else(|| Monitor::all().ok()?.into_iter().next())?;
    let (x, y, w, h) = (m.x().ok()?, m.y().ok()?, m.width().ok()?, m.height().ok()?);
    let scale = m.scale_factor().unwrap_or(1.0) as f64;
    Some(Grab { x, y, width: w, height: h, scale, image: m.capture_image().ok()? })
}

pub struct WinRect { pub x: i32, pub y: i32, pub w: u32, pub h: u32, pub title: String, pub focused: bool }

/// Visible top-level windows, top-most first, excluding Captura's own overlays.
pub fn windows() -> Vec<WinRect> {
    let mut list: Vec<(i32, WinRect)> = Window::all().unwrap_or_default().into_iter().filter_map(|w| {
        if w.is_minimized().unwrap_or(true) { return None; }
        let (x, y, ww, hh) = (w.x().ok()?, w.y().ok()?, w.width().ok()?, w.height().ok()?);
        if ww < 30 || hh < 30 { return None; }
        let title = w.title().unwrap_or_default();
        if title == "Captura capture" || title == "Captura pin" { return None; }
        let z = w.z().unwrap_or(0);
        Some((z, WinRect { x, y, w: ww, h: hh, title, focused: w.is_focused().unwrap_or(false) }))
    }).collect();
    list.sort_by(|a, b| b.0.cmp(&a.0));
    list.into_iter().map(|x| x.1).collect()
}

/// Window rectangles relative to a monitor, in CSS pixels (for the overlay page).
pub fn windows_for(g: &Grab, wins: &[WinRect]) -> Value {
    let v: Vec<Value> = wins.iter().filter_map(|w| {
        let (x, y) = ((w.x - g.x) as f64 / g.scale, (w.y - g.y) as f64 / g.scale);
        let (ww, hh) = (w.w as f64 / g.scale, w.h as f64 / g.scale);
        let (gw, gh) = (g.width as f64 / g.scale, g.height as f64 / g.scale);
        if x >= gw || y >= gh || x + ww <= 0.0 || y + hh <= 0.0 { return None; }
        Some(json!({ "x": x, "y": y, "width": ww, "height": hh, "title": w.title }))
    }).collect();
    Value::Array(v)
}

/// Crop a rectangle given in the grab's own pixels, clamped to the image.
pub fn crop(img: &RgbaImage, x: i64, y: i64, w: i64, h: i64) -> Option<RgbaImage> {
    let (iw, ih) = (img.width() as i64, img.height() as i64);
    let (x0, y0) = (x.clamp(0, iw), y.clamp(0, ih));
    let (x1, y1) = ((x + w).clamp(0, iw), (y + h).clamp(0, ih));
    if x1 - x0 < 2 || y1 - y0 < 2 { return None; }
    Some(image::imageops::crop_imm(img, x0 as u32, y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32).to_image())
}

pub fn active_window() -> Option<RgbaImage> {
    let wins = windows();
    let w = wins.iter().find(|w| w.focused).or_else(|| wins.first())?;
    let cx = w.x + w.w as i32 / 2;
    let cy = w.y + w.h as i32 / 2;
    let g = grab_at(cx, cy)?;
    crop(&g.image, (w.x - g.x) as i64, (w.y - g.y) as i64, w.w as i64, w.h as i64)
}

pub fn encode_png(img: &RgbaImage) -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    let _ = img.write_to(&mut out, image::ImageFormat::Png);
    out.into_inner()
}

/// Fast JPEG for showing a frozen screen in the overlay (the crop uses the lossless grab).
pub fn encode_preview(img: &RgbaImage) -> Vec<u8> {
    let rgb = image::DynamicImage::ImageRgba8(img.clone()).to_rgb8();
    let mut out = std::io::Cursor::new(Vec::new());
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 92);
    let _ = enc.encode_image(&rgb);
    out.into_inner()
}
