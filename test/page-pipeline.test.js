const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { runPipeline } = require('../lib/v1/input/page-pipeline');
const { CAPS } = require('../lib/v1/input/caps');

// 03-06 / INP-03..08 — the page-pipeline orchestrator. This is the keystone that
// turns any admitted document into ordered per-page results with a status
// rollup, routed through an INJECTED routePage fn (bound to the cascade in the
// worker) and an INJECTED spawnFn (the D-11 poppler seam) — so the whole module
// runs on the host with NO real poppler and NO real providers. Native decoders
// (unpdf for PDF text, sharp for the image frames) run for real.

const FIX = path.join(__dirname, 'fixtures');
const NATIVE_PDF = fs.readFileSync(path.join(FIX, 'native-sample.pdf')); // 2 native-text pages
const TIFF = fs.readFileSync(path.join(FIX, 'multi-frame.tif')); //       3 frames

// spawnCapture argv layout (CR-07 — the shell body is a constant; the command
// and its args ride argv from index 6 on).
const I_CMD = 6;

// A structurally COMPLETE fake PNG. renderPage validates its output (CR-01), so
// a stub render must carry the magic AND the terminating IEND chunk and clear
// the length floor — otherwise it is (correctly) rejected as truncated.
function fakePng(bytes = 1088) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(Math.max(0, bytes - 20), 0x5a),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('IEND', 'ascii'),
    Buffer.from([0xae, 0x42, 0x60, 0x82]),
  ]);
}

// A fake ChildProcess: emits pdfinfo's "Pages: N" for a pdfinfo call, or a fake
// PNG for a pdftoppm call, then closes 0. Records every command it saw so a
// test can assert that NO rasterization ran before a cap check.
function makePdfSpawn({ pages, renderPng, invoked, argvs, pageSize = '595.276 x 841.89 pts (A4)' }) {
  return (cmd, args) => {
    const target = args[I_CMD];
    if (invoked) invoked.push(target);
    if (argvs) argvs.push(args.slice(I_CMD));
    const cp = new EventEmitter();
    cp.stdout = new EventEmitter();
    cp.stderr = new EventEmitter();
    cp.kill = () => {};
    queueMicrotask(() => {
      if (target === 'pdfinfo') {
        cp.stdout.emit('data', Buffer.from(
          `Producer: x\nPages: ${pages}\n${pageSize ? `Page size:      ${pageSize}\n` : ''}Encrypted: no\n`,
        ));
      } else if (target === 'pdftoppm') {
        cp.stdout.emit('data', renderPng || fakePng());
      }
      cp.emit('close', 0, null);
    });
    return cp;
  };
}

// A recording fake routePage — captures each call and returns whatever `impl`
// yields (the {text,engineId,provider,confidence,trace} shape the worker's
// cascade/forced closure produces).
function makeRoutePage(impl) {
  const calls = [];
  const fn = async (b64, mime) => {
    calls.push({ b64, mime });
    return impl(b64, mime, calls.length);
  };
  fn.calls = calls;
  return fn;
}

function mkTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-test-'));
}

test('PDF native pages short-circuit OCR: routePage is NEVER called', async (t) => {
  const tempDir = mkTemp();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const routePage = makeRoutePage(() => ({ text: 'X', engineId: 'e', provider: 'p', confidence: 0.9 }));
  const spawnFn = makePdfSpawn({ pages: 2 });

  const out = await runPipeline({
    buffer: NATIVE_PDF, sniffedType: 'application/pdf', profile: 'balanced',
    tempDir, routePage, spawnFn,
  });

  assert.equal(routePage.calls.length, 0, 'a native page must NOT call the cascade');
  assert.equal(out.pages.length, 2, 'one result per page');
  assert.equal(out.pages[0].engine, 'pdf-native', 'native page engine is pdf-native');
  assert.equal(out.pages[0].confidence, 1, 'native page confidence is 1');
  assert.equal(out.pages[1].engine, 'pdf-native');
  assert.equal(out.status_rollup, 'completed', 'all pages succeeded');
  assert.equal(out.engine, 'pdf-native', 'single-engine summary');
  assert.ok(out.text.includes('page one'), 'concatenated text carries page 1');
  assert.ok(out.text.includes('Second page'), 'concatenated text carries page 2');
  assert.equal(typeof out.trace.elapsed_ms, 'number', 'trace preserves elapsed_ms');
  assert.equal(out.trace.winning_engine, 'pdf-native', 'trace preserves winning_engine');
});

test('mixed PDF: native pages skip OCR, a scanned page routes → mixed summary', async (t) => {
  const tempDir = mkTemp();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  // Report 3 pages though the fixture only has 2 text-bearing pages → page 3 has
  // no embedded text (sufficient()=false) → it must rasterize + route.
  const invoked = [];
  const spawnFn = makePdfSpawn({ pages: 3, renderPng: fakePng(), invoked });
  const routePage = makeRoutePage(() => ({ text: 'ocr-text', engineId: 'ollama-x', provider: 'ollama', confidence: 0.85 }));

  const out = await runPipeline({
    buffer: NATIVE_PDF, sniffedType: 'application/pdf', tempDir, routePage, spawnFn,
  });

  assert.equal(out.pages.length, 3, 'three pages');
  assert.equal(out.pages[0].engine, 'pdf-native');
  assert.equal(out.pages[1].engine, 'pdf-native');
  assert.equal(out.pages[2].engine, 'ollama-x', 'scanned page routed through the cascade');
  assert.equal(routePage.calls.length, 1, 'only the scanned page hit routePage');
  assert.equal(routePage.calls[0].mime, 'image/png', 'rasterized page routed as PNG');
  assert.equal(out.status_rollup, 'completed');
  assert.equal(out.engine, 'mixed', 'differing engines → mixed summary');
  assert.ok(invoked.includes('pdftoppm'), 'the scanned page was rasterized');
});

// CR-06 — the page geometry read by the pre-raster pdfinfo call must reach
// pdftoppm, so the page renders at its natural RASTER_DPI size instead of being
// force-upscaled to the RASTER_MAX_DIM ceiling. ONE pdfinfo call serves both.
test('scanned page renders at its natural DPI size from the pdfinfo geometry (no upscale)', async (t) => {
  const tempDir = mkTemp();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const argvs = [];
  const spawnFn = makePdfSpawn({ pages: 3, argvs }); // A4 page size by default
  const routePage = makeRoutePage(() => ({ text: 'x', engineId: 'e', provider: 'p', confidence: 0.8 }));

  await runPipeline({ buffer: NATIVE_PDF, sniffedType: 'application/pdf', tempDir, routePage, spawnFn });

  assert.equal(argvs.filter((a) => a[0] === 'pdfinfo').length, 1, 'exactly ONE pdfinfo call for count + geometry');

  const raster = argvs.find((a) => a[0] === 'pdftoppm');
  assert.ok(raster, 'the scanned page was rasterized');
  const scaleTo = Number(raster[raster.indexOf('-scale-to') + 1]);
  assert.equal(scaleTo, Math.round((841.89 / 72) * CAPS.RASTER_DPI), 'A4 renders at its natural RASTER_DPI size');
  assert.ok(scaleTo < CAPS.RASTER_MAX_DIM, 'the page is NOT upscaled to the RASTER_MAX_DIM ceiling');
});

// CR-01 — a truncated render must be recorded as a PER-PAGE ERROR, never routed
// to a provider and reported as a successful (but empty) page.
test('a truncated render is a per-page error, NOT a silent empty success', async (t) => {
  const tempDir = mkTemp();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  // poppler exits 0 having emitted ~90 bytes of a PNG it never finished.
  const truncated = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(82, 0x11),
  ]);
  const spawnFn = makePdfSpawn({ pages: 3, renderPng: truncated });
  const routePage = makeRoutePage(() => ({ text: '', engineId: 'e', provider: 'p', confidence: 0.5 }));

  const out = await runPipeline({
    buffer: NATIVE_PDF, sniffedType: 'application/pdf', tempDir, routePage, spawnFn,
  });

  assert.equal(routePage.calls.length, 0, 'garbage is NEVER sent to a paid provider');
  assert.equal(out.pages.length, 3, 'the page is recorded, not dropped');
  const bad = out.pages[2];
  assert.ok(bad.error, 'the truncated page carries an error');
  assert.equal(bad.error.code, 'raster_output_truncated', 'typed as a truncation');
  assert.equal(bad.engine, null, 'no engine is claimed for a page that never rendered');
  assert.equal(
    out.status_rollup, 'completed_with_errors',
    'the job must NOT report a clean "completed" rollup',
  );
  // The native pages still succeed — one bad page never fails the whole job.
  assert.equal(out.pages[0].engine, 'pdf-native');
});

// WR-04 — an unpdf/PDF.js failure must DEGRADE to rasterizing every page, not
// fail the job. pdfinfo already succeeded at this point, so poppler can read the
// file; aborting would contradict the product's core value ("never fail to
// return the best available text") for a purely optional fast path.
test('a native-text extraction failure degrades to rasterizing every page (WR-04)', async (t) => {
  const tempDir = mkTemp();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  // A PDF whose header pdfinfo (stubbed) reads fine but whose body unpdf cannot
  // parse — the shape of a password-protected or malformed-xref document.
  const unreadable = Buffer.concat([Buffer.from('%PDF-1.4\n', 'ascii'), Buffer.alloc(256, 0x00)]);

  const spawnFn = makePdfSpawn({ pages: 2 });
  const routePage = makeRoutePage((b64, mime, n) => ({
    text: `ocr${n}`, engineId: 'ollama-x', provider: 'ollama', confidence: 0.8,
  }));

  const out = await runPipeline({
    buffer: unreadable, sniffedType: 'application/pdf', tempDir, routePage, spawnFn,
  });

  assert.equal(out.pages.length, 2, 'both pages are produced');
  assert.equal(routePage.calls.length, 2, 'every page fell back to rasterize + route');
  assert.equal(out.status_rollup, 'completed', 'the job still completes cleanly');
  assert.equal(out.engine, 'ollama-x', 'OCR results, not a failed job');
  assert.equal(out.text, 'ocr1\n\nocr2');
});

test('image path: multipage TIFF → one routed page per frame, order preserved', async (t) => {
  const tempDir = mkTemp();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const routePage = makeRoutePage((b64, mime, n) => ({
    text: `p${n}`, engineId: 'ollama', provider: 'ollama', confidence: 0.8,
  }));

  const out = await runPipeline({ buffer: TIFF, sniffedType: 'image/tiff', tempDir, routePage });

  assert.equal(routePage.calls.length, 3, 'one routePage call per TIFF frame');
  assert.equal(out.pages.length, 3);
  assert.deepEqual(out.pages.map((p) => p.text), ['p1', 'p2', 'p3'], 'order preserved');
  assert.deepEqual(out.pages.map((p) => p.page), [1, 2, 3], 'page numbers in order');
  assert.equal(out.status_rollup, 'completed');
  assert.equal(out.engine, 'ollama', 'single-engine summary');
});

test('one failed page is recorded (with error) but does NOT fail the whole job', async (t) => {
  const tempDir = mkTemp();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  // routePage throws on the 2nd page only.
  const routePage = makeRoutePage((b64, mime, n) => {
    if (n === 2) throw Object.assign(new Error('provider exploded'), { code: 'route_failed' });
    return { text: `p${n}`, engineId: 'e', provider: 'p', confidence: 0.7 };
  });

  const out = await runPipeline({ buffer: TIFF, sniffedType: 'image/tiff', tempDir, routePage });

  assert.equal(out.pages.length, 3, 'no page is dropped');
  assert.deepEqual(out.pages.map((p) => p.page), [1, 2, 3], 'page order preserved across the failure');
  assert.equal(out.status_rollup, 'completed_with_errors', 'rollup flips on a page failure');
  assert.equal(out.pages[1].engine, null, 'failed page has no engine');
  assert.equal(out.pages[1].confidence, null, 'failed page has no confidence');
  assert.ok(out.pages[1].error, 'failed page records its error');
  assert.equal(out.pages[1].error.code, 'route_failed', 'error carries a typed code');
  assert.equal(out.pages[1].text, '', 'failed page has empty text');
  assert.equal(out.pages[0].text, 'p1', 'page 1 still succeeded');
  assert.equal(out.pages[2].text, 'p3', 'processing continued after the failure');
  // concatenated text joins only the non-empty (successful) pages
  assert.equal(out.text, 'p1\n\np3');
});

// WR-02 — an engine-less cascade result (budget exhausted, every tier failed)
// must be a PAGE ERROR. runCascade returns {text:'', engineId:null} with no
// `error` field in that case, which the pipeline used to record as a plain
// success — so a job whose deadline blew mid-way reported a clean 'completed'
// rollup with silently missing content.
test('an engine-less route result is a page error, not a silent empty success (WR-02)', async (t) => {
  const tempDir = mkTemp();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  // Frame 2 comes back with no engine — exactly runCascade's budget-exhausted shape.
  const routePage = makeRoutePage((b64, mime, n) => (n === 2
    ? { text: '', engineId: null, provider: null, confidence: null, trace: { stopped_reason: 'budget_exhausted' } }
    : { text: `p${n}`, engineId: 'ollama', provider: 'ollama', confidence: 0.8 }));

  const out = await runPipeline({ buffer: TIFF, sniffedType: 'image/tiff', tempDir, routePage });

  assert.equal(out.pages.length, 3, 'the page is still recorded');
  assert.ok(out.pages[1].error, 'the engine-less page carries an error');
  assert.equal(out.pages[1].error.code, 'budget_exhausted', 'the cascade stop reason is surfaced');
  assert.equal(out.pages[1].engine, null);
  assert.equal(
    out.status_rollup, 'completed_with_errors',
    'the job must NOT claim a clean completion when a page produced nothing',
  );
  assert.equal(out.pages[0].text, 'p1', 'other pages are unaffected');
  assert.equal(out.pages[2].text, 'p3');
});

test('an engine-less result with no stop reason still fails typed (WR-02)', async (t) => {
  const tempDir = mkTemp();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const routePage = makeRoutePage(() => ({ text: '', engineId: null, provider: null, confidence: null }));
  const out = await runPipeline({ buffer: TIFF, sniffedType: 'image/tiff', tempDir, routePage });

  assert.equal(out.status_rollup, 'completed_with_errors');
  assert.ok(out.pages.every((p) => p.error && p.error.code === 'no_engine_result'), 'default typed code');
});

test('over-cap page count rejects BEFORE any rasterization', async (t) => {
  const tempDir = mkTemp();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const invoked = [];
  const spawnFn = makePdfSpawn({ pages: CAPS.MAX_PDF_PAGES + 1, invoked });
  const routePage = makeRoutePage(() => ({ text: 'x', engineId: 'e', provider: 'p', confidence: 1 }));

  await assert.rejects(
    () => runPipeline({ buffer: NATIVE_PDF, sniffedType: 'application/pdf', tempDir, routePage, spawnFn }),
    /pdf_too_many_pages/,
    'an over-cap PDF is rejected typed',
  );

  assert.ok(!invoked.includes('pdftoppm'), 'no page was rasterized before the cap gate');
  assert.equal(routePage.calls.length, 0, 'no page was routed');
});
