/**
 * URL redaction for monitoring output
 *
 * Provider credentials live inside the endpoint URL itself (Infura uses
 * /v3/<key>, Alchemy uses /v2/<key>), so any endpoint that echoes TARGET_URL or
 * FALLBACK_URL hands out a working API key. The host is preserved because that
 * is what identifies the provider when reading the status page; only the parts
 * that can authenticate are masked.
 */

const MASK = '***';

// Query parameter names that carry credentials for the providers we talk to,
// plus the common spellings other providers use.
const SECRET_PARAMS = new Set([
  'key',
  'apikey',
  'api_key',
  'token',
  'access_token',
  'auth',
  'secret'
]);

/**
 * Heuristic for "this path segment is a credential, not a route".
 * Keys are long, opaque, and contain digits; route segments like 'v3' are short
 * and words like 'eth-mainnet' have no digits.
 * @param {string} segment - A single path segment
 * @returns {boolean}
 */
function looksLikeSecret(segment) {
  return segment.length >= 16 && /^[A-Za-z0-9_-]+$/.test(segment) && /\d/.test(segment);
}

/**
 * Mask credentials in a URL so it is safe to expose publicly.
 * Returns the input unchanged when there is nothing to redact, so URLs without
 * credentials are displayed exactly as configured.
 * @param {string} rawUrl - The URL to redact
 * @returns {string} The URL with any credentials replaced by '***'
 */
function redactUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;

  try {
    const url = new URL(rawUrl);
    let redacted = false;

    if (url.username || url.password) {
      if (url.username) url.username = MASK;
      if (url.password) url.password = MASK;
      redacted = true;
    }

    const segments = url.pathname.split('/');
    for (let i = 0; i < segments.length; i++) {
      if (looksLikeSecret(segments[i])) {
        segments[i] = MASK;
        redacted = true;
      }
    }
    if (redacted) url.pathname = segments.join('/');

    for (const name of [...url.searchParams.keys()]) {
      if (SECRET_PARAMS.has(name.toLowerCase())) {
        url.searchParams.set(name, MASK);
        redacted = true;
      }
    }

    return redacted ? url.toString() : rawUrl;
  } catch {
    // Unparseable input: mask the whole value rather than risk echoing a
    // credential we could not locate.
    return MASK;
  }
}

export { redactUrl };
