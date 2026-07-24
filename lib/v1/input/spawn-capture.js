// INP-08 / D-07 / D-11 — the single, injectable, sandboxed subprocess seam.
//
// EVERY child_process invocation in the input pipeline (poppler `pdftoppm` /
// `pdfinfo`) funnels through spawnCapture. It gives us, in one place:
//   1. A killable child bound to the Phase-2 job AbortSignal (`{ signal }`).
//   2. SIGTERM→SIGKILL escalation that Node does NOT do for us — on abort we
//      arm our own unref'd grace timer and SIGKILL the child ourselves if it
//      ignores the initial SIGTERM (Assumption A2 / Pitfall — a poppler that
//      ignores SIGTERM would otherwise wedge the concurrency-1 worker forever).
//      The escalation is armed from BOTH the abort listener and the 'error'
//      handler, and survives promise settlement until a real 'close' arrives —
//      see the CR-05 note at the arming site for why either alone is not enough.
//   3. Kernel-enforced resource caps via a FIXED `sh -c` body that reads every
//      variable part from the POSITIONAL PARAMETERS ("$1", "$@") — never by
//      string interpolation (CR-07). `cmd`, its args, the ulimits and the wall
//      clock are passed as argv operands after the `sh` $0 placeholder, so a
//      path containing a space, a quote or `;rm -rf /` is a plain argument and
//      can NEVER become shell syntax. `-v` (address space) is used, NOT `-m`
//      (RSS is unenforced on modern Linux). The `exec` is MANDATORY: without it
//      the shell — not poppler — receives the signal and poppler orphans
//      (Pitfall 4). `timeout(1)` is the hard wall-clock backstop.
//   4. A captured-stdout ceiling (maxStdoutBytes) so a pixel-bomb page can't
//      blow the heap before any deadline fires.
//
// `spawnFn` is an injected option (defaulting to node:child_process spawn) — the
// D-11 test seam: poppler is Docker-only, so host `node --test` stubs the
// subprocess boundary with a fake ChildProcess and NEVER shells out.
//
// Rejections carry ONLY a machine code + stderr string (+ signal). Never a
// captured buffer, never a key/secret — nothing sensitive rides the error.

const { spawn } = require('node:child_process');

/**
 * Run a command inside the sandbox wrapper and capture its stdout.
 *
 * @param {string} cmd  - the target binary (e.g. 'pdftoppm', 'pdfinfo')
 * @param {string[]} args - its arguments
 * @param {object} opts
 * @param {AbortSignal} [opts.signal]     - Phase-2 job deadline; abort kills the child
 * @param {number} opts.ulimitKB          - `ulimit -v` address-space cap (KB); REQUIRED
 * @param {number} opts.ulimitCpuSec      - `ulimit -t` CPU-seconds cap; REQUIRED
 * @param {number} [opts.wallMs=30000]    - `timeout(1)` wall-clock backstop (ms)
 * @param {number} [opts.killGraceMs=2000]- SIGTERM→SIGKILL grace window (ms)
 * @param {number} [opts.maxStdoutBytes]  - captured-output ceiling (bytes)
 * @param {Function} [opts.spawnFn=spawn] - injectable seam (D-11)
 * @returns {Promise<Buffer>} resolves captured stdout on exit 0; rejects on
 *   non-zero exit, abort/error, stdout-cap breach, or a missing sandbox limit
 *   (`spawn_sandbox_limits_required` — WR-01 fail-closed).
 */
function spawnCapture(cmd, args = [], {
  signal,
  ulimitKB,
  ulimitCpuSec,
  wallMs = 30000,
  killGraceMs = 2000,
  maxStdoutBytes,
  spawnFn = spawn,
} = {}) {
  // The sandbox body is a CONSTANT — nothing is interpolated into it (CR-07).
  // Every variable part arrives as a positional parameter:
  //   $1 = ulimit -v KB, $2 = ulimit -t sec, then after `shift 2`
  //   $1 = wall-clock ("30s"), $2 = cmd, $3.. = args
  // so `exec timeout -s KILL "$@"` expands to `timeout -s KILL 30s <cmd> <args>`
  // with each operand kept intact. `exec` replaces the shell so signals reach
  // the target binary directly (Pitfall 4). A ulimit the kernel refuses exits
  // 71 (EX_OSERR) rather than silently continuing UNSANDBOXED (WR-01).
  const wallSec = Math.ceil(wallMs / 1000);
  const body =
    'ulimit -v "$1" || exit 71; ulimit -t "$2" || exit 71; shift 2; ' +
    'exec timeout -s KILL "$@"';

  // WR-01 — FAIL CLOSED. A caller that forgets a limit previously produced the
  // literal body `ulimit -v undefined`, which dash rejects with "Illegal
  // number" and (absent `set -e`) then ran the child COMPLETELY UNSANDBOXED:
  // no address-space cap, no CPU cap. Refuse to spawn instead.
  const badLimit = (n) => !Number.isInteger(n) || n <= 0;
  if (badLimit(ulimitKB) || badLimit(ulimitCpuSec)) {
    const err = new Error('spawn_sandbox_limits_required');
    err.code = 'spawn_sandbox_limits_required';
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    // The literal 'sh' sets $0 so the remaining operands land in $1.. .
    const child = spawnFn('/bin/sh', [
      '-c', body, 'sh',
      String(ulimitKB), String(ulimitCpuSec),
      `${wallSec}s`, cmd, ...args,
    ], {
      signal,
      killSignal: 'SIGTERM',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let killTimer = null;
    const chunks = [];
    const errChunks = [];
    let bytes = 0;

    // SIGTERM→SIGKILL escalation Node does NOT perform automatically (A2).
    //
    // CR-05: this MUST NOT depend on abort-listener ordering. Node's own
    // `spawn({ signal })` listener is registered first (inside spawnFn above);
    // on abort it kills the child and SYNCHRONOUSLY emits 'error', which lands
    // in the handler below → fail() → cleanup(). Per the EventTarget dispatch
    // algorithm a listener removed DURING the dispatch of the event it is
    // registered for is never invoked, so an `escalate` that cleanup() removes
    // would silently never run. Two rules keep the escalation alive:
    //   1. The 'error' handler arms the escalation ITSELF when the signal has
    //      already aborted — the error IS the abort, so never rely on our own
    //      listener winning the race.
    //   2. cleanup() does NOT clear the timer. Settling the promise says nothing
    //      about whether the child died; only a 'close' event does. The timer is
    //      unref'd, so a pending SIGKILL never keeps the process alive.
    let escalationArmed = false;
    const armEscalation = () => {
      if (escalationArmed) return;
      escalationArmed = true;
      killTimer = setTimeout(() => {
        killTimer = null;
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, killGraceMs);
      if (killTimer.unref) killTimer.unref();
    };
    if (signal) signal.addEventListener('abort', armEscalation, { once: true });

    // Deliberately does NOT clearTimeout — see rule 2 above. Only a confirmed
    // 'close' (the child is actually gone) disarms the SIGKILL.
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', armEscalation);
    };

    const done = (fn) => (arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };
    const succeed = done(resolve);
    const fail = done(reject);

    child.stdout.on('data', (d) => {
      bytes += d.length;
      if (maxStdoutBytes && bytes > maxStdoutBytes) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        // Only a machine code — no captured buffer rides the error.
        return fail(new Error('output_pixel_cap_exceeded'));
      }
      chunks.push(d);
    });

    child.stderr.on('data', (d) => errChunks.push(d));

    // AbortError (from `{ signal }`) and spawn failures land here. When the
    // signal has already aborted, THIS event is Node's own abort handling — arm
    // the escalation from here rather than trusting our listener to be reached
    // (CR-05). A genuine spawn failure (ENOENT, EACCES) leaves it disarmed:
    // there is no child to kill.
    child.on('error', (e) => {
      if (signal && signal.aborted) armEscalation();
      fail(e);
    });

    child.on('close', (code, sig) => {
      // The child is confirmed gone — now, and only now, is it safe to cancel a
      // pending SIGKILL (CR-05 rule 2).
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      if (code === 0) return succeed(Buffer.concat(chunks));
      // Rejection carries ONLY code / signal / stderr-string — never a buffer,
      // never a key. stderr is a bounded diagnostic string.
      const err = new Error('subprocess_failed');
      err.code = code;
      err.signal = sig;
      err.stderr = Buffer.concat(errChunks).toString();
      fail(err);
    });
  });
}

module.exports = { spawnCapture };
