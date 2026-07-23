/**
 * OTLP HTTP exporters POST to /v1/traces and /v1/metrics. If callers pass
 * only the OTLP base (e.g. http://collector:4318), append the required path.
 */

/** Strip trailing slashes without a regex to avoid ReDoS on adversarial input. */
function _stripTrailingSlashes(s: string): string {
  let i = s.length;
  while (i > 0 && s[i - 1] === '/') i--;
  return i < s.length ? s.slice(0, i) : s;
}

function _appendSignalPath(endpoint: string, exportPath: string): string {
  if (endpoint.endsWith('/')) {
    return endpoint + exportPath;
  }
  return `${endpoint}/${exportPath}`;
}

export function normalizeOtlpHttpTracesEndpoint(url: string | null | undefined): string {
  const u = String(url ?? '').trim();
  if (!u) return u;
  const base = _stripTrailingSlashes(u);
  if (base.toLowerCase().endsWith('v1/traces')) return base;
  return _appendSignalPath(base, 'v1/traces');
}

export function normalizeOtlpHttpMetricsEndpoint(url: string | null | undefined): string {
  const u = String(url ?? '').trim();
  if (!u) return u;
  const base = _stripTrailingSlashes(u);
  if (base.toLowerCase().endsWith('v1/metrics')) return base;
  return _appendSignalPath(base, 'v1/metrics');
}

/** OTLP collector base URL without ``/v1/traces`` (for Traceloop ``baseUrl``). */
export function otlpCollectorBaseForTraceloop(url: string | null | undefined): string {
  const u = _stripTrailingSlashes(String(url ?? '').trim());
  if (!u) return u;
  const lower = u.toLowerCase();
  if (lower.endsWith('/v1/traces')) {
    return _stripTrailingSlashes(u.slice(0, -'/v1/traces'.length));
  }
  return u;
}
