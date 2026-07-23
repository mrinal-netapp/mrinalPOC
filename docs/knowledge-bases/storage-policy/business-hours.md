# Business Hours Policy

## Destructive Operations Windows

Destructive operations (delete, major resize >30% reduction) are ONLY permitted during designated maintenance windows:

### APAC Region
- **Window**: Saturday 02:00–06:00 UTC
- **Clusters**: Any cluster with `region=apac` label or timezone offset +5 to +12

### EMEA Region
- **Window**: Sunday 04:00–08:00 UTC
- **Clusters**: Any cluster with `region=emea` label or timezone offset 0 to +3

### Americas Region
- **Window**: Sunday 06:00–10:00 UTC
- **Clusters**: Any cluster with `region=americas` label or timezone offset -8 to -3

## Non-Destructive Operations

The following may be executed at any time (24/7):
- QoS policy changes (soft limit adjustments)
- Snapshot creation (pre-action safety snapshots)
- Volume grow (increase size only)
- Tiering policy changes

## Pre-Action Requirements

Before any destructive operation:
1. Verify current time is within the applicable maintenance window
2. Create a pre-action snapshot named `opt-{recommendation_id}-{YYYYMMDD}`
3. If outside window: defer execution and set status to `deferred_business_hours`

## Holiday Blackout Dates (2026)

No destructive operations on:
- January 1 (New Year)
- Last Friday of March (fiscal year-end)
- December 24–January 2 (year-end freeze)

## Emergency Override

If a volume is at >95% capacity and growing, an emergency resize (grow only) may be executed outside business hours. This does NOT apply to shrink/delete operations.
