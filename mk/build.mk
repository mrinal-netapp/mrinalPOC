# mk/build.mk -- service build, Docker image build/push, standalone images,
# Temporal worker images, AgentStudio operator, and clean targets.
#
# Holds everything that produces an artifact (jar / .so / OCI image) but
# does not touch a Kubernetes cluster. Cluster-touching helm-* / deploy-*
# targets live in mk/tier-helm.mk and mk/cloud/<cloud>.mk.
#
# Adding a new build target: put it here. Adding a new container image
# under src/images/: append to ALL_IMAGES so images-build/push picks it up.

# ============================================================================
# Build Commands
# ============================================================================

# True (=1) iff scripts/docker-build.sh / docker-build-image.sh would have
# folded the registry push into the build step (PUSHED=true) for the
# current invocation. Each Make-side push gate below consults this so we
# don't skip pushes when buildx wasn't actually active.
#
# DOCKER_BUILDX_PUSH is a *modifier* -- on its own it does not activate
# buildx. The script's activation rule is: buildx is in play iff
# DOCKER_PLATFORMS is non-empty OR DOCKER_BUILDX_BUILDER is pinned. With
# neither set, the script falls back to plain `docker build`, which only
# loads the image into the local daemon -- nothing is pushed. Skipping
# the Make-side push in that case would leave the requested tag missing
# from the registry.
#
# Pushed inline iff CONTAINER=docker AND one of:
#   - DOCKER_PLATFORMS contains a comma (multi-arch buildx always --push), OR
#   - DOCKER_BUILDX_PUSH=1 AND (DOCKER_PLATFORMS set OR DOCKER_BUILDX_BUILDER set)
#     (single-arch buildx with --push; needs buildx active for the modifier
#     to take effect.)
#
# Keep in lockstep with PUSHED=true in scripts/docker-build.sh and
# scripts/docker-build-image.sh.
comma := ,
BUILD_PUSHED_INLINE := $(strip \
  $(if $(filter docker,$(CONTAINER)),\
    $(if $(findstring $(comma),$(DOCKER_PLATFORMS)),1,\
      $(if $(filter 1,$(DOCKER_BUILDX_PUSH)),\
        $(if $(or $(DOCKER_PLATFORMS),$(DOCKER_BUILDX_BUILDER)),1)))))

build: ## Build all services
	@printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Building observability-client (Node.js)\n$(SEPARATOR)$(COLOR_RESET)\n\n"
	@cd src/common/src/observability/observability-client && npm install && npm run build && cd ../../../../.. || exit 1
	@printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Building common package\n$(SEPARATOR)$(COLOR_RESET)\n\n"
	@cd src/common && npm install && npm run build && cd ../.. || exit 1
	@echo "Consolidating OpenAPI specs for apigateway-service..."
	@python3 scripts/consolidate-openapi.py || echo "Warning: OpenAPI consolidation failed, continuing..."
	@for service in $(NEMO_SERVICES); do \
		[ -n "$(SKIP_SERVICES)" ] && echo ",$(SKIP_SERVICES)," | grep -q ",$$service," && { printf "$(COLOR_CYAN)  ⏭  Skipping $$service (SKIP_SERVICES)$(COLOR_RESET)\n"; continue; }; \
		if echo "$(PYTHON_SERVICES)" | grep -qE "(^| )$$service( |$$)"; then \
			printf "\n$(COLOR_GREEN)$(SEPARATOR)\n  BUILD  %-30s  [Python — Docker only]\n$(SEPARATOR)$(COLOR_RESET)\n\n" "$$service"; \
		elif echo "$(GO_SERVICES)" | grep -qE "(^| )$$service( |$$)"; then \
			printf "\n$(COLOR_GREEN)$(SEPARATOR)\n  BUILD  %-30s  [Go]\n$(SEPARATOR)$(COLOR_RESET)\n\n" "$$service"; \
			cd src/nemo/$$service && go mod download && go mod tidy && cd ../../.. || exit 1; \
		elif echo "$(RUST_SERVICES)" | grep -qE "(^| )$$service( |$$)"; then \
			printf "\n$(COLOR_GREEN)$(SEPARATOR)\n  BUILD  %-30s  [Rust]\n$(SEPARATOR)$(COLOR_RESET)\n\n" "$$service"; \
			cd src/nemo/$$service && cargo build --release && cd ../../.. || exit 1; \
		else \
			printf "\n$(COLOR_GREEN)$(SEPARATOR)\n  BUILD  %-30s  [Node]\n$(SEPARATOR)$(COLOR_RESET)\n\n" "$$service"; \
			cd src/nemo/$$service && npm install && npm run build && cd ../../.. || exit 1; \
		fi; \
	done
	@for service in $(OBSERVABILITY_SERVICES); do \
		printf "\n$(COLOR_GREEN)$(SEPARATOR)\n  BUILD  $$service  [Go]\n$(SEPARATOR)$(COLOR_RESET)\n\n"; \
		(cd src/nemo/observability/$$service && go mod download && go mod tidy) || exit 1; \
	done

docker-build: ## Build Docker images with version tags (set DOCKER_PLATFORMS=linux/amd64,linux/arm64 for multi-arch)
	@printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Docker Build — $(CONTAINER) (version $(VERSION))$(if $(DOCKER_PLATFORMS), platforms=$(DOCKER_PLATFORMS))\n$(SEPARATOR)$(COLOR_RESET)\n\n"
	@for service in $(NEMO_SERVICES); do \
		[ -n "$(SKIP_SERVICES)" ] && echo ",$(SKIP_SERVICES)," | grep -q ",$$service," && { printf "$(COLOR_CYAN)  ⏭  Skipping $$service (SKIP_SERVICES)$(COLOR_RESET)\n"; continue; }; \
		printf "\n$(COLOR_GREEN)$(SEPARATOR)\n  DOCKER BUILD  %-30s\n$(SEPARATOR)$(COLOR_RESET)\n\n" "$$service"; \
		DOCKER_PLATFORMS="$(DOCKER_PLATFORMS)" SERVICE_CONTEXT=nemo bash $(DOCKER_BUILD_SCRIPT) $$service $(VERSION) $(CONTAINER) $(CONTAINER_IMAGE_REPO) || exit 1; \
	done
	@for service in $(OBSERVABILITY_SERVICES); do \
		printf "\n$(COLOR_GREEN)$(SEPARATOR)\n  DOCKER BUILD  %-30s\n$(SEPARATOR)$(COLOR_RESET)\n\n" "$$service"; \
		DOCKER_PLATFORMS="$(DOCKER_PLATFORMS)" bash $(DOCKER_BUILD_SCRIPT) $$service $(VERSION) $(CONTAINER) $(CONTAINER_IMAGE_REPO) || exit 1; \
	done
	@printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Built images\n$(SEPARATOR)$(COLOR_RESET)\n"
	@for service in $(NEMO_SERVICES); do \
		[ -n "$(SKIP_SERVICES)" ] && echo ",$(SKIP_SERVICES)," | grep -q ",$$service," && continue; \
		printf "  $(COLOR_GREEN)✔$(COLOR_RESET)  $(CONTAINER_IMAGE_REPO)/nemo/$$service:$(VERSION)\n"; \
	done
	@for service in $(OBSERVABILITY_SERVICES); do \
		printf "  $(COLOR_GREEN)✔$(COLOR_RESET)  $(CONTAINER_IMAGE_REPO)/nemo/$$service:$(VERSION)\n"; \
	done
	@echo ""

docker-build-service: ## Build a specific service (usage: make docker-build-service SERVICE=apigateway)
	@if [ -z "$(SERVICE)" ]; then \
		echo "Error: SERVICE variable required. Usage: make docker-build-service SERVICE=<service-name>"; \
		exit 1; \
	fi
	@if echo "$(SERVICE)" | grep -qE "^(agent-service|agent-service-maf|agent-studio-ui|gui|config-service|apigateway-service|artifact-service|workflow-engine|storage-manager|analytics-engine|kb-retrieval-service)$$"; then \
		DOCKER_PLATFORMS="$(DOCKER_PLATFORMS)" SERVICE_CONTEXT=nemo bash $(DOCKER_BUILD_SCRIPT) $(SERVICE) $(VERSION) $(CONTAINER) $(CONTAINER_IMAGE_REPO); \
	else \
		echo "Error: Unknown service $(SERVICE)"; \
		exit 1; \
	fi

docker-push: ## Push Docker images to registry (skipped only when the build pushed inline via buildx --push; see BUILD_PUSHED_INLINE)
	@if [ "$(BUILD_PUSHED_INLINE)" = "1" ]; then \
		printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Docker Push — skipped (build already pushed inline)\n$(SEPARATOR)$(COLOR_RESET)\n\n"; \
	else \
		printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Docker Push — $(CONTAINER_IMAGE_REPO) ($(VERSION))\n$(SEPARATOR)$(COLOR_RESET)\n\n"; \
		for service in $(NEMO_SERVICES); do \
			[ -n "$(SKIP_SERVICES)" ] && echo ",$(SKIP_SERVICES)," | grep -q ",$$service," && { printf "$(COLOR_CYAN)  ⏭  Skipping $$service (SKIP_SERVICES)$(COLOR_RESET)\n"; continue; }; \
			printf "  $(COLOR_GREEN)⬆$(COLOR_RESET)  Pushing $$service ...\n"; \
			$(CONTAINER) push $(CONTAINER_IMAGE_REPO)/nemo/$$service:$(VERSION) || exit 1; \
			$(CONTAINER) push $(CONTAINER_IMAGE_REPO)/nemo/$$service:latest || exit 1; \
		done; \
		for service in $(OBSERVABILITY_SERVICES); do \
			printf "  $(COLOR_GREEN)⬆$(COLOR_RESET)  Pushing $$service ...\n"; \
			$(CONTAINER) push $(CONTAINER_IMAGE_REPO)/nemo/$$service:$(VERSION) || exit 1; \
			$(CONTAINER) push $(CONTAINER_IMAGE_REPO)/nemo/$$service:latest || exit 1; \
		done; \
	fi
	@printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Pushed images\n$(SEPARATOR)$(COLOR_RESET)\n"
	@for service in $(NEMO_SERVICES); do \
		[ -n "$(SKIP_SERVICES)" ] && echo ",$(SKIP_SERVICES)," | grep -q ",$$service," && continue; \
		printf "  $(COLOR_GREEN)✔$(COLOR_RESET)  $(CONTAINER_IMAGE_REPO)/nemo/$$service:$(VERSION)\n"; \
	done
	@for service in $(OBSERVABILITY_SERVICES); do \
		printf "  $(COLOR_GREEN)✔$(COLOR_RESET)  $(CONTAINER_IMAGE_REPO)/nemo/$$service:$(VERSION)\n"; \
	done
	@echo ""

docker-push-service: ## Push a specific service image (skipped only when the build pushed inline via buildx --push; usage: make docker-push-service SERVICE=apigateway)
	@if [ -z "$(SERVICE)" ]; then \
		echo "Error: SERVICE variable required. Usage: make docker-push-service SERVICE=<service-name>"; \
		exit 1; \
	fi
	@if [ "$(BUILD_PUSHED_INLINE)" = "1" ]; then \
		printf "$(COLOR_CYAN)  ⏭  Push skipped for $(SERVICE) (build pushed inline via buildx --push)$(COLOR_RESET)\n"; \
		exit 0; \
	fi
	@echo "Pushing $(SERVICE) to $(CONTAINER_IMAGE_REPO) using $(CONTAINER)..."
	@if echo "$(SERVICE)" | grep -qE "^(agent-service|agent-service-maf|agent-studio-ui|gui|config-service|apigateway-service|artifact-service|workflow-engine|storage-manager|analytics-engine|kb-retrieval-service)$$"; then \
		if $(CONTAINER) push $(CONTAINER_IMAGE_REPO)/nemo/$(SERVICE):$(VERSION) && \
		   $(CONTAINER) push $(CONTAINER_IMAGE_REPO)/nemo/$(SERVICE):latest; then \
			echo "Pushed image: $(CONTAINER_IMAGE_REPO)/nemo/$(SERVICE):$(VERSION) (+latest)"; \
		else \
			echo "Error: Failed to push image $(CONTAINER_IMAGE_REPO)/nemo/$(SERVICE):$(VERSION)"; \
			exit 1; \
		fi; \
	else \
		echo "Error: Unknown service $(SERVICE)"; \
		exit 1; \
	fi

docker-build-push: docker-build docker-push ## Build and push all Docker images

# ============================================================================
# Standalone Image Build Commands (delegated to individual Makefiles)
# ============================================================================
# Each image under src/images/ has its own Makefile with build/push/clean targets.
# To build individual images:
#   cd src/images/job-dataset-import && make build
#   cd src/images/mcp-server-kubernetes && make build
#   make image-build IMAGE=mcp-server-kubernetes
#
# Or use the convenience targets below to build all images at once.

# All images under src/images/ (jobs, workspaces, MCP servers, and versitygw mirror)
# Note: job-dataset-import and job-kb-update have been replaced by Temporal workers
# under src/nemo/workers/ (see WORKER_IMAGES below)
ALL_IMAGES := job-setup init-tools workspace-jupyterlab \
	mcp-server-kubernetes mcp-server-postgres mcp-server-filesystem \
	mcp-server-github mcp-server-sqlite mcp-server-memory mcp-server-duckdb \
	mcp-server-prometheus mcp-server-web-search mcp-server-searxng \
	mcp-server-ontap mcp-server-gcnv mcp-server-anf mcp-server-gcnv-logs mcp-server-anf-logs \
	mcp-server-analytics versitygw bifrost

# Subset of ALL_IMAGES whose per-image Makefile's `build` target is a
# `docker pull + docker tag` mirror of an upstream image rather than a
# real Dockerfile build. These do NOT participate in `docker buildx
# build --push`, so the standard "build already pushed inline" skip in
# images-push does not apply to them — they must be pushed explicitly
# even when DOCKER_BUILDX_PUSH=1 / multi-arch buildx is active. Without
# this, downstream cross-registry mirror steps (e.g. the ACR -> GAR/ECR
# mirror in .github/workflows/build-common.yml) read a missing source
# tag and fail with "not found".
#
# Both republish an upstream image without buildx --push: versitygw is a
# plain `docker pull + docker tag`, bifrost is a plain `docker build` of a
# Dockerfile (FROM maximhq/bifrost + baked pricing datasheets). Keep this
# list narrow — add only images whose `build` does not push inline via buildx.
MIRROR_IMAGES := versitygw bifrost

# Temporal worker images under src/nemo/workers/
WORKER_IMAGES := dataset-processor kb-processor connector-worker eval-worker

# Plain-stdout helpers for CI / scripts that need the canonical service
# and worker lists. `make -s print-nemo-services` etc. emits a single
# space-separated line with no surrounding noise.
print-nemo-services: ## Print NEMO_SERVICES (space-separated; for CI/scripts)
	@echo $(NEMO_SERVICES)

print-observability-services: ## Print OBSERVABILITY_SERVICES (space-separated; for CI/scripts)
	@echo $(OBSERVABILITY_SERVICES)

print-worker-images: ## Print WORKER_IMAGES (space-separated; for CI/scripts)
	@echo $(WORKER_IMAGES)

print-all-images: ## Print ALL_IMAGES from src/images/ (space-separated; for CI/scripts)
	@echo $(ALL_IMAGES)

# Image-prefix policy for src/images/* pushes:
#
# Each per-image Makefile under src/images/<image>/Makefile encodes the
# desired registry path inside its own `IMAGE_NAME :=` line:
#
#   * src/images/init-tools/Makefile           -> IMAGE_NAME := init-tools
#   * src/images/job-setup/Makefile            -> IMAGE_NAME := job-setup
#   * src/images/workspace-jupyterlab/Makefile -> IMAGE_NAME := workspace-jupyterlab
#   * src/images/mcp-server-*/Makefile         -> IMAGE_NAME := nemo/mcp-server-<x>
#   * src/images/versitygw/Makefile            -> IMAGE_NAME := versity/versitygw (upstream mirror)
#
# Each per-image Makefile then computes its final image ref as
# `$(REGISTRY)/$(IMAGE_NAME):$(VERSION)`, so the parent only has to pass
# `REGISTRY=$(CONTAINER_IMAGE_REPO)` and the right `<acr>/[nemo/]<img>`
# layout falls out automatically. No per-family switch is needed at the
# parent layer — adding one would double-prefix the mcp-server-* images
# (e.g. <acr>/nemo/nemo/mcp-server-X). If a future image needs to live
# under a different prefix, edit its own Makefile's `IMAGE_NAME`.
#
# The same flat `REGISTRY=<acr>` is mirrored in
# `.github/workflows/build-common.yml` (Generate ACR image URLs step) so
# the JSON URL list emitted to wiz-image-scan + the release-notes ACR
# map agree with what we just pushed.

images-build: ## Build all images in src/images/ (set DOCKER_PLATFORMS for multi-arch)
	@printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Image Build — $(CONTAINER) (version $(VERSION))$(if $(DOCKER_PLATFORMS), platforms=$(DOCKER_PLATFORMS))\n$(SEPARATOR)$(COLOR_RESET)\n\n"
	@for img in $(ALL_IMAGES); do \
		printf "\n$(COLOR_GREEN)$(SEPARATOR)\n  BUILD  %s\n$(SEPARATOR)$(COLOR_RESET)\n\n" "$$img"; \
		$(MAKE) -C src/images/$$img build CONTAINER=$(CONTAINER) VERSION=$(VERSION) REGISTRY=$(CONTAINER_IMAGE_REPO) DOCKER_PLATFORMS="$(DOCKER_PLATFORMS)" REPO_ROOT=$(CURDIR) || exit 1; \
	done
	@printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Built all images\n$(SEPARATOR)$(COLOR_RESET)\n"
	@for img in $(ALL_IMAGES); do \
		printf "  $(COLOR_GREEN)✔$(COLOR_RESET)  $$img\n"; \
	done
	@echo ""

images-push: ## Push all images in src/images/ (MIRROR_IMAGES always push; Dockerfile builds skip only when the build pushed inline via buildx --push; see BUILD_PUSHED_INLINE)
	@# Mirror images first, unconditionally. Their `build` target is
	@# `docker pull + docker tag` against the host daemon, so buildx
	@# --push never touched them and the inline-push skip below would
	@# leave the target tag missing from the registry.
	@if [ -n "$(strip $(MIRROR_IMAGES))" ]; then \
		printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Mirror Image Push — $(CONTAINER_IMAGE_REPO) ($(VERSION))\n$(SEPARATOR)$(COLOR_RESET)\n\n"; \
		for img in $(MIRROR_IMAGES); do \
			printf "  $(COLOR_GREEN)⬆$(COLOR_RESET)  Pushing %s (mirror) ...\n" "$$img"; \
			$(MAKE) -C src/images/$$img push CONTAINER=$(CONTAINER) VERSION=$(VERSION) REGISTRY=$(CONTAINER_IMAGE_REPO) || exit 1; \
		done; \
	fi
	@# Dockerfile-built images. Skip when buildx already pushed inline.
	@if [ "$(BUILD_PUSHED_INLINE)" = "1" ]; then \
		printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Image Push (Dockerfile builds) — skipped (build already pushed inline)\n$(SEPARATOR)$(COLOR_RESET)\n\n"; \
	else \
		printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Image Push — $(CONTAINER_IMAGE_REPO) ($(VERSION))\n$(SEPARATOR)$(COLOR_RESET)\n\n"; \
		for img in $(filter-out $(MIRROR_IMAGES),$(ALL_IMAGES)); do \
			printf "  $(COLOR_GREEN)⬆$(COLOR_RESET)  Pushing %s ...\n" "$$img"; \
			$(MAKE) -C src/images/$$img push CONTAINER=$(CONTAINER) VERSION=$(VERSION) REGISTRY=$(CONTAINER_IMAGE_REPO) || exit 1; \
		done; \
		printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Pushed all images\n$(SEPARATOR)$(COLOR_RESET)\n"; \
		for img in $(filter-out $(MIRROR_IMAGES),$(ALL_IMAGES)); do \
			printf "  $(COLOR_GREEN)✔$(COLOR_RESET)  $$img\n"; \
		done; \
		echo ""; \
	fi

images-build-push: images-build images-push ## Build and push all images in src/images/

workers-build: ## Build all Temporal worker images (set DOCKER_PLATFORMS for multi-arch; SKIP_SERVICES=name1,name2 to skip)
	@printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Worker Build — $(CONTAINER) (version $(VERSION))$(if $(DOCKER_PLATFORMS), platforms=$(DOCKER_PLATFORMS))$(if $(SKIP_SERVICES), skipping=$(SKIP_SERVICES))\n$(SEPARATOR)$(COLOR_RESET)\n\n"
	@printf "$(COLOR_CYAN)  Syncing Python observability client into workers build context...$(COLOR_RESET)\n"
	@rm -rf src/nemo/workers/observability-client
	@cp -r src/common-py/observability/observability-client src/nemo/workers/observability-client
	@for worker in $(WORKER_IMAGES); do \
		[ -n "$(SKIP_SERVICES)" ] && echo ",$(SKIP_SERVICES)," | grep -q ",$$worker," && { printf "$(COLOR_CYAN)  ⏭  Skipping $$worker (SKIP_SERVICES)$(COLOR_RESET)\n"; continue; }; \
		printf "\n$(COLOR_GREEN)$(SEPARATOR)\n  BUILD  %-30s\n$(SEPARATOR)$(COLOR_RESET)\n\n" "$$worker"; \
		$(MAKE) -C src/nemo/workers/$$worker build CONTAINER=$(CONTAINER) VERSION=$(VERSION) REGISTRY=$(CONTAINER_IMAGE_REPO) DOCKER_PLATFORMS="$(DOCKER_PLATFORMS)" REPO_ROOT=$(CURDIR) || exit 1; \
	done
	@printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Built all worker images\n$(SEPARATOR)$(COLOR_RESET)\n"
	@for worker in $(WORKER_IMAGES); do \
		[ -n "$(SKIP_SERVICES)" ] && echo ",$(SKIP_SERVICES)," | grep -q ",$$worker," && continue; \
		printf "  $(COLOR_GREEN)✔$(COLOR_RESET)  $$worker\n"; \
	done
	@echo ""

workers-push: ## Push all Temporal worker images (skipped only when the build pushed inline via buildx --push; SKIP_SERVICES=name1,name2 to skip; see BUILD_PUSHED_INLINE)
	@if [ "$(BUILD_PUSHED_INLINE)" = "1" ]; then \
		printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Worker Push — skipped (build already pushed inline)\n$(SEPARATOR)$(COLOR_RESET)\n\n"; \
	else \
		printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Worker Push — $(CONTAINER_IMAGE_REPO) ($(VERSION))$(if $(SKIP_SERVICES), skipping=$(SKIP_SERVICES))\n$(SEPARATOR)$(COLOR_RESET)\n\n"; \
		for worker in $(WORKER_IMAGES); do \
			[ -n "$(SKIP_SERVICES)" ] && echo ",$(SKIP_SERVICES)," | grep -q ",$$worker," && { printf "$(COLOR_CYAN)  ⏭  Skipping $$worker (SKIP_SERVICES)$(COLOR_RESET)\n"; continue; }; \
			printf "  $(COLOR_GREEN)⬆$(COLOR_RESET)  Pushing $$worker ...\n"; \
			$(MAKE) -C src/nemo/workers/$$worker push CONTAINER=$(CONTAINER) VERSION=$(VERSION) REGISTRY=$(CONTAINER_IMAGE_REPO) || exit 1; \
		done; \
		printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Pushed all worker images\n$(SEPARATOR)$(COLOR_RESET)\n"; \
		for worker in $(WORKER_IMAGES); do \
			[ -n "$(SKIP_SERVICES)" ] && echo ",$(SKIP_SERVICES)," | grep -q ",$$worker," && continue; \
			printf "  $(COLOR_GREEN)✔$(COLOR_RESET)  $$worker\n"; \
		done; \
		echo ""; \
	fi

workers-build-push: workers-build workers-push ## Build and push all Temporal worker images

image-build: ## Build a single image (usage: make image-build IMAGE=mcp-server-kubernetes)
	@if [ -z "$(IMAGE)" ]; then \
		echo "Error: IMAGE variable required. Usage: make image-build IMAGE=<name>"; \
		echo "Available images: $(ALL_IMAGES)"; \
		exit 1; \
	fi
	$(MAKE) -C src/images/$(IMAGE) build CONTAINER=$(CONTAINER) VERSION=$(VERSION) REGISTRY=$(CONTAINER_IMAGE_REPO) DOCKER_PLATFORMS="$(DOCKER_PLATFORMS)" REPO_ROOT=$(CURDIR)

image-push: ## Push a single image (skipped only when the build pushed inline via buildx --push; usage: make image-push IMAGE=mcp-server-kubernetes)
	@if [ -z "$(IMAGE)" ]; then \
		echo "Error: IMAGE variable required. Usage: make image-push IMAGE=<name>"; \
		echo "Available images: $(ALL_IMAGES)"; \
		exit 1; \
	fi
	@if [ "$(BUILD_PUSHED_INLINE)" = "1" ]; then \
		printf "$(COLOR_CYAN)  ⏭  Push skipped for $(IMAGE) (build pushed inline via buildx --push)$(COLOR_RESET)\n"; \
		exit 0; \
	fi
	$(MAKE) -C src/images/$(IMAGE) push CONTAINER=$(CONTAINER) VERSION=$(VERSION) REGISTRY=$(CONTAINER_IMAGE_REPO)

# ─── Integration-test harness image ───────────────────────────────────────
# Packages tests/integration/ (pytest + allure-pytest) so CI can `docker run`
# the suite instead of `make setup` + pytest on the runner. Tagged by the git
# tree hash of tests/integration/ (scripts/integration-image-tag.sh) so it
# rebuilds only when the harness changes. See docs/testing/integration-cicd.md
# and .github/workflows/integration-image-build.yml (the CI build/push path).
INTEGRATION_IMAGE_REPO ?= integration-tests

integration-image-tag: ## Print the content-hash tag for the integration-test image (git tree hash of tests/integration/)
	@scripts/integration-image-tag.sh

integration-image-build: ## Build the integration-test image locally (tag = tree hash; CONTAINER_IMAGE_REPO namespaces it; BASE_IMAGE overrides the base for off-VPN builds)
	@TAG="$$(scripts/integration-image-tag.sh)"; \
	IMAGE="$(strip $(if $(CONTAINER_IMAGE_REPO),$(CONTAINER_IMAGE_REPO)/))$(INTEGRATION_IMAGE_REPO)"; \
	printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Integration-test image — $$IMAGE:$$TAG\n$(SEPARATOR)$(COLOR_RESET)\n\n"; \
	$(CONTAINER) build $(if $(BASE_IMAGE),--build-arg BASE_IMAGE=$(BASE_IMAGE)) -t "$$IMAGE:$$TAG" -t "$$IMAGE:latest" tests/integration && \
	printf "  $(COLOR_GREEN)✔$(COLOR_RESET)  $$IMAGE:$$TAG\n\n"

# ─── Bifrost upstream-image mirror ────────────────────────────────────────
# Mirrors the upstream `maximhq/bifrost` image to CONTAINER_IMAGE_REPO/bifrost
# so the LLM-gateway tier's chart can pull it from a private registry without
# reaching docker.io at deploy time. Idempotent.
# v1.5.16 is the floor for file:// pricing URLs (see Dockerfile comment
# for the full rationale).
#
# Lockstep — this default must stay in sync with three other places:
#   * `ARG BIFROST_UPSTREAM_VERSION` in src/images/bifrost/Dockerfile
#   * `BIFROST_UPSTREAM_VERSION` in src/images/bifrost/Makefile
#   * `image.tag` in deployments/helm/llm-gateway/values.yaml
BIFROST_TAG ?= v1.5.16

bifrost-build-push: ## Mirror maximhq/bifrost to CONTAINER_IMAGE_REPO/bifrost (BIFROST_TAG=v1.5.16)
	@if [ -z "$(CONTAINER_IMAGE_REPO)" ]; then \
		echo "Error: CONTAINER_IMAGE_REPO required. Example:"; \
		echo "  make bifrost-build-push CONTAINER_IMAGE_REPO=cragentstudiodeveus2001.azurecr.io BIFROST_TAG=v1.5.16"; \
		exit 1; \
	fi
	$(MAKE) -C src/images/bifrost build-push CONTAINER=$(CONTAINER) REGISTRY=$(CONTAINER_IMAGE_REPO) BIFROST_UPSTREAM_VERSION=$(BIFROST_TAG)

bifrost-mirror-push: ## Mirror Bifrost to ACR and roll the cluster Deployment (requires kubectl + login)
	@bash scripts/bifrost-mirror-push.sh

# ============================================================================
# Text Embeddings Inference (TEI) — built-in embedding backend for KB
# ============================================================================

TEI_IMAGE ?= ghcr.io/huggingface/text-embeddings-inference:cpu-1.5

helm-tei-prepull: ## Pre-pull amd64 TEI image to local Docker cache (Apple Silicon dev). Avoids first-pod-start QEMU thrash; runs under Rosetta/QEMU after the pull.
	@echo "Pulling $(TEI_IMAGE) for linux/amd64 (works on arm64 hosts via QEMU/Rosetta)..."
	@docker pull --platform linux/amd64 $(TEI_IMAGE)
	@echo "Done. Helm install will reuse this image from local cache."

# ============================================================================
# AgentStudio Operator Commands
# ============================================================================
# The operator replaces the multi-stage Helm workflow with a single CR.
# Build the operator image (embeds Helm charts), deploy it to the cluster,
# then apply a NemoInstallation CR — the AgentStudio operator handles the rest.

OPERATOR_DIR := src/nemo/nemo-operator

# Common args forwarded to the operator sub-Makefile.
# IMAGE_TAG overrides the image tag (default: VERSION).
# FORCE_PULL=1 sets imagePullPolicy=Always on the operator Deployment.
OPERATOR_ARGS := CONTAINER=$(CONTAINER) VERSION=$(VERSION) REGISTRY=$(CONTAINER_IMAGE_REPO)
ifdef IMAGE_TAG
OPERATOR_ARGS += IMAGE_TAG=$(IMAGE_TAG)
endif
ifdef FORCE_PULL
OPERATOR_ARGS += FORCE_PULL=$(FORCE_PULL)
endif

operator-build: ## Build the AgentStudio operator Docker image (with embedded Helm charts). Supports IMAGE_TAG.
	@echo "Building AgentStudio operator image..."
	$(MAKE) -C $(OPERATOR_DIR) helm-dep-update docker-build $(OPERATOR_ARGS)

operator-push: ## Push the AgentStudio operator Docker image to registry. Supports IMAGE_TAG.
	$(MAKE) -C $(OPERATOR_DIR) docker-push $(OPERATOR_ARGS)

operator-build-push: ## Build and push the AgentStudio operator Docker image. Supports IMAGE_TAG.
	$(MAKE) -C $(OPERATOR_DIR) docker-build-push $(OPERATOR_ARGS)

operator-deploy: ## Deploy the AgentStudio operator to the K8s cluster. Supports IMAGE_TAG, FORCE_PULL=1.
	$(MAKE) -C $(OPERATOR_DIR) deploy $(OPERATOR_ARGS)
	@echo ""
	@echo "Operator deployed. Next steps:"
	@echo "  1. Edit $(OPERATOR_DIR)/config/samples/install_v1alpha1_nemoinstallation.yaml"
	@echo "  2. Run: make operator-apply-sample"
	@echo "  3. Watch: make operator-status"

operator-undeploy: ## Remove the AgentStudio operator from the K8s cluster
	$(MAKE) -C $(OPERATOR_DIR) undeploy

operator-apply-sample: ## Apply the sample NemoInstallation CR to start the platform install. Use IMAGE_TAG=v0.1.0 to set a specific image tag.
	$(MAKE) -C $(OPERATOR_DIR) apply-sample $(if $(IMAGE_TAG),IMAGE_TAG=$(IMAGE_TAG))

operator-delete-sample: ## Delete the sample NemoInstallation CR
	$(MAKE) -C $(OPERATOR_DIR) delete-sample

operator-status: ## Show NemoInstallation CR status and operator pod
	$(MAKE) -C $(OPERATOR_DIR) status

operator-logs: ## Tail AgentStudio operator pod logs
	$(MAKE) -C $(OPERATOR_DIR) logs

# ============================================================================

clean: ## Clean build artifacts (TS dist, node_modules, Rust target, Python caches, *.tsbuildinfo). Keeps Helm cache — use clean-helm for that.
	@echo "Cleaning build artifacts..."
	@# JS/TS build outputs (dist, node_modules) AND Rust target dirs at any
	@# depth under src/. -prune so we never descend INTO a matched dir
	@# (avoids minutes of stat'ing every cached crate / node module).
	@# .venv is excluded so we never touch a developer's virtualenv.
	@# The first -prune branch matches the dirs to delete; the second prunes
	@# .venv so find doesn't recurse into it.
	@find src \
	    -path '*/.venv/*' -prune -o \
	    -type d \( -name dist -o -name node_modules -o -name target \) -print -prune \
	    | xargs -I {} rm -rf {} 2>/dev/null || true
	@# TypeScript incremental-build state files (tsc --incremental output).
	@find src -path '*/.venv/*' -prune -o -type f -name '*.tsbuildinfo' -print -delete 2>/dev/null || true
	@# Python caches — project side only. -prune on .venv so we never
	@# touch a dev environment's site-packages.
	@find src \
	    -path '*/.venv/*' -prune -o \
	    \( -type d \( -name '__pycache__' -o -name '.pytest_cache' \
	                -o -name '.mypy_cache' -o -name '.ruff_cache' \) \
	      -o -type d -name '*.egg-info' \) -print -prune \
	    | xargs -I {} rm -rf {} 2>/dev/null || true
	@# Compiled Python bytecode in source trees.
	@find src -path '*/.venv/*' -prune -o -type f -name '*.pyc' -print -delete 2>/dev/null || true
	@echo "clean: done. Run 'make clean-helm' to also purge Helm chart caches."

clean-helm: ## Purge Helm chart dependency caches (.helm-cache + packaged subchart *.tgz under deployments/helm/*/charts/). Next helm-* target re-downloads them.
	@echo "Cleaning Helm chart caches..."
	@rm -rf .helm-cache
	@# Packaged subchart tarballs are produced by `helm dependency update`
	@# and are git-ignored; safe to delete. Constrained to immediate
	@# `charts/` children of an umbrella so we never touch chart sources.
	@find deployments/helm -mindepth 3 -maxdepth 4 -type f -name '*.tgz' -delete 2>/dev/null || true
	@echo "clean-helm: done."

clean-all: clean clean-helm ## Aggressive: combines clean + clean-helm. Forces full re-build + helm dep re-download next time.
	@echo "clean-all: done."
