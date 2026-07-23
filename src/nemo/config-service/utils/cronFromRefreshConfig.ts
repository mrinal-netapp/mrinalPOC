/**
 * Derive a standard 5-field cron expression from a user-facing
 * DatasetRefreshConfig. Returned alongside the timezone so the
 * workflow-engine schedule API can be called unchanged.
 *
 * Notes:
 * - cron schedule_type is pass-through (the caller's cron_expression).
 * - hourly maps interval_minutes to the step form "0 *_/N * * *" where
 *   N = floor(interval_minutes / 60). The validator enforces
 *   interval_minutes >= 120 (i.e. 2 hours minimum).
 * - daily/weekly/monthly use time_of_day (HH:mm). Minute precision only;
 *   seconds are not supported.
 * - When the schedule cannot be derived (auto_refresh_enabled=false or
 *   paused=true) the function returns null and the caller is expected to
 *   tear down any existing Temporal schedule instead.
 */

import type { DatasetRefreshConfig } from '../models/DataSet';

export interface DerivedCron {
  cronExpression: string;
  timezone: string;
}

export function cronFromRefreshConfig(cfg: DatasetRefreshConfig | null | undefined): DerivedCron | null {
  if (!cfg) return null;
  if (!cfg.auto_refresh_enabled) return null;
  if (cfg.paused) return null;

  const timezone = cfg.timezone && cfg.timezone.trim() !== '' ? cfg.timezone : 'UTC';

  switch (cfg.schedule_type) {
    case 'cron': {
      const expr = (cfg.cron_expression ?? '').trim();
      if (!expr) return null;
      return { cronExpression: expr, timezone };
    }
    case 'hourly': {
      const minutes = Number(cfg.interval_minutes);
      // Mirror the validator's minimum of 120 minutes (2h). Anything below is
      // rejected so the derived step never collapses to every-hour unexpectedly.
      if (!Number.isFinite(minutes) || minutes < 120) return null;
      const hours = Math.max(1, Math.floor(minutes / 60));
      return { cronExpression: `0 */${hours} * * *`, timezone };
    }
    case 'daily': {
      const tod = parseHHmm(cfg.time_of_day);
      if (!tod) return null;
      return { cronExpression: `${tod.minute} ${tod.hour} * * *`, timezone };
    }
    case 'weekly': {
      const tod = parseHHmm(cfg.time_of_day);
      const dow = Array.isArray(cfg.day_of_week) ? cfg.day_of_week.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
      if (!tod || dow.length === 0) return null;
      return { cronExpression: `${tod.minute} ${tod.hour} * * ${dow.join(',')}`, timezone };
    }
    case 'monthly': {
      const tod = parseHHmm(cfg.time_of_day);
      const dom = Number(cfg.day_of_month);
      if (!tod || !Number.isInteger(dom) || dom < 1 || dom > 31) return null;
      return { cronExpression: `${tod.minute} ${tod.hour} ${dom} * *`, timezone };
    }
    default:
      return null;
  }
}

function parseHHmm(s: string | undefined): { hour: number; minute: number } | null {
  if (!s || typeof s !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}
