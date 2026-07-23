function resolveMode(model, requested) {
  const mode = (requested || model.default_mode || 'quality').toLowerCase();
  if (!model.modes_supported.includes(mode)) return { error: 'mode' };
  return { mode, preset: model.modes?.[mode] || null };
}

module.exports = { resolveMode };
