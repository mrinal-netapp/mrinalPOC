# mk/cloud/storage-check.mk -- optional manual storage readiness checks.
#
# NOT wired into deploy-all-tiers-* (those keep their existing behavior).
# Use after `make storage` or to verify readiness before a deploy:
#   make aks-check-storage-ready
#   make eks-check-storage-ready
#   make gke-check-storage-ready

AKS_STORAGE_CLASS ?= anf-nfs
AKS_TBC_NAME ?= anf-backend-nfs
AKS_TRIDENT_NS ?= trident

EKS_STORAGE_CLASS ?= fsxn-nas
EKS_TBC_NAME ?= fsxn-nas-backend
EKS_TRIDENT_NS ?= trident

GKE_NAS_STORAGE_CLASS ?= gcnv-nas-rwx
GKE_SAN_STORAGE_CLASS ?= gcnv-san-rwo
GKE_NAS_TBC_NAME ?= gcnv-native-nas-backend
GKE_SAN_TBC_NAME ?= gcnv-native-san-backend
GKE_TRIDENT_NS ?= trident

aks-check-storage-ready: ## Fail if ANF Trident StorageClass/backend is not ready (run make storage first)
	@set -e; \
	sc="$(AKS_STORAGE_CLASS)"; tbc="$(AKS_TBC_NAME)"; ns="$(AKS_TRIDENT_NS)"; \
	if ! kubectl get storageclass "$$sc" >/dev/null 2>&1; then \
	  echo "ERROR: StorageClass/$$sc not found." >&2; \
	  echo "       Run: make storage CLOUD=azure ENV=<env> first." >&2; \
	  exit 1; \
	fi; \
	status="$$(kubectl get tridentbackendconfig "$$tbc" -n "$$ns" -o jsonpath='{.status.lastOperationStatus}' 2>/dev/null || true)"; \
	if [ "$$status" != "Success" ]; then \
	  echo "ERROR: TridentBackendConfig/$$tbc not Success (status=$${status:-missing})." >&2; \
	  echo "       Run: make storage CLOUD=azure ENV=<env> first." >&2; \
	  exit 1; \
	fi; \
	echo "  Storage ready: StorageClass/$$sc, TBC/$$tbc Success"

eks-check-storage-ready: ## Fail if FSxN Trident StorageClass/backend is not ready (run make storage first)
	@set -e; \
	sc="$(EKS_STORAGE_CLASS)"; tbc="$(EKS_TBC_NAME)"; ns="$(EKS_TRIDENT_NS)"; \
	if ! kubectl get storageclass "$$sc" >/dev/null 2>&1; then \
	  echo "ERROR: StorageClass/$$sc not found." >&2; \
	  echo "       Run: make storage CLOUD=aws ENV=<env> first." >&2; \
	  exit 1; \
	fi; \
	status="$$(kubectl get tridentbackendconfig "$$tbc" -n "$$ns" -o jsonpath='{.status.lastOperationStatus}' 2>/dev/null || true)"; \
	if [ "$$status" != "Success" ]; then \
	  echo "ERROR: TridentBackendConfig/$$tbc not Success (status=$${status:-missing})." >&2; \
	  echo "       Run: make storage CLOUD=aws ENV=<env> first." >&2; \
	  exit 1; \
	fi; \
	echo "  Storage ready: StorageClass/$$sc, TBC/$$tbc Success"

gke-check-storage-ready: ## Fail if GCNV NAS/SAN StorageClasses/backends are not ready (run make storage first)
	@set -e; \
	nas_sc="$(GKE_NAS_STORAGE_CLASS)"; san_sc="$(GKE_SAN_STORAGE_CLASS)"; \
	nas_tbc="$(GKE_NAS_TBC_NAME)"; san_tbc="$(GKE_SAN_TBC_NAME)"; ns="$(GKE_TRIDENT_NS)"; \
	for sc in "$$nas_sc" "$$san_sc"; do \
	  if ! kubectl get storageclass "$$sc" >/dev/null 2>&1; then \
	    echo "ERROR: StorageClass/$$sc not found." >&2; \
	    echo "       Run: make storage CLOUD=gcp ENV=<env> first." >&2; \
	    exit 1; \
	  fi; \
	done; \
	for tbc in "$$nas_tbc" "$$san_tbc"; do \
	  status="$$(kubectl get tridentbackendconfig "$$tbc" -n "$$ns" -o jsonpath='{.status.lastOperationStatus}' 2>/dev/null || true)"; \
	  if [ "$$status" != "Success" ]; then \
	    echo "ERROR: TridentBackendConfig/$$tbc not Success (status=$${status:-missing})." >&2; \
	    echo "       Run: make storage CLOUD=gcp ENV=<env> first." >&2; \
	    exit 1; \
	  fi; \
	done; \
	echo "  Storage ready: $$nas_sc + $$san_sc, TBCs Success"
