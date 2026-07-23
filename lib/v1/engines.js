// Shared engine/provider helpers. Previously findModel/envKeyFor/providerKeyPresent
// were duplicated byte-for-byte across server.js and router.js, so adding a provider
// meant editing the same logic in multiple places with silent-divergence risk (code
// review MR-03). This module is the single source of truth.
const models = require('../models');

// Which env var holds each provider's API key. Add a provider here once.
const PROVIDER_ENV = {
  ollama: 'OLLAMA_API_KEY',
  ocrspace: 'OCR_SPACE_API_KEY',
};

function findModel(modelId) {
  return models.find(m => m.id === modelId) || null;
}

// Returns the provider's configured API key, or null when unset/absent.
function envKeyFor(provider) {
  const envVar = PROVIDER_ENV[provider];
  return (envVar && process.env[envVar]) || null;
}

// Boolean form of envKeyFor for boot-time guards.
function providerKeyPresent(provider) {
  return Boolean(envKeyFor(provider));
}

module.exports = { findModel, envKeyFor, providerKeyPresent, PROVIDER_ENV };
