// E2E — the ASSEMBLED input-pipeline path over real HTTP.
//
// Closes Human-Verification item #1 of .planning/phases/03-input-pipeline/
// 03-VERIFICATION.md: "No test exercises multipart -> router -> queue -> worker
// -> job envelope for a PDF/TIFF/HEIC/BMP/GIF. Every link is individually
// verified and the chain is traceable in code, but the assembled path has never
// been run. This is the single largest untested seam in the phase."
//
// WHAT IS REAL HERE — everything except the paid provider call:
//   * a real HTTP server and a real multipart upload (multer, boundary parsing)
//   * real bearer auth on the route
//   * real magic-byte sniffing (the declared Content-Type is deliberately WRONG
//     in one case, to prove the sniffer — not the client — picks the branch)
//   * real sharp / heic-convert decoding of real fixture files
//   * the real page-pipeline, the real bounded queue, the real worker
//   * the real job store and the real response envelope
//
// ONLY `runOCR` is substituted, so no key and no network are needed. Stubbing
// anything below that would defeat the entire point of this file: the links are
// already covered individually — what has never run is the chain.
//
// PDF cases need poppler (pdfinfo/pdftoppm), which is present in the image but
// not necessarily on a dev host. They are gated on the binary being available
// and SKIP LOUDLY rather than silently passing (the WR-11 lesson).

// Env must be set before auth.js / engines read it at module load.
process.env.API_TOKEN = 'e2e-input-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
process.env.OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || 'e2e-ollama-key';
process.env.OCR_SPACE_API_KEY = process.env.OCR_SPACE_API_KEY || 'e2e-ocrspace-key';

// Private temp root for THIS test process — node --test runs files in parallel
// and temp.js's orphan sweep is global to os.tmpdir().
require('./helpers/isolated-tmp');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const express = require('express');

// Substitute the provider BEFORE requiring the router (which transitively
// requires the worker, which captures runOCR at load).
const ocrPath = require.resolve('../lib/ocr');
require('../lib/ocr');
const originalRunOCR = require.cache[ocrPath].exports.runOCR;

let ocrCalls = [];
require.cache[ocrPath].exports.runOCR = async (model, base64, mime) => {
  ocrCalls.push({ engine: model.id, mime, bytes: Buffer.from(base64, 'base64').length });
  // A long, clean result so the confidence heuristic passes on tier 1 and the
  // cascade does not escalate — this file tests the input path, not the cascade.
  return {
    ok: true,
    timeMs: 1,
    text: 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor',
    overlay: { HasOverlay: true, wordCount: 12 },
    ocrExitCode: 1,
  };
};
process.on('beforeExit', () => {
  require.cache[ocrPath].exports.runOCR = originalRunOCR;
});

const router = require('../lib/v1/router');
const { bearerAuth } = require('../lib/v1/auth');

const TOKEN = process.env.API_TOKEN;
const FIX = path.join(__dirname, 'fixtures');

function hasPoppler() {
  try {
    execFileSync('pdfinfo', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// The production stack: bearer auth in front of the real router.
function listen() {
  const app = express();
  app.use('/v1', bearerAuth, router);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
    server.on('error', reject);
  });
}

function multipart({ buffer, filename, contentType, fields = {} }) {
  const boundary = '----e2e-' + Math.random().toString(36).slice(2);
  const parts = [Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`,
  ), buffer, Buffer.from('\r\n')];

  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
    ));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function submit(url, opts) {
  const { body, contentType } = multipart(opts);
  const res = await fetch(`${url}/v1/ocr`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': contentType },
    body,
  });
  return { status: res.status, body: await res.json() };
}

// Poll the REAL job endpoint to a terminal state, exactly as a client would.
async function pollToTerminal(url, jobId, timeoutMs = 20000) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${url}/v1/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200, 'the job endpoint stays reachable while polling');
    const job = await res.json();
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    if (performance.now() > deadline) {
      throw new Error(`job ${jobId} never reached a terminal state (last: ${job.status})`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function runOne(t, opts) {
  const { server, url } = await listen();
  t.after(() => new Promise((r) => server.close(r)));
  ocrCalls = [];

  const submitted = await submit(url, opts);
  assert.equal(submitted.status, 202, `submit accepted (body: ${JSON.stringify(submitted.body)})`);
  assert.ok(submitted.body.job_id, 'the 202 carries a job_id to poll');

  return pollToTerminal(url, submitted.body.job_id);
}

// --- multi-frame: the whole point of the input pipeline ---------------------

test('E2E: multipart TIFF -> router -> queue -> worker -> per-page envelope', async (t) => {
  const job = await runOne(t, {
    buffer: fs.readFileSync(path.join(FIX, 'multi-frame.tif')),
    filename: 'scan.tif',
    contentType: 'image/tiff',
  });

  assert.equal(job.status, 'succeeded', `job failed: ${JSON.stringify(job.error)}`);
  assert.ok(Array.isArray(job.result.pages), 'the envelope carries pages[]');
  assert.equal(job.result.pages.length, 3, 'one entry per TIFF frame');
  assert.deepEqual(job.result.pages.map((p) => p.page), [1, 2, 3], 'pages are ordered');
  assert.equal(job.result.status_rollup, 'completed', 'every page succeeded');

  for (const page of job.result.pages) {
    assert.ok(page.engine, `page ${page.page} names the engine that produced it`);
    assert.equal(typeof page.confidence, 'number', `page ${page.page} carries a confidence`);
    assert.ok(page.text && page.text.length > 0, `page ${page.page} carries text`);
  }

  // The frames really were normalized and routed one at a time.
  assert.equal(ocrCalls.length, 3, 'the provider was called once per frame');
  assert.ok(ocrCalls.every((c) => c.mime === 'image/png'), 'every frame reached the engine as normalized PNG');
});

test('E2E: multipart animated GIF yields one routed page per frame', async (t) => {
  const job = await runOne(t, {
    buffer: fs.readFileSync(path.join(FIX, 'two-frame.gif')),
    filename: 'anim.gif',
    contentType: 'image/gif',
  });

  assert.equal(job.status, 'succeeded', `job failed: ${JSON.stringify(job.error)}`);
  assert.equal(job.result.pages.length, 2, 'one entry per GIF frame');
  assert.equal(job.result.status_rollup, 'completed');
});

// --- decode-first formats, over the wire, with a LYING content-type ---------

test('E2E: multipart HEIC is decoded and routed even when the client mislabels it', async (t) => {
  // The client declares image/png and sends HEIC bytes (major brand 'mif1').
  // Both gates are exercised: multer's fileFilter admits the DECLARED type, and
  // then the magic-byte sniff overrules it and picks the HEIC branch. If the
  // declared type were trusted downstream, sharp would be handed a raw HEIC and
  // throw (prebuilt libvips has no HEVC), so a green result here means the
  // sniffed type — not the client's claim — drove the routing.
  //
  // NOTE the declared type must still be one multer allows: the fileFilter is a
  // permissive allowlist on the client-declared mimetype that runs BEFORE any
  // sniffing, so application/octet-stream is rejected 422 at the door.
  const job = await runOne(t, {
    buffer: fs.readFileSync(path.join(FIX, 'sample.heic')),
    filename: 'photo.heic',
    contentType: 'image/png',
  });

  assert.equal(job.status, 'succeeded', `job failed: ${JSON.stringify(job.error)}`);
  assert.equal(job.result.pages.length, 1, 'a HEIC is a single page');
  assert.equal(job.result.status_rollup, 'completed');
  assert.equal(ocrCalls.length, 1);
  assert.equal(ocrCalls[0].mime, 'image/png', 'HEIC reached the engine as normalized PNG');
});

test('E2E: multipart BMP is decoded and routed', async (t) => {
  const job = await runOne(t, {
    buffer: fs.readFileSync(path.join(FIX, 'sample.bmp')),
    filename: 'scan.bmp',
    contentType: 'image/bmp',
  });

  assert.equal(job.status, 'succeeded', `job failed: ${JSON.stringify(job.error)}`);
  assert.equal(job.result.pages.length, 1);
  assert.equal(job.result.status_rollup, 'completed');
});

// --- the typed-failure path, end to end ------------------------------------

test('E2E: a malformed HEIC surfaces as a typed client failure, not a 500-shaped crash (G-1)', async (t) => {
  // 16 bytes that sniff as HEIC and cut off mid-ispe — the G-1 reproduction,
  // driven through the full stack this time. Before that fix this produced an
  // untyped RangeError, i.e. internal_error + a "job crashed" log.
  const truncated = Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'ascii'),
    Buffer.from([0, 0, 0, 20]), Buffer.from('ispe', 'ascii'),
    Buffer.alloc(4, 0), Buffer.from([0, 0, 0x75, 0x30]),
  ]);

  const job = await runOne(t, {
    buffer: truncated,
    filename: 'evil.heic',
    contentType: 'image/heic',
  });

  assert.equal(job.status, 'failed', 'a malformed upload fails the job');
  assert.ok(job.error, 'and says why');
  assert.notEqual(job.error.code, 'internal_error', 'a client-caused failure must never read as a server bug');
  assert.equal(ocrCalls.length, 0, 'no paid provider call was made for undecodable input');
});

// --- the queue, for real ----------------------------------------------------

test('E2E: concurrent submissions are queued and every one completes', async (t) => {
  const { server, url } = await listen();
  t.after(() => new Promise((r) => server.close(r)));
  ocrCalls = [];

  const tiff = fs.readFileSync(path.join(FIX, 'multi-frame.tif'));
  const submissions = await Promise.all([1, 2, 3].map(() => submit(url, {
    buffer: tiff, filename: 'scan.tif', contentType: 'image/tiff',
  })));

  for (const s of submissions) assert.equal(s.status, 202, 'each upload is accepted');

  const jobIds = submissions.map((s) => s.body.job_id);
  assert.equal(new Set(jobIds).size, 3, 'each submission gets its own job id');

  const finished = await Promise.all(jobIds.map((id) => pollToTerminal(url, id)));
  for (const job of finished) {
    assert.equal(job.status, 'succeeded', `queued job failed: ${JSON.stringify(job.error)}`);
    assert.equal(job.result.pages.length, 3, 'a queued job still produces the full page set');
  }
  assert.equal(ocrCalls.length, 9, '3 jobs x 3 frames all routed');
});

// --- PDF: gated on the capability it needs, skipped LOUDLY otherwise --------

test('E2E: multipart native-text PDF returns per-page text', async (t) => {
  if (!hasPoppler()) {
    t.skip('poppler (pdfinfo) not installed on this host — PDF E2E runs in the container image');
    return;
  }

  const job = await runOne(t, {
    buffer: fs.readFileSync(path.join(FIX, 'native-sample.pdf')),
    filename: 'doc.pdf',
    contentType: 'application/pdf',
  });

  assert.equal(job.status, 'succeeded', `job failed: ${JSON.stringify(job.error)}`);
  assert.ok(job.result.pages.length >= 1, 'the PDF produced at least one page');
  assert.equal(job.result.status_rollup, 'completed');
  // A native-text PDF short-circuits OCR entirely (INP-03).
  assert.equal(ocrCalls.length, 0, 'embedded text is extracted without paying for OCR');
});

test('E2E: multipart scanned PDF rasterizes each page through the cascade', async (t) => {
  if (!hasPoppler()) {
    t.skip('poppler (pdftoppm) not installed on this host — PDF E2E runs in the container image');
    return;
  }

  const job = await runOne(t, {
    buffer: fs.readFileSync(path.join(FIX, 'scanned-sample.pdf')),
    filename: 'scan.pdf',
    contentType: 'application/pdf',
  });

  assert.equal(job.status, 'succeeded', `job failed: ${JSON.stringify(job.error)}`);
  assert.ok(job.result.pages.length >= 1, 'the scanned PDF produced pages');
  assert.ok(ocrCalls.length >= 1, 'a scanned page really was routed to an engine');
  assert.ok(ocrCalls.every((c) => c.mime === 'image/png'), 'rasterized pages reach the engine as PNG');
});
