# Pre-prod infra validation checklist

Three-layer flow for every cloud:

```bash
make infra   CLOUD=<cloud> ENV=preprod ACTION=apply   # Layer 1: platform + Trident auth
make storage CLOUD=<cloud> ENV=preprod                 # Layer 2: Trident Helm + backends + SC (manual gate)
make deploy  CLOUD=<aks|eks|gke> ...                     # Layer 3: app tiers (fail-fast if storage missing)
```

---

## Layer 1 — Platform infra (`make infra`)

Confirms cloud API resources: cluster, networking, capacity pools, registry pull IAM, **and Trident cloud auth**.

### All clouds

- [ ] `kubectl get nodes` shows all node pools Ready (after fetching kubeconfig)
- [ ] Shared container registry pull works (see per-cloud below)
- [ ] Gateway static IP / PIP / EIP documented for edge Helm overlay
- [ ] DNS zone exists or corporate DNS records planned for `application.endpoint`

### AWS (`CLOUD=aws`)

```bash
make infra CLOUD=aws ENV=preprod ACTION=plan
make infra CLOUD=aws ENV=preprod ACTION=apply
```

- [ ] Stack `agentstudio-preprod` status `CREATE_COMPLETE`
- [ ] FSx file system + SVM exist: `aws fsx describe-file-systems --region us-east-2`
- [ ] `installer.enableInstance: false` in [preprod.yaml](../aws/envs/preprod.yaml)
- [ ] Shared ECR referenced in env yaml; nodes pull via `AmazonEC2ContainerRegistryReadOnly`
- [ ] Stack output `LoadBalancerControllerRoleArn` — use for LBC Helm IRSA before edge deploy
- [ ] **Trident auth:** Pod Identity association exists (stack-managed):
  ```bash
  aws eks list-pod-identity-associations --cluster-name agentstudio-preprod --region us-east-2 --namespace trident
  # Expect trident-controller -> TridentPodIdentityRoleArn
  ```

### Azure (`CLOUD=azure`)

```bash
make infra CLOUD=azure ENV=preprod ACTION=apply
```

- [ ] AKS cluster running in `rg-agentstudio-preprod-eus2-001`
- [ ] ANF account + capacity pool provisioned
- [ ] `containerRegistry.mode: shared` — AcrPull on shared ACR
- [ ] **Trident auth:** kubelet MI has Reader (RG) + Contributor (ANF account):
  ```bash
  KUBELET_OID=$(az aks show -g rg-agentstudio-preprod-eus2-001 -n aks-agentstudio-preprod-eus2 \
    --query identityProfile.kubeletidentity.objectId -o tsv)
  az role assignment list --assignee-object-id "$KUBELET_OID" \
    --scope /subscriptions/<sub>/resourceGroups/rg-agentstudio-preprod-eus2-001 -o table
  az role assignment list --assignee-object-id "$KUBELET_OID" \
    --scope /subscriptions/<sub>/resourceGroups/rg-agentstudio-preprod-eus2-001/providers/Microsoft.NetApp/netAppAccounts/anfagentstudiopreprodeus2 -o table
  ```
- [ ] Gateway PIP `pip-agentstudio-gw-preprod-eus2-001` — set in [values-aks.yaml](../../helm/edge/values-aks.yaml) or env-file deploy overlay
- [ ] **Gateway PIP RBAC:** AKS cluster identity has **Network Contributor** on the PIP (stack-managed by `main.bicep` when `edge.gatewayPipName` is set):
  ```bash
  CLUSTER_OID=$(az aks show -g rg-agentstudio-preprod-eus2-001 -n aks-agentstudio-preprod-eus2 \
    --query identity.principalId -o tsv)
  PIP_ID=$(az network public-ip show -g rg-agentstudio-preprod-eus2-001 \
    -n pip-agentstudio-gw-preprod-eus2-001 --query id -o tsv)
  az role assignment list --assignee-object-id "$CLUSTER_OID" --scope "$PIP_ID" -o table
  # Expect Network Contributor
  ```

### GCP (`CLOUD=gcp`)

```bash
make infra CLOUD=gcp ENV=preprod ACTION=apply
export SKIP_CLUSTER_CREATE=1   # before make deploy
```

- [ ] IM deployment `agentstudio-preprod` state succeeded
- [ ] PSA peering + GCNV NAS/SAN pools exist: `gcloud netapp storage-pools list --location=us-east4`
- [ ] NFS firewall (TCP 2049) on VPC
- [ ] Regional static IP `agentstudio-preprod-gw-ip` — reference in [values-gke.yaml](../../helm/edge/values-gke.yaml)
- [ ] Shared Artifact Registry reader IAM on node SA
- [ ] **Trident auth:** preprod reuses `agentstudio-cicd-sa` (no infra Terraform IAM). After `make storage`:
  ```bash
  kubectl get sa trident-controller -n trident \
    -o jsonpath='{.metadata.annotations.iam\.gke\.io/gcp-service-account}{"\n"}'
  # expect: agentstudio-cicd-sa@agent-studio-netapp.iam.gserviceaccount.com
  gcloud iam service-accounts get-iam-policy agentstudio-cicd-sa@agent-studio-netapp.iam.gserviceaccount.com
  # expect workloadIdentityUser for agent-studio-netapp.svc.id.goog[trident/trident-controller]
  ```

---

## Layer 2 — Cluster storage (`make storage`)

Manual gate between infra and deploy. **Idempotent:** safe to re-run; applies TBC/SC from `deployments/storage/manifests/` and waits for backend Success.

```bash
make storage CLOUD=azure ENV=preprod
make storage CLOUD=aws   ENV=preprod
make storage CLOUD=gcp   ENV=preprod
```

Implementation: [deployments/storage/README.md](../storage/README.md). Does **not** call `scripts/` — legacy scripts remain for other flows.

### Azure

- [ ] `kubectl get crd tridentbackendconfigs.trident.netapp.io`
- [ ] `kubectl get tbc anf-backend-nfs -n trident` → `lastOperationStatus=Success`
- [ ] `kubectl get storageclass anf-nfs`

### AWS

- [ ] Pod Identity association present (Layer 1 — no manual create)
- [ ] `kubectl get tbc fsxn-nas-backend -n trident` → Success
- [ ] `kubectl get storageclass fsxn-nas` → `(default)` annotation present

### GCP

- [ ] Trident controller uses Workload Identity (`cloudIdentity` on TridentOrchestrator)
- [ ] `kubectl get tbc gcnv-native-nas-backend gcnv-native-san-backend -n trident` → Success
- [ ] `kubectl get storageclass gcnv-nas-rwx gcnv-san-rwo`
- [ ] SAN nodes report Trident IQN (`make storage` runs `gke-ensure-san-hosts.sh`)

---

## Layer 3 — App deploy (`make deploy`)

Deploy runs existing `deploy-all-tiers-*` orchestrators unchanged. **GKE** still calls
`gke-ensure-storage-ready` inside deploy; **AKS/EKS** assume storage is already present.

For a clean manual gate on any cloud, run Layer 2 first:

```bash
make storage CLOUD=<cloud> ENV=<env>   # parallel path — does not modify deploy scripts
make deploy CLOUD=<aks|eks|gke> ...
```

Optional verification (not wired into deploy):

```bash
make aks-check-storage-ready   # or eks-check-storage-ready / gke-check-storage-ready
```
