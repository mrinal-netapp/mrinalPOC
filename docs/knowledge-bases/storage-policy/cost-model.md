# Storage Cost Model

## ONTAP On-Premises

| Tier | $/GiB/month | Notes |
|------|-------------|-------|
| SSD (Performance) | $0.08 | AFF A-series, all-flash |
| HDD (Capacity) | $0.03 | FAS series, spinning disk |
| FabricPool Cold (Object) | $0.01 | Auto-tiered to S3-compatible |
| Snapshot (Differential) | $0.005 | Only delta blocks charged |

### QoS Service Levels (ONTAP)
- **Extreme**: 12,800 IOPS/TiB, ≤1ms latency — $0.12/GiB/month
- **Premium**: 6,400 IOPS/TiB, ≤2ms latency — $0.08/GiB/month
- **Standard**: 1,600 IOPS/TiB, ≤4ms latency — $0.05/GiB/month

## Google Cloud NetApp Volumes (GCNV)

| Service Level | $/GiB/month | Throughput |
|---------------|-------------|------------|
| Standard | $0.10 | 16 MiB/s per TiB |
| Premium | $0.20 | 64 MiB/s per TiB |
| Extreme | $0.30 | 128 MiB/s per TiB |

### GCNV Snapshot Cost
- Snapshots: $0.02/GiB/month (consumed space only)

## Cost Calculation Rules

1. **Monthly savings from resize**: `(current_size - recommended_size) * tier_cost`
2. **Monthly savings from tier change**: `volume_size * (current_tier_cost - recommended_tier_cost)`
3. **Monthly savings from deletion**: `volume_size * tier_cost + snapshot_size * snapshot_cost`
4. **Monthly savings from consolidation**: Only if multiple underutilized volumes merge to fewer, larger volumes with better packing efficiency

## Currency
All costs in USD. Convert regional pricing variations using published NetApp/GCP price lists.
