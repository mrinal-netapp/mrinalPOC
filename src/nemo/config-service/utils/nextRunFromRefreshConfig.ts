/**
 * Compute the next scheduled run for a dataset from its user-facing
 * DatasetRefreshConfig, without requiring an external cron-parser library.
 *
 * Works on the structured fields (schedule_type, interval_minutes, time_of_day,
 * day_of_week, day_of_month) so no cron-string parsing is needed. Returns an
 * ISO-8601 string or null.
 *
 * Mirrors the knowledge-base `nextRunFromSyncConfig` helper so datasets and KBs
 * surface a consistent "next scheduled synchronization" value. Non-UTC and raw
 * `cron` schedules return null (accurate next-run for those needs a tz-aware
 * cron parser).
 */

import type { DatasetRefreshConfig } from '../models/DataSet';

export function nextRunFromRefreshConfig(
  cfg: DatasetRefreshConfig | null | undefined,
): string | null {
  // No schedule, auto-refresh disabled, or paused → no upcoming run.
  if (!cfg || !cfg.auto_refresh_enabled || cfg.paused) return null;

  // Only compute next-run for UTC schedules. Non-UTC timezone-aware computation
  // requires a tz library; returning a UTC-based time for a non-UTC schedule
  // would be incorrect, so we bail out early for those cases.
  const tz = cfg.timezone ?? 'UTC';
  if (tz !== 'UTC' && tz !== 'utc') return null;

  const now = new Date();

  if (cfg.schedule_type === 'hourly' && cfg.interval_minutes) {
    // Always produce a time strictly in the future by advancing to the next
    // interval boundary after the current one.
    const intervalMs = cfg.interval_minutes * 60 * 1000;
    const next = new Date(Math.floor(now.getTime() / intervalMs) * intervalMs + intervalMs);
    return next.toISOString();
  }

  if (cfg.schedule_type === 'cron') {
    // Without a cron-parser library we can't compute this for arbitrary expressions.
    return null;
  }

  // daily / weekly / monthly — time_of_day is "HH:MM" in UTC
  const [hStr, mStr] = (cfg.time_of_day ?? '00:00').split(':');
  const h = parseInt(hStr ?? '0', 10);
  const m = parseInt(mStr ?? '0', 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;

  if (cfg.schedule_type === 'daily') {
    const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
    if (candidate <= now) candidate.setUTCDate(candidate.getUTCDate() + 1);
    return candidate.toISOString();
  }

  if (cfg.schedule_type === 'weekly' && cfg.day_of_week?.length) {
    const days = cfg.day_of_week.slice().sort((a, b) => a - b);
    let best: Date | null = null;
    for (const dow of days) {
      const diff = (dow - now.getUTCDay() + 7) % 7;
      const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diff, h, m));
      if (candidate <= now) candidate.setUTCDate(candidate.getUTCDate() + 7);
      if (!best || candidate < best) best = candidate;
    }
    return best ? best.toISOString() : null;
  }

  if (cfg.schedule_type === 'monthly' && cfg.day_of_month) {
    // Coerce to integer — day_of_month may arrive as a string when the body is
    // persisted as-is before the Number() coercion in the validator runs.
    const dom = Math.trunc(Number(cfg.day_of_month));
    if (!Number.isFinite(dom) || dom < 1 || dom > 31) return null;
    let year = now.getUTCFullYear();
    let month = now.getUTCMonth();
    // Iterate up to 14 months to find a month where the requested day exists
    // and is strictly in the future (handles months shorter than dom, e.g. day
    // 31 in April overflows without this check).
    for (let attempts = 0; attempts < 14; attempts++) {
      if (month > 11) { month = 0; year += 1; }
      const candidate = new Date(Date.UTC(year, month, dom, h, m));
      // If JS date-overflow occurred (dom > days in month), skip this month.
      if (candidate.getUTCDate() !== dom) {
        month += 1;
        continue;
      }
      if (candidate > now) return candidate.toISOString();
      month += 1;
    }
    return null;
  }

  return null;
}
