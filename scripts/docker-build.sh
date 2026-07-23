#!/bin/bash
# Docker build helper script
# Supports multi-platform builds via DOCKER_PLATFORMS (e.g. linux/amd64,linux/arm64).
# When DOCKER_PLATFORMS is set, uses Docker Buildx for Docker, or --platform for Podman.
#
# Buildx (single-arch) is also active when DOCKER_BUILDX_BUILDER pins a specific
# builder (e.g. kube for cluster offload). Two optional modifiers attach to any
# active buildx invocation -- they do not, by themselves, activate buildx:
#   DOCKER_BUILDX_CACHE=1   import/export buildcache to/from $CONTAINER_IMAGE_REPO
#                           as a sibling tag `<image>:buildcache` (mode=max).
#                           Requires CONTAINER=docker; ignored for podman.
#   DOCKER_BUILDX_PUSH=1    fold the registry push into the build (--push).
#                           When set, the chained Make `*-push` targets become
#                           no-ops -- see mk/build.mk's docker-push gate.

set -e

SERVICE=$1
VERSION=$2
CONTAINER=${3:-docker}
CONTAINER_IMAGE_REPO=$4
# Optional: DOCKER_PLATFORMS set by caller (e.g. linux/amd64,linux/arm64) for multi-arch builds
# Optional: DOCKER_BUILDX_BUILDER set by caller to use a specific buildx builder (e.g. kube for Kubernetes offload)
# Optional: DOCKER_BUILDX_CACHE=1 to import/export registry-backed buildx cache (modifier; needs buildx active)
# Optional: DOCKER_BUILDX_PUSH=1 to push during build instead of a separate `docker push` pass (modifier; needs buildx active)

if [ -z "$SERVICE" ] || [ -z "$VERSION" ] || [ -z "$CONTAINER_IMAGE_REPO" ]; then
    echo "Usage: $0 <service> <version> [container] [image_repo]"
    echo "  Multi-platform: set DOCKER_PLATFORMS (e.g. linux/amd64,linux/arm64) and use Docker Buildx or Podman."
    exit 1
fi

# Normalize platforms: trim spaces, empty means native-only (legacy single-arch build)
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

BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

# Determine image prefix and service path based on service
# AgentStudio services: gui, agent-studio-ui, config-service, apigateway-service, artifact-service, storage-manager, workflow-engine, analytics-engine, kb-retrieval-service
if [[ "$SERVICE" == "agent-service" || "$SERVICE" == "agent-service-maf" || "$SERVICE" == "agent-studio-ui" || "$SERVICE" == "gui" || "$SERVICE" == "config-service" || "$SERVICE" == "apigateway-service" || "$SERVICE" == "artifact-service" || "$SERVICE" == "storage-manager" || "$SERVICE" == "workflow-engine" || "$SERVICE" == "analytics-engine" || "$SERVICE" == "kb-retrieval-service" ]]; then
    IMAGE_PREFIX="nemo"
    # Map apigateway-service service name to gateway directory path
    if [[ "$SERVICE" == "apigateway-service" ]]; then
        SERVICE_PATH="src/nemo/apigateway-service"
    else
    SERVICE_PATH="src/nemo/$SERVICE"
    fi
elif [[ "$SERVICE" == "grafana-proxy" || "$SERVICE" == "prometheus-proxy" ]]; then
    IMAGE_PREFIX="nemo"
    SERVICE_PATH="src/nemo/observability/$SERVICE"
else
    echo "Error: Unknown service $SERVICE"
    exit 1
fi

# Dockerfile location: most services keep it at the service root. agent-service-maf
# ships its build under deploy/Dockerfile (separate from the package's pyproject.toml).
if [[ "$SERVICE" == "agent-service-maf" ]]; then
    DOCKERFILE_PATH="$SERVICE_PATH/deploy/Dockerfile"
else
    DOCKERFILE_PATH="$SERVICE_PATH/Dockerfile"
fi

printf "\033[1;32m  ▶ Building %-30s  [%s %s]\033[0m\n" "$SERVICE" "$CONTAINER" "$VERSION"
# Build args common to all services
BUILD_ARGS=(
    --build-arg "VERSION=$VERSION"
    --build-arg "BUILD_TIME=$BUILD_TIME"
    --build-arg "GIT_COMMIT=$GIT_COMMIT"
)

# Add service-specific build args
if [[ "$SERVICE" == "gui" ]]; then
    # VITE_BASE_PATH defaults to /console when building for nemo (behind gateway)
    # Can be overridden via VITE_BASE_PATH environment variable
    VITE_BASE_PATH=${VITE_BASE_PATH:-/console}
    BUILD_ARGS+=(--build-arg "VITE_BASE_PATH=$VITE_BASE_PATH")
    
    # VITE_CONFIG_SERVICE_BASE_PATH defaults to /config when behind gateway
    # Can be overridden via VITE_CONFIG_SERVICE_BASE_PATH environment variable
    VITE_CONFIG_SERVICE_BASE_PATH=${VITE_CONFIG_SERVICE_BASE_PATH:-/config}
    BUILD_ARGS+=(--build-arg "VITE_CONFIG_SERVICE_BASE_PATH=$VITE_CONFIG_SERVICE_BASE_PATH")
    
    # Workspace subdomain configuration (build-time variables)
    # Can be overridden via environment variables
    # Bare deployment endpoint (workspace host = ws-{id}.{base}); not ws.{endpoint}
    VITE_WORKSPACE_SUBDOMAIN_BASE=${VITE_WORKSPACE_SUBDOMAIN_BASE:-agentstudio.local}
    BUILD_ARGS+=(--build-arg "VITE_WORKSPACE_SUBDOMAIN_BASE=$VITE_WORKSPACE_SUBDOMAIN_BASE")
    
    VITE_WORKSPACE_SUBDOMAIN_PROTOCOL=${VITE_WORKSPACE_SUBDOMAIN_PROTOCOL:-https}
    BUILD_ARGS+=(--build-arg "VITE_WORKSPACE_SUBDOMAIN_PROTOCOL=$VITE_WORKSPACE_SUBDOMAIN_PROTOCOL")
    
    # Keycloak OIDC configuration (build-time variables)
    # Can be overridden via environment variables
    VITE_KEYCLOAK_ISSUER=${VITE_KEYCLOAK_ISSUER:-https://auth.agentstudio.local/realms/nemo}
    BUILD_ARGS+=(--build-arg "VITE_KEYCLOAK_ISSUER=$VITE_KEYCLOAK_ISSUER")
    
    VITE_KEYCLOAK_CLIENT_ID=${VITE_KEYCLOAK_CLIENT_ID:-agentstudio-gui}
    BUILD_ARGS+=(--build-arg "VITE_KEYCLOAK_CLIENT_ID=$VITE_KEYCLOAK_CLIENT_ID")
    
    echo "Building gui with:"
    echo "  Base path: $VITE_BASE_PATH"
    echo "  Config service base path: $VITE_CONFIG_SERVICE_BASE_PATH"
    echo "  Workspace subdomain base: $VITE_WORKSPACE_SUBDOMAIN_BASE"
    echo "  Workspace subdomain protocol: $VITE_WORKSPACE_SUBDOMAIN_PROTOCOL"
    echo "  Keycloak issuer: $VITE_KEYCLOAK_ISSUER"
    echo "  Keycloak client ID: $VITE_KEYCLOAK_CLIENT_ID"
fi

# Build args for agent-studio-ui.
#
# VITE_BASE_PATH defaults to /studio — matches the Istio Gateway API /studio
# HTTPRoute (deployments/helm/edge/templates/httproute-app-istio.yaml), which
# strips /studio before forwarding to nginx, so the container always receives
# paths relative to /, but the Vite bundle must be built with /studio so asset
# references in index.html are /studio/assets/* and the browser fetches them via
# the gateway route rather than a bare /assets/*.
#
# The API base URLs default to the same-origin gateway prefixes on the console
# host: /api/v1 -> config-service, /agents-maf -> agent-service-maf (the gateway
# rewrites /agents-maf -> /api/v1, so the UI base omits /api/v1).
#
# Override at build time if deploying to a different gateway prefix, e.g.:
#   VITE_BASE_PATH=/myprefix make docker-build-service SERVICE=agent-studio-ui
if [[ "$SERVICE" == "agent-studio-ui" ]]; then
    VITE_BASE_PATH=${VITE_BASE_PATH:-/studio}
    BUILD_ARGS+=(--build-arg "VITE_BASE_PATH=$VITE_BASE_PATH")

    VITE_API_BASE_URL=${VITE_API_BASE_URL:-/api/v1}
    BUILD_ARGS+=(--build-arg "VITE_API_BASE_URL=$VITE_API_BASE_URL")

    VITE_UTILITIES_API_BASE_URL=${VITE_UTILITIES_API_BASE_URL:-}
    BUILD_ARGS+=(--build-arg "VITE_UTILITIES_API_BASE_URL=$VITE_UTILITIES_API_BASE_URL")

    VITE_AGENT_API_BASE_URL=${VITE_AGENT_API_BASE_URL:-/agents-maf}
    BUILD_ARGS+=(--build-arg "VITE_AGENT_API_BASE_URL=$VITE_AGENT_API_BASE_URL")

    VITE_AGENT_RUNTIME_API_BASE_URL=${VITE_AGENT_RUNTIME_API_BASE_URL:-/agents-maf}
    BUILD_ARGS+=(--build-arg "VITE_AGENT_RUNTIME_API_BASE_URL=$VITE_AGENT_RUNTIME_API_BASE_URL")

    # Default "/" so AGENTS_CONFIG_BASE_URL resolves to <origin>/ (absolute) and the
    # agents-config slice avoids /api/v1/api/v1/... double-prefixing. See Dockerfile.
    VITE_AGENTS_CONFIG_API_BASE_URL=${VITE_AGENTS_CONFIG_API_BASE_URL:-/}
    BUILD_ARGS+=(--build-arg "VITE_AGENTS_CONFIG_API_BASE_URL=$VITE_AGENTS_CONFIG_API_BASE_URL")

    VITE_MODEL_SERVICE_BASE_URL=${VITE_MODEL_SERVICE_BASE_URL:-}
    BUILD_ARGS+=(--build-arg "VITE_MODEL_SERVICE_BASE_URL=$VITE_MODEL_SERVICE_BASE_URL")

    VITE_AUTH_ENABLED=${VITE_AUTH_ENABLED:-false}
    BUILD_ARGS+=(--build-arg "VITE_AUTH_ENABLED=$VITE_AUTH_ENABLED")

    VITE_KEYCLOAK_ISSUER=${VITE_KEYCLOAK_ISSUER:-https://auth.agentstudio.local/realms/nemo}
    BUILD_ARGS+=(--build-arg "VITE_KEYCLOAK_ISSUER=$VITE_KEYCLOAK_ISSUER")

    VITE_KEYCLOAK_CLIENT_ID=${VITE_KEYCLOAK_CLIENT_ID:-agentstudio-ui}
    BUILD_ARGS+=(--build-arg "VITE_KEYCLOAK_CLIENT_ID=$VITE_KEYCLOAK_CLIENT_ID")

    echo "Building agent-studio-ui with:"
    echo "  Base path: $VITE_BASE_PATH"
    echo "  API base URL: $VITE_API_BASE_URL"
    echo "  Utilities API base URL: $VITE_UTILITIES_API_BASE_URL"
    echo "  Agent API base URL: ${VITE_AGENT_API_BASE_URL:-<unset>}"
    echo "  Agent runtime API base URL: ${VITE_AGENT_RUNTIME_API_BASE_URL:-<unset>}"
    echo "  Agents config API base URL: ${VITE_AGENTS_CONFIG_API_BASE_URL:-<unset>}"
    echo "  Model service base URL: ${VITE_MODEL_SERVICE_BASE_URL:-<unset>}"
    echo "  Auth enabled: $VITE_AUTH_ENABLED"
    echo "  Keycloak issuer: $VITE_KEYCLOAK_ISSUER"
    echo "  Keycloak client ID: $VITE_KEYCLOAK_CLIENT_ID"
fi

IMAGE_TAG="$CONTAINER_IMAGE_REPO/$IMAGE_PREFIX/$SERVICE:$VERSION"
IMAGE_LATEST="$CONTAINER_IMAGE_REPO/$IMAGE_PREFIX/$SERVICE:latest"

# Optional: disable cache (e.g. after Dockerfile RUN changes) via DOCKER_BUILD_NO_CACHE=1
EXTRA_OPTS=()
if [ -n "${DOCKER_BUILD_NO_CACHE:-}" ]; then
    EXTRA_OPTS+=(--no-cache)
fi

# Build command as array to avoid line-continuation issues (e.g. when Make uses sh or CRLF).
BUILDX_OPTS=()
[ -n "${DOCKER_BUILDX_BUILDER:-}" ] && BUILDX_OPTS+=(--builder "$DOCKER_BUILDX_BUILDER")

# Optional registry-backed buildx cache. Only attaches when CONTAINER=docker
# (cache flags are buildx-only); on the plain `docker build` fallback below
# the array is unused. mode=max exports intermediate stages so multi-stage
# Dockerfiles see the full hit rate on subsequent builds. The cache ref
# mirrors the image ref so ACR repo permissions / retention policies cover
# both uniformly.
CACHE_OPTS=()
if [ "${DOCKER_BUILDX_CACHE:-}" = "1" ] && [ "$CONTAINER" = "docker" ]; then
    CACHE_REF="$CONTAINER_IMAGE_REPO/$IMAGE_PREFIX/$SERVICE:buildcache"
    CACHE_OPTS+=(
        --cache-from "type=registry,ref=$CACHE_REF"
        --cache-to   "type=registry,ref=$CACHE_REF,mode=max,image-manifest=true,oci-mediatypes=true"
    )
fi

# Single-platform buildx paths default to --load so the image lands in the
# local docker daemon (matches existing local-dev behaviour). DOCKER_BUILDX_PUSH=1
# flips that to --push so CI can fold the registry push into the build step.
# Multi-platform manifest list builds always --push (buildx requirement) and
# don't go through this var.
LOAD_OR_PUSH="--load"
[ "${DOCKER_BUILDX_PUSH:-}" = "1" ] && LOAD_OR_PUSH="--push"

PUSHED=false

if [ "$USE_MULTIARCH" = true ]; then
    if [ "$CONTAINER" = "docker" ]; then
        if [ "$MULTIPLE_PLATFORMS" = true ]; then
            printf "\033[1;36m  ▶ Buildx multi-platform (push) %s\033[0m\n" "$PLATFORMS"
            DOCKER_BUILDKIT=1 docker buildx build "${BUILDX_OPTS[@]}" --platform "$PLATFORMS" "${CACHE_OPTS[@]}" "${EXTRA_OPTS[@]}" "${BUILD_ARGS[@]}" -t "$IMAGE_TAG" -t "$IMAGE_LATEST" -f "$DOCKERFILE_PATH" --push .
            PUSHED=true
        else
            printf "\033[1;36m  ▶ Buildx single platform (%s) %s\033[0m\n" "$LOAD_OR_PUSH" "$PLATFORMS"
            DOCKER_BUILDKIT=1 docker buildx build "${BUILDX_OPTS[@]}" --platform "$PLATFORMS" "${CACHE_OPTS[@]}" "${EXTRA_OPTS[@]}" "${BUILD_ARGS[@]}" -t "$IMAGE_TAG" -t "$IMAGE_LATEST" -f "$DOCKERFILE_PATH" "$LOAD_OR_PUSH" .
            [ "$LOAD_OR_PUSH" = "--push" ] && PUSHED=true
        fi
    else
        printf "\033[1;36m  ▶ Multi-platform build %s\033[0m\n" "$PLATFORMS"
        "$CONTAINER" build --platform "$PLATFORMS" "${EXTRA_OPTS[@]}" "${BUILD_ARGS[@]}" -t "$IMAGE_TAG" -t "$IMAGE_LATEST" -f "$DOCKERFILE_PATH" .
    fi
else
    if [ "$CONTAINER" = "docker" ] && [ -n "${DOCKER_BUILDX_BUILDER:-}" ]; then
        printf "\033[1;36m  ▶ Buildx (builder=%s) single-arch %s\033[0m\n" "$DOCKER_BUILDX_BUILDER" "$LOAD_OR_PUSH"
        DOCKER_BUILDKIT=1 docker buildx build "${BUILDX_OPTS[@]}" "${CACHE_OPTS[@]}" "${EXTRA_OPTS[@]}" "${BUILD_ARGS[@]}" -t "$IMAGE_TAG" -t "$IMAGE_LATEST" -f "$DOCKERFILE_PATH" "$LOAD_OR_PUSH" .
        [ "$LOAD_OR_PUSH" = "--push" ] && PUSHED=true
    else
        DOCKER_BUILDKIT=1 "$CONTAINER" build "${EXTRA_OPTS[@]}" "${BUILD_ARGS[@]}" -t "$IMAGE_TAG" -t "$IMAGE_LATEST" -f "$DOCKERFILE_PATH" .
    fi
fi

if [ "$PUSHED" = true ]; then
    printf "\033[1;32m  ✔ Built and pushed %-25s → %s/%s/%s:%s (+latest)\033[0m\n" "$SERVICE" "$CONTAINER_IMAGE_REPO" "$IMAGE_PREFIX" "$SERVICE" "$VERSION"
else
    printf "\033[1;32m  ✔ Built %-35s → %s/%s/%s:%s (+latest)\033[0m\n" "$SERVICE" "$CONTAINER_IMAGE_REPO" "$IMAGE_PREFIX" "$SERVICE" "$VERSION"
fi

