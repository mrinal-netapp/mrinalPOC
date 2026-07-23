IMAGE_NAME := connector-worker
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
VERSION := $(shell echo $(VERSION) | sed 's/^v//' | sed 's/-dirty$$//')
CONTAINER ?= docker
REGISTRY ?= docker.repo.eng.netapp.com/user/$(USER)
override IMAGE := $(REGISTRY)/$(IMAGE_NAME)
REPO_ROOT ?= ../../../..
BUILD_SCRIPT := $(REPO_ROOT)/scripts/docker-build-image.sh

.PHONY: build push

build:
	@rm -rf $(CURDIR)/../observability-client
	@cp -r $(REPO_ROOT)/src/common-py/observability/observability-client $(CURDIR)/../observability-client
	DOCKER_PLATFORMS="$(DOCKER_PLATFORMS)" $(BUILD_SCRIPT) $(IMAGE_NAME) $(VERSION) $(REGISTRY) $(CONTAINER) $(CURDIR)/Dockerfile $(CURDIR)/..

push:
	$(CONTAINER) push $(IMAGE):$(VERSION)
	$(CONTAINER) push $(IMAGE):latest
