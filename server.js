require('dotenv').config();

const express = require('express');
const path = require('path');
const models = require('./lib/models');
const { runOCR } = require('./lib/ocr');
const pinoHttp = require('pino-http');
const logger = require('./lib/logger');
const { v7: uuidv7 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

const httpLogger = pinoHttp({
  logger,
  genReqId(req, res) {
    const incoming = req.headers['x-request-id'];
    if (incoming && typeof incoming === 'string') {
      const sanitized = incoming.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 64);
      if (sanitized.length > 0) return sanitized;
    }
    return uuidv7();
  },
  customLogLevel(req, res, err) {
    if (err || res.statusCode >= 500) return 'error';
    return 'info';
  },
  customAttributeKeys: {
    responseTime: 'latency_ms',
  },
  customProps(req, res) {
    return { request_id: req.id };
  },
  autoLogging: { ignore: () => false },
});

app.use(httpLogger);
app.use(express.json({ limit: '20mb' }));

app.get('/api/config', (req, res) => {
  res.json({
    models: models.map(m => ({
      id: m.id,
      label: m.label,
      provider: m.provider,
    })),
    envKeys: {
      ollama:   Boolean(process.env.OLLAMA_API_KEY),
      ocrspace: Boolean(process.env.OCR_SPACE_API_KEY),
    },
  });
});

function findModel(modelId) {
  return models.find(m => m.id === modelId) || null;
}

function envKeyFor(provider) {
  if (provider === 'ollama')   return process.env.OLLAMA_API_KEY || null;
  if (provider === 'ocrspace') return process.env.OCR_SPACE_API_KEY || null;
  return null;
}

app.post('/api/ocr', async (req, res) => {
  try {
    const { modelId, image, mimeType, apiKeyOverride } = req.body || {};

    const model = findModel(modelId);
    if (!model) {
      return res.status(400).json({ ok: false, error: 'Modelo no reconocido' });
    }
    if (typeof image !== 'string' || image.length === 0) {
      return res.status(400).json({ ok: false, error: 'image requerido' });
    }
    if (typeof mimeType !== 'string' || !mimeType.startsWith('image/')) {
      return res.status(400).json({ ok: false, error: 'mimeType inválido' });
    }
    if (apiKeyOverride !== undefined &&
        (typeof apiKeyOverride !== 'string' || apiKeyOverride.length === 0)) {
      return res.status(400).json({ ok: false, error: 'apiKeyOverride inválido' });
    }

    const effectiveKey = apiKeyOverride || envKeyFor(model.provider);
    if (!effectiveKey) {
      return res.status(400).json({
        ok: false,
        error: `Falta API key para ${model.provider}. Configurala en .env o en ⚙ Configuración.`,
      });
    }

    const result = await runOCR(model, image, mimeType, effectiveKey);
    if (!result.ok) {
      return res.status(500).json(result);
    }
    return res.json(result);
  } catch (e) {
    // Log the actual error message so the legacy admin path is debuggable in
    // production. pino redaction already protects sensitive fields (MR-04).
    logger.error({ err: e && e.message }, 'Error interno en /api/ocr');
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

const PLACEHOLDER_API_TOKEN = 'generate-with-openssl-rand-hex-32';
if (!process.env.API_TOKEN || process.env.API_TOKEN === PLACEHOLDER_API_TOKEN) {
  throw new Error('API_TOKEN missing or still set to placeholder — refusing to start. Generate one with: openssl rand -hex 32');
}

const PLACEHOLDER_TAILSCALE_IP = '100.x.x.x';
// CR-01 fix — fail closed by default. The guard now fires UNLESS NODE_ENV is
// explicitly 'development'. Previous form (`NODE_ENV === 'production'`) was
// dead inside Docker because nothing in the deploy stack set NODE_ENV, leaving
// the admin-panel security model unenforced. Local `node server.js` invocations
// without NODE_ENV set will now also be guarded — set NODE_ENV=development to
// opt out of the check during local iteration.
const isDev = process.env.NODE_ENV === 'development';
if (!isDev && (!process.env.TAILSCALE_IP || process.env.TAILSCALE_IP === PLACEHOLDER_TAILSCALE_IP)) {
  throw new Error('TAILSCALE_IP missing or still placeholder — refusing to start. Run: tailscale ip -4');
}

// D-08 — zero-engine fail-closed boot guard. An engine is "configured" only when
// its provider has an env key present (ollama→OLLAMA_API_KEY, ocrspace→OCR_SPACE_API_KEY).
// With no usable engine every /v1/ocr request would fail, so refuse to start —
// mirroring the API_TOKEN / TAILSCALE_IP fail-closed guards above.
function providerKeyPresent(provider) {
  if (provider === 'ollama')   return Boolean(process.env.OLLAMA_API_KEY);
  if (provider === 'ocrspace') return Boolean(process.env.OCR_SPACE_API_KEY);
  return false;
}
const configuredEngines = models.filter(m => providerKeyPresent(m.provider));
if (configuredEngines.length === 0) {
  throw new Error('No OCR engine configured — set OLLAMA_API_KEY and/or OCR_SPACE_API_KEY. Refusing to start (zero-engine guard, D-08).');
}

const { bearerAuth } = require('./lib/v1/auth');
const v1Router = require('./lib/v1/router');
app.use('/v1', bearerAuth, v1Router);

app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: 'Imagen demasiado grande' });
  }
  next(err);
});

// WR-07 — surface effective env-derived caps so the operator can confirm what
// was actually applied (intFromEnv would have already thrown on a bad value).
const { MAX_UPLOAD_BYTES } = require('./lib/v1/upload');
const { MAX_QUEUE_DEPTH } = require('./lib/v1/worker');
const { JOB_MAX } = (() => {
  // jobs.js does not export JOB_MAX today; recompute the same way to avoid
  // module surface changes. intFromEnv is the source of truth.
  const { intFromEnv } = require('./lib/v1/env');
  return { JOB_MAX: intFromEnv('JOB_STORE_MAX', 500) };
})();

const httpServer = app.listen(PORT, () => {
  logger.info(
    { port: PORT, max_upload_bytes: MAX_UPLOAD_BYTES, max_queue_depth: MAX_QUEUE_DEPTH, job_store_max: JOB_MAX },
    'server ready'
  );
  if (!process.env.OLLAMA_API_KEY) {
    logger.info('OLLAMA_API_KEY not set — configure via UI settings');
  }
  if (!process.env.OCR_SPACE_API_KEY) {
    logger.info('OCR_SPACE_API_KEY not set — configure via UI settings');
  }
});

const { drainAndCancel } = require('./lib/v1/shutdown');

let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'signal_received');

  // CR-03 fix — start the close (non-blocking: stops accepting new TCP NOW),
  // but capture a Promise that resolves only after every in-flight response
  // has finished writing. Previously `httpServer.close()` was fire-and-forget
  // and `process.exit(0)` killed in-flight 202 responses mid-write.
  const httpClosed = new Promise((resolve) => httpServer.close(resolve));

  // LR-02 — httpServer.close() waits for idle keep-alive sockets (Caddy holds these)
  // to time out, so "graceful" shutdown would otherwise routinely stall until the 38s
  // hard-kill backstop. Drop idle connections now so only in-flight responses hold
  // httpClosed open (Node ≥18).
  if (typeof httpServer.closeIdleConnections === 'function') httpServer.closeIdleConnections();

  await drainAndCancel(35_000);    // D-10: 35-second hard window for job drain
  await httpClosed;                // CR-03: ensure no response is truncated

  // CR-03 / IN-06 — pino's default destination is async; flush before exit so
  // the final shutdown_complete log line is not lost.
  if (typeof logger.flush === 'function') logger.flush();

  process.exit(0);                 // D-10: clean exit code even on timeout (operator-requested)
}

// CR-03 backstop — if a wedged keep-alive socket holds httpClosed open past
// the drain budget, force-exit before Docker's stop_grace_period (40s) hits
// SIGKILL. 38s leaves a 2s margin and .unref() keeps the timer from blocking
// a clean exit when shutdown completes normally.
function armHardKillTimer() {
  setTimeout(() => process.exit(1), 38_000).unref();
}

// WR-03 fix — gracefulShutdown returns a Promise. If it ever rejects (today
// the body is protected, but any future change introducing an await outside
// the try/catch would surface as unhandledRejection), the signal handler
// previously turned into a silent black hole and the process stayed alive
// until Docker SIGKILL with no diagnostic context. Catch + log + exit 1.
const onSignal = (signal) => {
  armHardKillTimer();
  gracefulShutdown(signal).catch((e) => {
    logger.error({ err: e && e.message, signal }, 'shutdown_handler_crashed');
    process.exit(1);
  });
};
process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('SIGINT',  () => onSignal('SIGINT'));    // D-12: dev convenience
