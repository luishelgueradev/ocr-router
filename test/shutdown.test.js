// Private temp root for THIS test process — node --test runs files in
// parallel and temp.js's orphan sweep is global to os.tmpdir(). Must come
// before anything that creates or sweeps a temp dir. See the helper.
require('./helpers/isolated-tmp');
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

// CR-04 — ORDERING. The old code drained temp dirs as the FIRST step of
// drainAndCancel, which deleted the in-flight job's input.pdf out from under a
// running pdftoppm at t=0 while the drain was still politely waiting 35 s for
// that same job. The test above passes either way (it only checks the dir is
// eventually gone), so the ordering needs its own assertion.
test('drainAndCancel: temp dirs are drained AFTER the job drain, never before (CR-04)', async (t) => {
  const { drainAndCancel } = freshShutdown();
  const { store, fakeJobs } = buildFakeJobs();

  const order = [];
  const fakeLimiter = {
    stop: async () => {
      // Model an in-flight job that is still working while the limiter drains.
      await new Promise((r) => setTimeout(r, 20));
      order.push('jobs_drained');
    },
  };
  const fakeTemp = {
    drainAllTempDirs: async () => { order.push('temp_drained'); return 0; },
  };

  store.set('jorder', { job_id: 'jorder', status: 'queued' });

  await drainAndCancel(5000, { jobs: fakeJobs, limiter: fakeLimiter, temp: fakeTemp });

  assert.deepEqual(
    order, ['jobs_drained', 'temp_drained'],
    'in-flight work must finish before its temp dir is deleted',
  );
});

// CR-04 (second half) — the leak the old ordering left open: a temp dir created
// DURING the drain window (by the job bottleneck promoted into the executing
// slot) was registered after the snapshot had already been taken, so it was
// never drained. Draining after the job drain closes that window.
test('drainAndCancel: a temp dir created during the drain window is still removed (CR-04)', async (t) => {
  const { drainAndCancel } = freshShutdown();
  const { store, fakeJobs } = buildFakeJobs();
  t.after(() => temp.drainAllTempDirs());

  let lateDir = null;
  const fakeLimiter = {
    stop: async () => {
      // A job promoted into the executing slot registers its temp dir here —
      // i.e. AFTER shutdown began.
      lateDir = await temp.createJobTempDir();
      fs.writeFileSync(require('node:path').join(lateDir, 'input.pdf'), 'x');
    },
  };

  store.set('jlate', { job_id: 'jlate', status: 'queued' });
  await drainAndCancel(5000, { jobs: fakeJobs, limiter: fakeLimiter });

  assert.ok(lateDir, 'the late job registered a temp dir');
  assert.ok(!fs.existsSync(lateDir), 'a dir created during the drain window must NOT leak');
});

// WR-06 — a fast drain must not leave the grace-window timer armed. An unref'd
// timer cannot hold the event loop, so assert the handle is dead after the race.
test('drainAndCancel: the grace-window timer is cleared once the drain wins (WR-06)', async () => {
  const { drainAndCancel } = freshShutdown();
  const { store, fakeJobs } = buildFakeJobs();
  const fakeLimiter = { stop: async () => {} };
  const fakeTemp = { drainAllTempDirs: async () => 0 };

  const armed = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...rest) => {
    const t = realSetTimeout(fn, ms, ...rest);
    armed.push({ ms, t });
    return t;
  };

  try {
    store.set('jfast', { job_id: 'jfast', status: 'queued' });
    await drainAndCancel(35000, { jobs: fakeJobs, limiter: fakeLimiter, temp: fakeTemp });
  } finally {
    global.setTimeout = realSetTimeout;
  }

  const grace = armed.find((a) => a.ms === 35000);
  assert.ok(grace, 'the 35s grace timer was armed');
  // A cleared Node timeout is destroyed; a still-pending one is not. Without the
  // clearTimeout this handle stayed on the loop and delayed exit by ~35s.
  assert.equal(grace.t._destroyed, true, 'grace timer was cleared, not left pending for 35s');
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
