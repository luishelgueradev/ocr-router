// lib/v1/cascade/config.js
//
// D-01 / CASC-09 — Routing is DATA, not branches. This module is the single
// declarative source of truth for the cascade: the ordered per-profile chains,
// the engine capability table, the confidence heuristic's thresholds/weights/
// bounds, and the runner's deadline bounds. Adding/reordering an engine or
// tuning a threshold is a config edit here — never a code branch elsewhere.
//
// There is DELIBERATELY no `if`/`switch` that selects an engine or profile in
// this file: every routing decision downstream indexes this data via an
// allowlist (Object.hasOwn). See heuristic.js#passesThreshold and the plan's
// grep gate.
//
// Engine ids are reused verbatim from lib/models.js (ocrspace-engine2,
// ollama-gemini-3-flash, ollama-gemma4-31b, ollama-qwen3-vl-235b).

const { intFromEnv, floatFromEnv } = require('../env');

const CONFIG = {
  // --- Confidence heuristic thresholds / bounds / weights (CASC-03) ---------
  // All env-overridable so calibration needs no code change (D-02).
  // NOTE: threshold NUMBERS below are LOW-confidence starting values pending a
  // live-key calibration spike (deferred ops task, not a code blocker). The
  // formula shape is HIGH-confidence; only the constants await tuning.
  heuristic: {
    absMinChars:     intFromEnv('HEURISTIC_MIN_CHARS', 1),    // <= this after trim ⇒ EMPTY hard-gate → 0
    goodChars:       intFromEnv('HEURISTIC_GOOD_CHARS', 16),  // length fully satisfied at/above this
    goodWords:       intFromEnv('HEURISTIC_GOOD_WORDS', 4),   // overlay word-count fully satisfied at/above this
    maxGarbageRatio: floatFromEnv('HEURISTIC_MAX_GARBAGE', 0.30), // > this ⇒ GARBAGE hard-gate → 0
    // Weighted soft score over PRESENT signals; overlay is dropped + weights
    // renormalized when overlay is absent (all LLM tiers). D-03 (amended):
    // the overlay signal is a WORD COUNT proxy, never a real confidence.
    w: { printable: 0.5, length: 0.3, overlay: 0.2 },
  },

  // --- Named profiles (D-06) — declarative chain slice + threshold ----------
  // chain: ordered engine ids the runner walks (cheapest tier first).
  // threshold: min confidence to STOP at a tier (higher ⇒ escalates more).
  //   LOW-confidence starting numbers (0.50/0.60/0.70), env-overridable.
  // maxAttempts / budgetMs: independent bounds enforced by the runner (CASC-08).
  profiles: {
    fast: {
      chain: ['ocrspace-engine2', 'ollama-gemini-3-flash'],
      threshold: floatFromEnv('PROFILE_FAST_THRESHOLD', 0.50),
      maxAttempts: 2,
      budgetMs: 30000,
    },
    balanced: {
      chain: ['ocrspace-engine2', 'ollama-gemini-3-flash', 'ollama-gemma4-31b'],
      threshold: floatFromEnv('PROFILE_BALANCED_THRESHOLD', 0.60),
      maxAttempts: 3,
      budgetMs: 60000,
    },
    quality: {
      chain: ['ocrspace-engine2', 'ollama-gemini-3-flash', 'ollama-gemma4-31b', 'ollama-qwen3-vl-235b'],
      threshold: floatFromEnv('PROFILE_QUALITY_THRESHOLD', 0.70),
      maxAttempts: 4,
      budgetMs: 120000,
    },
  },

  // Unspecified request → balanced (D-06).
  defaultProfile: 'balanced',

  // --- Engine capability table (D-07 / CASC-06) -----------------------------
  // Keyed by engine id. `supports_structured` is included now (false for every
  // engine) so Phase 4's structured mode is purely additive — no schema change.
  capabilities: {
    'ocrspace-engine2':      { provider: 'ocrspace', modes: ['quality'],           supports_structured: false },
    'ollama-gemini-3-flash': { provider: 'ollama',   modes: ['speed', 'quality'],  supports_structured: false },
    'ollama-gemma4-31b':     { provider: 'ollama',   modes: ['speed', 'quality'],  supports_structured: false },
    'ollama-qwen3-vl-235b':  { provider: 'ollama',   modes: ['speed', 'quality'],  supports_structured: false },
  },

  // --- Runner deadline bounds (JOB-04 / CASC-08) ----------------------------
  // Single authoritative job deadline; per-engine slice = min(perEngineMs,
  // remaining). If remaining <= minSliceMs the runner stops (budget exhausted).
  minSliceMs: intFromEnv('CASCADE_MIN_SLICE_MS', 500),
  perEngineMs: intFromEnv('CASCADE_PER_ENGINE_MS', 30000),
};

module.exports = CONFIG;
