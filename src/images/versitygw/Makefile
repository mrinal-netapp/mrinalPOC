# versitygw mirror — republish versity/versitygw to CONTAINER_IMAGE_REPO for s3gateway (Helm workers tier).

IMAGE_NAME := versity/versitygw
UPSTREAM_IMAGE ?= versity/versitygw:latest
VERSION ?= latest
# EKS nodes are amd64; pin pull platform so arm64 laptops don't mirror wrong arch into ECR.
MIRROR_PLATFORM ?= linux/amd64

CONTAINER ?= docker
REGISTRY ?= docker.repo.eng.netapp.com/user/$(USER)

override IMAGE := $(REGISTRY)/$(IMAGE_NAME)

.PHONY: build push build-push clean help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-20s %s\n", $$1, $$2}'

build: ## Mirror upstream versity/versitygw (pull + tag; set DOCKER_PLATFORMS for platform override)
	@platform="$(MIRROR_PLATFORM)"; \
	if [ -n "$(DOCKER_PLATFORMS)" ] && ! echo "$(DOCKER_PLATFORMS)" | grep -q ','; then \
	  platform="$(DOCKER_PLATFORMS)"; \
	fi; \
	echo "Pulling $(UPSTREAM_IMAGE) (platform $$platform) ..."; \
	$(CONTAINER) pull --platform "$$platform" $(UPSTREAM_IMAGE); \
	echo "Tagging $(IMAGE):$(VERSION) and $(IMAGE):latest ..."; \
	$(CONTAINER) tag $(UPSTREAM_IMAGE) $(IMAGE):$(VERSION); \
	$(CONTAINER) tag $(UPSTREAM_IMAGE) $(IMAGE):latest; \
	echo "Mirrored $(UPSTREAM_IMAGE) -> $(IMAGE):$(VERSION)"

push: ## Push to REGISTRY (auto-creates ECR repo versity/versitygw when pushing to *.amazonaws.com)
	@registry='$(REGISTRY)'; \
	registry_host="$${registry%%/*}"; \
	case "$$registry_host" in \
	  *.amazonaws.com) \
	    aws_region="$${AWS_REGION:-$$(echo "$$registry_host" | sed -n 's/.*\.ecr\.\([^.]*\)\.amazonaws\.com/\1/p')}"; \
	    if [ -z "$$aws_region" ]; then \
	      echo "ERROR: REGISTRY is ECR but AWS_REGION is unset and could not be parsed from $$registry_host"; \
	      exit 1; \
	    fi; \
	    profile_args=""; \
	    [ -n "$${AWS_PROFILE:-}" ] && profile_args="--profile $$AWS_PROFILE"; \
	    if ! aws ecr describe-repositories $$profile_args --repository-names versity/versitygw --region "$$aws_region" >/dev/null 2>&1; then \
	      echo "Creating ECR repository versity/versitygw in $$aws_region..."; \
	      aws ecr create-repository $$profile_args --region "$$aws_region" \
	        --repository-name versity/versitygw \
	        --image-scanning-configuration scanOnPush=true \
	        --encryption-configuration encryptionType=AES256 >/dev/null; \
	    fi; \
	    ;; \
	esac; \
	$(CONTAINER) push $(IMAGE):$(VERSION); \
	$(CONTAINER) push $(IMAGE):latest; \
	echo "Pushed $(IMAGE):$(VERSION)"

build-push: build push ## Mirror and push

clean: ## Remove local mirror tags
	-$(CONTAINER) rmi $(IMAGE):$(VERSION) $(IMAGE):latest 2>/dev/null || true
