---
phase: 03-input-pipeline
plan: 03
subsystem: infra
tags: [subprocess, sandbox, abortsignal, sigkill, ulimit, temp-dir, shutdown, poppler, node-test]

# Dependency graph
requires:
  - phase: 02-cascade-router
    provides: "JOB-04 AbortController job deadline (the signal spawnCapture binds a child to)"
  - phase: 03-input-pipeline (03-01)
    provides: "lib/v1/input/caps.js — ULIMIT_V_KB, ULIMIT_CPU_SEC, RASTER_WALL_MS, MAX_RASTER_STDOUT_BYTES ceilings spawnCapture consumes"
provides:
  - "spawnCapture(cmd,args,opts) — the single injectable, sandboxed subprocess seam (ulimit + timeout + AbortSignal + SIGTERM→SIGKILL escalation + stdout ceiling)"
  - "Per-job temp-dir registry (createJobTempDir / cleanupJobTempDir / drainAllTempDirs) with mid-job-SIGTERM drain wired into shutdown.js"
affects: [03-04-rasterize, 03-06-page-pipeline, worker, shutdown]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Injectable spawnFn seam (D-11) so host node --test stubs the subprocess boundary — zero real poppler on host"
    - "Self-managed SIGTERM→SIGKILL grace timer (Node does not auto-escalate)"
    - "Module-level cleanup registry drained by graceful shutdown (deps-injection house style)"

key-files:
  created:
    - lib/v1/input/spawn-capture.js
    - lib/v1/input/temp.js
    - test/spawn-capture.test.js
    - test/temp.test.js
  modified:
    - lib/v1/shutdown.js
    - test/shutdown.test.js
    - package.json

key-decisions:
  - "ulimit -v (address space), NOT -m (RSS unenforced on modern Linux)"
  - "exec in the sh -c body is mandatory so the abort signal reaches poppler, not the shell (Pitfall 4 / T-03-05)"
  - "Worker owns the SIGTERM→SIGKILL escalation timer (unref'd) — Node has no built-in escalation (Assumption A2 / T-03-04)"
  - "Rejections carry only {code, signal, stderr-string} — never a captured buffer or key"
  - "Temp drain runs in its own try/catch inside drainAndCancel so a temp-rm failure never blocks the job drain"

patterns-established:
  - "spawnFn injection: default node:child_process spawn, overridable per-call for deterministic host tests"
  - "Best-effort idempotent cleanup: fs.rm({recursive,force}) + Promise.allSettled over a registry snapshot"

requirements-completed: [INP-08]

# Metrics
duration: ~18min
completed: 2026-07-23
---

# Phase 3 Plan 03: Subprocess Sandbox Seam + Temp-Dir Registry Summary

**The two highest-risk INP-08 safety primitives now exist and are proven on the host: a single mockable `spawnCapture` seam that sandboxes untrusted rendering (ulimit + timeout + AbortSignal + self-managed SIGKILL escalation + stdout ceiling), and a per-job temp-dir registry that graceful shutdown drains so a mid-job SIGTERM leaks nothing.**

## Performance

- **Duration:** ~18 min
- **Started:** 2026-07-23
- **Completed:** 2026-07-23
- **Tasks:** 2 completed (both TDD: RED → GREEN)
- **Files modified:** 7 (4 created, 3 modified)

## Accomplishments

### Task 1 — `spawnCapture`: the sandboxed, mockable subprocess seam
- `lib/v1/input/spawn-capture.js` exports `spawnCapture(cmd, args, { signal, ulimitKB, ulimitCpuSec, wallMs, killGraceMs, maxStdoutBytes, spawnFn })` → `Promise<Buffer>`.
- Real invocation wrapped as `spawnFn('/bin/sh', ['-c', "ulimit -v <KB>; ulimit -t <sec>; exec timeout -s KILL <n>s <cmd> <args>"], { signal, killSignal: 'SIGTERM', stdio: ['ignore','pipe','pipe'] })`.
  - `-v` (address space) not `-m`; `exec` mandatory (signal reaches poppler, not the shell); `timeout(1)` wall-clock backstop; `wallMs` rounded **up** to whole seconds.
- Binds the Phase-2 job `AbortSignal`; on abort arms an **unref'd** `killGraceMs` timer that calls `child.kill('SIGKILL')` (Node does not auto-escalate). Timer cleared on close/error.
- `maxStdoutBytes` ceiling: a runaway child is SIGKILL'd and the promise rejects `output_pixel_cap_exceeded`.
- Rejections carry only `{ code, signal, stderr-string }` — no buffer/key leak (asserted).
- `spawnFn` injectable (D-11): all 7 host tests run with a fake `EventEmitter` ChildProcess — **zero real subprocesses**.

### Task 2 — Per-job temp-dir registry drained by graceful shutdown
- `lib/v1/input/temp.js` exports `createJobTempDir` (mkdtemp under `os.tmpdir()`, prefix `ocr-job-`, registered), `cleanupJobTempDir` (deregister + `fs.rm` recursive/force, idempotent), `drainAllTempDirs` (`Promise.allSettled` best-effort rm over a snapshot, then clear).
- `lib/v1/shutdown.js drainAndCancel` now drains the registry inside its shutdown sequence, wrapped in its own try/catch so a temp-rm failure never blocks the job drain. The in-flight-`pending`-promise de-dupe and deps-injection (`deps.temp` seam) are intact — no module boolean reintroduced.
- Mid-job-SIGTERM case proven: a dir registered before `drainAndCancel` is gone from disk afterward while the existing `shutdown_cancelled` job-drain semantics stay green.

## Deviations from Plan

**1. [Rule 2 — missing critical functionality] Injectable `deps.temp` seam in shutdown.js**
- The plan said to `require('./input/temp')` directly in `drainAndCancel`. Added a `deps.temp || require('./input/temp')` injection point to match the module's existing `deps`-injection house style (keeps the drain unit-testable without the singleton, consistent with `deps.jobs`/`deps.limiter`). No behavior change; the real path still resolves the singleton.
- **Files:** lib/v1/shutdown.js
- **Commit:** 05c6238

Otherwise the plan executed as written.

## Test Results

- `node --test test/spawn-capture.test.js` → **7 pass / 0 fail**, zero real subprocesses (fake `spawnFn` only). Asserts the `ulimit -v` / `ulimit -t` / `exec timeout -s KILL` wrapper, the SIGKILL escalation, the `maxStdoutBytes` path, and no-buffer/key rejections.
- `node --test test/temp.test.js` → **4 pass / 0 fail** on real host fs (create/exists, cleanup/gone + idempotent, drain-all, best-effort missing-dir).
- `node --test test/shutdown.test.js` → **7 pass / 0 fail** — new mid-job-SIGTERM temp-drain case green AND all pre-existing shutdown tests still green.
- **Full suite `npm test` → 280 pass / 0 fail** (268 baseline + 12 new). New test files registered in `package.json`.

## Threat Model Coverage (INP-08)

| Threat ID | Mitigation delivered |
|-----------|----------------------|
| T-03-04 (hung/looping renderer) | AbortSignal binds child kill + `timeout -s KILL` backstop + self-managed SIGTERM→SIGKILL escalation timer |
| T-03-05 (orphaned child after abort) | `exec` in the sh -c body so the signal reaches poppler directly (`tini` reaps stragglers) |
| T-03-06 (malicious decoder) | `ulimit -v` (address space) + `ulimit -t` (CPU sec) kernel caps |
| T-03-07 (temp-file/disk exhaustion) | Registry drained by `drainAndCancel` on SIGTERM + idempotent `force:true` rm |

## Known Stubs

None. Both primitives are complete and independently testable; downstream plans (03-04 rasterize, 03-06 page-pipeline) will consume them.

## Docker-gated follow-ups (not host gates, per D-11)

- Real-poppler rasterization through `spawnCapture`, and the concrete `ulimit -v` numeric sizing (Assumption A1), remain a Docker integration smoke — recorded, not a host-suite gate.

## Self-Check: PASSED

- FOUND: lib/v1/input/spawn-capture.js
- FOUND: lib/v1/input/temp.js
- FOUND: test/spawn-capture.test.js
- FOUND: test/temp.test.js
- FOUND commit 26b6032 (test: spawnCapture)
- FOUND commit 9f95b0c (feat: spawnCapture)
- FOUND commit efeaa28 (test: temp/shutdown)
- FOUND commit 05c6238 (feat: temp registry + shutdown wiring)
