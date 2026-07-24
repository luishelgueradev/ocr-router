const Bottleneck = require('bottleneck');
const jobs = require('./jobs');
const { runOCR } = require('../ocr');
const { mapErrorCode } = require('./errors');
const logger = require('../logger');
const { intFromEnv } = require('./env');
const CONFIG = require('./cascade/config');
const { computeConfidence, passesThreshold } = require('./cascade/heuristic');
const { newTrace, recordAttempt, finalizeTrace } = require('./cascade/trace');
const { runCascade } = require('./cascade/runner');
const { runPipeline } = require('./input/page-pipeline');
const { createJobTempDir, cleanupJobTempDir } = require('./input/temp');
const clock = require('../clock');
const { CAPS } = require('./input/caps');
const { runStructured } = require('./structured/extract');
const { structuredImageSupport } = require('./structured/input-support');
const { normalizeFrames } = require('./input/image-normalize');

// D-06/D-10 — sniffed types that need the multi-page input pipeline (PDF native+
// scanned, TIFF/HEIC/BMP/GIF). png/jpeg/webp stay on the unchanged Phase-1/2
// single-image path (runForced/runCascadeJob).
const INPUT_FORMATS = new Set([
  'application/pdf',
  'image/tiff',
  'image/heic',
  'image/bmp',
  'image/gif',
]);

// With maxConcurrent:1 the queue — not the worker — is the dominant memory
// consumer: each queued job retains its full image buffer. Bound queue depth so
// MAX_QUEUE_DEPTH * MAX_UPLOAD_BYTES stays within the VPS memory budget.
// WR-07 fix — intFromEnv validates at boot; see lib/v1/env.js.
const MAX_QUEUE_DEPTH = intFromEnv('MAX_QUEUE_DEPTH', 10);

const limiter = new Bottleneck({
  maxConcurrent: 1,
  highWater: MAX_QUEUE_DEPTH,
  strategy: Bottleneck.strategy.OVERFLOW,
});

// Resolve a request profile to a known profile name via an Object.hasOwn
// allowlist (Pitfall 5 / T-02-13) — an unknown/hostile key falls back to the
// default (balanced) rather than reaching the prototype chain.
function resolveProfileName(profile) {
  return typeof profile === 'string' && Object.hasOwn(CONFIG.profiles, profile)
    ? profile
    : CONFIG.defaultProfile;
}

// D-07 FORCED bypass: the client forced a specific engine → run exactly that
// engine once, score its text, record a one-element trace, and NEVER escalate.
// Logging is byte-identical to the Phase-1 single-engine worker (OBSV-03/05).
async function runForced(jobId, { model, buffer, mimeType, mode, apiKey, preset, profile }, jobLogger) {
  jobLogger.info({ model: model.id, provider: model.provider, mode, bytes_received: buffer.length }, 'job start');
  // WR-02 — the forced path gets the SAME single authoritative job deadline as the
  // cascade (JOB-04): a hung forced provider must not block the concurrency-1 worker
  // for the full provider backstop. Budget resolves from the effective profile.
  const profileName = resolveProfileName(profile);
  const budgetMs = CONFIG.profiles[profileName].budgetMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  if (timer.unref) timer.unref();
  try {
    const base64 = buffer.toString('base64');
    const opts = {
      ...(preset?.options ? { options: preset.options, prompt: preset.prompt } : {}),
      signal: controller.signal,
    };
    const result = await runOCR(model, base64, mimeType, apiKey, opts);
    // IN-01 — ocr.space "all pages failed" (ocrExitCode:3) is a hard failure even
    // behind ok:true, matching the cascade contract for the same provider result.
    const allPagesFailed = result.ok && result.ocrExitCode === 3;
    if (result.ok && !allPagesFailed) {
      // Confidence is a COMPUTED number on the winning path (updates the one
      // Phase-1 assertion that expected null). A forced engine is judged against
      // the resolved profile threshold for the low_confidence flag, but it is
      // NEVER escalated — exactly one attempt (D-07).
      const confidence = computeConfidence(result.text, { overlay: result.overlay });
      const passed = passesThreshold(confidence, profileName);
      const trace = newTrace({ profile: profileName, budgetMs: null });
      recordAttempt(trace, {
        engine: model.id, provider: model.provider,
        outcome: passed ? 'passed' : 'low_confidence',
        confidence, timeMs: result.timeMs, error: null,
      });
      finalizeTrace(trace, {
        winningEngine: model.id, lowConfidence: !passed,
        stoppedReason: 'forced', elapsedMs: result.timeMs,
      });
      // D-04 page-aware envelope (single image ⇒ one page) — additive only:
      // pages[0].confidence is now populated, plus a `trace` + `low_confidence`.
      const pages = [{ page: 1, text: result.text, engine: model.id, confidence }];
      jobs.complete(jobId, {
        text: pages.map(p => p.text).join('\n\n'),
        pages,
        engine: model.id,
        provider: model.provider,
        mode,
        bytes_received: buffer.length,
        trace,
        low_confidence: trace.low_confidence,
      });
      jobLogger.info({ model: model.id, provider: model.provider, mode, bytes_received: buffer.length, latency_ms: result.timeMs }, 'job complete');
    } else {
      const errorInfo = allPagesFailed
        ? { code: 'ocr_all_pages_failed', message: 'OCR falló en todas las páginas' }
        : mapErrorCode(result);
      jobs.fail(jobId, errorInfo);
      jobLogger.error({ status: result.status, errorCode: errorInfo.code, message: errorInfo.message }, 'job failed');
    }
  } catch (e) {
    jobs.fail(jobId, { code: 'internal_error', message: 'unexpected' });
    jobLogger.error({ errorCode: 'internal_error' }, 'job crashed');
  } finally {
    clearTimeout(timer);
  }
}

// D-11 CASCADE path: no engine forced → walk the profile chain via runCascade,
// bounded by ONE authoritative job deadline (JOB-04). Assemble the UNCHANGED
// page-aware envelope from the winner and attach the JOB-02 trace additively.
async function runCascadeJob(jobId, { buffer, mimeType, mode, profile }, jobLogger) {
  const profileName = resolveProfileName(profile);
  const budgetMs = CONFIG.profiles[profileName].budgetMs;
  jobLogger.info({ profile: profileName, mode, bytes_received: buffer.length }, 'job start');

  // Single authoritative deadline for the whole cascade (JOB-04). The timer is
  // unref'd so it never keeps the process alive; cleared in finally.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  if (timer.unref) timer.unref();
  try {
    const base64 = buffer.toString('base64');
    const { result, trace } = await runCascade({
      base64, mimeType, profile: profileName,
      deadlineSignal: controller.signal, budgetMs,
    });

    // Only zero-engines-configured is a hard failure (boot guard already
    // prevents it). Every other outcome — including all-fail — returns the
    // best-so-far and SUCCEEDS: the product never loses work (CASC-04).
    if (result.error) {
      jobs.fail(jobId, { code: result.error, message: 'No hay ningún motor OCR configurado' });
      jobLogger.error({ errorCode: result.error }, 'job failed');
      return;
    }

    const pages = [{ page: 1, text: result.text, engine: result.engineId, confidence: result.confidence }];
    jobs.complete(jobId, {
      text: pages.map(p => p.text).join('\n\n'),
      pages,
      engine: result.engineId,
      provider: result.provider,
      mode,
      bytes_received: buffer.length,
      trace,
      low_confidence: trace.low_confidence,
    });
    jobLogger.info({
      winning_engine: trace.winning_engine,
      provider: result.provider,
      low_confidence: trace.low_confidence,
      mode,
      bytes_received: buffer.length,
      elapsed_ms: trace.elapsed_ms,
    }, 'job complete');
  } catch (e) {
    jobs.fail(jobId, { code: 'internal_error', message: 'unexpected' });
    jobLogger.error({ errorCode: 'internal_error' }, 'job crashed');
  } finally {
    clearTimeout(timer);
  }
}

// D-11 CASCADE per-page router: walk the profile chain for one page image,
// drawing its per-page budget from the REMAINING whole-job deadline (Pattern 5 /
// JOB-04). Returns the shape the pipeline records per page (engine/provider/
// confidence + the cascade trace).
function makeCascadeRoutePage({ profileName, controller, deadline }) {
  return async (pageBase64, mimeType) => {
    // WR-02 — clamp, and fail the page LOUDLY once the job deadline is spent.
    // An unclamped `deadline - now` goes NEGATIVE after MAX_JOB_MS, which
    // made runCascade's `remaining <= minSliceMs` break on the first iteration
    // and return {text:'', engineId:null, ...} with NO error field. The pipeline
    // then recorded that as a SUCCESSFUL page, so a job whose deadline blew
    // halfway through N pages reported status_rollup 'completed' with silently
    // missing content and no signal to the client.
    // Floored: a monotonic reading is fractional, and this value becomes a
    // budget that is reported in traces and turned into timer delays downstream.
    // Flooring also makes a sub-millisecond remainder read as spent, which is
    // what it is.
    const remaining = Math.max(0, Math.floor(deadline - clock.monotonicMs()));
    if (remaining === 0) {
      const err = new Error('job deadline exceeded before this page could be routed');
      err.code = 'job_deadline_exceeded';
      throw err; // recorded as a per-page error (INP-06)
    }
    const { result, trace } = await runCascade({
      base64: pageBase64,
      mimeType,
      profile: profileName,
      deadlineSignal: controller.signal,
      budgetMs: remaining,
    });
    return {
      text: result.text,
      engineId: result.engineId,
      provider: result.provider,
      confidence: result.confidence,
      trace,
    };
  };
}

// D-07 FORCED per-page router: run exactly the forced engine once per page (no
// escalation), reusing the runForced scoring/confidence approach. A hard failure
// THROWS so the pipeline records it as a per-page error (INP-06) — one bad page
// never fails the whole job.
function makeForcedRoutePage({ model, apiKey, preset, profileName, controller }) {
  return async (pageBase64, mimeType) => {
    const opts = {
      ...(preset?.options ? { options: preset.options, prompt: preset.prompt } : {}),
      signal: controller.signal,
    };
    const result = await runOCR(model, pageBase64, mimeType, apiKey, opts);
    const allPagesFailed = result.ok && result.ocrExitCode === 3;
    if (!result.ok || allPagesFailed) {
      const info = allPagesFailed
        ? { code: 'ocr_all_pages_failed', message: 'OCR falló en todas las páginas' }
        : mapErrorCode(result);
      const err = new Error(info.message || 'forced_engine_failed');
      err.code = info.code;
      throw err;
    }
    const confidence = computeConfidence(result.text, { overlay: result.overlay });
    const passed = passesThreshold(confidence, profileName);
    return {
      text: result.text,
      engineId: model.id,
      provider: model.provider,
      confidence,
      trace: { low_confidence: !passed },
    };
  };
}

// D-08/D-10/Pattern 5 — the multi-page INPUT job branch. Owns ONE authoritative
// job deadline (CAPS.MAX_JOB_MS) bounding rasterization AND every per-page
// cascade together, plus a per-job temp dir that is ALWAYS cleaned (success |
// typed failure | crash). Builds the routePage closure from the forced/cascade
// decision and delegates ordering + rollup to the page-pipeline. runForced and
// runCascadeJob are intentionally left untouched (single-image path unchanged).
async function runInputJob(jobId, { buffer, sniffedType, mode, profile, model, forced, apiKey, preset }, jobLogger, spawnFn) {
  const profileName = resolveProfileName(profile);
  jobLogger.info({ profile: profileName, mode, bytes_received: buffer.length }, 'job start');

  // One deadline for the whole job (raster + all pages). Unref'd so it never
  // keeps the process alive; cleared in finally.
  const controller = new AbortController();
  const deadline = clock.monotonicMs() + CAPS.MAX_JOB_MS;
  const timer = setTimeout(() => controller.abort(), CAPS.MAX_JOB_MS);
  if (timer.unref) timer.unref();

  let tempDir = null;
  try {
    tempDir = await createJobTempDir();

    const isForced = forced === true || model != null;
    const routePage = isForced
      ? makeForcedRoutePage({ model, apiKey, preset, profileName, controller })
      : makeCascadeRoutePage({ profileName, controller, deadline });

    const out = await runPipeline({
      buffer,
      sniffedType,
      profile: profileName,
      signal: controller.signal,
      tempDir,
      routePage,
      spawnFn,
    });

    jobs.complete(jobId, {
      text: out.text,
      pages: out.pages,
      status_rollup: out.status_rollup,
      engine: out.engine,
      provider: out.provider,
      mode,
      bytes_received: buffer.length,
      trace: out.trace,
      low_confidence: out.low_confidence,
    });
    jobLogger.info({
      winning_engine: out.trace.winning_engine,
      provider: out.provider,
      low_confidence: out.low_confidence,
      status_rollup: out.status_rollup,
      mode,
      bytes_received: buffer.length,
      elapsed_ms: out.trace.elapsed_ms,
    }, 'job complete');
  } catch (e) {
    // A pre-raster page-count cap (T-03-15) is a typed CLIENT failure (413/422),
    // not a crash — surface its code. Everything else is an internal_error whose
    // detail is NEVER logged (OPS-05). The temp dir is cleaned either way.
    if (e && (e.code === 'pdf_too_many_pages' || e.status === 413 || e.status === 422)) {
      const errorInfo = { code: e.code || 'invalid_parameter', message: e.message || 'input rejected' };
      jobs.fail(jobId, errorInfo);
      jobLogger.error({ status: e.status, errorCode: errorInfo.code, message: errorInfo.message }, 'job failed');
    } else {
      jobs.fail(jobId, { code: 'internal_error', message: 'unexpected' });
      jobLogger.error({ errorCode: 'internal_error' }, 'job crashed');
    }
  } finally {
    clearTimeout(timer);
    // WR-07 — temp cleanup is BEST-EFFORT and must never become the job's
    // outcome. An unguarded await here means an fs.rm rejection (EBUSY, EPERM,
    // EACCES on a bind-mounted or read-only /tmp) propagates OUT of the finally,
    // REPLACING whatever the try/catch produced: a job that had already
    // completed successfully would surface as `worker crashed` →
    // jobs.fail(internal_error). Everywhere else in the codebase (shutdown.js)
    // wraps its drain for exactly this reason; this call site was the exception.
    if (tempDir) {
      try {
        await cleanupJobTempDir(tempDir);
      } catch (e) {
        jobLogger.error({ message: e && e.message }, 'temp_cleanup_failed');
      }
    }
  }
}

// STR-01/02/03 — the structured-extraction branch. A dedicated path (NOT the
// cascade): resolve one vision-ready image (png/jpeg/webp direct; heic/bmp
// normalized to a single PNG frame via the Phase-3 pipeline), run structured
// extraction (constrained decode + ajv-validate + one repair + fall-through),
// and complete with an additive `structured` envelope. A typed extraction
// failure fails the job typed; never returns unvalidated JSON.
async function runStructuredJob(jobId, { model, buffer, mimeType, validate, apiKey, profile, forced }, jobLogger) {
  jobLogger.info({ mode: 'structured', profile: resolveProfileName(profile), bytes_received: buffer.length }, 'job start');

  const profileName = resolveProfileName(profile);
  const budgetMs = CONFIG.profiles[profileName].budgetMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  if (timer.unref) timer.unref();

  try {
    // Resolve the base64 image. The router already gated the sniffed type to a
    // structured-supported one, so support is 'direct' or 'normalize' here.
    let base64;
    if (structuredImageSupport(mimeType) === 'normalize') {
      // heic/bmp → one normalized PNG frame (reuses INP-05/INP-07 guards).
      let frame = null;
      for await (const png of normalizeFrames(buffer, mimeType)) { frame = png; break; }
      if (!frame) {
        jobs.fail(jobId, { code: 'image_decode_failed', message: 'No se pudo normalizar la imagen' });
        jobLogger.error({ errorCode: 'image_decode_failed' }, 'job failed');
        return;
      }
      base64 = frame.toString('base64');
    } else {
      base64 = buffer.toString('base64');
    }

    const out = await runStructured({
      base64,
      mimeType: 'image/png',
      profile: profileName,
      validate,
      deadlineSignal: controller.signal,
      model: forced ? model : null,
      apiKey: forced ? apiKey : null,
    });

    jobs.complete(jobId, {
      structured: out.structured,
      engine: out.engineId,
      provider: out.provider,
      mode: 'structured',
      bytes_received: buffer.length,
    });
    jobLogger.info(
      { mode: 'structured', engine: out.engineId, provider: out.provider, bytes_received: buffer.length, latency_ms: out.elapsedMs },
      'job complete',
    );
  } catch (e) {
    // Typed decoder/extraction errors (413/422) surface as themselves; anything
    // else is a generic internal_error (OPS-05 — no detail leaked to the client).
    if (e && (e.status === 413 || e.status === 422) && e.code) {
      jobs.fail(jobId, { code: e.code, message: e.message });
      jobLogger.error({ status: e.status, errorCode: e.code }, 'job failed');
    } else {
      jobs.fail(jobId, { code: 'internal_error', message: 'unexpected' });
      jobLogger.error({ errorCode: 'internal_error' }, 'job crashed');
    }
  } finally {
    clearTimeout(timer);
  }
}

async function runJob(jobId, { model, buffer, mimeType, mode, apiKey, preset, requestId, profile, forced, spawnFn, validate }) {
  // Defense in depth for the shutdown race: if drainAndCancel already finalized
  // this job (failed{shutdown_cancelled}), bottleneck.stop({dropWaitingJobs:true})
  // is the primary defense — but a queued job that bottleneck has already pulled
  // into its "executing" slot before stop() ran will still arrive here. Skip the
  // expensive provider call rather than emit a misleading "job complete" log
  // (jobs.complete is no-op on finalized; this prevents the log line altogether).
  const existing = jobs.get(jobId);
  if (!existing || existing.finalized) return;
  const jobLogger = logger.child({ job_id: jobId, request_id: requestId });
  jobs.setProcessing(jobId);

  // STR-01 — structured mode is its OWN path and must be checked BEFORE the
  // input-pipeline dispatch (a structured heic/bmp is normalized inside
  // runStructuredJob, not routed through the multi-page pipeline). The router
  // guarantees `validate` is present and the sniffed type is structured-supported
  // whenever mode==='structured'.
  if (mode === 'structured') {
    return runStructuredJob(jobId, { model, buffer, mimeType, validate, apiKey, profile, forced }, jobLogger);
  }

  // D-10 — a PDF or multi-format image (sniffed authoritatively) goes through the
  // multi-page input pipeline; png/jpeg/webp stay on the unchanged single-image
  // path below. (mimeType IS the sniffedType — router.js passes sniffedType here.)
  if (INPUT_FORMATS.has(mimeType)) {
    return runInputJob(jobId, { buffer, sniffedType: mimeType, mode, profile, model, forced, apiKey, preset }, jobLogger, spawnFn);
  }

  // Forced when the router flagged it OR when a concrete model is supplied
  // (the router passes no model on the cascade path).
  const isForced = forced === true || model != null;
  if (isForced) {
    return runForced(jobId, { model, buffer, mimeType, mode, apiKey, preset, profile }, jobLogger);
  }
  return runCascadeJob(jobId, { buffer, mimeType, mode, profile }, jobLogger);
}

module.exports = { runJob, runInputJob, runStructuredJob, limiter, MAX_QUEUE_DEPTH };
