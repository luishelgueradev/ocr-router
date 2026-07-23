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

async function runJob(jobId, { model, buffer, mimeType, mode, apiKey, preset, requestId, profile, forced }) {
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

  // Forced when the router flagged it OR when a concrete model is supplied
  // (the router passes no model on the cascade path).
  const isForced = forced === true || model != null;
  if (isForced) {
    return runForced(jobId, { model, buffer, mimeType, mode, apiKey, preset, profile }, jobLogger);
  }
  return runCascadeJob(jobId, { buffer, mimeType, mode, profile }, jobLogger);
}

module.exports = { runJob, limiter, MAX_QUEUE_DEPTH };
