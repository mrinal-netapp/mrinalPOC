# CI/CD Workflows (AWS/GKE)

This guide documents the deployment-only workflows for:

- AWS EKS: `.github/workflows/deploy-eks.yml`
- GKE: `.github/workflows/deploy-gke.yml`

Both workflows deploy an existing image tag using tiered Helm targets in the Makefile.

## Scope

- This is for deploy-only CI/CD.
- Image build/push is handled separately.

## AWS EKS (`deploy-eks.yml`)

### Required GitHub Environment: `dev-eks`

Variables:

- `ECR_REGISTRY` (example: `123456789012.dkr.ecr.us-east-2.amazonaws.com/agentstudio`)
- `AWS_REGION`
- `AWS_ROLE_ARN`
- `EKS_CLUSTER_NAME`
- `AGENTSTUDIO_ENDPOINT`

Optional variables:

- `HELM_NS_*`
- `OBSERVABILITY`
- `CERT_MANAGER_GATEWAY_TLS`
- `DEPLOYMENT_NAME`
- `HELM_EXTRA_ARGS`
- `KEYCLOAK_HOSTNAME`

Notes:

- EKS Keycloak identity follows the same pattern as GKE: chart-rendered values from `deployments/helm/identity/values-eks.yaml`.
- `deploy-eks.yml` does not read Keycloak secrets from GitHub environment secrets.
- Static gateway IPs for EKS are configured in `deployments/helm/services/values-eks.yaml` with `service.beta.kubernetes.io/aws-load-balancer-eip-allocations`.

### Run deployment

```bash
gh workflow run deploy-eks.yml -f image_tag=1.0.0-dev.1
```

### What runs in the workflow

Before cluster deploy, workflow runs:

- `make helm-tier-template-eks ...`

Then it runs:

- `make deploy-eks ...`

## GKE (`deploy-gke.yml`)

### Required GitHub Environment: `dev-gke`

Variables:

- `GAR_REGISTRY`
- `GCP_PROJECT_ID`
- `GKE_CLUSTER_NAME`
- `GKE_CLUSTER_LOCATION`
- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_SERVICE_ACCOUNT`
- `AGENTSTUDIO_ENDPOINT`

Optional variables:

- `HELM_NS_*`
- `CERT_MANAGER_GATEWAY_TLS`
- `DEPLOYMENT_NAME`
- `HELM_EXTRA_ARGS`
- `KEYCLOAK_HOSTNAME`

### Run deployment

```bash
gh workflow run deploy-gke.yml -f image_tag=1.0.0-dev.1
```

### Suggested test flow before GKE deploy

Run local render tests from repo root:

```bash
make helm-tier-template-gke \
  CONTAINER_IMAGE_REPO="<gar-registry>" \
  ENDPOINT="<endpoint>"
```

Then run `deploy-gke.yml`.

## Smoke validation after deploy (AWS and GKE)

After workflow completion, validate:

```bash
kubectl get pods -A | rg -v "Running|Completed"
kubectl get gateway,httproute -A
kubectl get svc -n agentstudio-services services-gateway-nginx
```

Optional app checks:

- `https://app.<ENDPOINT>:8443/console`
- `https://auth.<ENDPOINT>:8443/realms/nemo/.well-known/openid-configuration`
