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
const CONFIG = require('./cascade/config');

const router = express.Router();

// Human-readable profile descriptions for GET /v1/models profiles discovery
// (D-06 / API-05). Kept beside the router — thresholds stay INTERNAL to the
// heuristic and are deliberately never projected (T-02-15).
const PROFILE_DESCRIPTIONS = {
  fast: 'Cadena corta y económica: se detiene pronto (ocr.space → gemini).',
  balanced: 'Predeterminado: escala hasta gemma para un buen equilibrio calidad/coste.',
  quality: 'Cadena completa hasta qwen3-vl-235b para la máxima calidad.',
};

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
        message: 'El archivo no es un documento admitido (PNG, JPEG, WebP, PDF, TIFF, HEIC, BMP o GIF)',
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
        message: 'El archivo no es un documento admitido (PNG, JPEG, WebP, PDF, TIFF, HEIC, BMP o GIF)',
      });
    }

    const { model: modelId, mode: requestedMode, profile: rawProfile } = req.body || {};

    // D-06 — resolve the profile via an Object.hasOwn ALLOWLIST (prototype-
    // pollution guard, T-02-13). Absent ⇒ default (balanced); a supplied-but-
    // unknown profile (incl. '__proto__'/'constructor') ⇒ typed 422.
    let profile;
    if (rawProfile === undefined || rawProfile === null || rawProfile === '') {
      profile = CONFIG.defaultProfile;
    } else if (typeof rawProfile === 'string' && Object.hasOwn(CONFIG.profiles, rawProfile)) {
      profile = rawProfile;
    } else {
      return res.status(422).json({
        error: 'invalid_parameter',
        field: 'profile',
        message: `Perfil desconocido. Perfiles válidos: ${Object.keys(CONFIG.profiles).join(', ')}`,
      });
    }

    // D-07 — `model` is optional. FORCED path: an explicit model bypasses the
    // cascade (single attempt). CASCADE path: an omitted model walks the profile
    // chain (the worker/runner assembles it, dropping missing-key tiers — do NOT
    // pre-resolve a single default engine here, per CASC-07).
    let model = null;
    let mode;
    let preset = null;
    let apiKey = null;
    const forced = Boolean(modelId);

    if (forced) {
      model = findModel(modelId);
      if (!model) {
        return res.status(422).json({
          error: 'invalid_parameter',
          field: 'model',
          message: 'Use GET /v1/models para ver modelos válidos',
        });
      }

      // Capability allowlist (D-07 / CASC-06). Reject a forced engine that is
      // not in the capability table via Object.hasOwn — never bare-index config
      // with untrusted input (Pitfall 5 / T-02-13). Mode support is validated
      // separately by resolveMode below; this gate is the pre-enqueue capability
      // check that a future structured-only requirement would also fail closed.
      if (!Object.hasOwn(CONFIG.capabilities, model.id)) {
        return res.status(422).json({
          error: 'invalid_parameter',
          field: 'model',
          message: `El motor ${model.id} no admite esta solicitud. Use GET /v1/models.`,
        });
      }

      const modeResult = resolveMode(model, requestedMode);
      if (modeResult.error) {
        return res.status(422).json({
          error: 'invalid_parameter',
          field: 'mode',
          message: `Modo no soportado por ${model.id}. Modos válidos: ${model.modes_supported.join(', ')}`,
        });
      }
      mode = modeResult.mode;
      preset = modeResult.preset;
      apiKey = envKeyFor(model.provider);

      // Fail closed when a client-forced model's provider has no configured API
      // key — otherwise the job would be enqueued (wasting a bounded queue slot)
      // and run with `Authorization: Bearer null` (HR-01).
      if (!apiKey) {
        return res.status(422).json({
          error: 'invalid_parameter',
          field: 'model',
          message: `El motor ${model.id} no está configurado (falta su API key). Use GET /v1/models.`,
        });
      }
    } else {
      // Cascade path — mode is informational on the envelope (per-engine presets
      // are handled inside the runner); record the requested mode or 'quality'.
      mode = (typeof requestedMode === 'string' && requestedMode) ? requestedMode.toLowerCase() : 'quality';
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
    const createResult = jobs.create(jobId, { model_id: model ? model.id : `cascade:${profile}` });
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
      forced,
      profile,
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
    // API-05 profiles discovery (D-06): advertise the named profiles and their
    // chain engine ids ONLY — the confidence thresholds stay internal (T-02-15,
    // REQUIREMENTS out-of-scope), so no `threshold` field is ever projected.
    profiles: Object.keys(CONFIG.profiles).map(id => ({
      id,
      default: id === CONFIG.defaultProfile,
      description: PROFILE_DESCRIPTIONS[id] || '',
      engines: CONFIG.profiles[id].chain,
    })),
  });
});

module.exports = router;
