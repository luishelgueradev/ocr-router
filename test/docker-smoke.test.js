// 03-07 / D-11 — Docker-only real-dependency integration smoke.
//
// This file is the RECORDED Docker/human smoke, NOT a host-suite gate: it is
// deliberately OMITTED from package.json's `test` script (host `npm test` must
// never depend on real poppler/HEIC). It runs for real ONLY inside the built
// image (`bash scripts/docker-smoke.sh`), where `poppler-utils` (pdftoppm/
// pdfinfo), dash `ulimit`, and coreutils `timeout` are present.
//
// The skip-guard hinges on ONE signal — is `pdftoppm` on PATH? — because that
// binary is the thing that is Docker-only by design (D-11). On the host (no
// poppler) every real-dependency case SKIPS, so `node --test test/docker-smoke
// .test.js` is green-by-skip; in the image every case EXECUTES. That single
// switch also fronts the HEIC/subprocess/temp cases so the file is a clean
// host↔image binary (host = all skip, image = all run), matching D-11.
//
// What it proves against the real base image (the two STATE risk-flags):
//   1. A6  — dash `ulimit` + coreutils `timeout` exist and wrap the child.
//   2. INP-04 — a scanned (image-only, no text layer) PDF rasterizes page-by-
//      page through REAL pdfinfo + pdftoppm to a valid PNG buffer.
//   3. A1 / T-03-19 — the real `ulimit -v` number (CAPS.ULIMIT_V_KB, 768 MB)
//      ALLOWS a legitimate page yet a deliberately tiny `-v` REJECTS the same
//      render — the memory guard actually bites on the deployed image.
//   4. A5 / T-03-20 — a real HEIC decodes through heic-convert (WASM) → sharp
//      to a normalized PNG inside the runtime image.
//   5. Pitfall 4 / A2 — a runaway child bound to an AbortSignal is TERMINATED
//      within the grace window (killable, `exec` keeps the signal flowing to
//      the target, no wedge of the concurrency-1 worker); and coreutils
//      `timeout` is the hard wall-clock backstop.
//   6. Pitfall 2 — a job temp dir removed by the shutdown drain (simulated
//      mid-job SIGTERM) leaves NOTHING on disk.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sharp = require('sharp');

const {
  pdfPageCount,
  assertPageCountWithinCap,
  renderPage,
} = require('../lib/v1/input/rasterize');
const { spawnCapture } = require('../lib/v1/input/spawn-capture');
const { normalizeToFrames } = require('../lib/v1/input/image-normalize');
const {
  createJobTempDir,
  cleanupJobTempDir,
  drainAllTempDirs,
  _activeDirsForTest,
} = require('../lib/v1/input/temp');
const { CAPS } = require('../lib/v1/input/caps');

const FIX = path.join(__dirname, 'fixtures');
const SCANNED_PDF = path.join(FIX, 'scanned-sample.pdf'); // image-only, no text layer
const NATIVE_PDF = path.join(FIX, 'native-sample.pdf');   // 2-page real PDF
const SAMPLE_HEIC = path.join(FIX, 'sample.heic');        // real HEVC-in-HEIF (mif1)

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The single Docker-only signal (D-11): is real poppler on PATH?
function hasBinary(bin) {
  const r = spawnSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
  return r.status === 0;
}
const HAS_POPPLER = hasBinary('pdftoppm') && hasBinary('pdfinfo');

// Guard helper: skip (green) on the host, run for real in the image.
function requirePoppler(t) {
  if (!HAS_POPPLER) {
    t.skip('poppler Docker-only (D-11) — real-dependency smoke runs inside the image');
    return false;
  }
  return true;
}

test('smoke/A6: dash ulimit + coreutils timeout wrap a child in the base image', async (t) => {
  if (!requirePoppler(t)) return;
  // `echo` through the FULL sandbox body (ulimit -v/-t + exec timeout) proves
  // sh/ulimit/timeout are all present and compose (A6) — the very wrapper every
  // poppler call rides.
  const out = await spawnCapture('echo', ['ok'], {
    ulimitKB: CAPS.ULIMIT_V_KB,
    ulimitCpuSec: CAPS.ULIMIT_CPU_SEC,
    wallMs: 5000,
  });
  assert.equal(out.toString().trim(), 'ok', 'ulimit+timeout+exec wrapper runs and captures stdout');
});

test('smoke/INP-04: scanned PDF rasterizes page-by-page through real pdfinfo + pdftoppm', async (t) => {
  if (!requirePoppler(t)) return;

  const pages = await pdfPageCount(SCANNED_PDF);
  assert.equal(pages, 1, 'real pdfinfo reports the scanned fixture page count');
  assert.doesNotThrow(() => assertPageCountWithinCap(pages), 'page count within the memory cap');

  const png = await renderPage(SCANNED_PDF, 1);
  assert.ok(Buffer.isBuffer(png) && png.length > 0, 'real pdftoppm returns a non-empty buffer');
  assert.deepEqual(png.subarray(0, 8), PNG_MAGIC, 'the captured page is a valid PNG');
  const meta = await sharp(png).metadata();
  assert.equal(meta.format, 'png', 'sharp confirms a decodable PNG page');
  assert.ok(meta.width > 0 && meta.height > 0, 'the rasterized page has real dimensions');
});

test('smoke/INP-04: a multi-page native PDF renders each page independently', async (t) => {
  if (!requirePoppler(t)) return;

  const pages = await pdfPageCount(NATIVE_PDF);
  assert.equal(pages, 2, 'real pdfinfo reports 2 pages');
  for (let p = 1; p <= pages; p++) {
    const png = await renderPage(NATIVE_PDF, p);
    assert.deepEqual(png.subarray(0, 8), PNG_MAGIC, `page ${p} rasterizes to a PNG (one page in memory)`);
  }
});

test('smoke/A1: real ulimit -v ALLOWS a legit page but a tiny -v REJECTS the same render', async (t) => {
  if (!requirePoppler(t)) return;

  // Legit page at the shipped 768 MB ceiling (CAPS.ULIMIT_V_KB) — must succeed.
  const ok = await renderPage(SCANNED_PDF, 1);
  assert.deepEqual(ok.subarray(0, 8), PNG_MAGIC, `render succeeds at ULIMIT_V_KB=${CAPS.ULIMIT_V_KB} (legit page allowed)`);

  // Same render under an absurdly tight -v (2 MB address space) — the sandbox
  // cannot even map libc for the wrapped binary, so it exits non-zero and
  // spawnCapture rejects. This proves the -v guard actually constrains the real
  // process (T-03-19). NOTE: NO trailing '-' — pdftoppm streams to stdout when
  // the output-root is omitted (the trailing-'-' bug fixed in rasterize.js).
  const args = [
    '-r', String(CAPS.RASTER_DPI), '-png',
    '-f', '1', '-l', '1', '-singlefile',
    '-scale-to', String(CAPS.RASTER_MAX_DIM),
    SCANNED_PDF,
  ];
  await assert.rejects(
    () => spawnCapture('pdftoppm', args, {
      ulimitKB: 2048, ulimitCpuSec: CAPS.ULIMIT_CPU_SEC, wallMs: CAPS.RASTER_WALL_MS,
    }),
    (err) => {
      // Non-zero exit / kill signal — never a resolved buffer.
      assert.ok(err instanceof Error, 'tiny -v produces an error, not a page');
      return true;
    },
    'a 2 MB -v ceiling rejects the render (the address-space guard bites)',
  );
});

test('smoke/A5: a real HEIC decodes through heic-convert → sharp to a normalized PNG', async (t) => {
  if (!requirePoppler(t)) return; // gated on the image signal per D-11
  assert.ok(fs.existsSync(SAMPLE_HEIC), 'real HEIC fixture present');

  const frames = await normalizeToFrames(fs.readFileSync(SAMPLE_HEIC), 'image/heic', {});
  assert.equal(frames.length, 1, 'HEIC yields a single normalized frame');
  assert.deepEqual(frames[0].subarray(0, 8), PNG_MAGIC, 'decoded HEIC re-encodes to a valid PNG');
  const meta = await sharp(frames[0]).metadata();
  assert.equal(meta.format, 'png', 'sharp confirms the HEIC→PNG frame');
  assert.ok(meta.width > 0 && meta.height > 0, 'the decoded HEIC has real dimensions (A5 closed)');
});

test('smoke/Pitfall-4: a runaway child bound to an AbortSignal is killed within the grace window', async (t) => {
  if (!requirePoppler(t)) return;

  const ac = new AbortController();
  const started = Date.now();
  // `sleep 30` under the sandbox; abort at 150ms. `exec` means the signal reaches
  // the sleep itself (no orphaned shell — Pitfall 4). Must settle FAST, not in 30s.
  const p = spawnCapture('sleep', ['30'], {
    signal: ac.signal,
    ulimitKB: CAPS.ULIMIT_V_KB,
    ulimitCpuSec: CAPS.ULIMIT_CPU_SEC,
    wallMs: 30000,
    killGraceMs: 2000,
  });
  setTimeout(() => ac.abort(), 150);

  await assert.rejects(() => p, 'aborted child rejects (does not wedge the worker)');
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `child terminated within the grace window (${elapsed}ms << 30s wall)`);
});

test('smoke/Pitfall-4: coreutils timeout is the hard wall-clock backstop', async (t) => {
  if (!requirePoppler(t)) return;

  const started = Date.now();
  // No abort — rely purely on `timeout -s KILL 1s` to reap a 30s sleep.
  await assert.rejects(
    () => spawnCapture('sleep', ['30'], {
      ulimitKB: CAPS.ULIMIT_V_KB, ulimitCpuSec: CAPS.ULIMIT_CPU_SEC, wallMs: 1000,
    }),
    'timeout(1) kills the over-wall child',
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `wall-clock backstop fired (${elapsed}ms, ~1s timeout)`);
});

test('smoke/Pitfall-2: a mid-job SIGTERM (shutdown drain) leaves no temp dir on disk', async (t) => {
  if (!requirePoppler(t)) return;
  t.after(() => drainAllTempDirs());

  const dir = await createJobTempDir();
  // Simulate a partially-processed job: a page file already written to the dir.
  fs.writeFileSync(path.join(dir, 'page-1.png'), PNG_MAGIC);
  assert.ok(fs.existsSync(dir), 'job temp dir exists mid-render');
  assert.ok(_activeDirsForTest().includes(dir), 'dir is registered for shutdown drain');

  // The drainAndCancel path on SIGTERM: registry drain removes it even though the
  // job never reached its own `finally` (Pitfall 2 — the #1 leak vector).
  await drainAllTempDirs();
  assert.ok(!fs.existsSync(dir), 'temp dir (and its page file) gone after the drain');
  assert.equal(_activeDirsForTest().length, 0, 'registry emptied — no leak across the kill');

  // The happy-path cleanup remains idempotent after a drain (force:true).
  await assert.doesNotReject(cleanupJobTempDir(dir), 'double cleanup is a harmless no-op');
});
