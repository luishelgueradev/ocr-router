const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const models = require('../lib/models');

// CATALOG-01: add/remove models = edit lib/models.js only (no other code changes)
// CATALOG-02: each entry declares id, name, provider, modes_supported, default_mode, max_bytes (optional)
// CATALOG-03: admin panel /api/config still works — `label` field preserved

test('CATALOG-02: every model entry declares required fields', () => {
  assert.ok(Array.isArray(models), 'lib/models must export an array');
  assert.ok(models.length > 0, 'catalog must not be empty');
  for (const m of models) {
    assert.ok(typeof m.id === 'string' && m.id.length > 0, `entry missing id: ${JSON.stringify(m)}`);
    assert.ok(typeof m.name === 'string' && m.name.length > 0, `${m.id} missing name`);
    assert.ok(typeof m.provider === 'string' && m.provider.length > 0, `${m.id} missing provider`);
    assert.ok(Array.isArray(m.modes_supported), `${m.id} modes_supported must be array`);
    assert.ok(m.modes_supported.length > 0, `${m.id} modes_supported must be non-empty`);
    assert.ok(typeof m.default_mode === 'string' && m.default_mode.length > 0, `${m.id} missing default_mode`);
    assert.ok(m.modes_supported.includes(m.default_mode), `${m.id} default_mode must be in modes_supported`);
  }
});

test('CATALOG-02: every Ollama model has max_bytes and a modes block', () => {
  const ollamaModels = models.filter(m => m.provider === 'ollama');
  assert.ok(ollamaModels.length > 0, 'expected at least one Ollama model');
  for (const m of ollamaModels) {
    assert.ok(typeof m.max_bytes === 'number' && m.max_bytes > 0, `${m.id} max_bytes required`);
    assert.ok(m.modes && typeof m.modes === 'object', `${m.id} must have modes block`);
    for (const mode of m.modes_supported) {
      assert.ok(m.modes[mode], `${m.id} missing modes.${mode}`);
      assert.ok(m.modes[mode].options, `${m.id} modes.${mode}.options required`);
      const opts = m.modes[mode].options;
      assert.ok(typeof opts.num_ctx === 'number' && opts.num_ctx > 0, `${m.id} modes.${mode}.options.num_ctx required`);
      assert.ok(typeof opts.num_predict === 'number' && opts.num_predict > 0, `${m.id} modes.${mode}.options.num_predict required`);
      assert.ok(['short', 'full', 'describe'].includes(m.modes[mode].prompt), `${m.id} modes.${mode}.prompt must be short, full or describe`);
    }
  }
});

test('CATALOG-03: every model preserves `label` for /api/config admin panel', () => {
  for (const m of models) {
    assert.ok(
      typeof m.label === 'string' && m.label.length > 0,
      m.id + ' must retain label field for /api/config (CATALOG-03 — admin panel still works)'
    );
  }
});

test('CATALOG-03: /api/config projection {id,label,provider} yields non-empty values', () => {
  // server.js maps each entry to {id,label,provider}; assert none would be empty
  const projection = models.map(m => ({ id: m.id, label: m.label, provider: m.provider }));
  for (const p of projection) {
    assert.ok(p.id && p.label && p.provider, `projection missing fields: ${JSON.stringify(p)}`);
  }
});

// CATALOG-01: regression — no model id is hardcoded outside lib/models.js / findModel
test('CATALOG-01: no model id is hardcoded in any lib/v1/*.js file (router uses catalog only)', () => {
  const libV1Dir = path.join(__dirname, '..', 'lib', 'v1');
  const ids = models.map(m => m.id);
  const files = fs.readdirSync(libV1Dir).filter(f => f.endsWith('.js'));
  for (const file of files) {
    const src = fs.readFileSync(path.join(libV1Dir, file), 'utf8');
    for (const id of ids) {
      assert.ok(
        !src.includes(id),
        `lib/v1/${file} hardcodes model id "${id}" — CATALOG-01 requires adding/removing models = edit lib/models.js ONLY`
      );
    }
  }
});

test('CATALOG-01: lib/ocr.js and lib/providers/*.js do not hardcode any model id', () => {
  const ids = models.map(m => m.id);
  const ocrSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ocr.js'), 'utf8');
  for (const id of ids) {
    assert.ok(!ocrSrc.includes(id), `lib/ocr.js hardcodes model id "${id}"`);
  }
  const providersDir = path.join(__dirname, '..', 'lib', 'providers');
  for (const file of fs.readdirSync(providersDir).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(providersDir, file), 'utf8');
    for (const id of ids) {
      assert.ok(!src.includes(id), `lib/providers/${file} hardcodes model id "${id}"`);
    }
  }
});

test('CATALOG-02: model ids are unique', () => {
  const ids = models.map(m => m.id);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, 'duplicate model ids in lib/models.js');
});
