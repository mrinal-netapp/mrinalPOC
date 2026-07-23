# Detection Thresholds

## Idle Volume Detection
- **Condition**: Average total IOPS (read + write) = 0 for 30 consecutive days
- **Action**: Recommend deletion (after verifying exclusion list)
- **Risk**: High (data loss if volume has unreferenced data)
- **Savings**: Full volume cost eliminated

## Under-Utilized Volume Detection
- **Condition**: Average total IOPS < 20% of QoS ceiling over 30 days
- **Action**: Recommend QoS downgrade or volume resize
- **Risk**: Low (performance headroom reduction only)
- **Savings**: Difference between current and recommended QoS tier

## Over-Provisioned Space Detection
- **Condition**: Peak space usage < 50% of allocated capacity over 90 days
- **Action**: Recommend resize to 150% of peak usage (safety margin)
- **Risk**: Low (still provides 50% growth headroom)
- **Minimum volume size**: Never resize below 100 GiB

## Snapshot Bloat Detection
- **Condition**: Snapshot reserve usage > 50% of volume data size
- **Action**: Recommend snapshot policy review + old snapshot cleanup
- **Risk**: Medium (snapshots may be needed for recovery)
- **Threshold exceptions**: Volumes with "backup" or "archive" in name

## Tier Mismatch Detection (ONTAP)
- **Condition**: FabricPool cold data < 10% of total volume data AND volume is on Premium/Extreme tier
- **Action**: Recommend enabling/tuning auto-tiering policy
- **Alternative condition**: Volume avg IOPS < Standard tier ceiling → recommend downgrade
- **Risk**: Low (auto-tiering is transparent to applications)

## Tier Mismatch Detection (GCNV)
- **Condition**: Average IOPS < Standard tier throughput ceiling for 30 days AND volume is Premium/Extreme
- **Action**: Recommend service level downgrade
- **Risk**: Low (can be reversed if workload increases)

## Quota Drift Detection
- **Condition**: Actual usage > 90% of quota hard limit
- **Action**: Alert (not a cost optimization — a risk warning)
- **Risk**: High (application failures if quota exceeded)
- **No cost savings**: This is a proactive warning, not an optimization

## Observation Windows
| Detection | Minimum Window | Recommended |
|-----------|---------------|-------------|
| Idle | 30 days | 30 days |
| Under-utilized | 30 days | 30 days |
| Over-provisioned | 90 days | 90 days |
| Snapshot bloat | 7 days | 14 days |
| Tier mismatch | 30 days | 30 days |
| Quota drift | Real-time | 1 day |
