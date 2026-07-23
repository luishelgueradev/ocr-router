function mapErrorCode(result) {
  const s = result.status;
  const msg = (result.error || '').toLowerCase();

  if (s === 401 || /unauthorized|invalid api key/.test(msg))
    return { code: 'auth_failed', message: result.error };

  if (s === 403 || /subscription|quota/.test(msg))
    return { code: 'quota_exceeded', message: result.error };

  if (s === 404 || /model not found|not found/.test(msg))
    return { code: 'model_not_found', message: result.error };

  if (s === 429 || /rate limit/.test(msg))
    return { code: 'rate_limited', message: result.error, retryable: true };

  if (s === 502 || s === 503 || /unreachable|loading|bad gateway|econnrefused|enotfound|getaddrinfo|network|fetch failed/.test(msg))
    return { code: 'provider_unavailable', message: result.error, retryable: true };

  if (/tiempo de espera agotado/.test(msg))
    return { code: 'inference_timeout', message: result.error };

  return { code: 'provider_error', message: result.error };
}

module.exports = { mapErrorCode };
