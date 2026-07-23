#!/usr/bin/env bash
# deployments/_lib/kubeconfig.sh — fetch kubeconfig from env yaml (sourced by storage runners).
set -euo pipefail

_kubeconfig_require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[storage] ERROR: required command '$1' not found" >&2
    exit 1
  }
}

kubeconfig_azure() {
  local env_file="$1"
  _kubeconfig_require az
  _kubeconfig_require yq
  local subscription rg cluster
  subscription="$(yq '.subscriptionId' "$env_file")"
  rg="$(yq '.resourceGroup' "$env_file")"
  cluster="$(yq '.aks.clusterName' "$env_file")"
  az account set --subscription "$subscription"
  az aks get-credentials -g "$rg" -n "$cluster" --overwrite-existing
}

kubeconfig_aws() {
  local env_file="$1"
  _kubeconfig_require aws
  _kubeconfig_require python3
  local region stack cluster env_yaml
  env_yaml="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env_yaml.py"
  region="$(python3 "$env_yaml" --file "$env_file" --path region)"
  stack="$(python3 "$env_yaml" --file "$env_file" --path stackName)"
  cluster="$(aws cloudformation describe-stacks --region "$region" --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey=='EksClusterName'].OutputValue | [0]" --output text)"
  aws eks update-kubeconfig --region "$region" --name "$cluster"
}

kubeconfig_gke() {
  local env_file="$1"
  _kubeconfig_require gcloud
  _kubeconfig_require python3
  local project location cluster env_yaml
  env_yaml="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env_yaml.py"
  project="$(python3 "$env_yaml" --file "$env_file" --path projectId)"
  location="$(python3 "$env_yaml" --file "$env_file" --path location)"
  cluster="$(python3 "$env_yaml" --file "$env_file" --path gke.clusterName)"
  gcloud container clusters get-credentials "$cluster" --region "$location" --project "$project"
}
