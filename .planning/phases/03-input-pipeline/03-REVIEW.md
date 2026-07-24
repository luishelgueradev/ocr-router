---
phase: 03-input-pipeline
reviewed: 2026-07-24T00:00:00Z
depth: standard
files_reviewed: 24
files_reviewed_list:
  - lib/v1/input/caps.js
  - lib/v1/input/image-normalize.js
  - lib/v1/input/page-pipeline.js
  - lib/v1/input/pdf-text.js
  - lib/v1/input/rasterize.js
  - lib/v1/input/spawn-capture.js
  - lib/v1/input/temp.js
  - lib/v1/router.js
  - lib/v1/shutdown.js
  - lib/v1/sniff.js
  - lib/v1/upload.js
  - lib/v1/worker.js
  - scripts/docker-smoke.sh
  - test/caps.test.js
  - test/docker-smoke.test.js
  - test/image-normalize.test.js
  - test/page-pipeline.test.js
  - test/pdf-text.test.js
  - test/rasterize.test.js
  - test/shutdown.test.js
  - test/sniff.test.js
  - test/spawn-capture.test.js
  - test/temp.test.js
  - test/upload.test.js
findings:
  critical: 7
  warning: 11
  info: 5
  total: 23
status: issues_found
---

# Phase 3: Code Review Report

**Reviewed:** 2026-07-24
**Depth:** standard
**Files Reviewed:** 24
**Status:** issues_found

## Summary

The input pipeline is well-decomposed and the module headers document intent
carefully — but several of the headline safety properties they claim are **not
actually implemented by the shipped code**, and the tests that "prove" them use
fakes that cannot exercise the real failure mode. That gap is the theme of this
review:

- The **decompression-bomb guard is absent on the two decode paths that need it
  most** (BMP, HEIC) and absent entirely for multi-frame count (CR-02, CR-03).
- The **`-scale-to` flag does the opposite of what the comments claim** — it
  forces the long edge to exactly `RASTER_MAX_DIM` and *overrides* `-r`, so
  `RASTER_DPI` is inert and every small page is upscaled (CR-06).
- The **SIGTERM→SIGKILL escalation is dead code in production** — the abort
  listener is removed during the same dispatch that would have invoked it.
  The unit test passes only because its fake child never emits `'error'`
  (CR-05, WR-08).
- **Truncated renderer output is silently accepted as a valid page** — confirming
  the "non-blocking" note in 03-07-SUMMARY.md is, in my judgement, blocking
  (CR-01).
- The **shutdown temp drain runs before the job drain**, deleting the input PDF
  out from under an in-flight rasterization while still leaking any dir created
  after the drain (CR-04).
- The **spawn seam builds a shell string by unquoted interpolation** (CR-07).

There is no `<structural_findings>` block for this review, so all findings below
are narrative.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: Truncated / degenerate `pdftoppm` output is accepted as a successful page

**File:** `lib/v1/input/rasterize.js:112-119`, `lib/v1/input/page-pipeline.js:132-135`
**Issue:** `spawnCapture` resolves on `code === 0` with whatever bytes were
captured, and `renderPage` returns that buffer unvalidated. `page-pipeline` then
does `png.toString('base64')` and routes it. Nothing checks PNG magic, minimum
length, or decodability.

This is the exact failure the 03-07 summary recorded as "non-blocking": under a
tight `ulimit -v`, poppler can exit 0 after emitting a ~90-byte truncated PNG.
The result is a *silent success path that produces garbage*: the provider is
paid to OCR a corrupt image, returns empty/nonsense text, the page is recorded
with `engine`/`confidence` set and **no** `error`, and `status_rollup` stays
`'completed'`. The client cannot distinguish this from a genuinely blank page.
For a service whose core value is "never fail to return the best available
text", silently returning nothing while reporting success is worse than failing.
I classify it BLOCKER, not "latent".

Note that the ceiling this interacts with (`ULIMIT_V_KB`) is explicitly
documented in `caps.js` as un-tuned ("DEFERRED Docker-smoke item D-11"), so the
truncation trigger is live on any box whose real page render is heavier than the
smoke fixture.

**Fix:** validate the render before returning it.
```js
// rasterize.js
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MIN_PNG_BYTES = 1024; // a real 200-DPI page is orders of magnitude larger

async function renderPage(pdfPath, page, opts = {}) {
  const png = await spawnCapture('pdftoppm', args, { /* ... */ });
  if (png.length < MIN_PNG_BYTES || !png.subarray(0, 8).equals(PNG_MAGIC)) {
    const err = new Error('raster_output_truncated');
    err.code = 'raster_output_truncated';
    err.bytes = png.length;
    throw err;  // page-pipeline records it as a per-page error (INP-06)
  }
  return png;
}
```
Also verify the trailing IEND chunk (`png.subarray(-8, -4).toString() === 'IEND'`)
— that is the cheap, definitive truncation test.

---

### CR-02: No frame-count cap for TIFF/GIF — unbounded memory and unbounded provider calls

**File:** `lib/v1/input/image-normalize.js:69-79`, `lib/v1/input/page-pipeline.js:144-154`
**Issue:** PDFs are gated by `MAX_PDF_PAGES` *before* any work
(`assertPageCountWithinCap`). The image path has **no equivalent gate**.
`multiFrameToPngs` reads `meta.pages` from an attacker-supplied file and loops
that many times, **accumulating every normalized PNG in the `out` array**:

```js
const n = meta.pages || 1;
const out = [];
for (let p = 0; p < n; p++) out.push(await normalizeOne(buf, maxPixels, maxDim, { page: p }));
return out;
```

A 10 MB animated GIF or multipage TIFF can trivially declare thousands of frames.
Every normalized frame is retained simultaneously, then `runPipeline` retains the
whole array and additionally holds each frame's base64 string (~1.33x). On a
single-concurrency worker on a small VPS this is a straightforward OOM.

Two secondary consequences:
1. The module header's claim "**ONE FRAME IN MEMORY AT A TIME**" is false — the
   array is fully materialized. `page-pipeline.js:149`'s `frames[i] = null`
   releases only *after* every frame has already been allocated.
2. Each frame becomes a paid cascade call. Only the 180 s `MAX_JOB_MS` bounds
   the spend, and pages past the deadline degrade to CR-03/WR-02's silent-empty
   behavior.

**Fix:** add a cap to `caps.js` and gate before decoding; stream frames instead
of materializing.
```js
// caps.js
MAX_IMAGE_FRAMES: intFromEnv('MAX_IMAGE_FRAMES', 50),

// image-normalize.js
const n = meta.pages || 1;
if (n > CAPS.MAX_IMAGE_FRAMES) {
  const err = new Error('too_many_frames');
  err.code = 'too_many_frames'; err.status = 413;
  err.limit = CAPS.MAX_IMAGE_FRAMES; err.actual = n;
  throw err;
}
```
Longer term, export an async generator (`normalizeFrames(buffer, type)`) so
`page-pipeline` pulls one frame at a time and genuinely honours INP-07.

---

### CR-03: BMP/HEIC decode allocates from attacker-controlled header **before** any pixel guard

**File:** `lib/v1/input/image-normalize.js:101-124`
**Issue:** The module header asserts "DECOMPRESSION-BOMB GUARD ON EVERY DECODE"
and "Every path carries a decompression-bomb guard (limitInputPixels + resize
cap)". This is **false for BMP and HEIC**, because both decode to raw pixels
*before* sharp — and `limitInputPixels` only applies once sharp is reached.

`@vingle/bmp-js` reads the dimensions straight out of the 54-byte header and
allocates unconditionally (`node_modules/@vingle/bmp-js/lib/decoder.js:67-69,
237-238`):
```js
this.width  = this.buffer.readUInt32LE(this.pos);
this.height = this.buffer.readInt32LE(this.pos);
...
var len = this.width * this.height * 4;
this.data = Buffer.alloc(len, 0xff);
```
There is **no cross-check against the actual file length**. A ~60-byte upload
declaring `20000 x 20000` produces a 1.6 GB `Buffer.alloc` — enough to OOM-kill
the container on a small VPS. Larger declarations hit `ERR_OUT_OF_RANGE`, which
surfaces as a 500 (see WR-03) rather than a typed rejection. `sniff.js:33`
admits BMP on a 2-byte `BM` signature, so reaching this decoder is trivial
(see WR-09).

The existing test `test/image-normalize.test.js:118` ("BMP path still applies
limitInputPixels (no OOM)") does **not** cover this: it encodes a *valid* large
BMP, so bmp-js allocates the full raw buffer successfully and only then does
sharp reject. It proves the opposite of its title.

`heic-convert` (libheif WASM) has the same shape — full-size decode with no
caller-supplied pixel ceiling — and `heicToPngs` applies `maxPixels` only to the
*already-decoded* JPEG.

**Fix:** validate declared dimensions against the pixel cap before handing the
buffer to either decoder.
```js
function assertBmpWithinCap(buf, maxPixels) {
  if (buf.length < 26) { const e = new Error('bmp_truncated'); e.code = 'bmp_truncated'; e.status = 422; throw e; }
  const w = buf.readUInt32LE(18);
  const h = Math.abs(buf.readInt32LE(22));
  if (!w || !h || w * h > maxPixels) {
    const e = new Error('image_pixel_cap_exceeded');
    e.code = 'image_pixel_cap_exceeded'; e.status = 413;
    e.limit = maxPixels; e.actual = w * h;
    throw e;
  }
}
```
For HEIC, parse `ispe` box dimensions (or bound the decode in a worker thread
with a hard `--max-old-space-size`) before calling `convert()`.

---

### CR-04: Shutdown drains temp dirs **before** the job drain — destroys in-flight work and still leaks

**File:** `lib/v1/shutdown.js:30-36`
**Issue:** `drainAllTempDirs()` runs as the *first* step of `drainAndCancel`,
before queued jobs are failed and before `limiter.stop()`. Two defects:

1. **In-flight sabotage.** The currently-executing job's temp dir — containing
   the `input.pdf` that `pdftoppm`/`pdfinfo` are reading right now — is
   `rm -rf`'d out from under it. The job then fails with a confusing subprocess
   error instead of draining gracefully. This directly contradicts the "graceful
   drain" contract the rest of the function implements (it goes to real trouble
   to give in-flight work a 35 s grace window, then deletes its inputs at t=0).
2. **The leak it claims to fix is still open.** `drainAllTempDirs` snapshots and
   `active.clear()`s. Any temp dir created *after* that point — by a job
   bottleneck has already promoted into the executing slot, or by the in-flight
   job itself — is never drained. If the process is then SIGKILLed at the end of
   the grace window, that dir leaks. This is precisely the Pitfall-2 vector the
   module claims to close.

No test covers the ordering: `test/shutdown.test.js:128` registers a dir, calls
`drainAndCancel`, and asserts the dir is gone — which passes regardless of order.

**Fix:** drain temp dirs **after** the job drain completes.
```js
// ... queued cancelled, limiter.stop() raced against timeoutMs, timeout branch ...
// THEN, once no job can still be writing:
try {
  const temp = deps.temp || require('./input/temp');
  await temp.drainAllTempDirs();
  logger.info({}, 'shutdown_temp_drained');
} catch (e) {
  logger.error({ message: e && e.message }, 'shutdown_temp_drain_error');
}
logger.info({ duration_ms: Date.now() - start, /* ... */ }, 'shutdown_complete');
```
Separately, add a boot-time sweep of stale `os.tmpdir()/ocr-job-*` dirs to cover
SIGKILL (no in-process handler can).

---

### CR-05: SIGTERM→SIGKILL escalation never fires in production

**File:** `lib/v1/input/spawn-capture.js:72-91`, `107-108`
**Issue:** The escalation is the module's stated raison d'être (item 2 of the
header, "Assumption A2 … a poppler that ignores SIGTERM would otherwise wedge
the concurrency-1 worker forever"). With the **real** `child_process.spawn` it
cannot run.

Node's `spawn({ signal })` registers its own abort listener at spawn time —
*before* line 79 adds `escalate`. On abort, Node's listener runs first and calls
`abortChildProcess`, which does `child.kill(killSignal)` and then
**synchronously** `child.emit('error', new AbortError(...))`. That reaches
line 108 → `fail(e)` → `done()` → `cleanup()` → line 83
`signal.removeEventListener('abort', escalate)`.

Per the DOM `EventTarget` dispatch algorithm (which Node implements faithfully),
a listener removed during dispatch of the event it is registered for is **not
invoked**. So `escalate` is removed before its turn comes, `killTimer` is never
armed, and no SIGKILL is ever sent. Only `timeout -s KILL <wallSec>s` remains —
and that clock is `RASTER_WALL_MS` (30 s) or `PDFINFO_WALL_MS` (10 s), i.e. the
worker can still be wedged for up to 30 s per page by a SIGTERM-ignoring child
that the code believes it kills in 2 s.

The unit test at `test/spawn-capture.test.js:140` passes only because its fake
`spawnFn` returns a bare `EventEmitter` that never emits `'error'` on abort —
it does not model the real seam (see WR-08). The Docker smoke
(`test/docker-smoke.test.js:160`) only proves `sleep` dies from the initial
SIGTERM, which is the path that *does* work.

**Fix:** arm the escalation timer inside the settle path rather than relying on
listener ordering, and do not tear it down until the child is confirmed gone.
```js
let escalated = false;
const armEscalation = () => {
  if (escalated) return;
  escalated = true;
  killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, killGraceMs);
  if (killTimer.unref) killTimer.unref();
};
if (signal) signal.addEventListener('abort', armEscalation, { once: true });

const cleanup = () => { if (signal) signal.removeEventListener('abort', armEscalation); };
// note: do NOT clearTimeout here — let the SIGKILL land if the child is still alive.
child.on('close', () => { if (killTimer) { clearTimeout(killTimer); killTimer = null; } });

child.on('error', (e) => {
  if (signal && signal.aborted) armEscalation();  // the error IS the abort — escalate anyway
  fail(e);
});
```
And write a regression test whose fake `spawnFn` reproduces Node's behaviour
(register an abort listener that emits `'error'` synchronously).

---

### CR-06: `-scale-to` **forces** the long edge and **overrides `-r`** — `RASTER_DPI` is inert and small pages are upscaled

**File:** `lib/v1/input/rasterize.js:96-110`, `lib/v1/input/caps.js:27-38`
**Issue:** The comments describe `-scale-to` as a *ceiling* ("caps output pixels
regardless of a hostile MediaBox, independent of DPI", "`-scale-to` always caps
the long side as the second pixel guard"). That is not what poppler does. From
`pdftoppm(1)`:

> `-scale-to number` — Scales each page so that its longer side is *number*
> pixels in length. **This option overrides the -r option.**

Consequences, all live in production:

1. **`RASTER_DPI` has no effect whatsoever.** `-r 200` is passed and ignored;
   the `dpi` override parameter of `renderPage` (and its test at
   `test/rasterize.test.js:104`) asserts an argv flag that poppler discards.
   The `caps.js` documentation of `RASTER_DPI` as "render resolution … balanced
   against MAX_OUTPUT_PIXELS" is wrong.
2. **Every page is rendered at exactly 5000 px on its long edge**, including
   pages that would naturally be much smaller. A 200-DPI A4 page is ~1654x2339;
   `-scale-to 5000` upscales it to ~3536x5000 ≈ 17.7 M pixels — roughly a 4.5x
   pixel inflation over the intended budget, with **zero** OCR benefit
   (interpolated pixels carry no new information).
3. That inflation is what makes CR-01's truncation trigger reachable: it pushes
   peak allocation toward `ULIMIT_V_KB` and pushes the emitted PNG toward
   `MAX_RASTER_STDOUT_BYTES` (40 MB) on noisy scans, turning a legitimate page
   into a spurious `output_pixel_cap_exceeded`.
4. The "second pixel guard, independent of DPI" is therefore not a guard at all
   — it is a fixed target that can only *increase* the pixel count of a modest
   page.

**Fix:** use `-r` as the primary control and compute a genuine ceiling, or drop
`-scale-to` and rely on `-r` + `ULIMIT_V_KB` + `MAX_RASTER_STDOUT_BYTES`.
```js
// Option A (simplest, honest): DPI drives the render; the ulimit + stdout cap
// are the real ceilings. Drop -scale-to entirely.
const args = ['-r', String(dpi), '-png', '-f', String(page), '-l', String(page),
              '-singlefile', pdfPath];

// Option B (true ceiling): read the page box via pdfinfo, compute the DPI that
// keeps the long edge <= maxDim, and pass min(dpi, computedDpi) to -r.
```
Also correct the `caps.js` and `rasterize.js` comments, and consider `-gray`
(the pipeline greyscales images anyway) to cut the PNG size ~3x.

---

### CR-07: `spawnCapture` builds a `/bin/sh -c` string by unquoted interpolation

**File:** `lib/v1/input/spawn-capture.js:55-57`
**Issue:**
```js
const body =
  `ulimit -v ${ulimitKB}; ulimit -t ${ulimitCpuSec}; ` +
  `exec timeout -s KILL ${wallSec}s ${cmd} ${args.join(' ')}`;
```
`cmd` and every element of `args` are pasted into a shell command with **no
quoting or escaping**. This is a generic, exported seam documented as the funnel
for "EVERY child_process invocation in the input pipeline" — any future caller
that passes a filename derived from request data gets remote command execution.

Today's inputs are `path.join(os.tmpdir(), 'input.pdf')` and numeric strings, so
I could not construct an attacker-reachable payload through the HTTP API. But
the defect is real and unconditional:

- **Operator-reachable injection:** `os.tmpdir()` derives from `TMPDIR`/`TMP`/
  `TEMP`. Any of those containing shell metacharacters injects into the command.
- **Functional breakage today:** a `TMPDIR` containing a space silently splits
  the argument and `pdftoppm` renders the wrong (or no) file.
- Zero defence-in-depth: a one-line refactor elsewhere turns this into RCE, and
  nothing in the module or tests would catch it.

**Fix:** never interpolate. Pass argv positionally so the shell only ever sees
`"$@"`.
```js
const body =
  `ulimit -v "$1"; ulimit -t "$2"; shift 2; ` +
  `exec timeout -s KILL "$1" "$2" "$@"`;   // adjust shifting to taste

const child = spawnFn('/bin/sh', [
  '-c', body, 'sh',
  String(ulimitKB), String(ulimitCpuSec), `${wallSec}s`, cmd, ...args,
], { signal, killSignal: 'SIGTERM', stdio: ['ignore', 'pipe', 'pipe'] });
```
(The `'sh'` after the body sets `$0` so the remaining operands land in `$1..`.)
This keeps `ulimit`/`timeout`/`exec` semantics while making injection structurally
impossible. The existing tests that regex the body will need updating to inspect
the argv array instead — which is the more meaningful assertion anyway.

---

## Warnings

### WR-01: `pdfinfo` runs with **no** `ulimit` and no stdout ceiling

**File:** `lib/v1/input/rasterize.js:40-52`, `lib/v1/input/spawn-capture.js:55-57`
**Issue:** `pdfPageCount` calls `spawnCapture` without `ulimitKB`,
`ulimitCpuSec`, or `maxStdoutBytes`. Those become `undefined`, producing the
literal body `ulimit -v undefined; ulimit -t undefined; exec timeout …`. `dash`
prints `ulimit: Illegal number: undefined` to stderr, returns non-zero, and —
because there is no `set -e` — **continues to the `exec` anyway**. So the very
first subprocess to touch an untrusted PDF runs with no address-space cap, no
CPU cap, and unbounded stdout capture. The pre-raster gate that exists to stop a
decompression bomb is itself the least sandboxed call in the pipeline.

**Fix:**
```js
await spawnCapture('pdfinfo', [pdfPath], {
  signal,
  ulimitKB: CAPS.ULIMIT_V_KB,
  ulimitCpuSec: CAPS.ULIMIT_CPU_SEC,
  wallMs: CAPS.PDFINFO_WALL_MS,
  maxStdoutBytes: 64 * 1024,   // pdfinfo output is a few hundred bytes
  spawnFn,
});
```
Additionally make the sandbox fail closed when a limit is missing:
```js
if (!Number.isInteger(ulimitKB) || !Number.isInteger(ulimitCpuSec)) {
  throw new Error('spawn_sandbox_limits_required');
}
```

---

### WR-02: Job-deadline overrun produces pages that look **successful** but are empty

**File:** `lib/v1/worker.js:176-194`, `lib/v1/input/page-pipeline.js:92-105`
**Issue:** `makeCascadeRoutePage` computes `budgetMs: deadline - Date.now()`,
which goes **negative** once `MAX_JOB_MS` elapses. In `runCascade`, a negative
budget makes `remaining <= CONFIG.minSliceMs` on the first iteration, so it
breaks with `best = null` and returns
`{ text: '', engineId: null, provider: null, confidence: null }` — with **no**
`error` field (`runner.js` only sets `error` for `no_engine_configured`).

`routeAndRecord` treats that as a success: the page is pushed with `text: ''`,
`engine: null`, no `error`. `hadError` stays false, so a job whose deadline blew
halfway through N pages reports `status_rollup: 'completed'` with silently
missing content. The client has no signal that anything went wrong.

**Fix:** clamp the budget and treat an empty/engine-less result as a page error.
```js
const remaining = Math.max(0, deadline - Date.now());
if (remaining === 0) {
  const err = new Error('job_deadline_exceeded');
  err.code = 'job_deadline_exceeded';
  throw err;   // per-page error, recorded by pushError
}
// ...and in routeAndRecord:
if (!r.engineId) {
  const err = new Error('no_engine_result');
  err.code = r.stoppedReason || 'no_engine_result';
  throw err;
}
```

---

### WR-03: Decoder/pixel-cap failures surface as HTTP 500 `internal_error`

**File:** `lib/v1/worker.js:284-295`
**Issue:** The catch block only maps `pdf_too_many_pages` / `status === 413` /
`status === 422` to a typed client failure. Everything else becomes
`internal_error`. That bucket includes several **client-caused** conditions:

- sharp's `limitInputPixels` breach ("Input image exceeds pixel limit") — the
  primary decompression-bomb rejection has no `status`, so a bomb reports as a
  server fault.
- `heic-convert` / `@vingle/bmp-js` decode failures on malformed input.
- `unpdf` `PasswordException` on an encrypted PDF (see WR-04).
- `RangeError: ERR_OUT_OF_RANGE` from CR-03's oversized `Buffer.alloc`.

Operationally this is worse than cosmetic: real attack traffic and real
malformed uploads are indistinguishable from genuine server bugs in the logs
(which deliberately drop the detail per OPS-05), so the alerting signal is lost.

**Fix:** normalize decoder errors to typed 422/413 at the point of decode.
```js
// image-normalize.js — wrap every decode
try {
  return await normalizeOne(buffer, maxPixels, maxDim);
} catch (e) {
  const err = new Error('image_decode_failed');
  err.code = /pixel limit|exceeds/i.test(e.message) ? 'image_pixel_cap_exceeded' : 'image_decode_failed';
  err.status = err.code === 'image_pixel_cap_exceeded' ? 413 : 422;
  throw err;
}
```

---

### WR-04: An `unpdf` failure aborts the whole job with no rasterization fallback

**File:** `lib/v1/input/page-pipeline.js:120`
**Issue:** `await getPageTexts(buffer)` sits **outside** the per-page try/catch.
Any unpdf/PDF.js throw — password-protected PDF, malformed xref, an unsupported
construct PDF.js chokes on — fails the entire job as `internal_error`, even
though `pdfinfo` already succeeded (so poppler can read the file) and
rasterization would have produced usable pages. This directly contradicts the
product's stated core value ("never fail to return the best available
text/data") and the module's own per-page-resilience design.

**Fix:** degrade to "all pages scanned" instead of failing.
```js
let texts = [];
try {
  texts = await getPageTexts(buffer);
} catch (e) {
  // Native-text extraction is an OPTIMIZATION, never a requirement — fall back
  // to rasterizing every page.
  texts = [];
}
```

---

### WR-05: A zero / bogus `pdfinfo` page count yields a "completed" job with no pages

**File:** `lib/v1/input/rasterize.js:49-51`, `lib/v1/input/page-pipeline.js:115-139`
**Issue:** `Number(m[1])` is returned unvalidated. `assertPageCountWithinCap`
only checks the **upper** bound. If `pdfinfo` reports `Pages: 0` (it does for
some damaged/encrypted files), the `for (let p = 1; p <= 0; p++)` loop never
executes: `pages` is `[]`, `text` is `''`, `summarize` returns
`{engine: null, provider: null}`, and the job completes as `'completed'` with an
empty envelope. The caller gets a 200-equivalent success containing nothing.

**Fix:**
```js
const n = Number(m[1]);
if (!Number.isInteger(n) || n < 1) {
  const err = new Error('pdf_no_pages');
  err.code = 'pdf_no_pages'; err.status = 422;
  throw err;
}
return n;
```

---

### WR-06: `drainAndCancel` never clears its timeout timer — shutdown lingers up to 35 s

**File:** `lib/v1/shutdown.js:61-62`
**Issue:** `timeoutPromise` creates a `setTimeout(…, timeoutMs)` that is neither
`unref()`'d nor cleared when `stopPromise` wins the race. After a clean, fast
drain the timer stays on the event loop, keeping the process alive for the full
remaining grace window (35 s by default) before Node can exit. Under Docker that
means every graceful stop takes ~35 s regardless of how quickly work drained,
and orchestrators that impose a shorter stop grace will SIGKILL — the very
outcome the drain exists to avoid.

**Fix:**
```js
let timer;
const timeoutPromise = new Promise((resolve) => {
  timer = setTimeout(() => resolve('timeout'), timeoutMs);
  if (timer.unref) timer.unref();
});
const winner = await Promise.race([stopPromise, timeoutPromise]);
clearTimeout(timer);
```

---

### WR-07: Unguarded `await` in `runInputJob`'s `finally` can replace the job outcome

**File:** `lib/v1/worker.js:296-299`
**Issue:** `await cleanupJobTempDir(tempDir)` runs in a `finally` with no
try/catch. `fs.rm` can reject (EBUSY, EPERM, EACCES on a bind-mounted or
read-only `/tmp`). Because it is in a `finally`, that rejection **replaces**
whatever the `try`/`catch` produced and propagates out of `runInputJob` →
`runJob` → the `.catch()` at `router.js:183`, which calls `jobs.fail(…,
'internal_error')`. A job that already completed successfully would emit a
misleading `worker crashed` path (harmless only because `jobs.complete` already
finalized it). Temp cleanup is best-effort everywhere else in the codebase
(`shutdown.js` wraps its drain precisely for this reason); this call site is the
exception.

**Fix:**
```js
} finally {
  clearTimeout(timer);
  if (tempDir) {
    try { await cleanupJobTempDir(tempDir); }
    catch (e) { jobLogger.error({ message: e && e.message }, 'temp_cleanup_failed'); }
  }
}
```

---

### WR-08: The SIGKILL-escalation test cannot fail — it gives false assurance for CR-05

**File:** `test/spawn-capture.test.js:140-154`, `test/docker-smoke.test.js:160-179`
**Issue:** `makeFakeChild()` is a bare `EventEmitter`; the injected `spawnFn`
aborts the controller but the fake **never emits `'error'`** the way Node's real
`spawn({signal})` does. So the test exercises a code path that does not exist in
production and reports green while CR-05 is broken. The Docker smoke has the
complementary gap: `sleep` dies from the initial SIGTERM, so the escalation
branch is never reached there either. Between them, the phase's most
safety-critical mechanism has **zero** real coverage despite two tests named
after it.

This matters beyond the immediate bug: the same fake is reused by
`test/rasterize.test.js`, `test/page-pipeline.test.js` and
`test/worker-input.test.js`, so none of the abort/cancellation behaviour in the
pipeline is genuinely covered.

**Fix:** make the fake model Node's contract.
```js
function makeFakeChild(signal, { ignoresSigterm = false } = {}) {
  const cp = new EventEmitter();
  // ... stdout/stderr/kill as before ...
  if (signal) {
    signal.addEventListener('abort', () => {
      cp.kill('SIGTERM');
      cp.emit('error', Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (!ignoresSigterm) queueMicrotask(() => cp.emit('close', null, 'SIGTERM'));
    }, { once: true });
  }
  return cp;
}
```
Then assert that a child constructed with `ignoresSigterm: true` still receives
`SIGKILL` after `killGraceMs`.

---

### WR-09: BMP is admitted on a 2-byte signature with no structural validation

**File:** `lib/v1/sniff.js:33`
**Issue:** `if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4D) return 'image/bmp';`
Two bytes is the weakest signature in the sniffer by a wide margin — any file
beginning with the ASCII text `BM` (and plenty of binary formats) is routed into
`@vingle/bmp-js`, which is precisely the unguarded decoder from CR-03. The rest
of the module goes to real trouble to avoid false positives (the HEIC brand
allowlist at lines 26-30, the RIFF+WEBP pair check at line 15); BMP is the
outlier.

**Fix:** validate the DIB header alongside the magic.
```js
// BMP — 'BM' + a plausible file size and a known DIB header size.
if (buf.length >= 18 && buf[0] === 0x42 && buf[1] === 0x4D) {
  const declaredSize = buf.readUInt32LE(2);
  const dibSize = buf.readUInt32LE(14);
  const KNOWN_DIB = new Set([12, 40, 52, 56, 64, 108, 124]);
  if (KNOWN_DIB.has(dibSize) && declaredSize >= 26) return 'image/bmp';
  return null;
}
```

---

### WR-10: No startup sweep for orphaned `ocr-job-*` temp dirs

**File:** `lib/v1/input/temp.js:17-27`
**Issue:** The `active` Set is purely in-process. A SIGKILL (OOM killer — very
reachable given CR-02/CR-03 — `docker kill`, host reboot, or the CR-04 grace-
window expiry) leaves every live `ocr-job-*` dir on disk with its input PDF,
permanently. On a long-lived container with a small `/tmp` this accumulates
until the disk fills, at which point `mkdtemp` fails and every input job dies.
The module header calls this "the single most important safety property of the
input pipeline", yet the one shutdown case no in-process handler can catch is
unaddressed.

**Fix:** sweep on boot, before accepting traffic.
```js
async function sweepOrphanedTempDirs() {
  const base = os.tmpdir();
  const entries = await readdir(base, { withFileTypes: true });
  await Promise.allSettled(
    entries
      .filter((e) => e.isDirectory() && e.name.startsWith('ocr-job-'))
      .map((e) => rm(path.join(base, e.name), { recursive: true, force: true }))
  );
}
```
(Safe because the process is single-instance per container; if that ever changes,
gate on directory mtime older than `MAX_JOB_MS`.)

---

### WR-11: `docker-smoke.sh` gates HEIC and temp-lifecycle cases on an unrelated binary

**File:** `test/docker-smoke.test.js:70-76`, `149`, `197`
**Issue:** `requirePoppler(t)` is used to skip the HEIC decode case (line 149,
"gated on the image signal per D-11") and the temp-dir case (line 197), neither
of which needs poppler. The comment acknowledges this is deliberate, but the
consequence is that the **A5 HEIC risk-flag — explicitly called out in
CLAUDE.md as the reason `heic-convert` was chosen over sharp — is silently
skipped in any environment that has heic-convert but not poppler**, including a
future slimmed image or a CI runner. A skipped test reports green.

Compounding this: `requirePoppler` calls `t.skip()` and returns, but `t.skip()`
in `node --test` does not halt execution — the guard relies entirely on the
caller's `return`. That is correct here, but it is a pattern one missing
`return` away from a false pass.

**Fix:** gate each case on the capability it actually needs.
```js
const HAS_POPPLER = hasBinary('pdftoppm') && hasBinary('pdfinfo');
let HAS_HEIC = true;
try { require('heic-convert'); } catch { HAS_HEIC = false; }

function requireCap(t, ok, why) { if (!ok) { t.skip(why); return false; } return true; }
// HEIC case:   if (!requireCap(t, HAS_HEIC, 'heic-convert unavailable')) return;
// temp case:   no guard needed at all — it is pure fs.
```

---

## Info

### IN-01: Module headers assert safety properties the code does not implement

**File:** `lib/v1/input/image-normalize.js:9-19`, `lib/v1/input/rasterize.js:11-17`, `lib/v1/input/page-pipeline.js:22-24`
**Issue:** Three separate headers state invariants contradicted by the
implementation: "ONE FRAME IN MEMORY AT A TIME" (CR-02), "DECOMPRESSION-BOMB
GUARD ON EVERY DECODE" / "Every path carries a decompression-bomb guard"
(CR-03), and `-scale-to` as a ceiling (CR-06). Confidently wrong comments are
worse than none — a future maintainer will trust them instead of re-deriving.
**Fix:** correct all three alongside the code fixes; the header comments in this
codebase are load-bearing documentation and should be treated as such in review.

---

### IN-02: `test/image-normalize.test.js:150` asserts on module **source text**

**Issue:** The test reads the module source and regexes it to prove "HEIC/BMP are
DECODED FIRST, never sharp()-ed raw". This is brittle (any refactor or comment
edit can break or falsely satisfy it) and proves nothing about behaviour — it
would pass unchanged if the decode order were inverted at runtime via a helper.
**Fix:** replace with a behavioural assertion (feed a real HEIC/BMP and assert a
valid PNG out), which the file already does elsewhere.

---

### IN-03: Swallowed error objects with no debug-level logging

**File:** `lib/v1/worker.js:108-110`, `164-166`, `292-295`
**Issue:** Three `catch (e)` blocks bind `e` and never use it, logging only
`{ errorCode: 'internal_error' }`. OPS-05 justifies keeping detail out of the
default log, but with no `logger.debug({ err: e })` escape hatch there is
literally no way to diagnose a production crash from logs. Combined with WR-03
(client errors landing in this bucket), the operator is blind.
**Fix:** `jobLogger.debug({ err: { name: e?.name, message: e?.message } }, 'job crashed detail');`
— off at the default `info` level, available when needed.

---

### IN-04: `renderPage`'s `dpi` parameter is dead

**File:** `lib/v1/input/rasterize.js:84`, `91`
**Issue:** Per CR-06, `-scale-to` overrides `-r`, so the `dpi` option (and
`CAPS.RASTER_DPI`) cannot affect output. `test/rasterize.test.js:104` asserts the
flag is present in the argv, which is true but meaningless.
**Fix:** resolved by CR-06; once `-scale-to` is removed or replaced, delete or
re-point the assertion.

---

### IN-05: `application/pdf` sniff requires `%PDF` at byte 0

**File:** `lib/v1/sniff.js:18`
**Issue:** The PDF specification permits (and real-world producers emit) leading
bytes before the `%PDF-` header; poppler and PDF.js both accept it. Such a file
is rejected with a 422 "not an admitted document" even though the pipeline could
process it. Fail-closed is the right default, so this is informational rather
than a defect — but it is a plausible source of user-reported false rejections.
**Fix (if desired):** scan the first 1024 bytes for `%PDF-` rather than requiring
offset 0, matching poppler's tolerance.

---

_Reviewed: 2026-07-24_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
