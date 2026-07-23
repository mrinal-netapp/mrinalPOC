# Multi-Platform Docker Builds (macOS + Linux)

This project supports building Docker images for **multiple architectures** using **native builds only** (no cross-compilation). You can develop on **macOS (Apple Silicon or Intel)** and deploy on **linux/amd64** and **linux/arm64**.

## Quick reference

| Goal | Command |
|------|--------|
| Build for current machine only (fast, local run) | `make docker-build` |
| Build and push **services** for multiple platforms | `make docker-build DOCKER_PLATFORMS=linux/amd64,linux/arm64` |
| Build and push **workers** for multiple platforms | `make workers-build DOCKER_PLATFORMS=linux/amd64,linux/arm64` |
| Build and push **standalone images** (src/images/) for multiple platforms | `make images-build DOCKER_PLATFORMS=linux/amd64,linux/arm64` |
| Single service, multi-platform | `make docker-build-service SERVICE=apigateway-service DOCKER_PLATFORMS=linux/amd64,linux/arm64` |

## How it works

- **Native build only**: Every Dockerfile compiles for the platform it runs on. There is no cross-compilation (no `BUILDPLATFORM`/`TARGETARCH`, no `GOOS`/`GOARCH`, no Rust `--target`). This keeps Dockerfiles simple and works the same on macOS, Linux amd64, and Linux arm64.
- **DOCKER_PLATFORMS**: Comma-separated list (e.g. `linux/amd64`, `linux/arm64`). When set, the build uses Docker Buildx (or Podman `--platform`). With **multiple** platforms, the build **pushes** to the registry (manifest list). With a **single** platform, the image is built and **loaded** locally.
- **Default (no DOCKER_PLATFORMS)**: Build for the host architecture only; no push during build.

## Recommended workflows

### Local development (macOS)

- **Apple Silicon**: `make docker-build` → builds `linux/arm64` and loads into Docker. No push.
- **Intel Mac**: `make docker-build` → builds `linux/amd64` and loads into Docker. No push.

### Multi-platform from a single host

When you run `make docker-build DOCKER_PLATFORMS=linux/amd64,linux/arm64` from one machine (e.g. Mac arm64), Buildx builds each platform in turn. For the **non-native** platform it uses **QEMU emulation**:

- **Go services** (apigateway-service, workflow-engine, config-service, etc.): Typically work under QEMU (may be slower).
- **Rust (kb-retrieval-service)**: Running rustc under QEMU can segfault. Prefer building on a host of each arch.
- **CGO (analytics-engine)**: Native DuckDB build under QEMU can be slow or fail.

**Recommended**: Build each architecture on a host of that architecture, then push with the same tag to form the manifest list. For example:

- From **Mac (arm64)**: build and push `linux/arm64` only (`make docker-build`), or pass both platforms and **skip** fragile services: `make docker-build DOCKER_PLATFORMS=linux/amd64,linux/arm64 SKIP_SERVICES=kb-retrieval-service,analytics-engine`
- From **Linux amd64** (or CI): build and push `linux/amd64` for all services (or the ones skipped above), then combine manifests so the registry has both arches.

### CI / Release

Use a **matrix**: run the same build on `linux/amd64` and `linux/arm64` runners (e.g. GitHub Actions matrix), then create and push a manifest list from the two images. No QEMU, all native.

## Docker Buildx setup (Docker only)

Multi-platform builds with Docker use **Buildx**. Ensure a builder that supports multiple platforms exists:

```bash
docker buildx create --use --name multiarch 2>/dev/null || docker buildx use multiarch
```

Docker Desktop for Mac usually has a default builder that supports `linux/amd64` and `linux/arm64`.

## Services, workers, and images

| Area | Command | Notes |
|------|--------|------|
| AgentStudio services | `make docker-build` (add `DOCKER_PLATFORMS=linux/amd64,linux/arm64` for multi-platform) | Uses `scripts/docker-build.sh`. All Dockerfiles are native-only. |
| Temporal workers | `make workers-build` (add `DOCKER_PLATFORMS=...` for multi-platform) | connector-worker, dataset-processor, kb-processor. |
| Standalone images | `make images-build` (add `DOCKER_PLATFORMS=...` for multi-platform) | job-setup, workspace-jupyterlab, mcp-server-*, etc. |

Workers and images use `scripts/docker-build-image.sh`; they also use native builds only.

## Base Image Source in CI

To avoid Docker Hub anonymous pull-rate limits on shared self-hosted runners, Dockerfiles in this repo pull mirrored base images from:

- `docker.repo.eng.netapp.com`

Examples:

- `docker.repo.eng.netapp.com/node:20-alpine`
- `docker.repo.eng.netapp.com/nginx:alpine`
- `docker.repo.eng.netapp.com/python:3.11-slim`

If a newly added Dockerfile still references `docker.io` directly, CI may intermittently fail with HTTP 429 (`toomanyrequests`) during base-image pulls.

## Build offload to Kubernetes (Docker only)

You can run `make docker-build` (and `images-build` / `workers-build`) with builds executed **on a Kubernetes cluster** instead of locally, using [Docker Buildx’s Kubernetes driver](https://docs.docker.com/build/builders/drivers/kubernetes/). This uses the cluster’s native arch (e.g. amd64 on a remote cluster, arm64 on Kind on Apple Silicon). No cross-compilation; single arch per cluster.

### One-time setup

1. Create a namespace and a Buildx builder that uses the Kubernetes driver:

   ```bash
   kubectl create namespace buildkit
   docker buildx create --bootstrap --name=kube --driver=kubernetes --driver-opt=namespace=buildkit
   docker buildx use kube
   ```

2. Optional: add resource or replica options when creating the builder, for example:

   ```bash
   docker buildx create --bootstrap --name=kube --driver=kubernetes \
     --driver-opt=namespace=buildkit,replicas=2,requests.cpu=2,requests.memory=4G
   ```

### Running offloaded builds

- Offload service builds:  
  `DOCKER_BUILDX_BUILDER=kube make docker-build`
- Build and run on the same cluster: build on the cluster, then push so the cluster can pull:  
  `DOCKER_BUILDX_BUILDER=kube make docker-build && make docker-push`  
  then deploy as usual (deploy uses `CONTAINER_IMAGE_REPO`, so the cluster pulls the images).
- Workers and standalone images:  
  `DOCKER_BUILDX_BUILDER=kube make workers-build` or `DOCKER_BUILDX_BUILDER=kube make images-build`

With the Kubernetes driver, `--load` sends the built image to the **machine running `docker buildx`** (your Mac or CI runner), not into the cluster. To run workloads on the same cluster, push to a registry (as above) so the cluster can pull. For Kind without a registry, after build you can run `kind load docker-image <image>` for each image.

---

## Python images: faster rebuilds (BuildKit cache)

Several Dockerfiles use **`RUN --mount=type=cache,target=/root/.cache/pip`** (or `/home/jovyan/.cache/pip` for Jupyter) so pip reuses downloaded wheels across builds—especially helpful with the **Kubernetes BuildKit driver**.

- **dataset-processor**, **kb-processor**, **connector-worker**, **vector-query-service**, **agent-service**, **kb-retrieval-service** (model-downloader), **job-setup**, **workspace-jupyterlab**, **mcp-server-duckdb**: pip cache mounts where `pip install` runs.
- **vector-query-service** and **dataset-processor**: large Hugging Face downloads use a **cache mount plus `cp` into the image layer** so rebuilds reuse the hub cache while the final image still contains the models (a plain HF cache mount alone would not copy into the image).

`requirements.txt` is copied **before** application code so dependency layers stay cached when only code changes.

---

## Optional: no-cache build

If you change a Dockerfile and the build reuses a cached layer with the old instructions, force a clean build:

```bash
DOCKER_BUILD_NO_CACHE=1 make docker-build-service SERVICE=kb-retrieval-service DOCKER_PLATFORMS=linux/arm64
```

---

## Registry-backed buildx cache (CI)

For CI runs on a self-hosted runner with a small `/var` partition, the local Docker layer cache is fragile -- aggressive prunes wipe it, and any inter-build cleanup that's tuned for disk pressure inevitably erodes cache hit rates. Two opt-in environment variables push the durable build cache out to the same registry the images are published to, decoupling cache durability from runner disk hygiene.

| Variable | When to set | Effect |
|---|---|---|
| `DOCKER_BUILDX_CACHE=1` | CI builds (and any time you want cross-machine cache reuse) | Adds `--cache-from type=registry,ref=<image>:buildcache` and `--cache-to type=registry,ref=<image>:buildcache,mode=max,...` to every `docker buildx build` invocation. One cache tag per image, mirroring the existing image ref, so ACR repo permissions and retention policies cover both image and cache uniformly. |
| `DOCKER_BUILDX_PUSH=1` | CI builds (paired with `DOCKER_BUILDX_CACHE=1`) | Flips the buildx output from `--load` to `--push` so the registry push happens at build time. The chained Make targets `docker-push` / `images-push` / `workers-push` (and their single-image variants) detect this and become no-ops, so `make docker-build-push` pushes once instead of twice. |

Both vars are **modifiers** on an active buildx invocation -- they do not activate buildx by themselves. The build scripts already switch to `docker buildx build` whenever `DOCKER_BUILDX_BUILDER` is set or `DOCKER_PLATFORMS` requests multi-arch; CI sets `DOCKER_BUILDX_BUILDER` to the builder produced by `docker/setup-buildx-action`, so the cache and push flags attach to that. Setting `DOCKER_BUILDX_CACHE=1` (or `DOCKER_BUILDX_PUSH=1`) without one of those activators is a no-op -- the legacy `docker build` fallback doesn't accept either flag.

### CI usage

Wired into `.github/workflows/build-common.yml`:

```yaml
- name: Set up Docker Buildx
  id: buildx
  uses: docker/setup-buildx-action@v3
  with:
    driver: docker-container
    driver-opts: network=host
    install: false

- name: Build and push NEMO_SERVICES
  env:
    DOCKER_BUILDX_BUILDER: ${{ steps.buildx.outputs.name }}
    DOCKER_BUILDX_CACHE: "1"
    DOCKER_BUILDX_PUSH: "1"
  run: make docker-build-push CONTAINER_IMAGE_REPO="$PRIMARY_IMAGE_REGISTRY" VERSION="${{ inputs.tag }}"
```

The `docker-container` driver runs builds inside a buildkit sidecar container that inherits credentials from the host's `~/.docker/config.json` (populated by `az acr login`, `gcloud auth configure-docker`, `aws-actions/amazon-ecr-login`), so cache push/pull and image push to ACR/GAR/ECR work without extra auth wiring.

### Local usage

The vars are off by default. If you want to test cache reuse locally:

```bash
docker buildx create --use --name local-cache --driver docker-container --bootstrap
DOCKER_BUILDX_CACHE=1 DOCKER_BUILDX_BUILDER=local-cache \
  make docker-build CONTAINER_IMAGE_REPO=<your-acr>
```

`--load` is the default output (single-platform), so the image still ends up in your local Docker. Add `DOCKER_BUILDX_PUSH=1` to push directly instead.

### ACR retention (one-time admin step)

Each successful build overwrites the `:buildcache` tag, leaving the prior cache manifest untagged. Without a retention policy these accumulate as orphan blobs in ACR. Run once per registry:

```bash
az acr config retention update \
  --registry <acr-name> \
  --type UntaggedManifests \
  --days 7 \
  --status enabled
```

This bounds storage growth without affecting freshly written cache (always tagged for at least one build cycle).

### Cache pollution / invalidation

If a build produces bad layers and they get cached, the next build will reuse them. Two escape hatches:

1. Single-build bypass — `DOCKER_BUILD_NO_CACHE=1` is already wired into both build scripts; setting it skips the cache for that run.
2. Registry-side reset — delete the bad cache tag in ACR:
   ```bash
   az acr repository delete -n <acr-name> --image <image>:buildcache --yes
   ```
   The next build will repopulate it.
