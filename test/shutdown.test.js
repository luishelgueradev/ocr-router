const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const jobs = require('../lib/v1/jobs');
const temp = require('../lib/v1/input/temp');

// require.cache delete works ONLY while server.js is NOT imported by these tests; if E2E tests
// are added later that boot server.js, export a _resetIdempotency() helper from shutdown.js instead.
function freshShutdown() {
  delete require.cache[require.resolve('../lib/v1/shutdown.js')];
  return require('../lib/v1/shutdown');
}

function buildFakeJobs() {
  const store = new Map();
  const fakeJobs = {
    iterateAll: function* () {
      for (const j of store.values()) yield j;
    },
    get: (id) => store.get(id) || null,
    fail: (id, err) => {
      const j = store.get(id);
      if (j) {
        j.status = 'failed';
        j.error = err;
      }
    },
  };
  return { store, fakeJobs };
}

// Test 1: queued jobs become failed{shutdown_cancelled}
test('drainAndCancel: queued jobs become failed{shutdown_cancelled}', async () => {
  const { drainAndCancel } = freshShutdown();
  const { store, fakeJobs } = buildFakeJobs();
  const fakeLimiter = { stop: async () => {} };

  store.set('j1', { job_id: 'j1', status: 'queued' });

  await drainAndCancel(0, { jobs: fakeJobs, limiter: fakeLimiter });

  const j = store.get('j1');
  assert.equal(j.status, 'failed', 'queued job should be failed after drain');
  assert.equal(j.error.code, 'shutdown_cancelled', 'error.code should be shutdown_cancelled');
  assert.ok(j.error.message, 'error.message should be set');
});

// Test 2: succeeded (terminal) jobs are not touched (D-03)
test('drainAndCancel: succeeded jobs are not touched', async () => {
  const { drainAndCancel } = freshShutdown();
  const { store, fakeJobs } = buildFakeJobs();
  const fakeLimiter = { stop: async () => {} };

  store.set('jdone', { job_id: 'jdone', status: 'succeeded', result: { text: 'ok' } });

  await drainAndCancel(0, { jobs: fakeJobs, limiter: fakeLimiter });

  const j = store.get('jdone');
  assert.equal(j.status, 'succeeded', 'succeeded job stays succeeded');
  assert.equal(j.error, undefined, 'no error attached to a succeeded job');
});

// Test 3: timeout path — processing job becomes failed{shutdown_timeout}
// Uses INJECTED fake limiter so the real worker.limiter singleton is NEVER .stop()'d.
test('drainAndCancel: timeout path — processing job becomes failed{shutdown_timeout}', async () => {
  const { drainAndCancel } = freshShutdown();
  const { store, fakeJobs } = buildFakeJobs();
  // fake limiter that NEVER resolves → forces the Promise.race timeout branch
  const fakeLimiter = { stop: () => new Promise(() => {}) };

  store.set('jp', { job_id: 'jp', status: 'processing' });

  const start = Date.now();
  await drainAndCancel(50, { jobs: fakeJobs, limiter: fakeLimiter });
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 500, `drain should resolve within ~50-500ms, took ${elapsed}ms`);
  const j = store.get('jp');
  assert.equal(j.status, 'failed', 'processing job should be failed after timeout');
  assert.equal(j.error.code, 'shutdown_timeout', 'error.code should be shutdown_timeout');
});

// Regression: drainAndCancel MUST pass dropWaitingJobs:true to limiter.stop.
// Without this, bottleneck still drains queued jobs into the worker even after
// shutdown.js marked them failed{shutdown_cancelled} in the jobs store. The
// worker would then run a wasted Ollama call AND emit a misleading "job complete"
// log line (jobs.complete is no-op on finalized; worker logs unconditionally).
// See UAT-3 finding (Phase 3 human verification): observed shutdown_complete
// with duration_ms=12393 because bottleneck drained job2 instead of dropping it.
test('drainAndCancel: passes dropWaitingJobs:true to limiter.stop (UAT-3 regression)', async () => {
  const { drainAndCancel } = freshShutdown();
  const { store, fakeJobs } = buildFakeJobs();
  let stopOpts = null;
  const fakeLimiter = { stop: async (opts) => { stopOpts = opts; } };

  store.set('jq', { job_id: 'jq', status: 'queued' });

  await drainAndCancel(0, { jobs: fakeJobs, limiter: fakeLimiter });

  assert.ok(stopOpts, 'limiter.stop must be called');
  assert.equal(stopOpts.dropWaitingJobs, true, 'dropWaitingJobs MUST be true so bottleneck does not drain queued jobs into the worker');
});

// Test 4: idempotent — second concurrent call is a no-op on jobs state
test('drainAndCancel: idempotent — second concurrent call is a no-op', async () => {
  const { drainAndCancel } = freshShutdown();
  const { store, fakeJobs } = buildFakeJobs();
  const fakeLimiter = { stop: async () => {} };

  store.set('j1', { job_id: 'j1', status: 'queued' });

  // Two parallel calls — one wins, the other early-returns via the latch.
  await Promise.all([
    drainAndCancel(0, { jobs: fakeJobs, limiter: fakeLimiter }),
    drainAndCancel(0, { jobs: fakeJobs, limiter: fakeLimiter }),
  ]);

  const j = store.get('j1');
  assert.equal(j.status, 'failed');
  assert.equal(j.error.code, 'shutdown_cancelled');
});

// INP-08 / Pitfall 2 — mid-job SIGTERM must leak NO temp dir. drainAndCancel
// drains the temp-dir registry as part of its shutdown sequence, so a job that
// was rasterizing when SIGTERM arrived has its temp dir removed even though its
// own `finally` never ran. Also asserts the pre-existing job-drain behavior is
// unchanged (a queued job is still failed{shutdown_cancelled}).
test('drainAndCancel: drains registered temp dirs on mid-job SIGTERM (Pitfall 2)', async (t) => {
  const { drainAndCancel } = freshShutdown();
  const { store, fakeJobs } = buildFakeJobs();
  const fakeLimiter = { stop: async () => {} };
  t.after(() => temp.drainAllTempDirs());

  // Simulate a job caught mid-raster: it has a live temp dir on disk.
  const dir = await temp.createJobTempDir();
  fs.writeFileSync(require('node:path').join(dir, 'page-1.png'), 'x');
  assert.ok(fs.existsSync(dir), 'temp dir exists before shutdown');

  store.set('jmid', { job_id: 'jmid', status: 'queued' });

  await drainAndCancel(0, { jobs: fakeJobs, limiter: fakeLimiter });

  // Temp dir gone (no leak) AND existing drain semantics intact.
  assert.ok(!fs.existsSync(dir), 'temp dir removed by the shutdown drain');
  const j = store.get('jmid');
  assert.equal(j.status, 'failed', 'queued job still failed by the drain');
  assert.equal(j.error.code, 'shutdown_cancelled', 'existing shutdown_cancelled semantics unchanged');
});

// Test 5: iterateAll() yields live references in the real jobs module (I-02 acceptance)
// WR-08 fix — teardown via t.after() so the inserted record does NOT leak into
// subsequent tests that enumerate the real jobs store (TTL is 1h, so without
// this the leaked entry stays for the rest of the process lifetime).
test('jobs.iterateAll yields live references — mutation visible via jobs.get()', (t) => {
  const jobId = 'iter-test-' + Date.now();
  jobs.create(jobId, { model_id: 'test' });
  t.after(() => { if (jobs._clearForTest) jobs._clearForTest(); });

  let seen = false;
  for (const j of jobs.iterateAll()) {
    if (j.job_id === jobId) {
      seen = true;
      jobs.fail(jobId, { code: 'test', message: 'live-ref proof' });
      assert.equal(jobs.get(jobId).status, 'failed', 'mutation via fail() must be visible to get()');
      assert.equal(jobs.get(jobId).error.code, 'test');
    }
  }
  assert.ok(seen, 'iterateAll should yield the just-created job');
});
