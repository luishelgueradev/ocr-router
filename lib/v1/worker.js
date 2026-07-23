const Bottleneck = require('bottleneck');
const jobs = require('./jobs');
const { runOCR } = require('../ocr');
const { mapErrorCode } = require('./errors');
const logger = require('../logger');
const { intFromEnv } = require('./env');

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

async function runJob(jobId, { model, buffer, mimeType, mode, apiKey, preset, requestId }) {
  // Defense in depth for the shutdown race: if drainAndCancel already finalized
  // this job (failed{shutdown_cancelled}), bottleneck.stop({dropWaitingJobs:true})
  // is the primary defense — but a queued job that bottleneck has already pulled
  // into its "executing" slot before stop() ran will still arrive here. Skip the
  // expensive provider call rather than emit a misleading "job complete" log
  // (jobs.complete is no-op on finalized; this prevents the log line altogether).
  const existing = jobs.get(jobId);
  if (!existing || existing.finalized) return;
  const jobLogger = logger.child({ job_id: jobId, request_id: requestId });
  const start = Date.now();
  jobs.setProcessing(jobId);
  jobLogger.info({ model: model.id, provider: model.provider, mode, bytes_received: buffer.length }, 'job start');
  try {
    const base64 = buffer.toString('base64');
    const opts = preset?.options ? { options: preset.options, prompt: preset.prompt } : undefined;
    const result = await runOCR(model, base64, mimeType, apiKey, opts);
    if (result.ok) {
      // D-04 page-aware envelope (single image ⇒ one page). Written join-ready
      // so multi-page (Phase 3) is additive: top-level text === pages joined by
      // '\n\n', which for one page equals pages[0].text (Pitfall 3).
      const pages = [{ page: 1, text: result.text, engine: model.id, confidence: null }];
      jobs.complete(jobId, {
        text: pages.map(p => p.text).join('\n\n'),
        pages,
        // D-05 job-level trace stub (kept alongside the envelope):
        engine: model.id,
        provider: model.provider,
        mode,
        bytes_received: buffer.length,
      });
      jobLogger.info({ model: model.id, provider: model.provider, mode, bytes_received: buffer.length, latency_ms: result.timeMs }, 'job complete');
    } else {
      const errorInfo = mapErrorCode(result);
      jobs.fail(jobId, errorInfo);
      jobLogger.error({ status: result.status, errorCode: errorInfo.code, message: errorInfo.message }, 'job failed');
    }
  } catch (e) {
    jobs.fail(jobId, { code: 'internal_error', message: 'unexpected' });
    jobLogger.error({ errorCode: 'internal_error' }, 'job crashed');
  }
}

module.exports = { runJob, limiter, MAX_QUEUE_DEPTH };
