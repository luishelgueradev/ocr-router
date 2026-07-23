// test/cascade-heuristic.test.js
//
// CASC-03 / STATE risk-flag — the pure confidence heuristic's calibration
// suite. Table-driven over the 10 named fixtures (test/fixtures/heuristic),
// needing no images, no keys, and no network. Discharges the "false-good
// garbage detection" risk at the unit level: hard gates return 0, clean docs
// score high, and every score stays in [0,1].
//
// Also proves CASC-09 tunability: overriding an env threshold and re-requiring
// config flips a borderline fixture's pass/fail WITHOUT editing test logic.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeConfidence, passesThreshold } = require('../lib/v1/cascade/heuristic');
const { fixtures } = require('./fixtures/heuristic/fixtures');

const PROFILES = ['fast', 'balanced', 'quality'];

// ---------------------------------------------------------------------------
// Per-fixture: [0,1] invariant + expected band + pass/fail matrix (all profiles)
// ---------------------------------------------------------------------------
for (const fx of fixtures) {
  test(`fixture ${fx.name}: score is a finite number in [0,1]`, () => {
    const score = computeConfidence(fx.text, { overlay: fx.overlay });
    assert.equal(typeof score, 'number', `${fx.name} score must be a number`);
    assert.ok(Number.isFinite(score), `${fx.name} score must be finite, got ${score}`);
    assert.ok(score >= 0 && score <= 1, `${fx.name} score ${score} must be in [0,1]`);
  });

  test(`fixture ${fx.name}: score falls within its calibration band`, () => {
    const score = computeConfidence(fx.text, { overlay: fx.overlay });
    const [lo, hi] = fx.band;
    assert.ok(
      score >= lo && score <= hi,
      `${fx.name} score ${score} must be within band [${lo}, ${hi}]`
    );
  });

  test(`fixture ${fx.name}: passesThreshold matches the matrix for all profiles`, () => {
    const score = computeConfidence(fx.text, { overlay: fx.overlay });
    for (const profile of PROFILES) {
      assert.equal(
        passesThreshold(score, profile),
        fx.passes[profile],
        `${fx.name} @ ${profile}: expected passes=${fx.passes[profile]} (score ${score})`
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Hard-gate invariants (explicit, independent of bands)
// ---------------------------------------------------------------------------
test('hard gate: empty and whitespace-only text score exactly 0', () => {
  assert.equal(computeConfidence(''), 0);
  assert.equal(computeConfidence('   \n\t '), 0);
});

test('hard gate: garbage ratio > 0.30 scores exactly 0 and fails every profile', () => {
  const garbage = 'ab' + '�'.repeat(10);
  const score = computeConfidence(garbage);
  assert.equal(score, 0);
  for (const p of PROFILES) assert.equal(passesThreshold(score, p), false);
});

// ---------------------------------------------------------------------------
// Prototype-pollution guard (Pitfall 5 / T-02-01)
// ---------------------------------------------------------------------------
test('passesThreshold: unknown profile is not truthy (allowlist, no __proto__ lookup)', () => {
  assert.notEqual(passesThreshold(1, '__proto__'), true);
  assert.notEqual(passesThreshold(1, 'constructor'), true);
  assert.notEqual(passesThreshold(1, 'does-not-exist'), true);
});

// ---------------------------------------------------------------------------
// CASC-09 tunability proof: an env threshold override flips a borderline
// fixture WITHOUT editing test logic. near_empty ("OK") scores ~0.65: it
// clears balanced at the default 0.60, but fails when the threshold is raised.
// ---------------------------------------------------------------------------
test('tunability: raising PROFILE_BALANCED_THRESHOLD via env flips near_empty pass→fail', () => {
  const configPath = require.resolve('../lib/v1/cascade/config');
  const heuristicPath = require.resolve('../lib/v1/cascade/heuristic');
  const prev = process.env.PROFILE_BALANCED_THRESHOLD;

  try {
    // Baseline: default balanced threshold (0.60) → near_empty passes.
    delete require.cache[configPath];
    delete require.cache[heuristicPath];
    let h = require('../lib/v1/cascade/heuristic');
    const baseScore = h.computeConfidence('OK');
    assert.equal(h.passesThreshold(baseScore, 'balanced'), true, 'near_empty should pass balanced at 0.60');

    // Override the env, clear caches, re-require → near_empty now fails balanced.
    process.env.PROFILE_BALANCED_THRESHOLD = '0.70';
    delete require.cache[configPath];
    delete require.cache[heuristicPath];
    h = require('../lib/v1/cascade/heuristic');
    const tunedScore = h.computeConfidence('OK');
    assert.equal(h.passesThreshold(tunedScore, 'balanced'), false, 'near_empty should fail balanced at 0.70');
  } finally {
    if (prev === undefined) delete process.env.PROFILE_BALANCED_THRESHOLD;
    else process.env.PROFILE_BALANCED_THRESHOLD = prev;
    // Restore modules to default-config state for any later suites.
    delete require.cache[configPath];
    delete require.cache[heuristicPath];
    require('../lib/v1/cascade/heuristic');
  }
});
