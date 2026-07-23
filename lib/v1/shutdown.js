const logger = require('../logger');
// jobs and limiter are resolved inside drainAndCancel via the deps arg (default → real modules)

// WR-05 fix — replace the module-scoped `inProgress` boolean (which never reset
// and turned every subsequent drainAndCancel call into a silent no-op for the
// remainder of the process) with an in-flight Promise. Concurrent SIGTERMs
// (Docker quirk) still de-dupe to a single drain because they get back the
// SAME promise; once the drain settles, `pending` is cleared and a future call
// is allowed again. This also obviates the require-cache gymnastics in
// test/shutdown.test.js (freshShutdown helper) for future test authors.
let pending = null;

function drainAndCancel(timeoutMs = 35000, deps = {}) {
  if (pending) {
    logger.info({}, 'shutdown_already_in_progress');
    return pending;
  }
  pending = (async () => {
    try {
      const jobs    = deps.jobs    || require('./jobs');
      const limiter = deps.limiter || require('./worker').limiter;

      const start = Date.now();
      logger.info({ timeoutMs }, 'shutdown_started');

      try {
        // First pass: mark queued as failed{shutdown_cancelled}; remember processing ids for the timeout branch.
        const cancelled = [];
        const processingIds = [];
        for (const job of jobs.iterateAll()) {
          if (job.status === 'queued') {
            jobs.fail(job.job_id, { code: 'shutdown_cancelled', message: 'Server shutting down' });
            cancelled.push(job.job_id);
          } else if (job.status === 'processing') {
            processingIds.push(job.job_id);
          }
        }
        logger.info({ count: cancelled.length }, 'shutdown_queued_cancelled');

        // Race the bottleneck drain against a hard timeout.
        // `dropWaitingJobs: true` (bottleneck's default) — we already failed every
        // queued job above with `shutdown_cancelled`, so letting bottleneck still
        // pull them into the worker would waste a paid Ollama call AND emit a
        // misleading "job complete" log (worker logs unconditionally; jobs.complete
        // is no-op on finalized jobs but the log line still fires). The worker has
        // a finalized-guard early-return as defense in depth for the race window
        // where bottleneck has already promoted a queued job before stop() ran.
        const stopPromise = limiter.stop({ dropWaitingJobs: true, enqueueErrorMessage: 'Server shutting down' }).then(() => 'drained');
        const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs));
        const winner = await Promise.race([stopPromise, timeoutPromise]);

        if (winner === 'timeout') {
          for (const id of processingIds) {
            const j = jobs.get(id);
            if (j && j.status === 'processing') {
              jobs.fail(id, { code: 'shutdown_timeout', message: 'In-flight inference exceeded grace window' });
            }
          }
          logger.info({ timed_out: processingIds.length }, 'shutdown_timeout_hit');
        }

        logger.info(
          { duration_ms: Date.now() - start, cancelled: cancelled.length, drained: winner === 'drained' },
          'shutdown_complete'
        );
      } catch (e) {
        logger.error({ message: e && e.message }, 'shutdown_error');
      }
    } finally {
      pending = null;
    }
  })();
  return pending;
}

module.exports = { drainAndCancel };
