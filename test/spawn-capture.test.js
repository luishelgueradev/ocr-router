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
//
// WR-08: when a `signal` is supplied this fake MODELS NODE'S REAL CONTRACT for
// `child_process.spawn({ signal })` — Node registers its OWN abort listener at
// spawn time (i.e. before spawnCapture registers anything), and on abort it
// kills the child with `killSignal` and then SYNCHRONOUSLY emits 'error' with an
// AbortError. The previous bare-EventEmitter fake never emitted 'error', so it
// could not reach the production failure mode at all (CR-05).
//
// Pass the signal from INSIDE spawnFn so the listener-registration order matches
// production. `ignoresSigterm: true` models a child that survives the SIGTERM —
// the only case in which the SIGKILL escalation is supposed to fire.
function makeFakeChild(signal, { ignoresSigterm = false } = {}) {
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
  if (signal) {
    signal.addEventListener('abort', () => {
      cp.kill('SIGTERM');
      cp.emit('error', Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      if (!ignoresSigterm) queueMicrotask(() => cp.emit('close', null, 'SIGTERM'));
    }, { once: true });
  }
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

// Behavior: the real invocation is wrapped as `/bin/sh -c '<body>' sh <operands>`
// where the body is a CONSTANT and every variable part rides the ARGV as a
// positional parameter. The `exec` is mandatory (Pitfall 4 — without it the
// signal hits the shell, not poppler, orphaning the child).
test('spawnCapture: wraps in /bin/sh -c with ulimit + exec timeout backstop', async () => {
  let captured = null;
  const cp = makeFakeChild();
  const spawnFn = (cmd, args, opts) => {
    captured = { cmd, args, opts };
    queueMicrotask(() => cp.emit('close', 0, null));
    return cp;
  };

  await spawnCapture('pdftoppm', ['-r', '200', 'x.pdf'], {
    spawnFn, ulimitKB: 786432, ulimitCpuSec: 20, wallMs: 30000,
  });

  assert.equal(captured.cmd, '/bin/sh');
  assert.equal(captured.args[0], '-c');
  const body = captured.args[1];
  assert.match(body, /ulimit -v "\$1"/, 'address-space cap read from $1 (ulimit -v, NOT -m)');
  assert.match(body, /ulimit -t "\$2"/, 'CPU-seconds cap read from $2');
  assert.match(body, /exec timeout -s KILL "\$@"/, 'exec + timeout backstop present');
  // The whole point of CR-07: the operands ride argv, so the body itself can
  // contain NO caller-supplied text at all.
  assert.ok(!/pdftoppm/.test(body), 'the command never appears in the shell body');
  assert.ok(!/786432/.test(body), 'no limit is interpolated into the shell body');
  assert.deepEqual(
    captured.args.slice(2),
    ['sh', '786432', '20', '30s', 'pdftoppm', '-r', '200', 'x.pdf'],
    '$0 placeholder then ulimits, wall clock, cmd and args as separate operands',
  );
  assert.equal(captured.opts.killSignal, 'SIGTERM');
  assert.deepEqual(captured.opts.stdio, ['ignore', 'pipe', 'pipe']);
});

// CR-07 regression: an argument containing shell metacharacters (a TMPDIR with a
// space, a `;` injection attempt) must survive as ONE literal argv operand and
// must never appear in the shell body.
test('spawnCapture: shell metacharacters in cmd/args cannot reach the shell body', async () => {
  let captured = null;
  const cp = makeFakeChild();
  const spawnFn = (cmd, args, opts) => {
    captured = { cmd, args, opts };
    queueMicrotask(() => cp.emit('close', 0, null));
    return cp;
  };

  const hostile = '/tmp/my dir; touch /tmp/pwned; #/input.pdf';
  await spawnCapture('pdfinfo', [hostile], {
    spawnFn, ulimitKB: 1000, ulimitCpuSec: 5, wallMs: 1000,
  });

  const body = captured.args[1];
  assert.ok(!body.includes('pwned'), 'injected payload never lands in the shell body');
  assert.ok(!body.includes(hostile), 'the path never lands in the shell body');
  assert.equal(
    captured.args[captured.args.length - 1], hostile,
    'the hostile path survives intact as a single argv operand',
  );
});

// Behavior: wallMs is rounded UP to whole seconds for timeout(1) and passed as
// an argv operand (not interpolated).
test('spawnCapture: rounds wallMs up to whole seconds for timeout', async () => {
  let argv = null;
  const cp = makeFakeChild();
  const spawnFn = (cmd, args) => { argv = args; queueMicrotask(() => cp.emit('close', 0, null)); return cp; };
  await spawnCapture('pdfinfo', ['a'], { spawnFn, wallMs: 10500, ulimitKB: 1, ulimitCpuSec: 1 });
  assert.ok(argv.includes('11s'), 'ceil(10500/1000) = 11, passed as an operand');
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

// Behavior (WR-08/CR-05, modelling Node's REAL seam): on abort Node kills the
// child and synchronously emits 'error'. A COMPLIANT child dies from that
// SIGTERM, so its 'close' must disarm the escalation — exactly one signal, no
// stray SIGKILL.
test('spawnCapture: abort rejects AbortError; a child that dies on SIGTERM is never SIGKILLed', async () => {
  const controller = new AbortController();
  let cp;
  const spawnFn = (c, a, opts) => {
    cp = makeFakeChild(opts.signal);            // dies on SIGTERM
    queueMicrotask(() => controller.abort());
    return cp;
  };

  await assert.rejects(
    spawnCapture('pdftoppm', [], {
      spawnFn, signal: controller.signal, killGraceMs: 20, ulimitKB: 1, ulimitCpuSec: 1,
    }),
    (err) => { assert.equal(err.name, 'AbortError'); return true; }
  );

  // Past the grace window: the child already closed, so NO SIGKILL.
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(cp.killCalls, ['SIGTERM'], 'a compliant child is signalled exactly once');
});

// CR-05 REGRESSION — the phase's most safety-critical mechanism. Node's own
// abort listener runs FIRST and emits 'error' synchronously, which settles the
// promise and tears down our listeners inside the SAME dispatch. Before the fix
// that removed `escalate` before it could run, so no SIGKILL was EVER sent in
// production and a SIGTERM-ignoring poppler wedged the concurrency-1 worker for
// the full wall-clock backstop. This test fails against that implementation.
test('spawnCapture: escalates to SIGKILL when the child ignores the abort SIGTERM (CR-05)', async () => {
  const controller = new AbortController();
  let cp;
  const spawnFn = (c, a, opts) => {
    cp = makeFakeChild(opts.signal, { ignoresSigterm: true }); // survives SIGTERM
    queueMicrotask(() => controller.abort());
    return cp;
  };

  const p = spawnCapture('pdftoppm', [], {
    spawnFn, signal: controller.signal, killGraceMs: 15, ulimitKB: 1, ulimitCpuSec: 1,
  });

  await assert.rejects(p, (err) => { assert.equal(err.name, 'AbortError'); return true; });

  // The promise settling does NOT mean the child is gone — the escalation must
  // outlive it and land the SIGKILL.
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(cp.killCalls.includes('SIGKILL'), 'a SIGTERM-ignoring child MUST still be SIGKILLed');
});

// Behavior: the escalation also covers the case where the child neither errors
// nor exits after the abort (no 'error' event at all).
test('spawnCapture: escalates to SIGKILL when child ignores abort past killGraceMs', async () => {
  const cp = makeFakeChild();
  const controller = new AbortController();
  const spawnFn = () => {
    queueMicrotask(() => controller.abort());   // child stays alive (fake ignores signal)
    return cp;
  };

  const p = spawnCapture('pdftoppm', [], {
    spawnFn, signal: controller.signal, killGraceMs: 15, ulimitKB: 1, ulimitCpuSec: 1,
  });
  // Simulate the child finally dying from the SIGKILL after the grace window.
  setTimeout(() => cp.emit('close', null, 'SIGKILL'), 50);

  await assert.rejects(p);
  assert.ok(cp.killCalls.includes('SIGKILL'), 'must SIGKILL after the grace window');
});

// Behavior: a genuine spawn failure (ENOENT/EACCES — no abort) must NOT arm the
// escalation; there is no child to kill.
test('spawnCapture: a non-abort spawn error does not arm the SIGKILL escalation', async () => {
  const cp = makeFakeChild();
  const controller = new AbortController();
  const spawnFn = () => {
    queueMicrotask(() => cp.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
    return cp;
  };

  await assert.rejects(
    spawnCapture('pdftoppm', [], {
      spawnFn, signal: controller.signal, killGraceMs: 15, ulimitKB: 1, ulimitCpuSec: 1,
    }),
    /ENOENT/,
  );

  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(cp.killCalls, [], 'no signal is sent when the child never started');
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
