#!/usr/bin/env bash
# Mirror container images between registries (ACR, ECR, or any crane-compatible registry).
#
# Publishes a single-platform manifest (default linux/amd64) suitable for EKS/amd64 nodes.
# Uses crane copy when available; falls back to docker pull/tag/push.
#
# Required environment:
#   SRC_REGISTRY   Source registry host (e.g. myreg.azurecr.io or 123.dkr.ecr.us-east-1.amazonaws.com)
#   DST_REGISTRY   Destination registry host
#   SRC_TAG        Tag to pull from the source registry
#   DST_TAG        Tag to push to the destination registry
#
# Required when the corresponding registry is AWS ECR (*.amazonaws.com):
#   SRC_REGION     AWS region for source ECR login
#   DST_REGION     AWS region for destination ECR login / repo management
#
# Optional:
#   SRC_PROFILE    AWS CLI profile for source ECR
#   DST_PROFILE    AWS CLI profile for destination ECR
#   PLATFORM       Platform to copy (default: linux/amd64)
#   SKIP_REPOS     Comma-separated repository paths to skip
#
# Examples:
#   export SRC_REGISTRY=555431941196.dkr.ecr.us-east-1.amazonaws.com
#   export DST_REGISTRY=721140971281.dkr.ecr.us-east-2.amazonaws.com
#   export SRC_REGION=us-east-1 DST_REGION=us-east-2
#   export SRC_TAG=latest DST_TAG=latest
#   export SRC_PROFILE=source-account DST_PROFILE=dest-account
#   ./scripts/mirror-registry-images.sh --prune job-setup nemo/gui
#
#   export SRC_REGISTRY=cragentstudiodeveus2001.azurecr.io
#   export DST_REGISTRY=721140971281.dkr.ecr.us-east-2.amazonaws.com
#   export SRC_TAG=dev DST_TAG=latest DST_REGION=us-east-2
#   ./scripts/mirror-registry-images.sh job-setup init-tools
#
#   ./scripts/mirror-registry-images.sh --all --prune
#   ./scripts/mirror-registry-images.sh --create-repos nemo/agent-service

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PLATFORM="${PLATFORM:-linux/amd64}"
SKIP_REPOS="${SKIP_REPOS:-${SKIP_SERVICES:-}}"
PRUNE=0
CREATE_REPOS_ONLY=0
repos=()

usage() {
  cat <<'EOF'
Mirror container images between registries (single-arch copy via crane or docker).

Required:
  SRC_REGISTRY   Source registry hostname
  DST_REGISTRY   Destination registry hostname
  SRC_TAG        Source image tag
  DST_TAG        Destination image tag

Required for AWS ECR registries (*.amazonaws.com):
  SRC_REGION     When SRC_REGISTRY is ECR
  DST_REGION     When DST_REGISTRY is ECR (also required for --create-repos / --prune)

Optional:
  SRC_PROFILE    AWS CLI profile for source ECR login
  DST_PROFILE    AWS CLI profile for destination ECR login
  PLATFORM       Platform to copy (default: linux/amd64)
  SKIP_REPOS     Comma-separated repo paths to skip

Options:
  --prune        Delete untagged images and tags other than DST_TAG in each ECR repo
  --all          Mirror all Makefile image lists
  --create-repos Create destination ECR repositories only, then exit
  -h, --help     Show this help

Examples:
  export SRC_REGISTRY=555431941196.dkr.ecr.us-east-1.amazonaws.com
  export DST_REGISTRY=721140971281.dkr.ecr.us-east-2.amazonaws.com
  export SRC_REGION=us-east-1 DST_REGION=us-east-2
  export SRC_TAG=latest DST_TAG=latest
  ./scripts/mirror-registry-images.sh --prune job-setup nemo/gui
EOF
  exit "${1:-0}"
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "ERROR: ${name} must be set" >&2
    exit 1
  fi
}

is_ecr_registry() {
  [[ "$1" == *".amazonaws.com" ]]
}

is_acr_registry() {
  [[ "$1" == *".azurecr.io" ]]
}

require_ecr_region() {
  local registry="$1"
  local region_var="$2"
  if is_ecr_registry "${registry}" && [ -z "${!region_var:-}" ]; then
    echo "ERROR: ${region_var} must be set when ${registry} is an AWS ECR registry" >&2
    exit 1
  fi
}

validate_config() {
  require_env SRC_REGISTRY
  require_env DST_REGISTRY
  require_env SRC_TAG
  require_env DST_TAG
  require_ecr_region "${SRC_REGISTRY}" SRC_REGION
  require_ecr_region "${DST_REGISTRY}" DST_REGION
}

image_ref() {
  local registry="$1"
  local repo="$2"
  local tag="$3"
  printf '%s/%s:%s' "${registry}" "${repo}" "${tag}"
}

should_skip() {
  local repo="$1"
  local short="${repo##*/}"

  [ -n "${SKIP_REPOS}" ] || return 1
  echo ",${SKIP_REPOS}," | grep -Fq ",${repo}," && return 0
  echo ",${SKIP_REPOS}," | grep -Fq ",${short}," && return 0
  return 1
}

_nemo_services_cache=""

nemo_services_list() {
  if [ -z "${_nemo_services_cache}" ]; then
    _nemo_services_cache="$(make -s -C "${REPO_ROOT}" print-nemo-services)"
  fi
  printf '%s' "${_nemo_services_cache}"
}

normalize_repo() {
  local repo="$1"
  local svc

  case "${repo}" in
    nemo/*)
      printf '%s' "${repo}"
      return
      ;;
    mcp-server-*)
      printf 'nemo/%s' "${repo}"
      return
      ;;
  esac

  for svc in $(nemo_services_list); do
    if [ "${repo}" = "${svc}" ]; then
      printf 'nemo/%s' "${repo}"
      return
    fi
  done

  printf '%s' "${repo}"
}

aws_profile_args() {
  local profile="$1"
  if [ -n "${profile}" ]; then
    printf '%s' "--profile ${profile}"
  fi
}

_CRANE_DOCKER_CONFIG=""

setup_crane_config() {
  if [ -n "${DOCKER_CONFIG:-}" ]; then
    :
  elif [ -n "${_CRANE_DOCKER_CONFIG}" ]; then
    export DOCKER_CONFIG="${_CRANE_DOCKER_CONFIG}"
  else
    _CRANE_DOCKER_CONFIG="$(mktemp -d "${TMPDIR:-/tmp}/mirror-images-config.XXXXXX")"
    export DOCKER_CONFIG="${_CRANE_DOCKER_CONFIG}"
    trap 'rm -rf "${_CRANE_DOCKER_CONFIG}"' EXIT
  fi
  mkdir -p "${DOCKER_CONFIG}"
  if [ ! -f "${DOCKER_CONFIG}/config.json" ]; then
    echo '{}' > "${DOCKER_CONFIG}/config.json"
  fi
}

ecr_login() {
  local registry="$1"
  local region="$2"
  local profile="$3"
  local pass profile_args=""

  profile_args="$(aws_profile_args "${profile}")"
  # shellcheck disable=SC2086
  pass="$(aws ecr get-login-password --region "${region}" ${profile_args})"

  if command -v crane >/dev/null 2>&1; then
    setup_crane_config
    crane auth login -u AWS -p "${pass}" "${registry}"
  else
    echo "${pass}" | docker login --username AWS --password-stdin "${registry}" >/dev/null
  fi
}

acr_login() {
  local registry="$1"
  az acr login --name "${registry%%.*}" >/dev/null
}

registry_login() {
  local registry="$1"
  local region="$2"
  local profile="$3"

  if is_ecr_registry "${registry}"; then
    ecr_login "${registry}" "${region}" "${profile}"
  elif is_acr_registry "${registry}"; then
    acr_login "${registry}"
  else
    echo "  no automatic login for ${registry}; ensure crane/docker credentials are configured"
  fi
}

ensure_ecr_repo() {
  local repo="$1"
  local profile_args

  if ! is_ecr_registry "${DST_REGISTRY}"; then
    echo "ERROR: --create-repos requires DST_REGISTRY to be an AWS ECR registry" >&2
    exit 1
  fi

  profile_args="$(aws_profile_args "${DST_PROFILE}")"
  if aws ecr describe-repositories ${profile_args} --repository-names "${repo}" --region "${DST_REGION}" >/dev/null 2>&1; then
    return 0
  fi
  echo "  create ECR repository: ${repo}"
  aws ecr create-repository ${profile_args} \
    --region "${DST_REGION}" \
    --repository-name "${repo}" \
    --image-scanning-configuration scanOnPush=true \
    --encryption-configuration encryptionType=AES256 \
    >/dev/null
}

prune_ecr_repo() {
  local repo="$1"
  local keep_tag="$2"
  local profile_args digests_to_delete=() tagged_to_delete=()

  if ! is_ecr_registry "${DST_REGISTRY}"; then
    echo "ERROR: --prune requires DST_REGISTRY to be an AWS ECR registry" >&2
    exit 1
  fi

  profile_args="$(aws_profile_args "${DST_PROFILE}")"
  echo "  prune ${repo} (keep tag: ${keep_tag})"

  while IFS= read -r digest; do
    [ -n "${digest}" ] && digests_to_delete+=("imageDigest=${digest}")
  done < <(
    aws ecr list-images ${profile_args} \
      --region "${DST_REGION}" \
      --repository-name "${repo}" \
      --filter tagStatus=UNTAGGED \
      --query 'imageIds[*].imageDigest' \
      --output text 2>/dev/null | tr '\t' '\n'
  )

  while IFS= read -r tag; do
    [ -n "${tag}" ] || continue
    if [ "${tag}" != "${keep_tag}" ]; then
      tagged_to_delete+=("imageTag=${tag}")
      echo "    remove tag ${tag}"
    fi
  done < <(
    aws ecr list-images ${profile_args} \
      --region "${DST_REGION}" \
      --repository-name "${repo}" \
      --filter tagStatus=TAGGED \
      --query 'imageIds[*].imageTag' \
      --output text 2>/dev/null | tr '\t' '\n'
  )

  if [ "${#digests_to_delete[@]}" -gt 0 ]; then
    echo "    remove ${#digests_to_delete[@]} untagged manifest(s)"
    aws ecr batch-delete-image ${profile_args} \
      --region "${DST_REGION}" \
      --repository-name "${repo}" \
      --image-ids "${digests_to_delete[@]}" \
      >/dev/null
  fi

  if [ "${#tagged_to_delete[@]}" -gt 0 ]; then
    aws ecr batch-delete-image ${profile_args} \
      --region "${DST_REGION}" \
      --repository-name "${repo}" \
      --image-ids "${tagged_to_delete[@]}" \
      >/dev/null
  fi
}

mirror_one() {
  local repo="$1"
  local src dst

  src="$(image_ref "${SRC_REGISTRY}" "${repo}" "${SRC_TAG}")"
  dst="$(image_ref "${DST_REGISTRY}" "${repo}" "${DST_TAG}")"

  if is_ecr_registry "${DST_REGISTRY}"; then
    ensure_ecr_repo "${repo}"
  fi

  echo ""
  echo "=== ${repo} (${PLATFORM}) ==="
  echo "  from  ${src}"
  echo "  to    ${dst}"

  if command -v crane >/dev/null 2>&1; then
    setup_crane_config
    crane copy --platform "${PLATFORM}" "${src}" "${dst}"
  else
    echo "  (crane not found; using docker pull --platform ${PLATFORM})"
    docker pull --platform "${PLATFORM}" "${src}"
    docker tag "${src}" "${dst}"
    docker push "${dst}"
  fi

  if [ "${PRUNE}" = "1" ]; then
    prune_ecr_repo "${repo}" "${DST_TAG}"
  fi
}

load_all_repos() {
  repos=()
  local item

  for item in $(make -s -C "${REPO_ROOT}" print-all-images); do
    repos+=("$(normalize_repo "${item}")")
  done
  for item in $(make -s -C "${REPO_ROOT}" print-nemo-services); do
    repos+=("$(normalize_repo "${item}")")
  done
  for item in $(make -s -C "${REPO_ROOT}" print-worker-images); do
    repos+=("$(normalize_repo "${item}")")
  done
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage 0 ;;
    --create-repos) CREATE_REPOS_ONLY=1 ;;
    --all) load_all_repos ;;
    --prune) PRUNE=1 ;;
    --source-ecr)
      echo "WARNING: --source-ecr is deprecated; set SRC_REGISTRY to your source ECR hostname" >&2
      ;;
    --*) echo "Unknown option: $1" >&2; usage 1 ;;
    *) repos+=("$(normalize_repo "$1")") ;;
  esac
  shift
done

validate_config

if [ "${CREATE_REPOS_ONLY}" = "1" ]; then
  if [ "${#repos[@]}" -eq 0 ]; then
    load_all_repos
  fi
  echo "Creating ECR repositories in ${DST_REGION}..."
  for repo in "${repos[@]}"; do
    if should_skip "${repo}"; then
      echo "  skip ${repo} (SKIP_REPOS)"
      continue
    fi
    ensure_ecr_repo "${repo}"
    echo "  ok ${repo}"
  done
  exit 0
fi

if [ "${#repos[@]}" -eq 0 ]; then
  echo "ERROR: pass at least one repository path (e.g. job-setup or nemo/gui)" >&2
  usage 1
fi

echo "Mirror ${PLATFORM} images"
echo "  source: ${SRC_REGISTRY}:${SRC_TAG}"
echo "  dest:   ${DST_REGISTRY}:${DST_TAG}"

echo "Logging in to source registry (${SRC_REGISTRY})..."
registry_login "${SRC_REGISTRY}" "${SRC_REGION:-}" "${SRC_PROFILE:-}"

echo "Logging in to destination registry (${DST_REGISTRY})..."
registry_login "${DST_REGISTRY}" "${DST_REGION:-}" "${DST_PROFILE:-}"

for repo in "${repos[@]}"; do
  if should_skip "${repo}"; then
    echo "Skipping ${repo} (SKIP_REPOS)"
    continue
  fi
  mirror_one "${repo}"
done

echo ""
echo "Done."
