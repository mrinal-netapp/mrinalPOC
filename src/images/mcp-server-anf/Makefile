IMAGE_NAME := nemo/mcp-server-anf
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
VERSION := $(shell echo $(VERSION) | sed 's/^v//' | sed 's/-dirty$$//')

CONTAINER ?= docker

REGISTRY ?= docker.repo.eng.netapp.com/user/$(USER)

override IMAGE := $(REGISTRY)/$(IMAGE_NAME)
REPO_ROOT ?= ../../..
BUILD_SCRIPT := $(REPO_ROOT)/scripts/docker-build-image.sh
ANF_COMMON_SRC := $(REPO_ROOT)/src/nemo/workers/connector-worker/anf_common
ANF_COMMON_DST := ./anf_common

.PHONY: build push build-push sync-common clean help test

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-20s %s\n", $$1, $$2}'

sync-common: ## Vendor anf_common from connector-worker (canonical source)
	@echo "Syncing anf_common from $(ANF_COMMON_SRC)..."
	@rm -rf $(ANF_COMMON_DST)
	@cp -r $(ANF_COMMON_SRC) $(ANF_COMMON_DST)
	@echo "Vendored anf_common into $(ANF_COMMON_DST)"

test: sync-common ## Run unit tests (no Docker)
	python -m pytest tests/ -q

build: sync-common ## Build the Docker image (set DOCKER_PLATFORMS for multi-arch)
	@echo "Building $(IMAGE_NAME) image with $(CONTAINER) (version $(VERSION))..."
	DOCKER_PLATFORMS="$(DOCKER_PLATFORMS)" $(BUILD_SCRIPT) $(IMAGE_NAME) $(VERSION) $(REGISTRY) $(CONTAINER) Dockerfile .
	@echo "Built image: $(IMAGE):$(VERSION)"

push: ## Push the image to registry
	@echo "Pushing $(IMAGE_NAME) image to $(REGISTRY) using $(CONTAINER)..."
	$(CONTAINER) push $(IMAGE):$(VERSION)
	$(CONTAINER) push $(IMAGE):latest
	@echo "Pushed $(IMAGE_NAME) image successfully"

build-push: build push ## Build and push the image
	@echo "$(IMAGE_NAME) image build and push completed successfully!"

clean: ## Remove local images and vendored copy
	rm -rf $(ANF_COMMON_DST)
	$(CONTAINER) rmi $(IMAGE):$(VERSION) || true
	$(CONTAINER) rmi $(IMAGE):latest || true
