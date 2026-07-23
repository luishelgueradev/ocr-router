const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnCapture } = require('../lib/v1/input/spawn-capture');

// INP-08 / D-11 — spawnCapture is the SINGLE injectable subprocess seam. Every
// poppler invocation funnels through it, and because poppler is Docker-only
// (D-11) these host tests NEVER spawn a real subprocess — they inject a fake
// `spawnFn` that returns an EventEmitter-based ChildProcess double. If any test
// here shells out for real, the seam has leaked.

// Fake ChildProcess: stdout/stderr are EventEmitters, kill() records the signals
// it was asked to send so we can assert the SIGTERM→SIGKILL escalation.
function makeFakeChild() {
  const cp = new EventEmitter();
  cp.stdout = new EventEmitter();
  cp.stderr = new EventEmitter();
  cp.killed = false;
  cp.killCalls = [];
  cp.kill = (sig) => {
    cp.killCalls.push(sig);
    cp.killed = true;
    return true;
  };
  return cp;
}

// Behavior: injected spawnFn returns a child that emits stdout then close(0) →
// resolves a Buffer whose toString() carries the captured output.
test('spawnCapture: resolves captured stdout Buffer on exit 0', async () => {
  const cp = makeFakeChild();
  const spawnFn = () => {
    queueMicrotask(() => {
      cp.stdout.emit('data', Buffer.from('Pages:   7\n'));
      cp.emit('close', 0, null);
    });
    return cp;
  };

  const out = await spawnCapture('pdfinfo', ['/x.pdf'], {
    spawnFn, ulimitKB: 1000, ulimitCpuSec: 5,
  });

  assert.ok(Buffer.isBuffer(out), 'resolves a Buffer');
  assert.match(out.toString(), /Pages:   7/);
});

// Behavior: the real invocation is wrapped as `/bin/sh -c '<body>'` where the
// body contains the ulimit caps AND `exec timeout -s KILL <n>s <cmd> <args>`.
// The `exec` is mandatory (Pitfall 4 — without it the signal hits the shell,
// not poppler, orphaning the child).
test('spawnCapture: wraps in /bin/sh -c with ulimit + exec timeout backstop', async () => {
  let captured = null;
  const cp = makeFakeChild();
  const spawnFn = (cmd, args, opts) => {
    captured = { cmd, args, opts };
    queueMicrotask(() => cp.emit('close', 0, null));
    return cp;
  };

  await spawnCapture('pdftoppm', ['-r', '200', 'x.pdf', '-'], {
    spawnFn, ulimitKB: 786432, ulimitCpuSec: 20, wallMs: 30000,
  });

  assert.equal(captured.cmd, '/bin/sh');
  assert.equal(captured.args[0], '-c');
  const body = captured.args[1];
  assert.match(body, /ulimit -v 786432/, 'address-space cap present (ulimit -v, NOT -m)');
  assert.match(body, /ulimit -t 20/, 'CPU-seconds cap present');
  assert.match(body, /exec timeout -s KILL 30s pdftoppm -r 200 x\.pdf -/, 'exec + timeout backstop present');
  assert.equal(captured.opts.killSignal, 'SIGTERM');
  assert.deepEqual(captured.opts.stdio, ['ignore', 'pipe', 'pipe']);
});

// Behavior: wallMs is rounded UP to whole seconds for timeout(1).
test('spawnCapture: rounds wallMs up to whole seconds for timeout', async () => {
  let body = null;
  const cp = makeFakeChild();
  const spawnFn = (cmd, args) => { body = args[1]; queueMicrotask(() => cp.emit('close', 0, null)); return cp; };
  await spawnCapture('pdfinfo', ['a'], { spawnFn, wallMs: 10500, ulimitKB: 1, ulimitCpuSec: 1 });
  assert.match(body, /timeout -s KILL 11s/, 'ceil(10500/1000) = 11');
});

// Behavior: non-zero exit rejects with an error carrying code + stderr string,
// and NOTHING else — no captured buffer, no key/secret fields leaked onto the
// rejection object.
test('spawnCapture: non-zero exit rejects with {code, stderr} and no buffer/key leak', async () => {
  const cp = makeFakeChild();
  const spawnFn = () => {
    queueMicrotask(() => {
      cp.stderr.emit('data', Buffer.from('Syntax Error: boom'));
      cp.emit('close', 1, null);
    });
    return cp;
  };

  await assert.rejects(
    spawnCapture('pdftoppm', [], { spawnFn }),
    (err) => {
      assert.equal(err.code, 1, 'carries exit code');
      assert.match(err.stderr, /boom/, 'carries stderr string');
      assert.equal(typeof err.stderr, 'string', 'stderr is a string, not a Buffer');
      // No buffer or key/secret fields anywhere on the rejection object.
      for (const [k, v] of Object.entries(err)) {
        assert.ok(!Buffer.isBuffer(v), `field ${k} must not be a Buffer`);
        assert.ok(!/key|token|secret|buffer/i.test(k), `field ${k} looks like a leak`);
      }
      return true;
    }
  );
});

// Behavior: an 'error' event (this is where an AbortError lands) rejects with
// that error AND clears the escalation timer so no stray SIGKILL fires later.
test('spawnCapture: error event rejects with the error and clears escalation timer', async () => {
  const cp = makeFakeChild();
  const controller = new AbortController();
  const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

  const spawnFn = () => {
    queueMicrotask(() => {
      controller.abort();                       // arms the escalation timer
      queueMicrotask(() => cp.emit('error', abortErr)); // then the child errors out
    });
    return cp;
  };

  await assert.rejects(
    spawnCapture('pdftoppm', [], { spawnFn, signal: controller.signal, killGraceMs: 20 }),
    (err) => { assert.equal(err.name, 'AbortError'); return true; }
  );

  // Past the grace window: the timer must have been cleared, so NO SIGKILL.
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(!cp.killCalls.includes('SIGKILL'), 'escalation timer must be cleared on error');
});

// Behavior: on abort, if the child does not exit within killGraceMs the worker
// escalates by calling child.kill('SIGKILL') itself (Node does NOT auto-escalate).
test('spawnCapture: escalates to SIGKILL when child ignores abort past killGraceMs', async () => {
  const cp = makeFakeChild();
  const controller = new AbortController();
  const spawnFn = () => {
    queueMicrotask(() => controller.abort());   // child stays alive (fake ignores signal)
    return cp;
  };

  const p = spawnCapture('pdftoppm', [], { spawnFn, signal: controller.signal, killGraceMs: 15 });
  // Simulate the child finally dying from the SIGKILL after the grace window.
  setTimeout(() => cp.emit('close', null, 'SIGKILL'), 50);

  await assert.rejects(p);
  assert.ok(cp.killCalls.includes('SIGKILL'), 'must SIGKILL after the grace window');
});

// Behavior: when captured stdout exceeds maxStdoutBytes the child is SIGKILL'd
// and the promise rejects with output_pixel_cap_exceeded (pixel-bomb guard).
test('spawnCapture: SIGKILLs and rejects output_pixel_cap_exceeded past maxStdoutBytes', async () => {
  const cp = makeFakeChild();
  const spawnFn = () => {
    queueMicrotask(() => cp.stdout.emit('data', Buffer.alloc(100)));
    return cp;
  };

  await assert.rejects(
    spawnCapture('pdftoppm', [], { spawnFn, maxStdoutBytes: 50 }),
    (err) => { assert.match(err.message, /output_pixel_cap_exceeded/); return true; }
  );
  assert.ok(cp.killCalls.includes('SIGKILL'), 'runaway child must be SIGKILL\'d');
});
