const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sniffImage } = require('../lib/v1/sniff');

// VAL-02: magic-byte sniff identifies PNG/JPEG/WebP and rejects other types.
// The sniff is the second authoritative gate after multer's declared-MIME
// fileFilter (D-09/D-10). It must reject SVG, random bytes, and truncated
// buffers without throwing.

test('sniffImage identifies PNG by magic bytes (89 50 4E 47)', () => {
  const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00]);
  assert.equal(sniffImage(png), 'image/png');
});

test('sniffImage identifies JPEG by magic bytes (FF D8 FF)', () => {
  const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
  assert.equal(sniffImage(jpeg), 'image/jpeg');
});

test('sniffImage identifies WebP by RIFF + WEBP container', () => {
  // RIFF (4) + size (4) + WEBP (4) — both checks required, RIFF alone matches WAV/AVI
  const webp = Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8L', 'binary');
  assert.equal(sniffImage(webp), 'image/webp');
});

test('sniffImage rejects RIFF-only buffers (WAV/AVI must NOT pass)', () => {
  // RIFF...WAVE — must NOT be classified as WebP (D-09 risk)
  const wav = Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ', 'binary');
  assert.equal(sniffImage(wav), null);
});

test('sniffImage rejects SVG / XML (no binary signature)', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal(sniffImage(svg), null);
});

test('sniffImage rejects random / non-image bytes', () => {
  const rand = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B]);
  assert.equal(sniffImage(rand), null);
});

test('sniffImage rejects truncated PNG header (< 8 bytes)', () => {
  const tinyPng = Buffer.from([0x89, 0x50, 0x4E, 0x47]); // first 4 bytes only — length guard fires
  assert.equal(sniffImage(tinyPng), null);
});

test('sniffImage rejects truncated JPEG header (< 3 bytes)', () => {
  const tinyJpeg = Buffer.from([0xFF, 0xD8]);
  assert.equal(sniffImage(tinyJpeg), null);
});

test('sniffImage rejects truncated WebP header (< 12 bytes)', () => {
  const tinyWebp = Buffer.from('RIFF\x00\x00\x00\x00WEB', 'binary'); // 11 bytes
  assert.equal(sniffImage(tinyWebp), null);
});

test('sniffImage rejects empty buffer', () => {
  assert.equal(sniffImage(Buffer.alloc(0)), null);
});

test('sniffImage does not match text/HTML files', () => {
  const html = Buffer.from('<!DOCTYPE html><html><body></body></html>');
  assert.equal(sniffImage(html), null);
});

// --- Phase 3 (D-06 / INP-03..05): PDF, TIFF, HEIC/HEIF, BMP, GIF magic bytes.
// Type decided by magic bytes only — never the client content-type. Spoofed /
// unknown bytes still fall through to null (typed 422 upstream).

test('sniffImage identifies PDF by %PDF signature', () => {
  const pdf = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3', 'binary');
  assert.equal(sniffImage(pdf), 'application/pdf');
});

test('sniffImage identifies little-endian TIFF (49 49 2A 00)', () => {
  const tiffLE = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00]);
  assert.equal(sniffImage(tiffLE), 'image/tiff');
});

test('sniffImage identifies big-endian TIFF (4D 4D 00 2A)', () => {
  const tiffBE = Buffer.from([0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08]);
  assert.equal(sniffImage(tiffBE), 'image/tiff');
});

test('sniffImage identifies HEIC by ftyp box with major brand heic', () => {
  // ISO-BMFF: [4-byte box size][ftyp][major brand][minor version]...
  const heic = Buffer.from('\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic', 'binary');
  assert.equal(sniffImage(heic), 'image/heic');
});

test('sniffImage identifies HEIF by ftyp box with major brand mif1', () => {
  const heif = Buffer.from('\x00\x00\x00\x18ftypmif1\x00\x00\x00\x00mif1heic', 'binary');
  assert.equal(sniffImage(heif), 'image/heic');
});

test('sniffImage identifies HEIC variant brand heix', () => {
  const heix = Buffer.from('\x00\x00\x00\x18ftypheix\x00\x00\x00\x00heixheic', 'binary');
  assert.equal(sniffImage(heix), 'image/heic');
});

test('sniffImage rejects ftyp box with non-image brand mp42 (.heic-named MP4 must NOT pass)', () => {
  // T-03-02 false-positive guard — an MP4/MOV ftyp box must not sniff as HEIC.
  const mp4 = Buffer.from('\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom', 'binary');
  assert.equal(sniffImage(mp4), null);
});

test('sniffImage rejects ftyp box with isom brand (generic ISO base media)', () => {
  const isom = Buffer.from('\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2', 'binary');
  assert.equal(sniffImage(isom), null);
});

// Build a BMP file header + DIB header of the given size.
function bmpHeader(dibSize, declaredFileSize = 0x36) {
  const b = Buffer.alloc(18);
  b.write('BM', 0, 'ascii');
  b.writeUInt32LE(declaredFileSize, 2);
  b.writeUInt32LE(0x36, 10); // pixel data offset
  b.writeUInt32LE(dibSize, 14);
  return b;
}

test('sniffImage identifies BMP by BM signature + a known DIB header size', () => {
  assert.equal(sniffImage(bmpHeader(40)), 'image/bmp', 'BITMAPINFOHEADER');
  assert.equal(sniffImage(bmpHeader(12)), 'image/bmp', 'BITMAPCOREHEADER');
  assert.equal(sniffImage(bmpHeader(124)), 'image/bmp', 'BITMAPV5HEADER');
});

test('sniffImage: the real BMP fixture still sniffs as image/bmp', () => {
  const fixture = require('node:fs').readFileSync(
    require('node:path').join(__dirname, 'fixtures', 'sample.bmp'),
  );
  assert.equal(sniffImage(fixture), 'image/bmp', 'the guard must not reject genuine BMPs');
});

// WR-09 — 'BM' alone was the weakest signature in the sniffer, and it fed the
// one decoder that allocates from an unvalidated header (CR-03). Any text file
// beginning "BM" reached it.
test('sniffImage rejects a plain-text file that merely starts with "BM" (WR-09)', () => {
  const text = Buffer.from('BMW service manual, revision 3 — do not distribute', 'ascii');
  assert.equal(sniffImage(text), null, 'text starting with BM must not sniff as BMP');
});

test('sniffImage rejects "BM" with an unknown DIB header size', () => {
  assert.equal(sniffImage(bmpHeader(41)), null, '41 is not a defined DIB header size');
  assert.equal(sniffImage(bmpHeader(0)), null, 'a zero DIB header size is not a bitmap');
});

test('sniffImage rejects a truncated BMP header (< 18 bytes)', () => {
  assert.equal(sniffImage(Buffer.from([0x42, 0x4D, 0x36, 0x00])), null);
});

test('sniffImage identifies GIF87a', () => {
  const gif = Buffer.from('GIF87a\x10\x00\x10\x00', 'binary');
  assert.equal(sniffImage(gif), 'image/gif');
});

test('sniffImage identifies GIF89a', () => {
  const gif = Buffer.from('GIF89a\x10\x00\x10\x00', 'binary');
  assert.equal(sniffImage(gif), 'image/gif');
});

test('sniffImage rejects truncated PDF header (< 4 bytes)', () => {
  assert.equal(sniffImage(Buffer.from('%PD', 'binary')), null);
});

test('sniffImage rejects truncated ftyp box (< 12 bytes, brand unreadable)', () => {
  const tiny = Buffer.from('\x00\x00\x00\x18ftyp', 'binary'); // 8 bytes — no brand
  assert.equal(sniffImage(tiny), null);
});

test('sniffImage rejects truncated BMP (single byte)', () => {
  assert.equal(sniffImage(Buffer.from([0x42])), null);
});

test('sniffImage rejects GIF-like but incomplete signature', () => {
  assert.equal(sniffImage(Buffer.from('GIF8', 'binary')), null);
});
