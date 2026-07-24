// STR-01/02/03 over real HTTP — multipart image + `schema` → router → queue →
// worker (structured path) → validated envelope. Only the provider (runOCR) is
// stubbed; the schema guard, capability gate, input gate, worker dispatch, ajv
// validation, repair loop and envelope are all real. No network, no keys beyond
// the env toggles.

process.env.API_TOKEN = 'e2e-structured-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
process.env.OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || 'e2e-ollama-key';
process.env.OCR_SPACE_API_KEY = process.env.OCR_SPACE_API_KEY || 'e2e-ocrspace-key';

require('./helpers/isolated-tmp');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// Stub runOCR BEFORE requiring the router (worker binds it at load).
const ocrPath = require.resolve('../lib/ocr');
require('../lib/ocr');
const originalRunOCR = require.cache[ocrPath].exports.runOCR;

// Per-engine scripted responses (a queue of JSON strings or {ok:false}).
let scripts = {};
let ocrCalls = [];
require.cache[ocrPath].exports.runOCR = async (model, base64, mime, key, opts) => {
  ocrCalls.push({ id: model.id, hasFormat: opts?.format != null, prompt: opts?.structuredPrompt });
  const q = scripts[model.id];
  if (q && q.length) {
    const next = q.shift();
    return typeof next === 'string' ? { ok: true, timeMs: 1, text: next } : next;
  }
  // default: echo an empty object (invalid for a required-field schema)
  return { ok: true, timeMs: 1, text: '{}' };
};
process.on('beforeExit', () => { require.cache[ocrPath].exports.runOCR = originalRunOCR; });

const router = require('../lib/v1/router');
const { bearerAuth } = require('../lib/v1/auth');

const TOKEN = process.env.API_TOKEN;

const SCHEMA = {
  type: 'object',
  properties: { invoice_no: { type: 'string' }, total: { type: ['number', 'null'] } },
  required: ['invoice_no'],
  additionalProperties: false,
};

function pngBuffer() {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 0xaa)]);
}

function listen() {
  const app = express();
  app.use('/v1', bearerAuth, router);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
    server.on('error', reject);
  });
}

function multipart({ buffer, filename = 'doc.png', contentType = 'image/png', fields = {} }) {
  const boundary = '----stre2e-' + Math.random().toString(36).slice(2);
  const parts = [Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  ), buffer, Buffer.from('\r\n')];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
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

async function poll(url, jobId, timeoutMs = 15000) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${url}/v1/jobs/${jobId}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const job = await res.json();
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    if (performance.now() > deadline) throw new Error(`job ${jobId} never terminal (${job.status})`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function reset() { scripts = {}; ocrCalls = []; }

test('E2E structured: PNG + schema → 202 → validated structured envelope', async (t) => {
  const { server, url } = await listen();
  t.after(() => new Promise((r) => server.close(r))); reset();
  scripts['ollama-minimax-m3'] = [JSON.stringify({ invoice_no: 'A-100', total: 250 })];

  const sub = await submit(url, {
    buffer: pngBuffer(),
    fields: { mode: 'structured', schema: JSON.stringify(SCHEMA), profile: 'balanced' },
  });
  assert.equal(sub.status, 202, `submit body: ${JSON.stringify(sub.body)}`);

  const job = await poll(url, sub.body.job_id);
  assert.equal(job.status, 'succeeded', `job: ${JSON.stringify(job)}`);
  assert.deepEqual(job.result.structured, { invoice_no: 'A-100', total: 250 });
  assert.equal(job.result.mode, 'structured');
  assert.equal(job.result.engine, 'ollama-minimax-m3', 'cheapest structured tier; ocr.space excluded');
  assert.equal(job.result.provider, 'ollama');
  assert.ok(ocrCalls.every((c) => c.hasFormat), 'the constrained-decoding format was sent');
});

test('E2E structured: a HEIC photo is normalized to one frame then structured-extracted', async (t) => {
  // Exercises the D-S9 'normalize' branch end to end: the worker runs the real
  // heic-convert→sharp single-frame normalize before the (stubbed) vision call.
  const heicPath = path.join(__dirname, 'fixtures', 'sample.heic');
  if (!fs.existsSync(heicPath)) { t.skip('no HEIC fixture'); return; }

  const { server, url } = await listen();
  t.after(() => new Promise((r) => server.close(r))); reset();
  scripts['ollama-minimax-m3'] = [JSON.stringify({ invoice_no: 'HEIC-1', total: null })];

  const sub = await submit(url, {
    buffer: fs.readFileSync(heicPath),
    filename: 'photo.heic',
    contentType: 'image/heic',
    fields: { mode: 'structured', schema: JSON.stringify(SCHEMA) },
  });
  assert.equal(sub.status, 202, `submit body: ${JSON.stringify(sub.body)}`);
  const job = await poll(url, sub.body.job_id);
  assert.equal(job.status, 'succeeded', `job: ${JSON.stringify(job)}`);
  assert.deepEqual(job.result.structured, { invoice_no: 'HEIC-1', total: null });
  assert.equal(ocrCalls.length, 1, 'the normalized frame was routed once');
});

test('E2E structured: invalid-then-repaired resolves through the HTTP path', async (t) => {
  const { server, url } = await listen();
  t.after(() => new Promise((r) => server.close(r))); reset();
  scripts['ollama-minimax-m3'] = [
    JSON.stringify({ total: 5 }),                        // missing invoice_no → invalid
    JSON.stringify({ invoice_no: 'B-2', total: 5 }),     // repaired
  ];

  const sub = await submit(url, { buffer: pngBuffer(), fields: { mode: 'structured', schema: JSON.stringify(SCHEMA) } });
  assert.equal(sub.status, 202);
  const job = await poll(url, sub.body.job_id);
  assert.equal(job.status, 'succeeded');
  assert.deepEqual(job.result.structured, { invoice_no: 'B-2', total: 5 });
  assert.equal(ocrCalls.length, 2, 'exactly one repair retry');
});

test('E2E structured: forcing ocr.space with mode=structured → 422 field=model (before enqueue)', async (t) => {
  const { server, url } = await listen();
  t.after(() => new Promise((r) => server.close(r))); reset();

  const sub = await submit(url, {
    buffer: pngBuffer(),
    fields: { mode: 'structured', schema: JSON.stringify(SCHEMA), model: 'ocrspace-engine2' },
  });
  assert.equal(sub.status, 422);
  assert.equal(sub.body.error, 'invalid_parameter');
  assert.equal(sub.body.field, 'model');
  assert.equal(ocrCalls.length, 0, 'no engine ran');
});

test('E2E structured: a missing schema → 422 field=schema', async (t) => {
  const { server, url } = await listen();
  t.after(() => new Promise((r) => server.close(r))); reset();
  const sub = await submit(url, { buffer: pngBuffer(), fields: { mode: 'structured' } });
  assert.equal(sub.status, 422);
  assert.equal(sub.body.field, 'schema');
});

test('E2E structured: a non-object-root schema → 422 field=schema', async (t) => {
  const { server, url } = await listen();
  t.after(() => new Promise((r) => server.close(r))); reset();
  const sub = await submit(url, {
    buffer: pngBuffer(),
    fields: { mode: 'structured', schema: JSON.stringify({ type: 'string' }) },
  });
  assert.equal(sub.status, 422);
  assert.equal(sub.body.field, 'schema');
});

test('E2E structured: a PDF with mode=structured → 422 field=file (single-image only, D-S9)', async (t) => {
  const { server, url } = await listen();
  t.after(() => new Promise((r) => server.close(r))); reset();
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20)]);
  const sub = await submit(url, {
    buffer: pdf, filename: 'doc.pdf', contentType: 'application/pdf',
    fields: { mode: 'structured', schema: JSON.stringify(SCHEMA) },
  });
  assert.equal(sub.status, 422);
  assert.equal(sub.body.field, 'file');
  assert.equal(ocrCalls.length, 0);
});

test('E2E structured: when no output ever validates, the job FAILS typed (never unvalidated JSON)', async (t) => {
  const { server, url } = await listen();
  t.after(() => new Promise((r) => server.close(r))); reset();
  // every structured engine returns an object missing the required field, twice.
  for (const id of ['ollama-minimax-m3', 'ollama-gemma4-31b', 'ollama-qwen35-397b']) {
    scripts[id] = [JSON.stringify({ total: 1 }), JSON.stringify({ total: 2 })];
  }
  const sub = await submit(url, {
    buffer: pngBuffer(),
    fields: { mode: 'structured', schema: JSON.stringify(SCHEMA), profile: 'quality' },
  });
  assert.equal(sub.status, 202);
  const job = await poll(url, sub.body.job_id);
  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'structured_extraction_failed');
  assert.equal(job.result, undefined, 'no result envelope on a failed structured job');
});
