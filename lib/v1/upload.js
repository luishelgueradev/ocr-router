const multer = require('multer');
const { intFromEnv } = require('./env');

// WR-07 fix — validated at boot; see lib/v1/env.js. Default 10 MiB.
const MAX_UPLOAD_BYTES = intFromEnv('MAX_UPLOAD_BYTES', 10 * 1024 * 1024);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    // First, PERMISSIVE gate on the client-declared mimetype (untrusted). The
    // authoritative decision is the magic-byte sniff in router.js (sniffImage),
    // which still 422s anything whose real bytes are unknown/spoofed. Admitting
    // these declared types just lets the new formats reach that second gate.
    // The multipart size cap (limits.fileSize / API-07) is unaffected.
    const allowed = [
      'image/png', 'image/jpeg', 'image/webp',
      'application/pdf', 'image/tiff',
      'image/heic', 'image/heif',
      'image/bmp', 'image/gif',
    ];
    if (allowed.includes(file.mimetype)) return cb(null, true);

    // UNLABELED binary — admit it and let the sniff decide. Automation clients
    // (n8n and similar, the primary consumers) routinely upload a valid document
    // with no precise Content-Type; multer stamps such a part
    // `application/octet-stream`. Rejecting it here — BEFORE the authoritative
    // magic-byte sniff — refused perfectly valid uploads for a header the client
    // never set. The sniff still 422s anything whose real bytes are unknown, so
    // this widens only the DECLARED-type door, never the actual content check.
    // An empty/absent mimetype is the same case.
    if (file.mimetype === 'application/octet-stream' || !file.mimetype) {
      return cb(null, true);
    }

    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'file'));
  },
});

module.exports = { upload, MAX_UPLOAD_BYTES };
