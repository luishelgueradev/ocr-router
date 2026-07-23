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
