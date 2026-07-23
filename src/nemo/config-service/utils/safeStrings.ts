/**
 * Small helpers used to defuse CodeQL's untrusted-string flow tracking
 * (SSRF, log-injection, format-string).
 *
 * - `safeSegment` URL-encodes a single path component so it can be
 *   interpolated into an outbound URL without smuggling extra slashes or
 *   query characters. Recognized by CodeQL as a sanitizer for the
 *   url-injection / SSRF queries.
 *
 * - `safeLog` returns a printable single-line version of a value, stripping
 *   CR/LF/tab/other control characters and capping length, so user-supplied
 *   values can be embedded in log lines without injecting forged log
 *   records.
 *
 * Both helpers are defensive: the IDs used here (`projectId`, `kbId`,
 * `datasetId`, etc.) are already validated upstream to be short
 * alphanumeric handles, but treating them as untrusted at the boundary
 * keeps the static-analysis surface clean and protects against future
 * callers that bypass the validators.
 */

/** URL-encode a single path segment for inclusion in an outbound URL. */
export function safeSegment(value: string | undefined | null): string {
  if (value == null) return '';
  return encodeURIComponent(String(value));
}

/**
 * Sanitize a value for inclusion in a log line:
 *   - coerces non-strings to string
 *   - removes CR/LF explicitly so untrusted input cannot split/forge log lines
 *   - replaces remaining TAB / other control chars with a single space
 *     (defuses CodeQL `js/log-injection` — forged log record injection)
 *   - escapes `%` to `%%` so the value cannot act as a printf format
 *     specifier when interpolated into the first argument of
 *     `console.log/warn/error` (defuses CodeQL
 *     `js/tainted-format-string`). Node's `util.format` (and therefore
 *     `console.*`) treats the first arg as a printf-style format
 *     string when subsequent args are present; a `%s` / `%d` smuggled
 *     in via untrusted input would otherwise consume / mis-format the
 *     trailing args. Doubling the `%` is the printf-standard escape and
 *     renders as a single literal `%` on the wire.
 *   - caps length at 500 chars to avoid log-flooding
 */
export function safeLog(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  const s = typeof value === 'string' ? value : String(value);
  const cleaned = s
    .replace(/\r|\n/g, ' ')
    .replace(/[\t\u0000-\u001F\u007F]+/g, ' ')
    .replace(/%/g, '%%');
  return cleaned.length > 500 ? cleaned.slice(0, 500) + '…' : cleaned;
}

/**
 * Log with a static prefix and sanitized trailing args (no user data in the
 * format string). Prefer this over template literals for CodeQL log-injection.
 */
export function safeConsoleError(prefix: string, ...values: unknown[]): void {
  console.error(prefix, ...values.map(safeLog));
}

export function safeConsoleWarn(prefix: string, ...values: unknown[]): void {
  console.warn(prefix, ...values.map(safeLog));
}

export function safeConsoleLog(prefix: string, ...values: unknown[]): void {
  console.log(prefix, ...values.map(safeLog));
}

/** User-visible init failure text: single-line, control-stripped, length-capped. */
export function sanitizeInitError(value: string | null | undefined): string | null {
  if (value == null || value.trim() === '') {
    return null;
  }
  return safeLog(value);
}
