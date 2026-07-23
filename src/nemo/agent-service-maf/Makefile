.PHONY: dev test-unit test-int test-e2e test-e2e-docker test-all lint typecheck format \
        regen-openapi \
        docker-build docker-run docker-stop \
        e2e-up e2e-down e2e-logs \
        helm-install helm-upgrade helm-uninstall helm-template helm-lint helm-schema \
        k8s-apply k8s-delete \
        ca-docker-build ca-deploy-infra ca-set-secrets ca-deploy-app ca-update ca-show ca-logs ca-restart \
        clean

# --- Development ---

dev:
	set -a && [ -f .env ] && . ./.env; set +a; \
	PYTHONPATH=src uvicorn agent_service_maf.interface_layer.api:create_app --factory --host 0.0.0.0 --port 8000 --reload

install:
	pip install -e ".[dev]" --break-system-packages

# --- Testing ---

test-unit:
	PYTHONPATH=src pytest tests/unit/ -v -m "not integration and not e2e" --tb=short

test-int:
	PYTHONPATH=src pytest tests/integration/ -v -m "integration or not (unit or e2e)" --tb=short

test-e2e:
	PYTHONPATH=src pytest tests/e2e/ -v -m "e2e or not (unit or integration)" --tb=short

test-e2e-docker:
	docker compose -f docker/docker-compose.e2e.yml up -d --build --wait
	PYTHONPATH=src pytest tests/e2e/ -v -m "e2e or not (unit or integration)" --docker --tb=short; \
	EXIT_CODE=$$?; \
	docker compose -f docker/docker-compose.e2e.yml logs > e2e-docker-logs.txt 2>&1; \
	docker compose -f docker/docker-compose.e2e.yml down; \
	exit $$EXIT_CODE

test-all:
	PYTHONPATH=src pytest tests/ -v --tb=short --cov=agent_service_maf --cov-report=term-missing --cov-report=html

# --- OpenAPI ---

# §H1 / §G5: regenerate the OpenAPI fixture that CI diffs against.
# Run this after any intentional change to a route or response schema;
# commit the updated `tests/fixtures/openapi.expected.json` with the
# code change so the §G5 drift-check stays green.
regen-openapi:
	PYTHONPATH=src python scripts/generate_openapi.py

# --- Code Quality ---

lint:
	ruff check src/ tests/
	ruff format --check src/ tests/

typecheck:
	mypy src/agent_service_maf/

format:
	ruff check --fix src/ tests/
	ruff format src/ tests/

# --- E2E Docker Stack ---

e2e-up:
	docker compose -f docker/docker-compose.e2e.yml up -d --build --wait

e2e-down:
	docker compose -f docker/docker-compose.e2e.yml down

e2e-logs:
	docker compose -f docker/docker-compose.e2e.yml logs

# --- Docker ---

docker-build:
	docker build -f deploy/Dockerfile -t agent-service-maf:latest ../../..

docker-run:
	docker compose -f deploy/docker-compose.yaml up -d

docker-stop:
	docker compose -f deploy/docker-compose.yaml down

# --- Helm ---

HELM_CHART    := deploy/helm/agent-framework
HELM_RELEASE  := agent-framework
HELM_NS       := agent-framework
IMAGE_REPO    ?= agentframeworkprodacr.azurecr.io/agent-framework
IMAGE_TAG     ?= latest

helm-lint:
	helm lint $(HELM_CHART)

helm-schema:
	helm lint $(HELM_CHART) --strict

helm-template:
	helm template $(HELM_RELEASE) $(HELM_CHART) \
	  --namespace $(HELM_NS) \
	  --set image.repository=$(IMAGE_REPO) \
	  --set image.tag=$(IMAGE_TAG) \
	  --set keyVaultSecrets.tenantId=00000000-0000-0000-0000-000000000000

helm-install:
	helm upgrade --install $(HELM_RELEASE) $(HELM_CHART) \
	  --namespace $(HELM_NS) \
	  --create-namespace \
	  --set image.repository=$(IMAGE_REPO) \
	  --set image.tag=$(IMAGE_TAG) \
	  --wait \
	  --timeout 5m

helm-upgrade:
	helm upgrade $(HELM_RELEASE) $(HELM_CHART) \
	  --namespace $(HELM_NS) \
	  --set image.repository=$(IMAGE_REPO) \
	  --set image.tag=$(IMAGE_TAG) \
	  --wait \
	  --timeout 5m \
	  --atomic

helm-uninstall:
	helm uninstall $(HELM_RELEASE) --namespace $(HELM_NS)

# --- Azure Container Apps ---

CA_RG          ?= agent-service-maf-staging-ca-rg
CA_APP_NAME    ?= agent-service-maf-staging-app
CA_LOCATION    ?= eastus2
CA_ENV         ?= staging
CA_ACR_NAME    ?= aiagentstudiocloudengnetappdev
CA_ACR_SERVER  ?= $(CA_ACR_NAME).azurecr.io
CA_IMAGE       ?= $(CA_ACR_SERVER)/agent-service-maf
CA_SUB_ID      ?= ae26acbb-72f9-440e-822f-b13ef3e4fec1
BICEP_CA_FILE  := deploy/bicep/main-container-apps.bicep
BICEP_CA_PARAMS:= deploy/bicep/parameters-container-apps.json

ca-docker-build:
	docker build -f deploy/Dockerfile -t agent-service-maf:latest ../../..

ca-deploy-infra:
	az account set --subscription $(CA_SUB_ID)
	az deployment sub create \
	  --location $(CA_LOCATION) \
	  --template-file $(BICEP_CA_FILE) \
	  --parameters $(BICEP_CA_PARAMS) \
	  --parameters environment=$(CA_ENV) imageTag=$(IMAGE_TAG)
	@echo "--- Assigning AcrPull role on external ACR ---"
	$(eval PRINCIPAL_ID := $(shell az identity show \
	  --name agent-service-maf-$(CA_ENV)-ca-identity \
	  --resource-group agent-service-maf-$(CA_ENV)-ca-rg \
	  --query principalId --output tsv))
	az role assignment create \
	  --assignee-object-id $(PRINCIPAL_ID) \
	  --assignee-principal-type ServicePrincipal \
	  --role AcrPull \
	  --scope /subscriptions/$(CA_SUB_ID)/resourceGroups/Agent_Poc/providers/Microsoft.ContainerRegistry/registries/$(CA_ACR_NAME) \
	  2>/dev/null || echo "AcrPull role already assigned."

ca-set-secrets:
	@echo "Setting Container App secrets (reads from env vars ANTHROPIC_API_KEY, LITELLM_MASTER_KEY, AUTH_SECRET_KEY)..."
	az containerapp secret set \
	  --name $(CA_APP_NAME) \
	  --resource-group $(CA_RG) \
	  --secrets \
	    anthropic-api-key="$${ANTHROPIC_API_KEY}" \
	    litellm-master-key="$${LITELLM_MASTER_KEY}" \
	    auth-secret-key="$${AUTH_SECRET_KEY}"

ca-deploy-app: ca-docker-build
	az account set --subscription $(CA_SUB_ID)
	az acr login --name $(CA_ACR_NAME)
	docker tag agent-service-maf:latest $(CA_IMAGE):$(IMAGE_TAG)
	docker push $(CA_IMAGE):$(IMAGE_TAG)
	az containerapp update \
	  --name $(CA_APP_NAME) \
	  --resource-group $(CA_RG) \
	  --image $(CA_IMAGE):$(IMAGE_TAG)

ca-update:
	az containerapp update \
	  --name $(CA_APP_NAME) \
	  --resource-group $(CA_RG) \
	  --image $(CA_IMAGE):$(IMAGE_TAG)

ca-show:
	az containerapp show \
	  --name $(CA_APP_NAME) \
	  --resource-group $(CA_RG) \
	  --output table

ca-logs:
	az containerapp logs show \
	  --name $(CA_APP_NAME) \
	  --resource-group $(CA_RG) \
	  --type console \
	  --follow

ca-restart:
	az containerapp revision restart \
	  --name $(CA_APP_NAME) \
	  --resource-group $(CA_RG) \
	  --revision $$(az containerapp revision list \
	    --name $(CA_APP_NAME) \
	    --resource-group $(CA_RG) \
	    --query "[0].name" --output tsv)

# --- Kubernetes (raw manifests — dev/local only) ---

k8s-apply:
	kubectl apply -f deploy/k8s/

k8s-delete:
	kubectl delete -f deploy/k8s/

# --- Cleanup ---

clean:
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .pytest_cache -exec rm -rf {} + 2>/dev/null || true
	find . -name "*.pyc" -delete 2>/dev/null || true
	rm -rf htmlcov/ .coverage .mypy_cache/
