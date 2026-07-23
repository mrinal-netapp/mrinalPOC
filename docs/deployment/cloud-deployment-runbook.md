# Cloud Deployment Runbook (GKE + Trident + Cloud DNS)

This runbook documents cloud deployment for AgentStudio on GKE using Trident storage and ExternalDNS with Cloud DNS.

## Scope

- Provider: GCP (`CLOUD_PROVIDER=gcp`)
- Kubernetes: GKE
- Storage backend: GCNV + Trident
- DNS: ExternalDNS + Cloud DNS

## Two GKE entry points

There are two ways to deploy on GKE; pick based on how much you want automated:

| Entry point | What it does | When to use |
|-------------|--------------|-------------|
| `make deploy-gke` | Deploys the app stack onto an **already-provisioned** GKE cluster using the **tiered multi-namespace** charts (`identity`, `platform`, `llm-gateway`, `services`, `console`, `workers`). Ensures dual GCNV-native Trident storage (NAS+SAN) + Gateway API, then runs `deploy-all-tiers-gke`. | You already have a cluster, storage driver, and DNS; you just want the workloads deployed/upgraded. |
| `make deploy-cloud-auto` | End-to-end automation: optionally creates the cluster + node pool, provisions GCNV/Trident storage, deploys ExternalDNS + Cloud DNS, then runs the app deploy. | Greenfield: you want the cluster, storage, and DNS stood up too. (See the rest of this runbook.) |

> **Tiered layout note:** PR #20 split the former `nemo` umbrella into per-tier
> charts, each in its own namespace (`agentstudio-{identity,platform,llm-gateway,services,console,workers}`),
> and moved the Gateway into the `services` tier (`services-gateway` in
> `agentstudio-services`). `make deploy-gke` now drives the tiered orchestrator
> `deploy-all-tiers-gke`; the old monolith path is retired. Full rationale:
> `docs/deployment/gke-tiered-deploy-design.md`.

## GKE tiered deployment (`make deploy-gke`)

Deploys the tiers in dependency order onto an existing cluster:
`GCNV-native storage gate → Gateway API → gateway TLS → database → identity → workers
(+ s3gateway readiness) → platform → llm-gateway → services → console`.

Storage model on GKE:

- **GCNV-native Trident NAS (RWX)** for shared default-bucket PVCs that multiple
  pods co-mount: workers `s3gateway` PVCs and services `defaultBucketPvc`.
  Provisioned via `gcnv-nas-rwx`.
- **GCNV-native Trident SAN (RWO)** for database persistence (Postgres).
  Provisioned via `gcnv-san-rwo`.
- Other tier PVCs follow chart defaults unless explicitly pinned by overlay.

Workload Identity is **off** in this path (chart-rendered secrets / node service
account); GKE Workload Identity is a planned follow-up.

Prerequisites:

- An existing GKE cluster with Workload Identity enabled and the kubectl context
  pointing at it (`gke_<project>_<location>_<cluster>`).
- A GSA for Trident identity (for example `TRIDENT_GSA_EMAIL`) with required
  NetApp API permissions.
- IAM prerequisites must be preconfigured (the storage script does not mutate IAM):
  - Project role on the Trident GSA: `roles/netapp.admin`
  - Workload Identity binding on the Trident GSA for
    `serviceAccount:<project>.svc.id.goog[trident/trident-controller]`
- A reserved regional static IP for the services gateway load balancer.
  The GKE edge overlay pins to `agentstudio-services-gw-ip` in
  project `agent-studio-netapp`, region `us-east4`:
  ```bash
  gcloud compute addresses create agentstudio-services-gw-ip \
    --project agent-studio-netapp \
    --region us-east4
  ```
  Pinning is by NAME only -- the edge chart sets the GKE annotation
  `networking.gke.io/load-balancer-ip-addresses` with the full address
  resource path (`projects/agent-studio-netapp/regions/us-east4/addresses/agentstudio-services-gw-ip`).
  GKE's cloud-controller-manager resolves the name to whatever IP the
  reservation currently holds, so the resolved IP appears at runtime in
  `Gateway.status.addresses[].value`. If the reservation is renamed or
  moved to a different region/project, update the annotation only.
- Images already built/pushed for the cluster architecture (`CONTAINER_IMAGE_REPO` + `IMAGE_TAG`).
- A wildcard TLS cert / DNS for `*.<endpoint>` (the auth hostname `auth.<endpoint>` must be covered).

Deploy command:

```bash
make deploy-gke \
  ENDPOINT=agentstudio.example.com \
  CONTAINER_IMAGE_REPO=<your-registry/repo> \
  IMAGE_TAG=<tag>
# KEYCLOAK_HOSTNAME is auto-derived to https://auth.<endpoint>:8443.
# Override explicitly only for a non-default auth subdomain/port:
#   KEYCLOAK_HOSTNAME=https://<custom-host>:<port>
```

Useful sub-targets (all idempotent; safe to re-run a single tier):

```bash
make gke-ensure-storage-ready            # create/verify GCNV native NAS/SAN backends + classes
make helm-tier-template-gke \            # offline smoke-test all tier charts
  CONTAINER_IMAGE_REPO=<repo> ENDPOINT=<endpoint>
make helm-workers-upgrade-gke            # redeploy just the workers tier, etc.
make deploy-all-tiers-gke \              # run the orchestrator directly
  KEYCLOAK_HOSTNAME=https://auth.<endpoint>:8443 \
  CONTAINER_IMAGE_REPO=<repo> IMAGE_TAG=<tag> ENDPOINT=<endpoint>
```

Per-tier verification:

```bash
kubectl get pods -n agentstudio-identity
kubectl get pods -n agentstudio-workers      # s3gateway + workers
kubectl get pods -n agentstudio-platform     # temporal, lakekeeper, redis
kubectl get pods -n agentstudio-services     # APIs + the Gateway
kubectl get pods -n agentstudio-console      # GUI
# Gateway + cross-namespace auth route:
kubectl get gateway -n agentstudio-services services-gateway
kubectl get httproute -n agentstudio-identity keycloak -o yaml   # expect Accepted/ResolvedRefs
# NAS/SAN PVCs are Bound:
kubectl get pvc -n agentstudio-workers
kubectl get pvc -n agentstudio-services
kubectl get pvc -n database
```

## Prerequisites

- `kubectl`, `helm`, `gcloud`, `dig`
- Access to GKE cluster and GCP project
- Trident identity for backend creation:
  - `TRIDENT_GSA_EMAIL` (or `TRIDENT_GSA`)
- Workload Identity service account for ExternalDNS:
  - `GCP_DNS_SA_EMAIL`

## Required environment variables

- `CLOUD_PROVIDER=gcp`
- `GCP_PROJECT_ID`
- `K8S_CLUSTER_NAME`
- `K8S_CLUSTER_LOCATION`
- `NETWORK_VPC_NAME`
- `GCNV_LOCATION`
- `GCNV_NETWORK` (format: `name=<vpc>` or long-form network path)
- `TRIDENT_GSA_EMAIL`
- `ENDPOINT`
- `DNS_ZONE_NAME`
- `EXTERNALDNS_TXT_OWNER_ID`

## Optional environment variables

- `AUTO_CREATE_CLUSTER=1` (create cluster if missing)
- `AUTO_CREATE_NODE_POOL=1` (create node pool if missing)
- `NODE_ARCHITECTURE=amd64|arm64` (default `amd64`)
- `GKE_MACHINE_TYPE` (auto default by architecture)
- `GKE_NODEPOOL_NAME` (default `<architecture>-pool`)
- `GKE_NODEPOOL_NUM_NODES` (default `3`)
- `GKE_SUBNETWORK` (for cluster create)
- `GKE_NODE_LOCATIONS` (comma-separated zones for node pool)
- `GKE_NODE_TAINTS` (optional taints on created node pool)
- `DEPLOYMENT_NAME` (recommended for deterministic names)
- `GCNV_NAS_POOL_NAME` (default `sp-agentstudio-gcnv-nas`)
- `GCNV_SAN_POOL_NAME` (default `sp-agentstudio-gcnv-san`)
- `GCNV_NAS_SERVICE_LEVEL` (default `standard`)
- `GCNV_SAN_SERVICE_LEVEL` (default `flex`; required for unified SAN pool)
- `GCNV_NAS_POOL_CAPACITY_GIB` (default `4096`)
- `GCNV_SAN_POOL_CAPACITY_GIB` (default `4096`)
- `GCNV_SAN_POOL_TYPE` (default `unified`)
- `GCNV_SAN_MODE` (default `default`)
- `GCNV_SAN_ZONE` (default `${GCNV_LOCATION}-b`)
- `GCNV_SAN_REPLICA_ZONE` (default `${GCNV_LOCATION}-c`; set explicitly for zone-redundant SAN pool policies)
- `AUTO_CREATE_SAN_NODE_POOL` (default `1`)
- `GKE_SAN_NODEPOOL_NAME` (default `san-ubuntu-pool`)
- `GKE_SAN_NODEPOOL_NUM_NODES` (default `1`)
- `GKE_SAN_MACHINE_TYPE` (default `e2-standard-4`)
- `GKE_SAN_IMAGE_TYPE` (default `UBUNTU_CONTAINERD`)
- `GKE_SAN_NODE_LABELS` (default `agentstudio.netapp.io/san=true`)
- `GKE_SAN_NODE_TAINTS` (default `agentstudio.netapp.io/san=true:NoSchedule`)
- `GKE_SAN_NODE_LOCATIONS` (defaults to `GKE_NODE_LOCATIONS`)
- `AUTO_BOOTSTRAP_SAN_HOSTS` (default `1`; applies host iSCSI/multipath bootstrap DaemonSet)
- `GCNV_NAS_SC_NAME` (default `gcnv-nas-rwx`)
- `GCNV_SAN_SC_NAME` (default `gcnv-san-rwo`)
- `SERVICES_NAMESPACE` (default `nemo`)
- `DATABASE_NAMESPACE` (default `database`)
- `EXTERNAL_DNS_NAMESPACE` (default `external-dns`)
- `EXTERNALDNS_SOURCE_MODE=gateway|service` (default `gateway`)
- `ARCH_PIN_WORKLOADS=1` (auto-inject `nodeSelector` overlays for selected architecture)
- `ARCH_NODE_SELECTOR_KEY` (default `kubernetes.io/arch`)
- `RESUME_FROM=preflight|storage|dns|app|verify`

## Deploy command

```bash
CLOUD_PROVIDER=gcp \
GCP_PROJECT_ID=proj-123 \
K8S_CLUSTER_NAME=agentstudio-gke \
K8S_CLUSTER_LOCATION=us-central1 \
AUTO_CREATE_CLUSTER=1 \
AUTO_CREATE_NODE_POOL=1 \
NODE_ARCHITECTURE=arm64 \
GKE_MACHINE_TYPE=t2a-standard-4 \
GKE_NODEPOOL_NAME=arm64-workloads \
GKE_NODEPOOL_NUM_NODES=3 \
NETWORK_VPC_NAME=agentstudio-vpc \
GCNV_LOCATION=us-central1 \
GCNV_NETWORK="name=agentstudio-vpc" \
TRIDENT_GSA_EMAIL=trident-gsa@proj-123.iam.gserviceaccount.com \
GCNV_NAS_POOL_NAME=sp-agentstudio-gcnv-nas \
GCNV_SAN_POOL_NAME=sp-agentstudio-gcnv-san \
GCNV_NAS_SERVICE_LEVEL=standard \
GCNV_SAN_SERVICE_LEVEL=flex \
GCNV_NAS_POOL_CAPACITY_GIB=4096 \
GCNV_SAN_POOL_CAPACITY_GIB=4096 \
ENDPOINT=agentstudio.example.com \
DNS_ZONE_NAME=agentstudio-example-com \
EXTERNALDNS_TXT_OWNER_ID=agentstudio-dev \
GCP_DNS_SA_EMAIL=external-dns@proj-123.iam.gserviceaccount.com \
DEPLOYMENT_NAME=agentstudio \
ARCH_PIN_WORKLOADS=1 \
make deploy-cloud-auto
```

### SAN-specific notes (GCNV + Trident SAN)

- The SAN backend (`google-cloud-netapp-volumes-san`) requires a SAN-capable GCNV
  pool. The pool must be `type=UNIFIED`.
- Current GCNV APIs require `serviceLevel=FLEX` for unified pools, so SAN defaults
  to `GCNV_SAN_SERVICE_LEVEL=flex`.
- SAN placement defaults to `GCNV_SAN_ZONE=${GCNV_LOCATION}-b` and
  `GCNV_SAN_REPLICA_ZONE=${GCNV_LOCATION}-c`. Override either var if you need
  different zones.
- Preflight creates a dedicated Ubuntu SAN node pool (`agentstudio.netapp.io/san=true`)
  and bootstraps host dependencies via `kube-system/san-host-bootstrap` DaemonSet
  (`open-iscsi`, `multipath-tools`, `find_multipaths no`) so Trident SAN node-stage
  can discover iSCSI devices reliably.
- `deploy-all-tiers-gke` runs `make gke-ensure-san-hosts` (after the storage gate,
  before the DB tier) so the standard `make deploy-gke` path is self-healing without
  preflight. It is idempotent and gates the DB deploy on SAN readiness:
  1. (Re)applies the `kube-system/san-host-bootstrap` DaemonSet and waits for rollout.
  2. Checks each SAN node's `tridentnode.iqn`. If any is empty (Trident registered
     before `open-iscsi` was installed -> GCNV host group built without the node IQN
     -> LUN masked -> `no devices present yet`), it restarts the Trident node
     DaemonSet (`trident/trident-node-linux`) so it re-reads the initiator name and
     re-registers. Healthy clusters skip the restart (no node CSI churn).
  3. Blocks (up to `IQN_WAIT_TIMEOUT`, default 300s) until **every** SAN node reports
     a non-empty IQN, so `shared-postgresql-0` only schedules once its node can mount
     its LUN. Run it standalone with `make gke-ensure-san-hosts`.
- On reruns, if Trident Helm upgrade reports a `spec.cloudIdentity` apply conflict,
  rerun the storage gate; the script now clears stale field ownership before Helm.

## Upgrade and rollback

- In-place upgrades use `helm upgrade` path from existing phased targets.
- Resume from a failed phase:

```bash
RESUME_FROM=app make deploy-gke-auto
```

- State and outputs are recorded in `.deploy-state/cloud-auto.env`.
- PVC deletion is never automated.

## Architecture behavior

- The workflow can create architecture-specific node pools:
  - `NODE_ARCHITECTURE=amd64` -> default machine type `e2-standard-4`
  - `NODE_ARCHITECTURE=arm64` -> default machine type `t2a-standard-4`
- If the cluster already exists, the workflow validates/creates the requested node pool.
- If `ARCH_PIN_WORKLOADS=1`, the workflow generates Helm overlays that set `nodeSelector` to the selected architecture for AgentStudio services (and keycloak identity upgrade path).

## Verification

- Storage:
  - `kubectl get storageclass`
  - `kubectl get tbc -n trident`
  - `kubectl get storageclass gcnv-nas-rwx`
  - `kubectl get storageclass gcnv-san-rwo`
  - `kubectl get pvc -A`
- DNS:
  - `kubectl get deploy -n external-dns external-dns`
  - `dig +short app.<endpoint>` (canonical console host — single label, covered by wildcard)
  - `dig +short ws-smoketest.<endpoint>` (any single-label name resolves via the wildcard)
  - `dig +short <endpoint>` (apex; only present if your zone has an explicit A record — the chart no longer relies on apex resolving)
- App (tiered layout):
  - `kubectl get deployments -A | grep agentstudio-`
  - or per tier, e.g. `kubectl get deployments -n agentstudio-services`

## Hostname layout

The chart targets clusters whose wildcard DNS covers single-label subdomains
(`*.<endpoint>`) and does not assume the apex resolves. All public hostnames
are single-label so a single `*.<endpoint>` wildcard A/AAAA record is enough:

| Purpose                | Public hostname                     | Helm value                  |
|------------------------|-------------------------------------|-----------------------------|
| Console + API gateway  | `<consoleSubdomain>.<endpoint>`     | `consoleSubdomain` (default `app`) |
| Auth (Keycloak)        | `auth.<endpoint>`                   | derived                     |
| Catalog (Lakekeeper)   | `catalog.<endpoint>`                | derived                     |
| Workflows (Temporal)   | `workflows.<endpoint>`              | derived                     |
| Phoenix UI             | `phoenix.<endpoint>`                | derived                     |
| S3 (path-style only)   | `s3.<endpoint>`                     | derived                     |
| Workspaces             | `<workspaceLabelPrefix><id>.<endpoint>` | `workspaceLabelPrefix` (default `ws-`) |

ExternalDNS will publish records for every name in the HTTPRoute `hostnames`
list (see `nemo.defaultGatewayHostnames`). The list includes `*.<endpoint>`
so per-workspace hosts (allocated dynamically) are covered without
re-publishing the route on every workspace creation.

The apex `<endpoint>` is intentionally NOT in the routing list — the chart
no longer depends on it resolving. If your zone separately has an explicit
A record for the apex, that's fine; nothing in the chart requires or
prohibits it.

## Steps taken in this implementation

1. Added cloud makefile modules:
   - `make/cloud/common.mk`
   - `make/cloud/gke.mk`
2. Added automation scripts:
   - `scripts/deploy-cloud-auto.sh`
   - `scripts/gke-preflight.sh`
   - `scripts/gke-provision-gcnv.sh`
   - `scripts/gke-deploy-externaldns.sh`
   - `scripts/gke-postcheck.sh`
3. Updated root `Makefile`:
   - optional include of cloud modules
   - new cloud targets in `.PHONY`
   - namespace variables (`SERVICES_NAMESPACE`, `DATABASE_NAMESPACE`)
   - namespace usage updates in phased targets
