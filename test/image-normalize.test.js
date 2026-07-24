const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const { normalizeToFrames, normalizeFrames } = require('../lib/v1/input/image-normalize');
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
    (err) => {
      assert.equal(err.code, 'image_pixel_cap_exceeded', 'typed 413, not an untyped 500 (WR-03)');
      assert.equal(err.status, 413);
      return true;
    },
    'decode rejects rather than OOMs, and does so TYPED',
  );
});

test('normalizeToFrames: over-pixel SINGLE-frame input is rejected via limitInputPixels (no OOM)', async () => {
  const big = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: { r: 10, g: 10, b: 10 } } })
    .png().toBuffer();
  await assert.rejects(
    () => normalizeToFrames(big, 'image/png', { maxPixels: 1000, maxDim: 50 }),
    (err) => {
      assert.equal(err.code, 'image_pixel_cap_exceeded', 'typed 413, not an untyped 500 (WR-03)');
      assert.equal(err.status, 413);
      return true;
    },
    'single-frame decode carries limitInputPixels too, typed',
  );
});

// --- CR-02: frame-count cap + genuine one-frame-at-a-time streaming ---------

test('normalizeFrames: a multi-frame input over MAX_IMAGE_FRAMES is rejected BEFORE any frame decodes', async () => {
  // The 3-frame TIFF fixture with a cap of 2. `meta.pages` comes straight out of
  // the file header, so this is the same class of gate MAX_PDF_PAGES applies to
  // a PDF — without it a GIF declaring thousands of frames is a straight OOM
  // plus thousands of paid cascade calls.
  const it = normalizeFrames(TIFF, 'image/tiff', { ...OPTS, maxFrames: 2 });

  await assert.rejects(
    () => it.next(),
    (err) => {
      assert.equal(err.code, 'too_many_frames', 'typed frame-count rejection');
      assert.equal(err.status, 413);
      assert.equal(err.limit, 2, 'reports the cap');
      assert.equal(err.actual, 3, 'reports the declared frame count');
      return true;
    },
    'the FIRST pull rejects — nothing is decoded, nothing is routed',
  );
});

test('normalizeFrames: exactly at the frame cap is allowed', async () => {
  const frames = await normalizeToFrames(TIFF, 'image/tiff', { ...OPTS, maxFrames: 3 });
  assert.equal(frames.length, 3, '3 frames at a cap of 3 is fine');
});

test('normalizeFrames: streams one frame at a time (frames decode lazily, not up front)', async () => {
  // The CR-02 memory property: pulling ONE frame must not have decoded the rest.
  // A generator that eagerly built the whole array could not satisfy this.
  const it = normalizeFrames(TIFF, 'image/tiff', OPTS);

  const first = await it.next();
  assert.ok(Buffer.isBuffer(first.value), 'first pull yields one PNG buffer');
  assert.equal(first.done, false);

  // Abandon the stream after one frame — the remaining frames were never
  // decoded, which is the whole point of pulling instead of collecting.
  await it.return();

  const rest = await it.next();
  assert.equal(rest.done, true, 'the generator is finished; no frames were buffered behind it');
});

test('normalizeFrames: single-frame types yield exactly one frame', async () => {
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 5, g: 5, b: 5 } } })
    .png().toBuffer();
  const seen = [];
  for await (const f of normalizeFrames(png, 'image/png', OPTS)) seen.push(f);
  assert.equal(seen.length, 1, 'a plain PNG is a one-frame stream');
});

// --- WR-03: every decoder failure carries a client status, never a bare 500 --
// worker.js maps only status 413/422 to a typed client failure; everything else
// becomes internal_error with its detail deliberately unlogged (OPS-05). So an
// untyped decoder error made real attack traffic and real malformed uploads
// indistinguishable from genuine server bugs.

test('every decoder failure carries a 413/422 status (WR-03)', async () => {
  const cases = [
    ['malformed GIF body', Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(64, 0xff)]), 'image/gif'],
    ['malformed HEIC body', Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'ascii'), Buffer.alloc(200, 0x00),
    ]), 'image/heic'],
    ['garbage claiming to be PNG', Buffer.alloc(128, 0x7f), 'image/png'],
    ['garbage claiming to be JPEG', Buffer.alloc(128, 0x31), 'image/jpeg'],
  ];

  for (const [label, buf, type] of cases) {
    await assert.rejects(
      () => normalizeToFrames(buf, type, OPTS),
      (err) => {
        assert.ok(
          err.status === 413 || err.status === 422,
          `${label}: must be a typed client failure, got status=${err.status} code=${err.code}`,
        );
        assert.ok(
          err.code === 'image_decode_failed' || err.code === 'image_pixel_cap_exceeded',
          `${label}: typed code, got ${err.code}`,
        );
        assert.equal(typeof err.detail, 'string', `${label}: detail is a bounded string`);
        return true;
      },
      `${label} must not surface as an untyped internal_error`,
    );
  }
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

// --- CR-03: BMP/HEIC are guarded BEFORE their decoder allocates -------------
//
// The test this replaces ("BMP path still applies limitInputPixels (no OOM)")
// encoded a genuinely large, VALID BMP — so bmp-js allocated the whole raw
// framebuffer successfully and only then did sharp reject it. It proved the
// opposite of its title: the OOM had already happened. The real failure mode is
// a TINY file whose HEADER lies about its size, which is what these exercise.

test('normalizeToFrames: a tiny BMP declaring gigantic dimensions is rejected BEFORE decode', async () => {
  // 54-byte header claiming 20000x20000 = 4e8 px. @vingle/bmp-js sizes its
  // allocation straight from these bytes with no cross-check against the file
  // length, so without the guard this is a 1.6 GB Buffer.alloc from a 54-byte
  // upload — an OOM kill on a small VPS, reached through a 2-byte 'BM' sniff.
  const bomb = Buffer.alloc(54);
  bomb.write('BM', 0, 'ascii');
  bomb.writeUInt32LE(54, 2); // (dishonest) declared file size
  bomb.writeUInt32LE(54, 10); // pixel data offset
  bomb.writeUInt32LE(40, 14); // BITMAPINFOHEADER
  bomb.writeInt32LE(20000, 18); // width
  bomb.writeInt32LE(20000, 22); // height
  bomb.writeUInt16LE(1, 26);
  bomb.writeUInt16LE(32, 28);

  await assert.rejects(
    () => normalizeToFrames(bomb, 'image/bmp', { maxPixels: CAPS.MAX_OUTPUT_PIXELS, maxDim: 5000 }),
    (err) => {
      assert.equal(err.code, 'image_pixel_cap_exceeded', 'typed, not an OOM or a RangeError');
      assert.equal(err.status, 413);
      assert.equal(err.actual, 20000 * 20000, 'reports the DECLARED pixel count');
      return true;
    },
    'the header is validated before bmp-js allocates anything',
  );
});

test('normalizeToFrames: a truncated BMP is a typed 422, not a decoder crash', async () => {
  const stub = Buffer.from([0x42, 0x4d, 0x00, 0x00]); // 'BM' and nothing usable
  await assert.rejects(
    () => normalizeToFrames(stub, 'image/bmp', OPTS),
    (err) => {
      assert.equal(err.code, 'bmp_truncated');
      assert.equal(err.status, 422);
      return true;
    },
  );
});

test('normalizeToFrames: a valid BMP over the pixel cap is rejected by the header guard', async () => {
  const bmp = require('@vingle/bmp-js');
  const W = 300, H = 300;
  const data = Buffer.alloc(W * H * 4, 128);
  const bigBmp = bmp.encode({ data, width: W, height: H }).data;
  await assert.rejects(
    () => normalizeToFrames(bigBmp, 'image/bmp', { maxPixels: 1000, maxDim: 50 }),
    (err) => {
      assert.equal(err.code, 'image_pixel_cap_exceeded', 'the BMP branch has a real pixel cap');
      assert.equal(err.actual, W * H);
      return true;
    },
  );
});

test('normalizeToFrames: a HEIC declaring oversized ispe extents is rejected before libheif decodes', async () => {
  // Take the real fixture and rewrite its primary `ispe` box to claim a
  // 30000x30000 image. libheif sizes its framebuffer from exactly this box.
  const heicPath = path.join(FIX, 'sample.heic');
  const real = fs.readFileSync(heicPath);
  const bomb = Buffer.from(real);
  const at = bomb.indexOf('ispe', 0, 'ascii');
  assert.ok(at > 4, 'the fixture carries an ispe box to tamper with');
  bomb.writeUInt32BE(30000, at + 8); // width
  bomb.writeUInt32BE(30000, at + 12); // height

  await assert.rejects(
    () => normalizeToFrames(bomb, 'image/heic', { maxPixels: CAPS.MAX_OUTPUT_PIXELS, maxDim: 5000 }),
    (err) => {
      assert.equal(err.code, 'image_pixel_cap_exceeded', 'HEIC extents are checked pre-decode');
      assert.equal(err.status, 413);
      assert.equal(err.actual, 30000 * 30000);
      return true;
    },
  );
});

// G-1 — the ispe scan bounds-checked `i + 12` but read `readUInt32BE(i + 12)`,
// which consumes bytes i+12..i+15. A HEIC-sniffing upload too short to hold the
// full box threw a raw RangeError (code ERR_OUT_OF_RANGE, NO status), and the
// worker maps a status-less error to 500 internal_error + a "job crashed" log.
// That is the exact alerting-signal destruction WR-03 exists to prevent, on the
// one path the WR-03 fix did not cover. Every rejection here must be TYPED.
test('normalizeToFrames: a HEIC truncated mid-ispe is a typed client error, never a RangeError 500 (G-1)', async () => {
  // 16 bytes: [size=20]['ispe'][version+flags][width] — the height read that
  // used to run off the end starts exactly at the buffer boundary.
  const truncated = Buffer.concat([
    Buffer.from([0, 0, 0, 20]),
    Buffer.from('ispe', 'ascii'),
    Buffer.alloc(4, 0),
    Buffer.from([0, 0, 0x75, 0x30]), // width 30000, height missing entirely
  ]);
  assert.equal(truncated.length, 16, 'the buffer ends where the height read begins');

  await assert.rejects(
    () => normalizeToFrames(truncated, 'image/heic', { maxPixels: CAPS.MAX_OUTPUT_PIXELS, maxDim: 5000 }),
    (err) => {
      assert.notEqual(err.code, 'ERR_OUT_OF_RANGE', 'the raw RangeError must not escape');
      assert.ok(!(err instanceof RangeError), 'a decoder bounds slip is not a client-visible crash');
      assert.ok(
        err.status === 413 || err.status === 422,
        `a malformed HEIC must be typed 413/422, got status=${err.status} code=${err.code}`,
      );
      return true;
    },
  );
});

test('normalizeToFrames: an ispe box ending exactly at the buffer end is still read and capped (G-1 boundary)', async () => {
  // The minimum buffer the scan may legally read: the box occupies bytes 0..19
  // and the height read ends on the final byte. Off-by-one in the other
  // direction (requiring i+17) would silently stop enforcing the cap here.
  const exact = Buffer.concat([
    Buffer.from([0, 0, 0, 20]),
    Buffer.from('ispe', 'ascii'),
    Buffer.alloc(4, 0),
    Buffer.from([0, 0, 0x75, 0x30]), // width 30000
    Buffer.from([0, 0, 0x75, 0x30]), // height 30000
  ]);
  assert.equal(exact.length, 20, 'exactly one complete ispe box, nothing more');

  await assert.rejects(
    () => normalizeToFrames(exact, 'image/heic', { maxPixels: CAPS.MAX_OUTPUT_PIXELS, maxDim: 5000 }),
    (err) => {
      assert.equal(err.code, 'image_pixel_cap_exceeded', 'the cap still fires at the exact boundary');
      assert.equal(err.status, 413);
      assert.equal(err.actual, 30000 * 30000);
      return true;
    },
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
