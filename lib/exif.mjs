// Minimal metadata reader: JPEG EXIF (camera, date, exposure, GPS) and
// pixel dimensions for JPEG, PNG, GIF and WebP. Reads only the bytes given.

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function parseTiff(view, start, length) {
  const out = {};
  const le = view.getUint16(start) === 0x4949;
  const u16 = (o) => view.getUint16(start + o, le);
  const u32 = (o) => view.getUint32(start + o, le);
  const i32 = (o) => view.getInt32(start + o, le);
  const inRange = (o, n) => o >= 0 && o + n <= length;

  function readIfd(offset) {
    const tags = {};
    if (!inRange(offset, 2)) return tags;
    const count = u16(offset);
    for (let i = 0; i < count; i++) {
      const e = offset + 2 + i * 12;
      if (!inRange(e, 12)) break;
      const tag = u16(e);
      const type = u16(e + 2);
      const n = u32(e + 4);
      const size = (TYPE_SIZE[type] || 1) * n;
      const at = size > 4 ? u32(e + 8) : e + 8;
      if (!inRange(at, Math.min(size, 4096))) continue;
      tags[tag] = readValue(type, n, at);
    }
    return tags;
  }

  function readValue(type, n, at) {
    switch (type) {
      case 2: {
        let s = '';
        for (let i = 0; i < Math.min(n, 256); i++) {
          const c = view.getUint8(start + at + i);
          if (c === 0) break;
          s += String.fromCharCode(c);
        }
        return s.trim();
      }
      case 3: return n === 1 ? u16(at) : Array.from({ length: Math.min(n, 8) }, (_, i) => u16(at + i * 2));
      case 4: return n === 1 ? u32(at) : Array.from({ length: Math.min(n, 8) }, (_, i) => u32(at + i * 4));
      case 9: return i32(at);
      case 5: case 10: {
        const vals = [];
        for (let i = 0; i < Math.min(n, 4); i++) {
          const num = type === 5 ? u32(at + i * 8) : i32(at + i * 8);
          const den = type === 5 ? u32(at + i * 8 + 4) : i32(at + i * 8 + 4);
          vals.push(den ? num / den : 0);
        }
        return n === 1 ? vals[0] : vals;
      }
      case 1: case 7: return n === 1 ? view.getUint8(start + at) : null;
      default: return null;
    }
  }

  const ifd0 = readIfd(u32(4));
  const exif = ifd0[0x8769] ? readIfd(ifd0[0x8769]) : {};
  const gps = ifd0[0x8825] ? readIfd(ifd0[0x8825]) : {};

  if (ifd0[0x010f]) out.make = ifd0[0x010f];
  if (ifd0[0x0110]) out.model = ifd0[0x0110];
  if (ifd0[0x0112]) out.orientation = ifd0[0x0112];
  const dt = exif[0x9003] || exif[0x9004] || ifd0[0x0132];
  if (dt) out.taken = dt;
  if (exif[0x829a]) out.exposure = exif[0x829a];
  if (exif[0x829d]) out.fnumber = exif[0x829d];
  if (exif[0x8827]) out.iso = Array.isArray(exif[0x8827]) ? exif[0x8827][0] : exif[0x8827];
  if (exif[0x920a]) out.focal = exif[0x920a];
  if (exif[0xa434]) out.lens = exif[0xa434];
  if (exif[0xa002] && exif[0xa003]) { out.width = exif[0xa002]; out.height = exif[0xa003]; }

  const lat = gps[2], lon = gps[4];
  if (Array.isArray(lat) && Array.isArray(lon)) {
    const dms = (v) => v[0] + (v[1] || 0) / 60 + (v[2] || 0) / 3600;
    let la = dms(lat), lo = dms(lon);
    if (gps[1] === 'S') la = -la;
    if (gps[3] === 'W') lo = -lo;
    if (Number.isFinite(la) && Number.isFinite(lo) && !(la === 0 && lo === 0)) out.gps = { lat: la, lon: lo };
  }
  return out;
}

function readJpeg(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let meta = {};
  let o = 2;
  while (o + 4 <= buf.length) {
    if (buf[o] !== 0xff) { o++; continue; }
    const marker = buf[o + 1];
    if (marker === 0xff) { o++; continue; }
    if (marker === 0xd9 || marker === 0xda) break;
    const len = view.getUint16(o + 2);
    if (marker === 0xe1 && buf.toString('latin1', o + 4, o + 10) === 'Exif\0\0') {
      try {
        const tiffLen = Math.min(len - 8, buf.length - (o + 10));
        meta = { ...parseTiff(view, o + 10, tiffLen), ...meta };
      } catch { /* malformed EXIF: keep what we have */ }
    }
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof && o + 9 <= buf.length) {
      meta.height = view.getUint16(o + 5);
      meta.width = view.getUint16(o + 7);
      meta.sof = true;
    }
    o += 2 + len;
  }
  return meta;
}

export function readMeta(buf, ext) {
  try {
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      const m = readJpeg(buf);
      // SOF dimensions are authoritative over EXIF PixelXDimension.
      return m;
    }
    if (buf.toString('latin1', 1, 4) === 'PNG') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (buf.toString('latin1', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
      const chunk = buf.toString('latin1', 12, 16);
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    }
    if (buf.toString('latin1', 0, 2) === 'BM') return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
  } catch { /* unreadable header */ }
  return {};
}

// "2023:05:01 14:22:10" -> local timestamp (ms) or null
export function exifDateToTs(s) {
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s || '');
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  if (y < 1900 || mo < 1 || mo > 12) return null;
  const t = new Date(y, mo - 1, d, h, mi, se).getTime();
  return Number.isFinite(t) ? t : null;
}
