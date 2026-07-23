# AgentStudio Deployments (Infrastructure as Code)

Unified, in-repo provisioning for AgentStudio across **Azure, AWS, and GCP**. One
normalized verb set (`make infra` / `make storage` / `make deploy`) drives every
cloud through its own native tool, off a single per-environment config file. The
same commands run identically on a laptop and in CI (only the auth source differs).

## Three-layer model

| Layer | Command | What it does |
|-------|---------|--------------|
| 1. Infra | `make infra CLOUD=<cloud> ENV=<env> ACTION=plan\|apply\|destroy` | Cluster + networking + registry/IAM + storage identity |
| 2. Storage | `make storage CLOUD=<cloud> ENV=<env>` | Trident Helm + cloud NAS/SAN backends + StorageClasses (manual gate) |
| 3. Deploy | `make deploy CLOUD=<cluster> ENDPOINT=... IMAGE_TAG=...` | Helm app rollout onto the cluster |

Layers 1–2 are keyed by **cloud provider** (`azure`/`aws`/`gcp`); layer 3 is keyed
by **cluster type** (`aks`/`eks`/`gke`, plus `local`).

## Per-cloud matrix

| Cloud | Native infra tool | Runner | Cluster (deploy) | Storage backend |
|-------|-------------------|--------|------------------|-----------------|
| `azure` | Azure Deployment Stacks (Bicep) | `azure/scripts/infra.sh` | `aks` | ANF (NFS) |
| `aws` | CloudFormation | `aws/scripts/infra.sh` | `eks` | FSx for NetApp ONTAP |
| `gcp` | Infrastructure Manager (Terraform) | `gcp/scripts/infra.sh` | `gke` | GCNV (NAS RWX + SAN RWO) |

The `make infra` dispatch lives in [`mk/cloud/infra-dispatch.mk`](../mk/cloud/infra-dispatch.mk);
`make storage` in [`mk/cloud/storage-dispatch.mk`](../mk/cloud/storage-dispatch.mk).
Adding a new cloud = drop `deployments/<cloud>/scripts/infra.sh` + add the token to
the dispatch guard; no other Make edits.

## Quickstart

```bash
# ---- Azure (AKS) ----
make infra   CLOUD=azure ENV=preprod ACTION=plan
make infra   CLOUD=azure ENV=preprod ACTION=apply
make storage CLOUD=azure ENV=preprod
make deploy  CLOUD=aks   ENDPOINT=... CONTAINER_IMAGE_REPO=... IMAGE_TAG=...

# ---- AWS (EKS) ----
make infra   CLOUD=aws   ENV=preprod ACTION=apply
make storage CLOUD=aws   ENV=preprod
make deploy  CLOUD=eks   ENDPOINT=... IMAGE_TAG=...

# ---- GCP (GKE) ----
make infra   CLOUD=gcp   ENV=preprod ACTION=apply
make storage CLOUD=gcp   ENV=preprod
export SKIP_CLUSTER_CREATE=1   # infra already built the cluster
make deploy  CLOUD=gke   ENDPOINT=... IMAGE_TAG=...

# Tear down an environment's managed resources
make infra CLOUD=<cloud> ENV=<env> ACTION=destroy CONFIRM=<env>
```

`ACTION` defaults to `plan` (read-only) so a bare invocation never mutates infra.

## Layout

```text
deployments/
  azure/            # Azure Deployment Stacks (Bicep)
    stacks/         #   main.bicep orchestrator + per-resource ARM JSON modules
    envs/           #   _schema.yaml + <env>.yaml (dev, preprod, ...)
    scripts/infra.sh
  aws/              # CloudFormation
    stacks/agentstudio-foundation.yaml
    envs/           #   _schema.yaml + <env>.yaml
    scripts/infra.sh
  gcp/              # Infrastructure Manager + Terraform
    stacks/         #   main.tf + modules/ (networking, gke, ...)
    envs/           #   _schema.yaml + <env>.yaml
    scripts/infra.sh
  storage/          # Layer 2 Trident bootstrap for all clouds (make storage)
    storage.sh, lib/, manifests/   # see storage/README.md
  _lib/             # cloud-agnostic helpers (common.sh, env_yaml.py, ...)
```

## Environment config model

Each environment is one file: `deployments/<cloud>/envs/<env>.yaml`. It mixes
**template parameters** (consumed by the infra template) with **runner-only keys**
(consumed by the runner script and stripped before the template — e.g.
`subscriptionId`, `region`, `stackName`, `keycloak`, `deploy`, `storage`). See each
cloud's `envs/_schema.yaml` for the shape.

**Adding a new environment** (e.g. `prod`) needs no Make/template/workflow change:

1. `cp deployments/<cloud>/envs/preprod.yaml deployments/<cloud>/envs/prod.yaml` and edit the values.
2. `make infra CLOUD=<cloud> ENV=prod ACTION=plan` then `ACTION=apply`.
3. One-time CI setup (below), then run the workflow with `environment=prod`.

`ENV` is validated by checking the file exists — not a hardcoded allowlist.

## CI workflows

All run on GitHub-hosted `ubuntu-latest`, log in via GitHub OIDC to the cloud's
GitHub Environment (`azure`/`aws`/`gcp`), then run the identical `make` commands.

| Workflow | Purpose | Inputs |
|----------|---------|--------|
| [`deploy-env.yml`](../.github/workflows/deploy-env.yml) | Generic, ad-hoc envs (localtest, sandbox, ...) — full infra→storage→deploy | `cloud`, `environment`, `image_tag` |
| [`deploy-preprod-azure.yml`](../.github/workflows/deploy-preprod-azure.yml) | Pinned `preprod` on Azure/AKS | `image_tag` |
| [`deploy-preprod-aws.yml`](../.github/workflows/deploy-preprod-aws.yml) | Pinned `preprod` on AWS/EKS | `image_tag` |
| [`deploy-preprod-gcp.yml`](../.github/workflows/deploy-preprod-gcp.yml) | Pinned `preprod` on GCP/GKE | `image_tag` |

`deploy-env.yml` **rejects `preprod` and `dev`** — those have dedicated pipelines.
Reviewer gating is CI-only (via required reviewers on the cloud's GitHub
Environment); local `apply`/`destroy` is for sandbox/break-glass.

One-time setup per cloud (OIDC identity + GitHub Environment vars):

- **azure:** federated credential on `agent-studio-cicd-umi` (subject
  `repo:<org>/<repo>:environment:azure`) + Contributor / User Access Admin; repo
  Variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.
- **aws:** IAM role with a GitHub OIDC trust policy; env vars `AWS_ROLE_ARN`, `AWS_REGION`.
- **gcp:** Workload Identity pool/provider; GitHub Environment `gcp` vars
  `GCP_PROJECT_ID`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`
  (OIDC login and IM Terraform executor — export locally for `make infra`, not in
  env yaml). Grant the SA `config.admin`, `compute.networkAdmin`, `container.admin`,
  `artifactregistry.admin`, and `resourcemanager.projectIamAdmin`.

## Cloud-specific notes

### Azure — Deployment Stacks lifecycle
Native Azure, no Terraform/remote state. Desired state = the specs under
`azure/stacks/`; managed state = the Deployment Stack (`agentstudio-<env>`, one per
env in its own resource group). `plan` = `az deployment group what-if`. Removing a
resource from a template marks it unmanaged on the next `apply`, resolved by
`--action-on-unmanage`:

- `detachAll` — keep the orphan (cautious)
- `deleteResources` — delete resources, never resource groups (default)
- `deleteAll` — delete resources and resource groups (forced on `destroy`)

Resolution order: per-run `UNMANAGE=` > `actionOnUnmanage` in `envs/<env>.yaml` >
`deleteResources`. Because templates are shared across envs, gate env-specific
resources with a template condition driven by an env-yaml flag rather than editing
the shared template.

### AWS — CloudFormation
`aws/stacks/agentstudio-foundation.yaml` is the single foundation stack. CloudFormation
has no "unmanage" concept: resources removed from the template are deleted on the
next `apply`. `plan` uses a change-set preview. If a stack is `ROLLBACK_COMPLETE`,
delete it before re-applying.

### GCP — Infrastructure Manager
`ACTION=apply` runs `gcloud infra-manager deployments apply` (an upsert on
`deploymentId`). After infra builds the cluster, set `SKIP_CLUSTER_CREATE=1` before
`make deploy` so preflight doesn't recreate the Terraform-managed cluster.
Prerequisites: enable the config/container/compute/servicenetworking/netapp/dns/
artifactregistry APIs, and grant the runner SA `config.admin`, `compute.networkAdmin`,
`container.admin`, `iam.serviceAccountUser`, and `resourcemanager.projectIamAdmin`
(for the Trident GSA `netapp.admin` binding). See
[`docs/deployment/gcp-im-runner-cloud-ops-request.md`](../docs/deployment/gcp-im-runner-cloud-ops-request.md).

## Storage layer

Layer 2 (`make storage`) is a manual gate between infra and deploy: it installs
Trident, applies TridentBackendConfigs + StorageClasses, and waits for backend
health. It's idempotent (re-run safe) and shared across clouds. Details and the
reconcile contract: [`storage/README.md`](storage/README.md).

## Relationship to app deployment

Layers 1–2 provision **infrastructure and cluster storage**. Rolling the AgentStudio
**application** on is layer 3 (`make deploy CLOUD=<cluster>` / the deploy workflows).
Provision first, deploy second.
