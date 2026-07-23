/**
 * Canonical level strings and ordering aligned with the Python client
 * (structlog / LogLevel enum). Stored JSON field is always the canonical
 * name (e.g. "warning", not "warn").
 */

export const LogLevel = Object.freeze({
  DEBUG: 'debug',
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical',
  EXCEPTION: 'exception',
} as const);

export type LogLevelValue = (typeof LogLevel)[keyof typeof LogLevel];

/** Rank for min_log_level filtering (lower = more verbose). Matches Python LEVEL_RANK. */
export const LEVEL_RANK: Readonly<Record<string, number>> = Object.freeze({
  trace: 5,
  debug: 10,
  info: 20,
  warning: 30,
  error: 40,
  exception: 40,
  critical: 50,
});

export const VALID_MIN_LOG_LEVEL_KEYS: ReadonlyArray<string> = Object.freeze(
  Object.keys(LEVEL_RANK),
) as ReadonlyArray<string>;

/** Lowercase; map ``warn`` → ``warning``, ``fatal`` → ``critical`` (Python normalize_level_name). */
export function normalizeLevelName(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'warn') return 'warning';
  if (s === 'fatal') return 'critical';
  return s;
}
