const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveMode } = require('../lib/v1/modes');
const models = require('../lib/models');

// MODE-01: mode accepts 'speed'|'quality', default 'quality', case-insensitive
// MODE-02: modes thread provider options (temperature, num_predict, num_ctx) and prompt selector
// MODE-03: modes_supported declared in lib/models.js
// MODE-04: unsupported mode → resolveMode returns {error:'mode'} (router maps to 422)

const ollamaModel = {
  id: 'ollama-test',
  provider: 'ollama',
  modes_supported: ['speed', 'quality'],
  default_mode: 'quality',
  modes: {
    speed:   { options: { temperature: 0, num_predict: 1024, num_ctx: 4096  }, prompt: 'short' },
    quality: { options: { temperature: 0, num_predict: 4096, num_ctx: 16384 }, prompt: 'full'  },
  },
};

const ocrspaceModel = {
  id: 'ocrspace-test',
  provider: 'ocrspace',
  modes_supported: ['quality'],
  default_mode: 'quality',
  // intentionally no `modes` block — ocrspace has no provider-side knobs
};

test('resolveMode: explicit "speed" returns the speed preset', () => {
  const r = resolveMode(ollamaModel, 'speed');
  assert.equal(r.mode, 'speed');
  assert.deepEqual(r.preset.options, { temperature: 0, num_predict: 1024, num_ctx: 4096 });
  assert.equal(r.preset.prompt, 'short');
});

test('resolveMode: case-insensitive — "QUALITY" returns the quality preset (MODE-01)', () => {
  const r = resolveMode(ollamaModel, 'QUALITY');
  assert.equal(r.mode, 'quality');
  assert.equal(r.preset.prompt, 'full');
});

test('resolveMode: mixed-case "Speed" returns the speed preset (MODE-01)', () => {
  const r = resolveMode(ollamaModel, 'Speed');
  assert.equal(r.mode, 'speed');
});

test('resolveMode: undefined mode falls back to model.default_mode', () => {
  const r = resolveMode(ollamaModel, undefined);
  assert.equal(r.mode, 'quality');
  assert.equal(r.preset.prompt, 'full');
});

test('resolveMode: empty-string mode falls back to default', () => {
  const r = resolveMode(ollamaModel, '');
  assert.equal(r.mode, 'quality');
});

test('resolveMode: unsupported mode returns {error:"mode"} (MODE-04 trigger)', () => {
  const r = resolveMode(ollamaModel, 'ludicrous');
  assert.equal(r.error, 'mode');
  assert.equal(r.mode, undefined);
  assert.equal(r.preset, undefined);
});

test('resolveMode: ocrspace model rejects "speed" mode (D-06)', () => {
  const r = resolveMode(ocrspaceModel, 'speed');
  assert.equal(r.error, 'mode');
});

test('resolveMode: ocrspace default lands on quality with no preset (provider has no knobs)', () => {
  const r = resolveMode(ocrspaceModel, undefined);
  assert.equal(r.mode, 'quality');
  // model.modes is undefined → preset is null per impl
  assert.equal(r.preset, null);
});

test('resolveMode: preset payload threads provider options for MODE-02', () => {
  const r = resolveMode(ollamaModel, 'speed');
  // The router/worker passes preset.options to runOCR → runOllama as body.options
  assert.ok(r.preset.options.num_ctx, 'num_ctx must be set for MODE-02 wiring');
  assert.ok(r.preset.options.num_predict, 'num_predict must be set for MODE-02 wiring');
  assert.equal(r.preset.options.temperature, 0, 'temperature 0 for deterministic OCR');
  assert.match(r.preset.prompt, /^(short|full)$/, 'prompt selector for short/full variant');
});

// ---------------------------------------------------------------------------
// MODE-03 — every catalog model declares modes_supported and default_mode
// ---------------------------------------------------------------------------

test('MODE-03: every catalog model declares modes_supported (non-empty array)', () => {
  for (const m of models) {
    assert.ok(Array.isArray(m.modes_supported), `${m.id} must have modes_supported as array`);
    assert.ok(m.modes_supported.length > 0, `${m.id} must have at least one supported mode`);
  }
});

test('MODE-03: every catalog model declares default_mode and it is supported', () => {
  for (const m of models) {
    assert.ok(typeof m.default_mode === 'string', `${m.id} must have default_mode as string`);
    assert.ok(
      m.modes_supported.includes(m.default_mode),
      `${m.id} default_mode "${m.default_mode}" must be in modes_supported`
    );
  }
});

test('MODE-03: every Ollama model has a modes block with options for each supported mode', () => {
  const ollamaModels = models.filter(m => m.provider === 'ollama');
  assert.ok(ollamaModels.length > 0, 'expected at least one ollama model in catalog');
  for (const m of ollamaModels) {
    assert.ok(m.modes, `${m.id} must have a modes block`);
    for (const mode of m.modes_supported) {
      assert.ok(m.modes[mode], `${m.id} must have modes.${mode}`);
      assert.ok(m.modes[mode].options, `${m.id} modes.${mode}.options required for MODE-02`);
      assert.ok(m.modes[mode].prompt, `${m.id} modes.${mode}.prompt selector required`);
    }
  }
});

test('MODE-03: ocrspace model declares modes_supported = ["quality"] only (D-06)', () => {
  const oc = models.find(m => m.provider === 'ocrspace');
  assert.ok(oc, 'expected an ocrspace entry');
  assert.deepEqual(oc.modes_supported, ['quality']);
});
