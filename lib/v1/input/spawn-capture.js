// INP-08 / D-07 / D-11 — the single, injectable, sandboxed subprocess seam.
//
// EVERY child_process invocation in the input pipeline (poppler `pdftoppm` /
// `pdfinfo`) funnels through spawnCapture. It gives us, in one place:
//   1. A killable child bound to the Phase-2 job AbortSignal (`{ signal }`).
//   2. SIGTERM→SIGKILL escalation that Node does NOT do for us — on abort we
//      arm our own unref'd grace timer and SIGKILL the child ourselves if it
//      ignores the initial SIGTERM (Assumption A2 / Pitfall — a poppler that
//      ignores SIGTERM would otherwise wedge the concurrency-1 worker forever).
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
 * @param {number} [opts.ulimitKB]        - `ulimit -v` address-space cap (KB)
 * @param {number} [opts.ulimitCpuSec]    - `ulimit -t` CPU-seconds cap
 * @param {number} [opts.wallMs=30000]    - `timeout(1)` wall-clock backstop (ms)
 * @param {number} [opts.killGraceMs=2000]- SIGTERM→SIGKILL grace window (ms)
 * @param {number} [opts.maxStdoutBytes]  - captured-output ceiling (bytes)
 * @param {Function} [opts.spawnFn=spawn] - injectable seam (D-11)
 * @returns {Promise<Buffer>} resolves captured stdout on exit 0; rejects on
 *   non-zero exit, abort/error, or stdout-cap breach.
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
    const escalate = () => {
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, killGraceMs);
      if (killTimer.unref) killTimer.unref();
    };
    if (signal) signal.addEventListener('abort', escalate, { once: true });

    const cleanup = () => {
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      if (signal) signal.removeEventListener('abort', escalate);
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

    // AbortError (from `{ signal }`) and spawn failures land here.
    child.on('error', (e) => fail(e));

    child.on('close', (code, sig) => {
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
