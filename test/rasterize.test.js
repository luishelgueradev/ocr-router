const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  pdfInfo,
  pdfPageCount,
  assertPageCountWithinCap,
  renderPage,
  computeScaleTo,
} = require('../lib/v1/input/rasterize');
const { CAPS } = require('../lib/v1/input/caps');

// INP-04 / INP-07 / D-02 / D-03 / D-11 — memory-safe single-page rasterization.
// poppler (pdfinfo/pdftoppm) is Docker-only, so EVERY subprocess call funnels
// through spawnCapture and here we inject a fake `spawnFn` (the D-11 seam): NOT
// ONE real poppler process runs on the host. We assert (a) pdfinfo page-count
// parsing + the pre-raster over-cap gate (Pitfall 1 guard #1), and (b) that
// renderPage builds the exact one-page, pixel-bounded pdftoppm argv the memory
// model requires (-singlefile stdout, -r DPI, -scale-to ceiling, -f/-l page).

// spawnCapture argv layout (CR-07 — nothing is interpolated into the body):
//   [0]'-c' [1]<constant body> [2]'sh' [3]ulimitKB [4]ulimitCpuSec [5]wallSec
//   [6]cmd  [7..]cmd args
const I_ULIMIT_KB = 3, I_ULIMIT_CPU = 4, I_CMD = 6;
const cmdlineOf = (args) => (args ? args.slice(I_CMD) : []);

// A fake ChildProcess that emits the given stdout then closes 0. Records the
// (cmd, args, opts) it was spawned with so tests can assert the sandbox argv.
function makeFakeSpawn(stdout, sink) {
  return (cmd, args, opts) => {
    if (sink) {
      sink.cmd = cmd; sink.args = args; sink.opts = opts;
      sink.body = args && args[1];
      sink.cmdline = cmdlineOf(args);
    }
    const cp = new EventEmitter();
    cp.stdout = new EventEmitter();
    cp.stderr = new EventEmitter();
    cp.kill = () => {};
    queueMicrotask(() => {
      if (stdout != null) cp.stdout.emit('data', Buffer.from(stdout));
      cp.emit('close', 0, null);
    });
    return cp;
  };
}

test('pdfPageCount: parses "Pages:   7" from stubbed pdfinfo stdout', async () => {
  const sink = {};
  const spawnFn = makeFakeSpawn('Producer: x\nPages:          7\nEncrypted: no\n', sink);
  const n = await pdfPageCount('/tmp/x.pdf', { spawnFn });

  assert.equal(n, 7, 'parses the Pages field to a number');
  // Funnels through spawnCapture → /bin/sh -c '...'; the real pdfinfo call and
  // the input path ride the sandbox body.
  assert.equal(sink.cmd, '/bin/sh', 'spawns via the sandbox shell (spawnCapture)');
  assert.deepEqual(sink.cmdline, ['pdfinfo', '/tmp/x.pdf'], 'pdfinfo invoked in the sandbox');
  assert.match(sink.body, /exec timeout -s KILL "\$@"/, 'wrapped by the timeout backstop');
});

// WR-01 — pdfinfo is the FIRST subprocess to touch an untrusted PDF (it IS the
// pre-raster decompression-bomb gate), so it must carry the SAME sandbox as the
// raster child. It previously passed no ulimits at all.
test('pdfPageCount: pdfinfo runs under the full sandbox (ulimits + stdout ceiling)', async () => {
  const sink = {};
  const spawnFn = makeFakeSpawn('Pages: 1\n', sink);
  await pdfPageCount('/tmp/x.pdf', { spawnFn });

  assert.equal(sink.args[I_ULIMIT_KB], String(CAPS.ULIMIT_V_KB), 'pdfinfo gets ulimit -v');
  assert.equal(sink.args[I_ULIMIT_CPU], String(CAPS.ULIMIT_CPU_SEC), 'pdfinfo gets ulimit -t');
  assert.ok(CAPS.PDFINFO_MAX_STDOUT_BYTES > 0, 'a captured-output ceiling is configured');
});

test('pdfPageCount: throws pdfinfo_no_page_count when the field is absent', async () => {
  const spawnFn = makeFakeSpawn('Producer: x\nEncrypted: no\n');
  await assert.rejects(
    () => pdfPageCount('/tmp/x.pdf', { spawnFn }),
    /pdfinfo_no_page_count/,
    'missing Pages field rejects typed',
  );
});

test('assertPageCountWithinCap: over-cap throws a typed 413/422 error', () => {
  let thrown;
  try {
    assertPageCountWithinCap(CAPS.MAX_PDF_PAGES + 1);
  } catch (e) { thrown = e; }

  assert.ok(thrown, 'over-cap page count throws');
  assert.equal(thrown.code, 'pdf_too_many_pages', 'carries the typed error code');
  assert.ok(thrown.status === 413 || thrown.status === 422, 'maps to 413/422');
  assert.equal(thrown.limit, CAPS.MAX_PDF_PAGES, 'reports the cap');
  assert.equal(thrown.actual, CAPS.MAX_PDF_PAGES + 1, 'reports the offending count');
});

test('assertPageCountWithinCap: at/under cap returns normally (no throw)', () => {
  assert.doesNotThrow(() => assertPageCountWithinCap(CAPS.MAX_PDF_PAGES), 'exactly at cap is allowed');
  assert.doesNotThrow(() => assertPageCountWithinCap(1), 'a single page is allowed');
});

test('renderPage: builds the exact one-page pixel-bounded pdftoppm argv and resolves the PNG buffer', async () => {
  const sink = {};
  const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
  const spawnFn = makeFakeSpawn(fakePng, sink);

  const out = await renderPage('/tmp/input.pdf', 3, { spawnFn });

  assert.ok(Buffer.isBuffer(out), 'resolves a Buffer');
  assert.deepEqual(out, fakePng, 'returns the captured PNG buffer');

  // pdftoppm streams to stdout when the output-root is OMITTED (a trailing '-'
  // is written as a file '-.png' by poppler 22.12.0 — see 03-07 Docker smoke).
  // With no page geometry available, -r carries the DPI (never poppler's silent
  // 150 default — Pitfall 6) and NO -scale-to is passed (CR-06: a bare
  // -scale-to would upscale the page, not cap it).
  assert.deepEqual(sink.cmdline, [
    'pdftoppm',
    '-r', String(CAPS.RASTER_DPI),
    '-png',
    '-f', '3', '-l', '3',
    '-singlefile',
    '/tmp/input.pdf',
  ], 'exact one-page argv, NO output-root (stdout streaming)');
  // Sandbox caps ride the argv as positional operands (guards #3; wall-clock backstop).
  assert.equal(sink.args[I_ULIMIT_KB], String(CAPS.ULIMIT_V_KB), 'ulimit -v address-space cap');
  assert.equal(sink.args[I_ULIMIT_CPU], String(CAPS.ULIMIT_CPU_SEC), 'ulimit -t CPU-sec cap');
});

test('renderPage: honors dpi/page overrides in the argv', async () => {
  const sink = {};
  const spawnFn = makeFakeSpawn(Buffer.from([0x89, 0x50]), sink);
  await renderPage('/tmp/y.pdf', 5, { dpi: 300, maxDim: 4000, spawnFn });

  assert.deepEqual(sink.cmdline, [
    'pdftoppm', '-r', '300', '-png', '-f', '5', '-l', '5',
    '-singlefile', '/tmp/y.pdf',
  ], 'dpi / page overrides applied');
});

// --- CR-06: -scale-to is a CEILING, not a target, and -r is never inert ------
// poppler: "-scale-to number ... This option overrides the -r option." So the
// old `-r 200 ... -scale-to 5000` rendered EVERY page at exactly 5000px on its
// long edge and ignored RASTER_DPI entirely. These tests pin the corrected
// contract: exactly one resolution flag, and the cap only ever scales DOWN.

test('renderPage: -r and -scale-to are never passed together (they are mutually exclusive)', async () => {
  const sink = {};
  const spawnFn = makeFakeSpawn(Buffer.from([0x89]), sink);

  // Known geometry → -scale-to only.
  await renderPage('/tmp/a.pdf', 1, { longEdgePts: 841.89, spawnFn });
  assert.ok(sink.cmdline.includes('-scale-to'), 'known geometry uses -scale-to');
  assert.ok(!sink.cmdline.includes('-r'), '-r must NOT accompany -scale-to (poppler ignores it)');

  // Unknown geometry → -r only.
  await renderPage('/tmp/a.pdf', 1, { spawnFn });
  assert.ok(sink.cmdline.includes('-r'), 'unknown geometry falls back to -r');
  assert.ok(!sink.cmdline.includes('-scale-to'), 'no bare -scale-to: it would upscale, not cap');
});

test('renderPage: DPI is EFFECTIVE — an A4 page renders at its natural DPI size, not the cap', async () => {
  const sink = {};
  const spawnFn = makeFakeSpawn(Buffer.from([0x89]), sink);
  const A4_LONG_PTS = 841.89; // 11.69 in

  await renderPage('/tmp/a4.pdf', 1, { longEdgePts: A4_LONG_PTS, dpi: 200, maxDim: 5000, spawnFn });
  const at200 = Number(sink.cmdline[sink.cmdline.indexOf('-scale-to') + 1]);
  assert.equal(at200, Math.round((A4_LONG_PTS / 72) * 200), 'A4 @200dpi ≈ 2339px, NOT the 5000px cap');
  assert.ok(at200 < 5000, 'a normal page is never upscaled to the ceiling');

  await renderPage('/tmp/a4.pdf', 1, { longEdgePts: A4_LONG_PTS, dpi: 300, maxDim: 5000, spawnFn });
  const at300 = Number(sink.cmdline[sink.cmdline.indexOf('-scale-to') + 1]);
  assert.equal(at300, Math.round((A4_LONG_PTS / 72) * 300), 'A4 @300dpi ≈ 3508px');
  assert.ok(at300 > at200, 'raising RASTER_DPI actually raises the rendered resolution');
});

test('renderPage: a hostile MediaBox is clamped to maxDim (the cap is a real ceiling)', async () => {
  const sink = {};
  const spawnFn = makeFakeSpawn(Buffer.from([0x89]), sink);
  // 200 inches on the long edge — 40000px at 200dpi if uncapped.
  await renderPage('/tmp/bomb.pdf', 1, { longEdgePts: 14400, dpi: 200, maxDim: 5000, spawnFn });

  const scaleTo = Number(sink.cmdline[sink.cmdline.indexOf('-scale-to') + 1]);
  assert.equal(scaleTo, 5000, 'an oversized page is clamped to maxDim');
});

test('computeScaleTo: clamps down, never up, and reports null for unknown geometry', () => {
  // Natural size below the cap → the natural size (DPI honoured).
  assert.equal(computeScaleTo(841.89, 200, 5000), 2339);
  // Natural size above the cap → the cap (ceiling honoured).
  assert.equal(computeScaleTo(14400, 200, 5000), 5000);
  // Cap below the natural size at a low DPI → still the natural size.
  assert.equal(computeScaleTo(841.89, 50, 5000), 585);
  // Never zero (a degenerate tiny page still renders one pixel).
  assert.equal(computeScaleTo(0.1, 1, 5000), 1);
  // Unknown / bogus geometry → caller falls back to -r.
  for (const bad of [undefined, null, 0, -5, NaN, Infinity, 'x']) {
    assert.equal(computeScaleTo(bad, 200, 5000), null, `${String(bad)} → null`);
  }
});

test('pdfInfo: parses page count AND page geometry from one pdfinfo call', async () => {
  const uniform = await pdfInfo('/tmp/x.pdf', {
    spawnFn: makeFakeSpawn('Pages:          3\nPage size:      595.276 x 841.89 pts (A4)\n'),
  });
  assert.equal(uniform.pages, 3, 'page count parsed');
  assert.equal(uniform.longEdgePts, 841.89, 'longer side of the page box');

  // poppler switches to a per-page label when the pages differ in size.
  const varying = await pdfInfo('/tmp/x.pdf', {
    spawnFn: makeFakeSpawn('Pages:          2\nPage    1 size: 1224 x 792 pts (landscape)\n'),
  });
  assert.equal(varying.longEdgePts, 1224, 'per-page "Page N size:" form also parsed');

  // No geometry line at all → null, and renderPage falls back to -r.
  const none = await pdfInfo('/tmp/x.pdf', { spawnFn: makeFakeSpawn('Pages: 1\n') });
  assert.equal(none.longEdgePts, null, 'missing geometry is null, not a guess');
  assert.equal(none.pages, 1, 'page count still parsed');
});

test('renderPage: passes the job signal through to the sandbox spawn', async () => {
  const sink = {};
  const ac = new AbortController();
  const spawnFn = makeFakeSpawn(Buffer.from([0x89]), sink);
  await renderPage('/tmp/z.pdf', 1, { signal: ac.signal, spawnFn });

  assert.equal(sink.opts.signal, ac.signal, 'the AbortSignal reaches the child (deadline binding)');
});
