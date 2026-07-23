# Storage Best Practices

## Aggregate Management (ONTAP)
- Aggregate fill level should not exceed 85% (performance degradation above this)
- Leave at least 10% free space in aggregates for WAFL reserves
- Distribute volumes across aggregates for balanced I/O

## QoS Best Practices (ONTAP)
- QoS floor should be at least 10% of ceiling (prevents starvation)
- Never set QoS ceiling below the volume's average IOPS over 7 days
- Use adaptive QoS policies where available (scales with volume size)

## Snapshot Retention
- **Daily snapshots**: Retain 7
- **Weekly snapshots**: Retain 4
- **Monthly snapshots**: Retain 3 (for compliance-tagged volumes only)
- **Pre-action snapshots**: Retain 14 days, then auto-delete

## Volume Sizing
- Provision at 150% of expected peak usage
- Never auto-shrink below 80% of current used space
- Growth rate extrapolation: use 90th percentile of daily growth over 30 days

## GCNV Specific
- Storage pool utilization should stay below 80%
- Prefer Standard tier for workloads with < 128 IOPS/GiB
- Use volume snapshots before any tier change (provides rollback path)
- Minimum recommended volume size: 100 GiB (below this, management overhead exceeds savings)

## Tiering (FabricPool)
- Enable auto tiering policy for volumes with > 50% cold data
- Cold data threshold: no access for 31 days (default cooling period)
- Never tier volumes with random read patterns (causes retrieval latency spikes)

## Safety Protocol for Automated Actions
1. Always create a snapshot before resize or delete
2. Verify the action target exists and matches expected state
3. Confirm no active I/O during delete (check last-access-time < 48h ago)
4. Report success/failure per operation
5. On any failure: STOP processing remaining recommendations (fail-fast)

## Naming Conventions
- Pre-action snapshots: `opt-{recommendation_id}-{YYYYMMDD}`
- Optimization reports: stored as pipeline output, not as volume metadata
