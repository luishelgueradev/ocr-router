const express = require('express');
const { v7: uuidv7 } = require('uuid');
const models = require('../models');
const jobs = require('./jobs');
const { resolveMode } = require('./modes');
const { upload, MAX_UPLOAD_BYTES } = require('./upload');
const { sniffImage } = require('./sniff');
const { runJob, limiter, MAX_QUEUE_DEPTH } = require('./worker');
const { healthHandler } = require('./health');
const { findModel, envKeyFor } = require('./engines');

const router = express.Router();

// D-08 — Phase 1 has no cascade. When the client omits `model`, resolve a single
// default engine: prefer the ocr.space engine when OCR_SPACE_API_KEY is present,
// otherwise the first configured engine whose provider has an env key present.
// Returns null only when zero engines are usable (server.js fails closed at boot,
// so this null path is defensive).
function resolveDefaultEngine() {
  if (process.env.OCR_SPACE_API_KEY) {
    const ocrspace = models.find(m => m.provider === 'ocrspace');
    if (ocrspace) return ocrspace;
  }
  return models.find(m => envKeyFor(m.provider)) || null;
}

// POST /v1/ocr — submit OCR job
router.post('/ocr', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'payload_too_large', limit_bytes: MAX_UPLOAD_BYTES });
      }
      return res.status(422).json({
        error: 'invalid_parameter',
        field: 'file',
        message: 'El archivo no es una imagen PNG/JPEG/WebP válida',
      });
    }

    if (!req.file) {
      return res.status(422).json({
        error: 'invalid_parameter',
        field: 'file',
        message: 'Se requiere el campo file (multipart)',
      });
    }

    // Deep content sniff — defends against spoofed content-types and SVG-with-script (D-07).
    // Use the sniffed type as the authoritative content type downstream; the client-declared
    // multipart mimetype is untrusted and must not be what we forward to a provider (HR-01/MR-01).
    const sniffedType = sniffImage(req.file.buffer);
    if (sniffedType === null) {
      return res.status(422).json({
        error: 'invalid_parameter',
        field: 'file',
        message: 'El archivo no es una imagen PNG/JPEG/WebP válida',
      });
    }

    const { model: modelId, mode: requestedMode } = req.body || {};

    // D-08 — `model` is optional. An explicit model is validated; an omitted
    // model resolves to the default engine so a minimal POST (just a file) works.
    let model;
    if (modelId) {
      model = findModel(modelId);
      if (!model) {
        return res.status(422).json({
          error: 'invalid_parameter',
          field: 'model',
          message: 'Use GET /v1/models para ver modelos válidos',
        });
      }
    } else {
      model = resolveDefaultEngine();
      if (!model) {
        return res.status(422).json({
          error: 'invalid_parameter',
          field: 'model',
          message: 'No hay ningún motor OCR configurado. Use GET /v1/models.',
        });
      }
    }

    const modeResult = resolveMode(model, requestedMode);
    if (modeResult.error) {
      return res.status(422).json({
        error: 'invalid_parameter',
        field: 'mode',
        message: `Modo no soportado por ${model.id}. Modos válidos: ${model.modes_supported.join(', ')}`,
      });
    }

    const { mode, preset } = modeResult;
    const apiKey = envKeyFor(model.provider);

    // Fail closed when the selected engine has no configured API key. The default-engine
    // path (resolveDefaultEngine) already guarantees a key, so this only rejects a
    // client-forced model whose provider is unconfigured — otherwise the job would be
    // enqueued (wasting a bounded queue slot) and run with `Authorization: Bearer null`,
    // failing with a misleading auth error. Mirrors the legacy /api/ocr guard (HR-01).
    if (!apiKey) {
      return res.status(422).json({
        error: 'invalid_parameter',
        field: 'model',
        message: `El motor ${model.id} no está configurado (falta su API key). Use GET /v1/models.`,
      });
    }

    // Reject before holding another image buffer in the queue — each queued job
    // retains its full buffer behind the concurrency-1 worker (memory-exhaustion guard).
    if (limiter.counts().QUEUED >= MAX_QUEUE_DEPTH) {
      return res.status(503)
        .set('Retry-After', '10')
        .json({
          error: 'server_busy',
          message: 'El servidor tiene la cola de trabajos llena. Intente de nuevo en unos segundos.',
        });
    }

    const jobId = uuidv7();
    const createResult = jobs.create(jobId, { model_id: model.id });
    if (createResult.full) {
      return res.status(503)
        .set('Retry-After', '10')
        .json({
          error: 'server_busy',
          message: 'El servidor está procesando el máximo de trabajos permitido. Intente de nuevo en unos segundos.',
        });
    }

    const jobRecord = jobs.get(jobId);

    res.status(202)
      .location(`/v1/jobs/${jobId}`)
      .set('Retry-After', '10')
      .json({
        job_id: jobId,
        status: 'queued',
        status_url: `/v1/jobs/${jobId}`,
        created_at: jobRecord.created_at,
        expires_at: jobRecord.expires_at,
      });

    // fire-and-forget — do NOT await
    limiter.schedule(() => runJob(jobId, {
      model,
      buffer: req.file.buffer,
      mimeType: sniffedType,
      mode,
      apiKey,
      preset,
      requestId: req.id,
    })).catch(() => {
      jobs.fail(jobId, { code: 'internal_error', message: 'worker crashed' });
    });
  });
});

// GET /v1/jobs/:id — poll job status
router.get('/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({
      error: 'job_not_found',
      job_id: req.params.id,
      message: 'Trabajo no encontrado o expirado',
    });
  }
  return res.status(200).json(job);
});

// GET /v1/health — liveness probe (public, no auth required — bearerAuth exempts /health)
router.get('/health', healthHandler);

// GET /v1/models — catalog listing (authenticated — behind bearerAuth)
router.get('/models', (req, res) => {
  return res.status(200).json({
    models: models.map(m => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      modes_supported: m.modes_supported,
      default_mode: m.default_mode,
    })),
  });
});

module.exports = router;
