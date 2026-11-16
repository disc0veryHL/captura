//! Photo metadata: pixel size, EXIF camera/exposure/date/GPS, orientation.

use chrono::{Local, TimeZone};
use exif::{In, Reader, Tag, Value};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

#[derive(Default, Debug)]
pub struct Meta {
    pub width: u32,
    pub height: u32,
    pub orientation: u32,
    pub taken: Option<String>,
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    pub iso: Option<f64>,
    pub fnumber: Option<f64>,
    pub exposure: Option<f64>,
    pub focal: Option<f64>,
    pub gps: Option<(f64, f64)>,
}

fn rational(v: &Value) -> Option<f64> {
    match v {
        Value::Rational(r) if !r.is_empty() => Some(r[0].to_f64()),
        Value::SRational(r) if !r.is_empty() => Some(r[0].to_f64()),
        Value::Short(s) if !s.is_empty() => Some(s[0] as f64),
        Value::Long(l) if !l.is_empty() => Some(l[0] as f64),
        _ => None,
    }
}

fn ascii(v: &Value) -> Option<String> {
    if let Value::Ascii(parts) = v {
        let s = parts.iter().map(|p| String::from_utf8_lossy(p).trim().trim_matches('\0').to_string()).collect::<Vec<_>>().join(" ");
        let s = s.trim().to_string();
        if !s.is_empty() { return Some(s); }
    }
    None
}

fn dms(v: &Value) -> Option<f64> {
    if let Value::Rational(r) = v {
        if r.len() >= 3 { return Some(r[0].to_f64() + r[1].to_f64() / 60.0 + r[2].to_f64() / 3600.0); }
        if !r.is_empty() { return Some(r[0].to_f64()); }
    }
    None
}

pub fn read(path: &Path) -> Meta {
    let mut m = Meta::default();
    // pixel size from the file header
    if let Ok(mut f) = File::open(path) {
        let mut head = vec![0u8; 512 * 1024];
        let n = f.read(&mut head).unwrap_or(0);
        head.truncate(n);
        if let Ok(sz) = imagesize::blob_size(&head) {
            m.width = sz.width as u32;
            m.height = sz.height as u32;
        }
    }
    // EXIF (JPEG, and the EXIF chunk of PNG/WebP where present)
    let Ok(f) = File::open(path) else { return m };
    let Ok(ex) = Reader::new().read_from_container(&mut BufReader::new(f)) else { return m };
    let get = |t: Tag| ex.get_field(t, In::PRIMARY).map(|f| &f.value);
    m.orientation = get(Tag::Orientation).and_then(rational).unwrap_or(0.0) as u32;
    m.taken = get(Tag::DateTimeOriginal).or(get(Tag::DateTimeDigitized)).or(get(Tag::DateTime)).and_then(ascii);
    m.make = get(Tag::Make).and_then(ascii);
    m.model = get(Tag::Model).and_then(ascii);
    m.lens = get(Tag::LensModel).and_then(ascii);
    m.iso = get(Tag::PhotographicSensitivity).and_then(rational);
    m.fnumber = get(Tag::FNumber).and_then(rational);
    m.exposure = get(Tag::ExposureTime).and_then(rational);
    m.focal = get(Tag::FocalLength).and_then(rational);
    if m.width == 0 {
        m.width = get(Tag::PixelXDimension).and_then(rational).unwrap_or(0.0) as u32;
        m.height = get(Tag::PixelYDimension).and_then(rational).unwrap_or(0.0) as u32;
    }
    if let (Some(lat), Some(lon)) = (get(Tag::GPSLatitude).and_then(dms), get(Tag::GPSLongitude).and_then(dms)) {
        let s = get(Tag::GPSLatitudeRef).and_then(ascii).unwrap_or_default();
        let w = get(Tag::GPSLongitudeRef).and_then(ascii).unwrap_or_default();
        let lat = if s.starts_with('S') { -lat } else { lat };
        let lon = if w.starts_with('W') { -lon } else { lon };
        if lat.is_finite() && lon.is_finite() && !(lat == 0.0 && lon == 0.0) { m.gps = Some((lat, lon)); }
    }
    m
}

/// "2023:05:01 14:22:10" → local timestamp in ms.
pub fn exif_date_to_ts(s: &str) -> Option<f64> {
    let d: Vec<u32> = s.split(|c: char| !c.is_ascii_digit()).filter(|x| !x.is_empty()).filter_map(|x| x.parse().ok()).collect();
    if d.len() < 6 || d[0] < 1900 || !(1..=12).contains(&d[1]) { return None; }
    Local.with_ymd_and_hms(d[0] as i32, d[1], d[2], d[3], d[4], d[5]).single().map(|t| t.timestamp_millis() as f64)
}
