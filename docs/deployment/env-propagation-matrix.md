# Cross-cloud env propagation matrix

This matrix documents how deploy-time environment variables flow from Make
targets into Helm command lines for each cloud entrypoint. **Run
`make verify-env-propagation` after changing any tier-set string to confirm
the matrix still holds.**

## Variables covered

- `IMAGE_TAG`
- `FORCE_PULL`
- `ENDPOINT`
- `HELM_EXTRA_ARGS`
- `OBSERVABILITY`
- `CERT_MANAGER_GATEWAY_TLS`
- `GATEWAY_LB_IP`
- `GATEWAY_MATCH_ALL_HOSTS`

## Tier-set propagation (`mk/tier-helm.mk`)

| Cloud | Tier-set variable | `IMAGE_TAG`                              | `FORCE_PULL`                              | `ENDPOINT`                                             |
| ----- | ----------------- | ---------------------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| local | `LOCAL_TIER_SET`  | `--set global.imageTag=$(IMAGE_TAG)`     | `--set global.imagePullPolicy=Always`     | `--set global.endpoint=… --set endpoint=…`             |
| aks   | `AKS_TIER_SET`    | `--set global.imageTag=$(IMAGE_TAG)`     | `--set global.imagePullPolicy=Always`     | **n/a in tier-set** (AKS routes via Workload Identity) |
| gke   | `GKE_TIER_SET`    | `--set global.imageTag=$(IMAGE_TAG)`     | `--set global.imagePullPolicy=Always`     | `--set global.endpoint=… --set endpoint=…`             |
| eks   | `EKS_TIER_SET`    | `--set global.imageTag=$(IMAGE_TAG)`     | `--set global.imagePullPolicy=Always`     | `--set global.endpoint=… --set endpoint=…`             |

`HELM_EXTRA_ARGS` is appended last by `helm_upgrade_tier`, so it retains
last-write-wins precedence over the tier-set defaults.

### Historical note — `LOCAL_TIER_SET` regression

Prior to the env-propagation hardening that landed alongside this matrix,
`LOCAL_TIER_SET` only emitted `--set global.imageRepository=…`. Running
`make deploy CLOUD=local IMAGE_TAG=v1.2.3 FORCE_PULL=1 ENDPOINT=studio.local`
silently dropped all three flags. The current matrix entry restores parity
with AKS/GKE/EKS; the `verify-env-propagation` target below was added at
the same time to prevent a future regression from going undetected.

## Deploy wrapper behavior

| Variable                   | local (`deploy-local`)                   | aks (`deploy-all-tiers-aks`)             | gke (`deploy-all-tiers-gke`)              | eks (`deploy-all-tiers-eks`)              |
| -------------------------- | ---------------------------------------- | ---------------------------------------- | ----------------------------------------- | ----------------------------------------- |
| `OBSERVABILITY`            | gates Phase 0                            | gates Phase 0                            | n/a in target body                        | gates Phase 0                             |
| `CERT_MANAGER_GATEWAY_TLS` | passed to `prepare-nemo-gateway.sh`      | passed to `prepare-nemo-gateway.sh`      | passed to `prepare-nemo-gateway.sh`       | passed to `prepare-nemo-gateway.sh`       |
| `ENDPOINT`                 | passed to gateway prep **+ tier-set**    | passed to gateway prep only              | passed to gateway prep **+ tier-set**     | passed to gateway prep **+ tier-set**     |
| `GATEWAY_LB_IP`            | not auto-wired as Helm `--set` in deploy | not auto-wired as Helm `--set` in deploy | not auto-wired as Helm `--set` in deploy  | not auto-wired as Helm `--set` in deploy  |
| `GATEWAY_MATCH_ALL_HOSTS`  | not auto-wired as Helm `--set` in deploy | not auto-wired as Helm `--set` in deploy | not auto-wired as Helm `--set` in deploy  | not auto-wired as Helm `--set` in deploy  |

For gateway chart-level behavior, pass explicit overrides through
`HELM_EXTRA_ARGS` (for example: `--set httproute.matchAllHosts=true`).

## Guardrail command

Use:

```bash
make verify-env-propagation \
  IMAGE_TAG=v0.0.0-test \
  FORCE_PULL=1 \
  ENDPOINT=studio-test.local \
  HELM_EXTRA_ARGS="--set foo=bar"
```

This runs `make -n` against the deploy entrypoints for local, AKS, GKE, and
EKS, and verifies that the expected `--set` tokens appear in the emitted
Helm command lines. AKS is allowed to drop ENDPOINT from the tier-set
(routes via Workload Identity instead of an explicit gateway host); every
other cloud must propagate all three vars. Exits 1 with a clear diagnostic
when any expected token is missing.

Run it as part of CI on any change to `mk/tier-helm.mk`, `mk/cloud/*.mk`, or
`mk/dispatch.mk` so silent drops never reach a release.
