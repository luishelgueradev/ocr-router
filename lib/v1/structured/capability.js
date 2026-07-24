// STR-01 — structured-capability lookups over the declarative capability table.
//
// mode=structured must run ONLY on engines whose `supports_structured` flag is
// true (the vision LLMs). This module reads that flag from cascade/config.js —
// there is deliberately NO engine-id branching here or downstream, so adding a
// structured-capable provider is a one-line config edit (CASC-09).

const CONFIG = require('../cascade/config');

/**
 * Is this engine id capable of schema-constrained structured decoding?
 * Unknown ids are NOT capable (fail closed).
 * @param {string} engineId
 * @returns {boolean}
 */
function supportsStructured(engineId) {
  return CONFIG.capabilities[engineId]?.supports_structured === true;
}

/**
 * The profile's chain, filtered to structured-capable engines, order preserved.
 * ocr.space drops out; the Ollama tiers stay in their cheapest-first order so a
 * structured run escalates exactly as the text cascade does.
 *
 * @param {string} profileName
 * @returns {string[]} ordered structured-capable engine ids (possibly empty)
 */
function structuredChain(profileName) {
  const prof = Object.hasOwn(CONFIG.profiles, profileName)
    ? CONFIG.profiles[profileName]
    : CONFIG.profiles[CONFIG.defaultProfile];
  return prof.chain.filter(supportsStructured);
}

module.exports = { supportsStructured, structuredChain };
