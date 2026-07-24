const { LRUCache } = require('lru-cache');
const { intFromEnv } = require('./env');
const clock = require('../clock');

const JOB_TTL_MS = 60 * 60 * 1000;
// WR-07 fix — intFromEnv validates the env var at boot. Previously
// `Number('not-a-number') || 500` silently downgraded a typo to the default
// with no log line. intFromEnv throws a clear error on a non-integer, on
// non-positive values, and falls back to the documented default only when
// the var is unset/empty.
const JOB_MAX = intFromEnv('JOB_STORE_MAX', 500);

const store = new LRUCache({ max: JOB_MAX, ttl: JOB_TTL_MS, ttlAutopurge: true });

function nowIso() {
  return new Date().toISOString();
}

// Count only non-terminal jobs (queued/processing) against the cap. Terminal
// `succeeded`/`failed` records are retained for the TTL for polling but hold no
// image buffer (buffers live only in the worker queue closure, bounded
// separately by MAX_QUEUE_DEPTH). Counting terminal records here produced
// spurious 503 `server_busy` once JOB_STORE_MAX terminal jobs accumulated within
// the TTL window even while the worker sat idle — a false availability failure
// that contradicts the "never fail to return" core value. (Code review HR-02.)
function activeCount() {
  let n = 0;
  for (const j of store.values()) if (!j.finalized) n++;
  return n;
}

function create(jobId, meta) {
  if (activeCount() >= JOB_MAX) return { full: true };
  const created_at = nowIso();
  // WALL clock on purpose, and the only place in the service that should use it
  // for arithmetic: `expires_at` is an absolute timestamp a CLIENT reads and
  // compares against its own civil time, so it must track civil time — including
  // across an NTP correction. Deadlines and durations use clock.monotonicMs()
  // instead; see lib/clock.js.
  const expires_at = new Date(clock.wallMs() + JOB_TTL_MS).toISOString();
  store.set(jobId, {
    job_id: jobId,
    status: 'queued',
    created_at,
    expires_at,
    ...meta,
  });
  return { full: false };
}

function get(id) {
  return store.get(id) || null;
}

function setProcessing(id) {
  const job = store.get(id);
  if (job) {
    job.status = 'processing';
    job.started_at = nowIso();
  }
}

// WR-04 fix — once a job reaches a terminal state (succeeded or failed) it is
// marked `finalized: true` and subsequent complete()/fail() calls become no-ops.
// This closes the shutdown race: `drainAndCancel` marks a processing job as
// `failed{shutdown_timeout}`, but the worker that owns that job is not aborted
// (axios receives no abort signal). If the worker's HTTP call resolves AFTER
// drainAndCancel returns, the old code would overwrite the shutdown status
// back to `succeeded`, making the poller see a "succeeded" job that no one
// promised would deliver and under-counting `timed_out` in shutdown_complete.
function complete(id, result) {
  const job = store.get(id);
  if (job && !job.finalized) {
    job.status = 'succeeded';
    job.completed_at = nowIso();
    job.result = result;
    job.finalized = true;
  }
}

function fail(id, error) {
  const job = store.get(id);
  if (job && !job.finalized) {
    job.status = 'failed';
    job.completed_at = nowIso();
    job.error = error;
    job.finalized = true;
  }
}

function iterateAll() {
  return store.values();   // lru-cache 11 Generator<V>; yields live job objects
}

// WR-08 — test-only escape hatch. Test 5 in test/shutdown.test.js (and any
// future test that inserts records into the real singleton) uses t.after()
// to call this helper, preventing leaked records from polluting subsequent
// tests that iterate the store.
function _clearForTest() {
  store.clear();
}

module.exports = { create, get, setProcessing, complete, fail, iterateAll, _clearForTest, JOB_MAX };
