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

function hostPatternMatches(hostname, pattern) {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return hostname !== suffix && hostname.endsWith(`.${suffix}`);
  }

  return hostname === pattern;
}

export function matchingHostPattern(hostname, patterns) {
  const normalizedHostname = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');

  if (!normalizedHostname) {
    return null;
  }

  const matches = patterns.filter(pattern => hostPatternMatches(normalizedHostname, pattern));

  matches.sort((a, b) => {
    const aExact = a.startsWith('*.') ? 0 : 1;
    const bExact = b.startsWith('*.') ? 0 : 1;

    if (aExact !== bExact) {
      return bExact - aExact;
    }

    return b.length - a.length;
  });

  return matches[0] ?? null;
}

export function isHostnameAllowed(hostname, patterns) {
  return matchingHostPattern(hostname, patterns) !== null;
}

export function normalizePathPattern(pattern) {
  if (typeof pattern !== 'string') {
    throw new Error('Path patterns must be strings.');
  }

  const normalized = pattern.trim();

  if (!normalized || !normalized.startsWith('/')) {
    throw new Error(`Path pattern must start with "/": ${pattern}`);
  }

  if (normalized.includes('?') || normalized.includes('#')) {
    throw new Error(`Path pattern must not contain a query or fragment: ${pattern}`);
  }

  if (normalized.endsWith('/**')) {
    const base = normalized.slice(0, -3);

    if (base.includes('*')) {
      throw new Error(`Only a trailing /** wildcard is supported in path patterns: ${pattern}`);
    }
  } else if (normalized.includes('*')) {
    throw new Error(`Only a trailing /** wildcard is supported in path patterns: ${pattern}`);
  }

  return normalized;
}

export function normalizeAllowedPaths(value, allowedHosts) {
  if (value == null) {
    return {};
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('allowed_paths must be an object keyed by allowed host pattern.');
  }

  const allowedHostSet = new Set(allowedHosts);
  const entries = [];

  for (const [rawHostPattern, pathPatterns] of Object.entries(value)) {
    const hostPattern = normalizeHostPattern(rawHostPattern);

    if (!allowedHostSet.has(hostPattern)) {
      throw new Error(`allowed_paths key must also appear in allowed_hosts: ${hostPattern}`);
    }

    if (!Array.isArray(pathPatterns)) {
      throw new Error(`allowed_paths[${JSON.stringify(hostPattern)}] must be an array.`);
    }

    entries.push([
      hostPattern,
      [...new Set(pathPatterns.map(normalizePathPattern))]
    ]);
  }

  return Object.fromEntries(entries);
}

export function isPathAllowed(pathname, pathPatterns) {
  if (!Array.isArray(pathPatterns) || pathPatterns.length === 0) {
    return true;
  }

  return pathPatterns.some(pattern => {
    if (!pattern.endsWith('/**')) {
      return pathname === pattern;
    }

    const base = pattern.slice(0, -3);

    if (!base) {
      return true;
    }

    return pathname === base || pathname.startsWith(`${base}/`);
  });
}

export function assertAllowedUrl(rawUrl, hostPatterns, allowedPaths = {}) {
  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http:// and https:// URLs are supported.');
  }

  const hostPattern = matchingHostPattern(url.hostname, hostPatterns);

  if (!hostPattern) {
    throw new Error(`Host is not allowed by savage_mcp: ${url.hostname}`);
  }

  if (!isPathAllowed(url.pathname, allowedPaths[hostPattern])) {
    throw new Error(`Path is not allowed by savage_mcp for ${hostPattern}: ${url.pathname}`);
  }

  return url;
}
