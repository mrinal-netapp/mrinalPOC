#!/usr/bin/env bash
# Idempotent AWS Load Balancer Controller Helm install for EKS.
#
# Reads LoadBalancerControllerRoleArn + EksClusterName from the CloudFormation stack
# named in deployments/aws/envs/<env>.yaml (stackName, region).
#
# Required env:
#   DEPLOY_ENV_FILE — path to deployments/aws/envs/<env>.yaml
#
# Optional:
#   LBC_CHART_VERSION — default 1.13.0 (controller image ~v2.13.x)
#   SKIP_EKS_LBC_INSTALL=1 — no-op (breakglass)

set -euo pipefail

if [ "${SKIP_EKS_LBC_INSTALL:-}" = "1" ]; then
  echo "SKIP_EKS_LBC_INSTALL=1 — skipping AWS Load Balancer Controller install"
  exit 0
fi

DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-}"
if [ -z "$DEPLOY_ENV_FILE" ] || [ ! -f "$DEPLOY_ENV_FILE" ]; then
  echo "No DEPLOY_ENV_FILE — skipping LBC install (legacy/manual clusters)."
  exit 0
fi

ENV_YAML="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/_lib/env_yaml.py"
ey() { python3 "$ENV_YAML" --file "$DEPLOY_ENV_FILE" --path "$1"; }

STACK="$(ey stackName)"
REGION="$(ey region)"
LBC_VERSION="${LBC_CHART_VERSION:-1.13.0}"

if [ -z "$STACK" ] || [ -z "$REGION" ]; then
  echo "ERROR: stackName and region required in $DEPLOY_ENV_FILE for LBC install" >&2
  exit 1
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "ERROR: aws CLI required to resolve CFN outputs for LBC install" >&2
  exit 1
fi

cfn_output() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" \
    --output text 2>/dev/null | tr -d '[:space:]'
}

ROLE_ARN="$(cfn_output LoadBalancerControllerRoleArn)"
CLUSTER="$(cfn_output EksClusterName)"
[ -z "$CLUSTER" ] || [ "$CLUSTER" = "None" ] && CLUSTER="$STACK"

if [ -z "$ROLE_ARN" ] || [ "$ROLE_ARN" = "None" ]; then
  echo "ERROR: LoadBalancerControllerRoleArn not found on stack $STACK — run infra apply first" >&2
  exit 1
fi

if kubectl get deployment -n kube-system aws-load-balancer-controller >/dev/null 2>&1; then
  ready="$(kubectl get deployment -n kube-system aws-load-balancer-controller \
    -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)"
  if [ "${ready:-0}" -ge 1 ]; then
    echo "AWS Load Balancer Controller already running in kube-system (readyReplicas=${ready})"
    exit 0
  fi
  echo "AWS Load Balancer Controller deployment exists but not ready — upgrading..."
fi

helm repo add eks https://aws.github.io/eks-charts --force-update >/dev/null 2>&1 || true
helm repo update eks >/dev/null 2>&1 || helm repo update

echo "Installing AWS Load Balancer Controller (cluster=$CLUSTER region=$REGION)..."
helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller \
  --namespace kube-system \
  --version "$LBC_VERSION" \
  --set clusterName="$CLUSTER" \
  --set region="$REGION" \
  --set serviceAccount.create=true \
  --set serviceAccount.name=aws-load-balancer-controller \
  --set "serviceAccount.annotations.eks\.amazonaws\.com/role-arn=${ROLE_ARN}" \
  --wait --timeout 5m

kubectl rollout status deployment/aws-load-balancer-controller -n kube-system --timeout=120s
echo "AWS Load Balancer Controller ready."
