export function normalizeHostPattern(pattern) {
  if (typeof pattern !== 'string') {
    throw new Error('Host patterns must be strings.');
  }

  const normalized = pattern.trim().toLowerCase().replace(/\.$/, '');

  if (!normalized) {
    throw new Error('Host patterns cannot be empty.');
  }

  if (normalized.includes('://') || normalized.includes('/') || normalized.includes(':')) {
    throw new Error(`Host pattern must contain only a hostname: ${pattern}`);
  }

  if (normalized === '*' || normalized === '*.*') {
    throw new Error('Global wildcard host patterns are not allowed.');
  }

  const wildcard = normalized.startsWith('*.');
  const hostname = wildcard ? normalized.slice(2) : normalized;

  if (!hostname || hostname.includes('*')) {
    throw new Error(`Invalid host wildcard pattern: ${pattern}`);
  }

  return wildcard ? `*.${hostname}` : hostname;
}

export function normalizeHostPatterns(patterns) {
  if (!Array.isArray(patterns)) {
    throw new Error('allowed_hosts must be an array.');
  }

  return [...new Set(patterns.map(normalizeHostPattern))];
}

export function isHostnameAllowed(hostname, patterns) {
  const normalizedHostname = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');

  if (!normalizedHostname) {
    return false;
  }

  return patterns.some(pattern => {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2);
      return normalizedHostname !== suffix && normalizedHostname.endsWith(`.${suffix}`);
    }

    return normalizedHostname === pattern;
  });
}

export function assertAllowedUrl(rawUrl, patterns) {
  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http:// and https:// URLs are supported.');
  }

  if (!isHostnameAllowed(url.hostname, patterns)) {
    throw new Error(`Host is not allowed by savage_mcp: ${url.hostname}`);
  }

  return url;
}
