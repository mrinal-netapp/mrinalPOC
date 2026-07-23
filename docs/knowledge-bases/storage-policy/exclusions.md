# Exclusion Rules

## Never Recommend Deletion

The following volumes must NEVER be recommended for deletion, regardless of utilization:

### Name Pattern Exclusions
- `*-prod-*` — Production workloads
- `*-dr-*` — Disaster recovery replicas
- `*-backup-*` — Backup targets
- `*-archive-*` — Long-term archives
- `*_repl_*` — Replication targets
- `rootvol*` — SVM root volumes

### Label/Tag Exclusions
- Volumes with label `critical=true`
- Volumes with label `do-not-optimize=true`
- Volumes with label `compliance-hold=true`

### Type Exclusions
- DP (data protection) volumes
- LS (load-sharing) mirrors
- Volumes smaller than 10 GiB (overhead not worth optimizing)

## Never Resize Below

- ONTAP: Never recommend resizing below 100 GiB
- GCNV: Never recommend resizing below the minimum pool allocation unit (1 TiB for Standard)

## Tier Change Exclusions

- Volumes with explicit QoS policy group `performance-guaranteed` — do not downgrade
- Volumes accessed by databases (detected via naming: `*-db-*`, `*-oracle-*`, `*-sql-*`) — require manual review flag

## Rate Limiting

- Maximum 10 resize operations per cluster per maintenance window
- Maximum 5 deletions per pipeline run (safety cap)
- No more than 20% of a cluster's volumes should be modified in a single run

## Cooldown Period

- After a volume is resized: exclude from further resize recommendations for 14 days
- After a tier change: exclude for 30 days
- After deletion recommendation is rejected: exclude for 90 days
