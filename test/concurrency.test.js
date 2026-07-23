const { test } = require('node:test');
const assert = require('node:assert/strict');
const { limiter } = require('../lib/v1/worker');

// ASYNC-03 — Bottleneck enforces maxConcurrent:1 on Ollama calls.
// The integration test (real Ollama latency) lives in 01-VERIFICATION.md
// human_verification block 2. Here we assert the in-process invariant: only
// one task runs at a time even when two are scheduled back-to-back.

test('ASYNC-03: limiter.counts() returns the documented shape', () => {
  const counts = limiter.counts();
  assert.ok('RUNNING' in counts, 'limiter.counts() must expose RUNNING');
  assert.ok('QUEUED' in counts, 'limiter.counts() must expose QUEUED');
});

test('ASYNC-03: maxConcurrent === 1 (only one Ollama call in flight)', () => {
  // Bottleneck stores config under _store.storeOptions in v2.x
  assert.equal(
    limiter._store.storeOptions.maxConcurrent,
    1,
    'ASYNC-03 requires Bottleneck maxConcurrent:1'
  );
});

test('ASYNC-03: two scheduled tasks serialize — second waits while first executes', async () => {
  let release1;
  const task1 = new Promise(r => { release1 = r; });

  // Schedule the first task — it should start and hold the slot.
  let task1Started = false;
  const p1 = limiter.schedule(async () => {
    task1Started = true;
    return task1;
  });

  // Wait long enough for bottleneck's internal scheduler to pull task1 into
  // EXECUTING. Bottleneck v2 has a ~5ms scheduling latency; 200ms is generous.
  for (let i = 0; i < 20 && !task1Started; i++) {
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(task1Started, true, `first task must have started; counts=${JSON.stringify(limiter.counts())}`);

  // Schedule a second task — it should NOT start while task1 holds the slot.
  let task2Started = false;
  const p2 = limiter.schedule(async () => {
    task2Started = true;
    return 'two';
  });

  // Allow ample event-loop ticks. With maxConcurrent:1, task2 cannot start.
  await new Promise(r => setTimeout(r, 50));

  assert.equal(
    task2Started,
    false,
    'second task must NOT start while first holds the slot (ASYNC-03 maxConcurrent:1)'
  );

  // Bottleneck's counts: while the callback runs it's tracked in EXECUTING
  // (not RUNNING). RUNNING + EXECUTING together must be exactly 1.
  const counts = limiter.counts();
  const inFlight = (counts.RUNNING || 0) + (counts.EXECUTING || 0);
  assert.equal(inFlight, 1, `exactly one task in flight; counts=${JSON.stringify(counts)}`);

  // Release task1 and verify task2 then completes.
  release1('one');
  const r1 = await p1;
  const r2 = await p2;
  assert.equal(r1, 'one');
  assert.equal(r2, 'two');
  assert.equal(task2Started, true, 'second task must run after first completes');
});
