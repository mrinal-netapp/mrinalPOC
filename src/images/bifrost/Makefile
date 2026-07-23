# Bifrost mirror image — republish maximhq/bifrost to CONTAINER_IMAGE_REPO.

IMAGE_NAME := bifrost
# Default upstream tag. v1.5.16 is the floor that supports file://
# pricing URLs (see Dockerfile comment for the full rationale).
#
# Lockstep — this default must stay in sync with three other places:
#   * `ARG BIFROST_UPSTREAM_VERSION` in src/images/bifrost/Dockerfile
#   * `BIFROST_TAG` in mk/build.mk
#   * `image.tag` in deployments/helm/llm-gateway/values.yaml
BIFROST_UPSTREAM_VERSION ?= v1.5.16
# Release tag: forwarded by the images-* loop as VERSION=$(VERSION) and used
# VERBATIM (no 'v' prefix) so it matches the chart's global.imageTag. Defaults
# to latest for ad-hoc/local builds.
VERSION ?= latest

CONTAINER ?= docker
REGISTRY ?= docker.repo.eng.netapp.com/user/$(USER)

override IMAGE := $(REGISTRY)/$(IMAGE_NAME)
REPO_ROOT ?= ../../..

.PHONY: build push build-push clean help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-20s %s\n", $$1, $$2}'

build: ## Build mirror image (BIFROST_UPSTREAM_VERSION=v1.5.16; VERSION=<release tag>)
	@echo "Mirroring maximhq/bifrost:$(BIFROST_UPSTREAM_VERSION) -> $(IMAGE):$(VERSION) + $(IMAGE):latest ..."
	DOCKER_BUILDKIT=1 $(CONTAINER) build \
		--build-arg BIFROST_UPSTREAM_VERSION=$(BIFROST_UPSTREAM_VERSION) \
		-t $(IMAGE):$(VERSION) \
		-t $(IMAGE):latest \
		-f Dockerfile .
	@echo "Built $(IMAGE):$(VERSION)"

push: ## Push to REGISTRY (login required: az acr login / docker login)
	$(CONTAINER) push $(IMAGE):$(VERSION)
	$(CONTAINER) push $(IMAGE):latest
	@echo "Pushed $(IMAGE):$(VERSION)"

build-push: build push ## Build and push

clean: ## Remove local mirror tags
	-$(CONTAINER) rmi $(IMAGE):$(VERSION) $(IMAGE):latest
