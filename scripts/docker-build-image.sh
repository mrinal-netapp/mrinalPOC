#!/bin/bash
# Generic Docker image build with optional multi-platform (DOCKER_PLATFORMS).
# Use for workers and standalone images (src/images/*). Invoke from the image directory.
# Usage: DOCKER_PLATFORMS=linux/amd64,linux/arm64 $0 <image_name> <version> <registry> <container> [dockerfile] [context]
# Example: $0 connector-worker 1.0 docker.repo.eng.netapp.com/user/me docker Dockerfile .
#
# Buildx (single-arch) is also active when DOCKER_BUILDX_BUILDER pins a builder
# (e.g. kube for cluster offload). Two optional modifiers attach to any active
# buildx invocation -- they do not, by themselves, activate buildx:
#   DOCKER_BUILDX_CACHE=1   import/export buildcache as `<registry>/<image>:buildcache`
#                           (mode=max). Requires CONTAINER=docker.
#   DOCKER_BUILDX_PUSH=1    fold the registry push into the build (--push). When set,
#                           the per-image `make push` recipes become no-ops via the
#                           gating in mk/build.mk's images-push / workers-push.

set -e

IMAGE_NAME=$1
VERSION=$2
REGISTRY=$3
CONTAINER=${4:-docker}
DOCKERFILE=${5:-Dockerfile}
CONTEXT=${6:-.}

if [ -z "$IMAGE_NAME" ] || [ -z "$VERSION" ] || [ -z "$REGISTRY" ]; then
    echo "Usage: $0 <image_name> <version> <registry> [container] [dockerfile] [context]"
    echo "  image_name: e.g. connector-worker or nemo/mcp-server-kubernetes"
    echo "  Set DOCKER_PLATFORMS for multi-arch (e.g. linux/amd64,linux/arm64)"
    echo "  Set DOCKER_BUILDX_BUILDER to use a specific buildx builder (e.g. kube for Kubernetes offload)"
    exit 1
fi

PLATFORMS="${DOCKER_PLATFORMS:-}"
PLATFORMS=$(echo "$PLATFORMS" | tr -d ' ')
USE_MULTIARCH=false
MULTIPLE_PLATFORMS=false
if [ -n "$PLATFORMS" ]; then
    USE_MULTIARCH=true
    if echo "$PLATFORMS" | grep -q ','; then
        MULTIPLE_PLATFORMS=true
    fi
fi

IMAGE_TAG="$REGISTRY/$IMAGE_NAME:$VERSION"
IMAGE_LATEST="$REGISTRY/$IMAGE_NAME:latest"

BUILDX_OPTS=()
[ -n "${DOCKER_BUILDX_BUILDER:-}" ] && BUILDX_OPTS+=(--builder "$DOCKER_BUILDX_BUILDER")

# Optional registry-backed buildx cache; only attaches on buildx code paths
# (USE_MULTIARCH=true OR DOCKER_BUILDX_BUILDER set). On the plain `docker build`
# fallback below the array is unused.
CACHE_OPTS=()
if [ "${DOCKER_BUILDX_CACHE:-}" = "1" ] && [ "$CONTAINER" = "docker" ]; then
    CACHE_REF="$REGISTRY/$IMAGE_NAME:buildcache"
    CACHE_OPTS+=(
        --cache-from "type=registry,ref=$CACHE_REF"
        --cache-to   "type=registry,ref=$CACHE_REF,mode=max,image-manifest=true,oci-mediatypes=true"
    )
fi

# Forward selected env vars as Docker --build-arg flags. Keeps Dockerfiles
# free of per-CI hardcoding while letting laptops opt out of network-heavy
# build steps that don't survive a TLS-intercepting corporate proxy.
#
# Usage:
#   PREFETCH_HF_MODELS=0 make workers-build
# or for arbitrary args:
#   DOCKER_BUILD_ARGS="FOO=bar BAZ=qux" make workers-build
BUILD_ARGS_OPTS=()
# Specific opt-outs honored by the worker Dockerfiles.
if [ -n "${PREFETCH_HF_MODELS:-}" ]; then
    BUILD_ARGS_OPTS+=(--build-arg "PREFETCH_HF_MODELS=$PREFETCH_HF_MODELS")
fi
# Generic escape hatch: space-separated KEY=VALUE pairs.
if [ -n "${DOCKER_BUILD_ARGS:-}" ]; then
    # shellcheck disable=SC2086  # intentional word split
    for arg in $DOCKER_BUILD_ARGS; do
        BUILD_ARGS_OPTS+=(--build-arg "$arg")
    done
fi

# Single-platform buildx defaults to --load; DOCKER_BUILDX_PUSH=1 flips to --push
# so CI can fold the registry push into the build. Multi-platform always pushes
# (buildx requirement) and bypasses this var.
LOAD_OR_PUSH="--load"
[ "${DOCKER_BUILDX_PUSH:-}" = "1" ] && LOAD_OR_PUSH="--push"

PUSHED=false

if [ "$USE_MULTIARCH" = true ]; then
    if [ "$CONTAINER" = "docker" ]; then
        if [ "$MULTIPLE_PLATFORMS" = true ]; then
            DOCKER_BUILDKIT=1 docker buildx build "${BUILDX_OPTS[@]}" \
                --platform "$PLATFORMS" \
                "${CACHE_OPTS[@]}" \
                "${BUILD_ARGS_OPTS[@]}" \
                -t "$IMAGE_TAG" \
                -t "$IMAGE_LATEST" \
                -f "$DOCKERFILE" \
                --push "$CONTEXT"
            PUSHED=true
        else
            DOCKER_BUILDKIT=1 docker buildx build "${BUILDX_OPTS[@]}" \
                --platform "$PLATFORMS" \
                "${CACHE_OPTS[@]}" \
                "${BUILD_ARGS_OPTS[@]}" \
                -t "$IMAGE_TAG" \
                -t "$IMAGE_LATEST" \
                -f "$DOCKERFILE" \
                "$LOAD_OR_PUSH" "$CONTEXT"
            [ "$LOAD_OR_PUSH" = "--push" ] && PUSHED=true
        fi
    else
        $CONTAINER build \
            --platform "$PLATFORMS" \
            "${BUILD_ARGS_OPTS[@]}" \
            -t "$IMAGE_TAG" \
            -t "$IMAGE_LATEST" \
            -f "$DOCKERFILE" \
            "$CONTEXT"
    fi
else
    if [ "$CONTAINER" = "docker" ] && [ -n "${DOCKER_BUILDX_BUILDER:-}" ]; then
        DOCKER_BUILDKIT=1 docker buildx build "${BUILDX_OPTS[@]}" \
            "${CACHE_OPTS[@]}" \
            "${BUILD_ARGS_OPTS[@]}" \
            -t "$IMAGE_TAG" \
            -t "$IMAGE_LATEST" \
            -f "$DOCKERFILE" \
            "$LOAD_OR_PUSH" "$CONTEXT"
        [ "$LOAD_OR_PUSH" = "--push" ] && PUSHED=true
    else
        DOCKER_BUILDKIT=1 $CONTAINER build \
            "${BUILD_ARGS_OPTS[@]}" \
            -t "$IMAGE_TAG" \
            -t "$IMAGE_LATEST" \
            -f "$DOCKERFILE" \
            "$CONTEXT"
    fi
fi

if [ "$PUSHED" = true ]; then
    echo "Built and pushed → $IMAGE_TAG (+latest)"
else
    echo "Built → $IMAGE_TAG (+latest)"
fi
