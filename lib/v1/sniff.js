// Magic-byte content sniffer (D-06 / INP-02 cont.). The AUTHORITATIVE content
// type is decided here from the raw bytes only — the client-declared multipart
// mimetype is untrusted and is never read. Unknown / spoofed bytes → null, which
// the router maps to a typed 422. Every branch is length-guarded so a truncated
// or empty buffer can never index past the end.

// Still-image ISO-BMFF brands. An `ftyp` box whose major brand is NOT one of
// these (e.g. an .heic-named MP4 with 'mp42'/'isom') must NOT sniff as HEIC
// (T-03-02 false-positive guard).
const HEIC_BRANDS = new Set(['heic', 'heif', 'heix', 'mif1']);

function sniffImage(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';

  // PDF — '%PDF' (25 50 44 46). The version/binary comment follows.
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';

  // TIFF — little-endian 'II*\0' (49 49 2A 00) or big-endian 'MM\0*' (4D 4D 00 2A).
  if (buf.length >= 4 && buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2A && buf[3] === 0x00) return 'image/tiff';
  if (buf.length >= 4 && buf[0] === 0x4D && buf[1] === 0x4D && buf[2] === 0x00 && buf[3] === 0x2A) return 'image/tiff';

  // HEIC/HEIF — ISO-BMFF 'ftyp' box at bytes 4-8, then the major brand at
  // bytes 8-12 must be a still-image brand. Need ≥12 bytes to read the brand.
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (HEIC_BRANDS.has(brand)) return 'image/heic';
    return null; // ftyp box with a non-image brand (mp42/isom/…) — not HEIC.
  }

  // BMP — 'BM' (42 4D).
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4D) return 'image/bmp';

  // GIF — 'GIF87a' / 'GIF89a' (6-byte signature).
  if (buf.length >= 6) {
    const sig = buf.toString('ascii', 0, 6);
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif';
  }

  return null;
}

module.exports = { sniffImage };
