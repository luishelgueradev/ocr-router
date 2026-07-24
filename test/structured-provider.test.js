const { test } = require('node:test');
const assert = require('node:assert/strict');

// STR-01/02/03 provider layer: structured mode must send Ollama's `format`
// (constrained decoding) and the injection-safe prompt, on the IMAGE channel —
// with NO network. axios.post is monkey-patched via require.cache (the
// established test/provider-signal.test.js pattern). The free-text path must be
// byte-unchanged when opts.format is absent.

const { runOllama } = require('../lib/providers/ollama');
const { STRUCTURED_PROMPT } = require('../lib/v1/structured/prompt');

function patchAxios(t, handler) {
  const axiosPath = require.resolve('axios');
  const axios = require(axiosPath);
  const original = axios.post;
  axios.post = handler;
  t.after(() => { axios.post = original; });
}

test('structured: the request carries format + the structured prompt on the image channel', async (t) => {
  const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
  let sent;
  patchAxios(t, async (_url, body) => {
    sent = body;
    return { data: { message: { content: '{"name":"Acme"}' } } };
  });

  const res = await runOllama('qwen3-vl:235b-cloud', 'YmFzZTY0', 'k', {
    format: schema,
    structuredPrompt: STRUCTURED_PROMPT,
    options: { temperature: 0 },
  });

  assert.deepEqual(sent.format, schema, 'the JSON Schema is sent as body.format');
  assert.equal(sent.messages[0].content, STRUCTURED_PROMPT, 'the structured prompt is the message content');
  assert.deepEqual(sent.messages[0].images, ['YmFzZTY0'], 'the document rides the image channel, not the prompt');
  assert.equal(sent.messages[0].content.includes('YmFzZTY0'), false, 'the image is NOT interpolated into the prompt');
  assert.equal(res.ok, true);
  assert.equal(res.text, '{"name":"Acme"}', 'the JSON string is surfaced as text for the caller to parse');
});

test('free-text path is unchanged when opts.format is absent (no format field)', async (t) => {
  let sent;
  patchAxios(t, async (_url, body) => {
    sent = body;
    return { data: { message: { content: 'plain ocr text' } } };
  });

  const res = await runOllama('gemini-3-flash-preview:latest', 'YmFzZTY0', 'k', { prompt: 'short' });

  assert.equal('format' in sent, false, 'no format field on the free-text call');
  assert.equal(res.text, 'plain ocr text');
});

test('structured: an aborted structured call still falls through as ok:false, never a crash', async (t) => {
  patchAxios(t, async () => {
    const err = new Error('canceled');
    err.code = 'ERR_CANCELED';
    throw err;
  });

  const res = await runOllama('qwen3-vl:235b-cloud', 'YmFzZTY0', 'k', {
    format: { type: 'object' },
    structuredPrompt: STRUCTURED_PROMPT,
  });
  assert.equal(res.ok, false, 'a deadline abort is a clean ok:false, not a thrown error');
});
