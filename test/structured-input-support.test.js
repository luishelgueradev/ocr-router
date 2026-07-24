const { test } = require('node:test');
const assert = require('node:assert/strict');

const { structuredImageSupport } = require('../lib/v1/structured/input-support');

// D-S9 — the single-image boundary for structured mode.

test('structuredImageSupport: png/jpeg/webp are consumed directly', () => {
  for (const t of ['image/png', 'image/jpeg', 'image/webp']) {
    assert.equal(structuredImageSupport(t), 'direct', `${t} → direct`);
  }
});

test('structuredImageSupport: heic/bmp need one-frame normalization', () => {
  for (const t of ['image/heic', 'image/bmp']) {
    assert.equal(structuredImageSupport(t), 'normalize', `${t} → normalize`);
  }
});

test('structuredImageSupport: pdf and multi-frame tiff/gif are unsupported (→ null → 422)', () => {
  for (const t of ['application/pdf', 'image/tiff', 'image/gif', 'application/octet-stream', undefined]) {
    assert.equal(structuredImageSupport(t), null, `${t} → null`);
  }
});
