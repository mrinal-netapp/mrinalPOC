/**
 * Derive a standard 5-field cron expression from a user-facing
 * KBSynchronizationConfig. Returned alongside the timezone so the
 * workflow-engine schedule API can be called unchanged.
 *
 * Notes:
 * - sync_mode='manual' or 'after_dataset_updates' returns null (no Temporal
 *   schedule should be created; the caller is expected to tear down any
 *   existing schedule).
 * - sync_mode='scheduled' switches on schedule_type:
 *   - cron pass-through (caller's cron_expression).
 *   - hourly maps interval_minutes to step form `0 *_/N * * *` where
 *     N = floor(interval_minutes / 60). The validator enforces
 *     interval_minutes >= 120 (i.e. 2 hours minimum).
 *   - daily/weekly/monthly use time_of_day (HH:mm). Minute precision only;
 *     seconds are not supported.
 * - When the schedule cannot be derived (missing required fields) the
 *   function returns null.
 */

import type { KBSynchronizationConfig } from '../models/KnowledgeBase';

export interface DerivedKBCron {
  cronExpression: string;
  timezone: string;
}

export function cronFromKBSync(cfg: KBSynchronizationConfig | null | undefined): DerivedKBCron | null {
  if (!cfg) return null;
  if (cfg.sync_mode !== 'scheduled') return null;

  const timezone = cfg.timezone && cfg.timezone.trim() !== '' ? cfg.timezone : 'UTC';

  switch (cfg.schedule_type) {
    case 'cron': {
      const expr = (cfg.cron_expression ?? '').trim();
      if (!expr) return null;
      return { cronExpression: expr, timezone };
    }
    case 'hourly': {
      const minutes = Number(cfg.interval_minutes);
      if (!Number.isFinite(minutes) || minutes < 60) return null;
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
      const dow = Array.isArray(cfg.day_of_week)
        ? cfg.day_of_week.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
        : [];
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
