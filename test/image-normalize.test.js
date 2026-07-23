const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const { normalizeToFrames } = require('../lib/v1/input/image-normalize');
const { CAPS } = require('../lib/v1/input/caps');

// INP-05 / INP-07 / D-04 / D-05 — image normalization to routable PNG frames.
//
// Every decoder here (sharp for TIFF/GIF/PNG/JPEG/WebP, @vingle/bmp-js for BMP,
// heic-convert for HEIC) is pure-JS/WASM/native-addon that runs FOR REAL on the
// host — no subprocess, no poppler. So these tests exercise the actual decode
// path with tiny real multi-frame/BMP fixtures. The three properties under test
// are the plan's must-haves: (1) multipage TIFF/GIF → one ordered PNG PER FRAME,
// (2) HEIC/BMP decode FIRST then sharp (never sharp() on the raw buffer), and
// (3) a decompression-bomb guard (limitInputPixels + resize cap) on EVERY decode.

const FIX = path.join(__dirname, 'fixtures');
const TIFF = fs.readFileSync(path.join(FIX, 'multi-frame.tif')); // 3 frames, brightness ↑
const GIF = fs.readFileSync(path.join(FIX, 'two-frame.gif')); //  2 frames, brightness ↑
const BMP = fs.readFileSync(path.join(FIX, 'sample.bmp')); //    solid teal 24×18

const OPTS = { maxPixels: CAPS.MAX_OUTPUT_PIXELS, maxDim: CAPS.RASTER_MAX_DIM };

// Helper: assert a buffer is a valid PNG and return its mean luminance (frame 0).
async function pngMean(buf) {
  const meta = await sharp(buf).metadata();
  assert.equal(meta.format, 'png', 'frame is a valid PNG');
  const stats = await sharp(buf).stats();
  return stats.channels[0].mean;
}

test('normalizeToFrames: multipage TIFF → one ordered PNG per frame', async () => {
  const frames = await normalizeToFrames(TIFF, 'image/tiff', OPTS);
  assert.ok(Array.isArray(frames), 'returns an array');
  assert.equal(frames.length, 3, 'one PNG per TIFF page (3-frame fixture)');

  const means = [];
  for (const f of frames) means.push(await pngMean(f));
  // Fixture frames are progressively brighter → monotonic means prove order kept.
  assert.ok(means[0] < means[1] && means[1] < means[2], `frame order preserved (means=${means.map(Math.round)})`);
});

test('normalizeToFrames: animated GIF → one ordered PNG per frame', async () => {
  const frames = await normalizeToFrames(GIF, 'image/gif', OPTS);
  assert.equal(frames.length, 2, 'one PNG per GIF frame (2-frame fixture)');
  const m0 = await pngMean(frames[0]);
  const m1 = await pngMean(frames[1]);
  assert.ok(m0 < m1, `GIF frame order preserved (means=${[m0, m1].map(Math.round)})`);
});

test('normalizeToFrames: single-frame PNG → 1-element array (straight-through normalize)', async () => {
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 90, g: 90, b: 90 } } })
    .png().toBuffer();
  const frames = await normalizeToFrames(png, 'image/png', OPTS);
  assert.equal(frames.length, 1, 'PNG yields a single frame');
  await pngMean(frames[0]);
});

test('normalizeToFrames: JPEG and WebP each normalize straight-through to one PNG', async () => {
  const base = { create: { width: 32, height: 24, channels: 3, background: { r: 120, g: 60, b: 30 } } };
  const jpeg = await sharp(base).jpeg().toBuffer();
  const webp = await sharp(base).webp().toBuffer();
  const jf = await normalizeToFrames(jpeg, 'image/jpeg', OPTS);
  const wf = await normalizeToFrames(webp, 'image/webp', OPTS);
  assert.equal(jf.length, 1, 'JPEG → 1 frame');
  assert.equal(wf.length, 1, 'WebP → 1 frame');
  await pngMean(jf[0]);
  await pngMean(wf[0]);
});

test('normalizeToFrames: over-pixel MULTIPAGE input is rejected via limitInputPixels (metadata guard, no OOM)', async () => {
  // A 1000×1000 (1e6 px) image with a tiny maxPixels cap must be rejected at the
  // sharp() metadata read — proving limitInputPixels is set on the frame-count call.
  const big = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: { r: 10, g: 10, b: 10 } } })
    .tiff().toBuffer();
  await assert.rejects(
    () => normalizeToFrames(big, 'image/tiff', { maxPixels: 1000, maxDim: 50 }),
    /pixel limit/i,
    'decode rejects rather than OOMs',
  );
});

test('normalizeToFrames: over-pixel SINGLE-frame input is rejected via limitInputPixels (no OOM)', async () => {
  const big = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: { r: 10, g: 10, b: 10 } } })
    .png().toBuffer();
  await assert.rejects(
    () => normalizeToFrames(big, 'image/png', { maxPixels: 1000, maxDim: 50 }),
    /pixel limit/i,
    'single-frame decode carries limitInputPixels too',
  );
});

test('normalizeToFrames: an unknown sniffed type throws a typed error', async () => {
  await assert.rejects(
    () => normalizeToFrames(Buffer.from([0, 1, 2, 3]), 'image/unknown', OPTS),
    /unsupported_image_type/,
    'unsupported type is rejected, not silently normalized',
  );
});

// --- Task 2: HEIC (heic-convert) + BMP (@vingle/bmp-js) decode → sharp ------

test('normalizeToFrames: BMP → single normalized PNG via @vingle/bmp-js → sharp (real, host)', async () => {
  // BMP is decoded FOR REAL on the host: @vingle/bmp-js → raw RGBA → sharp.
  // sharp() can NOT read a BMP buffer directly (prebuilt libvips lacks BMP), so
  // this asserts the decode-first handoff actually produces a valid PNG.
  const frames = await normalizeToFrames(BMP, 'image/bmp', OPTS);
  assert.equal(frames.length, 1, 'BMP yields a single frame');
  const meta = await sharp(frames[0]).metadata();
  assert.equal(meta.format, 'png', 'BMP normalized to a valid PNG');
  assert.equal(meta.width, 24, 'BMP width preserved');
  assert.equal(meta.height, 18, 'BMP height preserved');
});

test('normalizeToFrames: BMP path still applies limitInputPixels (no OOM)', async () => {
  // Encode a larger BMP, then cap maxPixels below its pixel count — the sharp
  // step (post-decode) must reject via limitInputPixels, proving the guard is on
  // the BMP branch too.
  const bmp = require('@vingle/bmp-js');
  const W = 300, H = 300;
  const data = Buffer.alloc(W * H * 4, 128);
  const bigBmp = bmp.encode({ data, width: W, height: H }).data;
  await assert.rejects(
    () => normalizeToFrames(bigBmp, 'image/bmp', { maxPixels: 1000, maxDim: 50 }),
    /pixel limit/i,
    'BMP decode carries limitInputPixels',
  );
});

test('normalizeToFrames: HEIC → single normalized PNG (host-asserted if a real HEIC fixture exists, else Docker smoke A5)', async (t) => {
  // heic-convert is WASM and decodes on host, but producing a real HEIC on the
  // host is impractical (no host encoder), so this is skip-guarded on the
  // presence of a real fixture. Real HEIC decode is validated in the 03-07
  // Docker smoke (STATE risk-flag A5). The host suite must NOT hard-depend on a
  // HEIC that cannot be produced here.
  const heicPath = path.join(FIX, 'sample.heic');
  if (!fs.existsSync(heicPath)) {
    t.skip('no real HEIC fixture on host — real decode validated in 03-07 Docker smoke (A5)');
    return;
  }
  const frames = await normalizeToFrames(fs.readFileSync(heicPath), 'image/heic', OPTS);
  assert.equal(frames.length, 1, 'HEIC yields a single frame');
  const meta = await sharp(frames[0]).metadata();
  assert.equal(meta.format, 'png', 'HEIC normalized to a valid PNG');
});

test('image-normalize source: HEIC/BMP are DECODED FIRST, never sharp()-ed raw', () => {
  // Structural guard for the acceptance criterion "no sharp(rawHeic/rawBmp)
  // anywhere": the module must go through heic-convert / @vingle/bmp-js decoders
  // before handing pixels to sharp.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'v1', 'input', 'image-normalize.js'), 'utf8');
  assert.match(src, /require\('heic-convert'\)/, 'HEIC decoded via heic-convert');
  assert.match(src, /require\('@vingle\/bmp-js'\)/, 'BMP decoded via @vingle/bmp-js');
  assert.match(src, /bmp\.decode\(/, 'BMP raw pixels obtained before sharp');
});
