const multer = require('multer');
const { intFromEnv } = require('./env');

// WR-07 fix — validated at boot; see lib/v1/env.js. Default 10 MiB.
const MAX_UPLOAD_BYTES = intFromEnv('MAX_UPLOAD_BYTES', 10 * 1024 * 1024);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/webp'];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'file'));
  },
});

module.exports = { upload, MAX_UPLOAD_BYTES };
