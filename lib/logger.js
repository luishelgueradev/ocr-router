const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'apiKeyOverride',
      'req.body.apiKeyOverride',
    ],
    censor: '[REDACTED]',
  },
});

module.exports = logger;
