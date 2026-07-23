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

test('VAL-02: fileFilter rejects image/gif', () => {
  let cbErr;
  upload.fileFilter({}, { mimetype: 'image/gif' }, (err) => {
    cbErr = err;
  });
  assert.ok(cbErr instanceof multer.MulterError, 'fileFilter must reject non-whitelist with MulterError');
});

test('VAL-02: fileFilter rejects application/pdf', () => {
  let cbErr;
  upload.fileFilter({}, { mimetype: 'application/pdf' }, (err) => {
    cbErr = err;
  });
  assert.ok(cbErr instanceof multer.MulterError);
});

test('VAL-02: fileFilter rejects image/svg+xml (defense against SVG-with-script)', () => {
  let cbErr;
  upload.fileFilter({}, { mimetype: 'image/svg+xml' }, (err) => {
    cbErr = err;
  });
  assert.ok(cbErr instanceof multer.MulterError, 'SVG must be rejected at declared-MIME gate');
});

test('VAL-02: fileFilter rejects empty mimetype', () => {
  let cbErr;
  upload.fileFilter({}, { mimetype: '' }, (err) => {
    cbErr = err;
  });
  assert.ok(cbErr instanceof multer.MulterError);
});
