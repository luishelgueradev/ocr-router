const { test } = require('node:test');
const assert = require('node:assert/strict');

const { supportsStructured, structuredChain } = require('../lib/v1/structured/capability');
const CONFIG = require('../lib/v1/cascade/config');

// STR-01 — ocr.space excluded by capability, the vision LLMs included, and the
// per-profile chain filtered without disturbing order.

test('supportsStructured: ocr.space is NOT structured-capable', () => {
  assert.equal(supportsStructured('ocrspace-engine2'), false);
});

test('supportsStructured: the three Ollama vision engines ARE structured-capable', () => {
  for (const id of ['ollama-minimax-m3', 'ollama-gemma4-31b', 'ollama-qwen35-397b']) {
    assert.equal(supportsStructured(id), true, `${id} must be structured-capable`);
  }
});

test('supportsStructured: an unknown engine id fails closed', () => {
  assert.equal(supportsStructured('nope'), false);
  assert.equal(supportsStructured(undefined), false);
});

test('structuredChain: drops ocr.space and preserves the remaining order for every profile', () => {
  for (const name of Object.keys(CONFIG.profiles)) {
    const full = CONFIG.profiles[name].chain;
    const structured = structuredChain(name);

    assert.ok(!structured.includes('ocrspace-engine2'), `${name}: ocr.space excluded`);
    // Order-preserving subsequence of the full chain.
    assert.deepEqual(
      structured,
      full.filter((id) => id !== 'ocrspace-engine2'),
      `${name}: structured chain is the ocr.space-free subsequence, order intact`,
    );
    assert.ok(structured.length >= 1, `${name}: at least one structured engine remains`);
  }
});

test('structuredChain: an unknown profile falls back to the default profile', () => {
  assert.deepEqual(structuredChain('does-not-exist'), structuredChain(CONFIG.defaultProfile));
});
