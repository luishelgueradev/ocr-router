const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  pdfPageCount,
  assertPageCountWithinCap,
  renderPage,
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
  // Guard #2: explicit DPI (never poppler's silent 150 default — Pitfall 6).
  assert.deepEqual(sink.cmdline, [
    'pdftoppm',
    '-r', String(CAPS.RASTER_DPI),
    '-png',
    '-f', '3', '-l', '3',
    '-singlefile',
    '-scale-to', String(CAPS.RASTER_MAX_DIM),
    '/tmp/input.pdf',
  ], 'exact one-page pixel-bounded argv, NO output-root (stdout streaming)');
  // Sandbox caps ride the argv as positional operands (guards #3; wall-clock backstop).
  assert.equal(sink.args[I_ULIMIT_KB], String(CAPS.ULIMIT_V_KB), 'ulimit -v address-space cap');
  assert.equal(sink.args[I_ULIMIT_CPU], String(CAPS.ULIMIT_CPU_SEC), 'ulimit -t CPU-sec cap');
});

test('renderPage: honors dpi/maxDim/page overrides in the argv', async () => {
  const sink = {};
  const spawnFn = makeFakeSpawn(Buffer.from([0x89, 0x50]), sink);
  await renderPage('/tmp/y.pdf', 5, { dpi: 300, maxDim: 4000, spawnFn });

  assert.deepEqual(sink.cmdline, [
    'pdftoppm', '-r', '300', '-png', '-f', '5', '-l', '5',
    '-singlefile', '-scale-to', '4000', '/tmp/y.pdf',
  ], 'dpi / maxDim / page overrides all applied');
});

test('renderPage: passes the job signal through to the sandbox spawn', async () => {
  const sink = {};
  const ac = new AbortController();
  const spawnFn = makeFakeSpawn(Buffer.from([0x89]), sink);
  await renderPage('/tmp/z.pdf', 1, { signal: ac.signal, spawnFn });

  assert.equal(sink.opts.signal, ac.signal, 'the AbortSignal reaches the child (deadline binding)');
});
