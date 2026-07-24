// The service's clock, split by what each caller actually needs.
//
// WHY THIS EXISTS
// Every budget, deadline and duration in the service used to be computed from
// `Date.now()` — the WALL clock, which is not monotonic. NTP steps it, and so
// does a VM resume; on a suspended/resumed VPS the jump can be large. Reproduced
// on this codebase, from a real failing run of the CASC-08 budget test:
//
//   DBG-FAIL stopped_reason=passed elapsed=-791
//   DBG-attempts=[{"engine":"ocrspace-engine2","time_ms":-791,...}]
//
// The wall clock stepped ~1.1s BACKWARD mid-run, so the runner's
// `remaining = deadline - Date.now()` INFLATED past minSliceMs and it escalated
// to a tier the budget had already spent. The same arithmetic backs the worker's
// `deadline = Date.now() + CAPS.MAX_JOB_MS` — the single authoritative job
// deadline JOB-04/CASC-08 exist to enforce. A backward step lets a job run past
// MAX_JOB_MS; a forward step kills jobs that still had budget left. Negative
// durations also leak straight into traces and logs.
//
// THE RULE
//   monotonicMs() — anything measuring ELAPSED TIME or bounding a DEADLINE.
//                   Never goes backward, so a difference of two readings is
//                   always a real, non-negative duration.
//   wallMs()      — only for absolute timestamps a CLIENT will read (e.g. a job's
//                   `expires_at`). Those genuinely must track civil time, which
//                   is exactly why they must not be used for arithmetic.
//
// Do not reach for `Date.now()` directly in duration or deadline code. Call
// through this module object (`clock.monotonicMs()`, not a destructured
// binding) so tests can substitute the clock — see test/clock.test.js.
//
// `performance.now()` is a Node global backed by a monotonic source and returns
// fractional milliseconds since process start. Callers reporting a duration to a
// client or a log should round it; internal arithmetic can use it as-is.

const clock = {
  /**
   * Monotonic milliseconds. Immune to wall-clock steps. Only meaningful as a
   * DIFFERENCE between two readings — the origin is process start, not an epoch.
   *
   * @returns {number} fractional ms from a monotonic source
   */
  monotonicMs() {
    return performance.now();
  },

  /**
   * Wall-clock milliseconds since the Unix epoch. For absolute timestamps only,
   * never for measuring elapsed time or bounding a deadline.
   *
   * @returns {number} ms since epoch
   */
  wallMs() {
    return Date.now();
  },
};

module.exports = clock;
