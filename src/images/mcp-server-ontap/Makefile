IMAGE_NAME := nemo/mcp-server-ontap
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
VERSION := $(shell echo $(VERSION) | sed 's/^v//' | sed 's/-dirty$$//')

CONTAINER ?= docker

REGISTRY ?= docker.repo.eng.netapp.com/user/$(USER)

override IMAGE := $(REGISTRY)/$(IMAGE_NAME)
REPO_ROOT ?= ../../..
BUILD_SCRIPT := $(REPO_ROOT)/scripts/docker-build-image.sh
ONTAP_COMMON_SRC := $(REPO_ROOT)/src/nemo/workers/connector-worker/ontap_common
ONTAP_COMMON_DST := ./ontap_common
OBS_CLIENT_SRC := $(REPO_ROOT)/src/common-py/observability/observability-client
OBS_CLIENT_DST := ./obs-client

.PHONY: build push build-push sync-common clean help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-20s %s\n", $$1, $$2}'

sync-common: ## Vendor ontap_common from connector-worker (canonical source)
	@echo "Syncing ontap_common from $(ONTAP_COMMON_SRC)..."
	@rm -rf $(ONTAP_COMMON_DST)
	@cp -r $(ONTAP_COMMON_SRC) $(ONTAP_COMMON_DST)
	@echo "Vendored ontap_common into $(ONTAP_COMMON_DST)"

build: sync-common ## Build the Docker image (set DOCKER_PLATFORMS for multi-arch)
	@echo "Building $(IMAGE_NAME) image with $(CONTAINER) (version $(VERSION))..."
	@cp -r $(OBS_CLIENT_SRC) $(OBS_CLIENT_DST)
	DOCKER_PLATFORMS="$(DOCKER_PLATFORMS)" $(BUILD_SCRIPT) $(IMAGE_NAME) $(VERSION) $(REGISTRY) $(CONTAINER) Dockerfile . ; \
	  status=$$?; rm -rf $(OBS_CLIENT_DST); exit $$status
	@echo "Built image: $(IMAGE):$(VERSION)"

push: ## Push the image to registry
	@echo "Pushing $(IMAGE_NAME) image to $(REGISTRY) using $(CONTAINER)..."
	$(CONTAINER) push $(IMAGE):$(VERSION)
	$(CONTAINER) push $(IMAGE):latest
	@echo "Pushed $(IMAGE_NAME) image successfully"

build-push: build push ## Build and push the image
	@echo "$(IMAGE_NAME) image build and push completed successfully!"

clean: ## Remove local images and vendored copies
	rm -rf $(ONTAP_COMMON_DST) $(OBS_CLIENT_DST)
	$(CONTAINER) rmi $(IMAGE):$(VERSION) || true
	$(CONTAINER) rmi $(IMAGE):latest || true
