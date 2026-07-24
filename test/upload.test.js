const { test } = require('node:test');
const assert = require('node:assert/strict');
const multer = require('multer');
const { upload, MAX_UPLOAD_BYTES } = require('../lib/v1/upload');

// VAL-01: multer enforces fileSize limit; excess → LIMIT_FILE_SIZE → 413 in router.
// VAL-02: fileFilter whitelists image/png, image/jpeg, image/webp.
// VAL-05: memoryStorage — image buffer never touches disk.

test('VAL-05: upload uses memoryStorage (not DiskStorage)', () => {
  // multer.memoryStorage() returns a MemoryStorage instance whose prototype has
  // _handleFile and _removeFile. DiskStorage instances have the same surface
  // but a different constructor name. We verify the storage is a MemoryStorage.
  const sample = multer.memoryStorage();
  const sampleCtorName = sample.constructor.name;
  assert.equal(
    upload.storage.constructor.name,
    sampleCtorName,
    `upload.storage must be a ${sampleCtorName} (memoryStorage) instance — VAL-05 requires buffer-only, no disk writes`
  );
  // Hard guard against accidental swap to DiskStorage:
  assert.notEqual(upload.storage.constructor.name, 'DiskStorage');
});

test('VAL-01: upload.limits.fileSize equals MAX_UPLOAD_BYTES', () => {
  assert.equal(typeof MAX_UPLOAD_BYTES, 'number');
  assert.ok(MAX_UPLOAD_BYTES > 0, 'MAX_UPLOAD_BYTES must be positive');
  assert.equal(upload.limits.fileSize, MAX_UPLOAD_BYTES);
});

test('VAL-01: MAX_UPLOAD_BYTES default is 10 MiB when unset (10 * 1024 * 1024)', () => {
  // intFromEnv falls back to 10*1024*1024 when MAX_UPLOAD_BYTES is unset.
  // The test process inherits whatever .env has; only assert default when unset.
  if (!process.env.MAX_UPLOAD_BYTES) {
    assert.equal(MAX_UPLOAD_BYTES, 10 * 1024 * 1024);
  }
});

test('VAL-01: upload.limits.files === 1 (single-image upload only)', () => {
  assert.equal(upload.limits.files, 1);
});

test('VAL-02: fileFilter accepts image/png', () => {
  let called = false;
  let acceptResult;
  upload.fileFilter({}, { mimetype: 'image/png' }, (err, accept) => {
    called = true;
    acceptResult = accept;
    assert.equal(err, null);
  });
  assert.ok(called, 'fileFilter must invoke its callback synchronously');
  assert.equal(acceptResult, true, 'image/png must be accepted');
});

test('VAL-02: fileFilter accepts image/jpeg', () => {
  let acceptResult;
  upload.fileFilter({}, { mimetype: 'image/jpeg' }, (err, accept) => {
    assert.equal(err, null);
    acceptResult = accept;
  });
  assert.equal(acceptResult, true);
});

test('VAL-02: fileFilter accepts image/webp', () => {
  let acceptResult;
  upload.fileFilter({}, { mimetype: 'image/webp' }, (err, accept) => {
    assert.equal(err, null);
    acceptResult = accept;
  });
  assert.equal(acceptResult, true);
});

// Phase 3 (D-06 / INP-03..05): the declared-MIME gate now admits the new
// formats too. This is only the FIRST, permissive gate — sniffImage in
// router.js remains authoritative and 422s anything whose real bytes are
// unknown/spoofed. Admitting the declared type just lets it reach that gate.
for (const mime of ['application/pdf', 'image/tiff', 'image/heic', 'image/heif', 'image/bmp', 'image/gif']) {
  test(`VAL-02: fileFilter accepts ${mime} (Phase 3 new format)`, () => {
    let acceptResult;
    let cbErr = 'unset';
    upload.fileFilter({}, { mimetype: mime }, (err, accept) => {
      cbErr = err;
      acceptResult = accept;
    });
    assert.equal(cbErr, null, `${mime} must not error at the declared-MIME gate`);
    assert.equal(acceptResult, true, `${mime} must be accepted at the declared-MIME gate`);
  });
}

// UNLABELED binary is now ADMITTED at this first gate (the sniff is
// authoritative). Automation clients routinely upload a valid document with no
// precise Content-Type, which multer stamps `application/octet-stream`; refusing
// it here rejected valid uploads for a header the client never set. The sniff in
// router.js still 422s anything whose real bytes are unknown — proven by the two
// e2e cases in test/e2e-input-http.test.js (octet-stream + real TIFF → 202;
// octet-stream + text → 422).
test('VAL-02: fileFilter ADMITS application/octet-stream (unlabeled binary → sniff decides)', () => {
  let cbErr = 'unset';
  let acceptResult;
  upload.fileFilter({}, { mimetype: 'application/octet-stream' }, (err, accept) => {
    cbErr = err;
    acceptResult = accept;
  });
  assert.equal(cbErr, null, 'an unlabeled binary must not be refused at the declared-MIME gate');
  assert.equal(acceptResult, true);
});

test('VAL-02: fileFilter ADMITS an empty/absent mimetype (same unlabeled case)', () => {
  let cbErr = 'unset';
  let acceptResult;
  upload.fileFilter({}, { mimetype: '' }, (err, accept) => {
    cbErr = err;
    acceptResult = accept;
  });
  assert.equal(cbErr, null, 'an absent Content-Type is the unlabeled case, not a rejection');
  assert.equal(acceptResult, true);
});

test('VAL-02: fileFilter still rejects a POSITIVELY non-document declared type (image/svg+xml)', () => {
  // Widening to octet-stream must not turn the gate into an allow-all: a type
  // the client explicitly declares AND that is a known non-document (SVG, the
  // SVG-with-script vector) is still refused before the sniff.
  let cbErr;
  upload.fileFilter({}, { mimetype: 'image/svg+xml' }, (err) => {
    cbErr = err;
  });
  assert.ok(cbErr instanceof multer.MulterError, 'SVG must be rejected at declared-MIME gate');
});

test('VAL-02: fileFilter still rejects text/plain (a declared non-document is not admitted)', () => {
  let cbErr;
  upload.fileFilter({}, { mimetype: 'text/plain' }, (err) => {
    cbErr = err;
  });
  assert.ok(cbErr instanceof multer.MulterError, 'an explicitly-declared non-document type is still refused');
});
