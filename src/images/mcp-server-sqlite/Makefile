IMAGE_NAME := nemo/mcp-server-sqlite
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
VERSION := $(shell echo $(VERSION) | sed 's/^v//' | sed 's/-dirty$$//')

CONTAINER ?= docker

REGISTRY ?= docker.repo.eng.netapp.com/user/$(USER)

override IMAGE := $(REGISTRY)/$(IMAGE_NAME)
REPO_ROOT ?= ../../..
BUILD_SCRIPT := $(REPO_ROOT)/scripts/docker-build-image.sh

.PHONY: build push build-push clean help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-20s %s\n", $$1, $$2}'

build: ## Build the Docker image (set DOCKER_PLATFORMS for multi-arch)
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

clean: ## Remove local images
	$(CONTAINER) rmi $(IMAGE):$(VERSION) || true
	$(CONTAINER) rmi $(IMAGE):latest || true
