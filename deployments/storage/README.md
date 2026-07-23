# Trident storage (deployments-native)

Layer 2 bootstrap for AgentStudio cloud environments. **Re-run safe:** each invocation applies desired state; existing healthy resources are logged and left in place unless spec drift requires recreation.

```bash
make storage CLOUD=azure ENV=preprod
make storage CLOUD=aws   ENV=preprod
make storage CLOUD=gcp   ENV=preprod
```

## Layout

```text
deployments/storage/
  storage.sh              # thin dispatcher (--cloud --env)
  lib/
    reconcile.py          # kubectl/helm ensure helpers
    render.py             # manifest template render
    kubeconfig.py         # cloud CLI kubeconfig fetch
    azure_anf.py          # Azure ANF reconcile
    aws_fsxn.py           # AWS FSxN reconcile
    gcp_gcnv.py           # GKE GCNV NAS/SAN reconcile
    gcp_san_hosts.py      # SAN node iSCSI prep
  manifests/              # git-checked .yaml.tpl templates
deployments/_lib/
  env_yaml.py             # shared env yaml loader
  kubeconfig.sh           # bash kubeconfig helpers (optional)
  reconcile.sh            # bash kubectl helpers (optional)
  trident-install-helm.sh # helm upgrade --install (azure/aws via Python too)
```

## Reconcile contract

| Step | On re-run |
|------|-----------|
| Kubeconfig | Refreshed from env yaml + cloud CLI |
| Trident Helm | `helm upgrade --install` (idempotent) |
| TridentBackendConfig | **Always** `kubectl apply` from templates |
| StorageClass | Apply; recreate only if immutable fields differ |
| Backend health | Wait for `lastOperationStatus=Success` |
| GCNV pools | Create if missing; log if already exists |
| SAN hosts | Apply DaemonSet; restart Trident nodes only if IQN missing |

## Env configuration

Same files as `make infra`: `deployments/<cloud>/envs/<env>.yaml` with a `storage:` block (see `deployments/<cloud>/envs/_schema.yaml`).

## Legacy `scripts/` (unchanged)

These files are **not deleted or modified**. AgentStudio cloud envs should use `make storage` instead:

| Legacy script | Superseded by |
|---------------|---------------|
| `scripts/setup-anf-trident.sh` | `lib/azure_anf.py` |
| `scripts/configure-ontap-storage.sh` (FSxN) | `lib/aws_fsxn.py` |
| `scripts/gke-provision-gcnv-native.sh` | `lib/gcp_gcnv.py` |
| `scripts/gke-ensure-san-hosts.sh` | `lib/gcp_san_hosts.py` |

`make configure-ontap-storage` and on-prem ONTAP flows still use `scripts/configure-ontap-storage.sh`.

## GKE deploy path (`--from-env`)

`deploy-all-tiers-gke` still calls `gke-ensure-storage-ready` / `gke-ensure-san-hosts`, which now invoke `deployments/storage/lib/` with `--from-env` (same `GCP_PROJECT_ID`, `GCNV_*`, `TRIDENT_GSA_EMAIL` variables as before).

## Verification

```bash
kubectl get tbc -n trident
kubectl get storageclass
make aks-check-storage-ready   # optional manual checks
```

See [preprod-infra-validation.md](../docs/preprod-infra-validation.md) Layer 2.

## Single-backend / ONTAP (legacy)

For on-prem or ad hoc FSx/ONTAP via env vars, continue using:

```bash
make configure-ontap-storage CONFIG_FILE=deployments/storage/trident-backends.example.yaml
```

See [trident-backends.example.yaml](trident-backends.example.yaml) for format.
