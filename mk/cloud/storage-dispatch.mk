# mk/cloud/storage-dispatch.mk -- Trident + StorageClass bootstrap (Layer 2).
#
# Manual gate between `make infra` and `make deploy`. Installs Trident Helm,
# applies TridentBackendConfig(s), StorageClasses, and waits for backend health.
# Cloud IAM/RBAC for Trident is owned by `make infra` — storage only consumes it.
#
#   make storage CLOUD=azure ENV=preprod
#   make storage CLOUD=aws   ENV=preprod
#   make storage CLOUD=gcp   ENV=preprod
#
# ENV is free-form: each cloud runner validates deployments/<cloud>/envs/<env>.yaml.

STORAGE_VALID_CLOUDS := azure aws gcp

storage: ## Bootstrap Trident storage: make storage CLOUD=azure ENV=<env>
	@case " $(STORAGE_VALID_CLOUDS) " in \
	  *" $(CLOUD) "*) ;; \
	  *) echo "ERROR: CLOUD=$(CLOUD) is not valid for storage {$(STORAGE_VALID_CLOUDS)}." >&2; \
	     echo "       Pass CLOUD=azure, CLOUD=aws, or CLOUD=gcp." >&2; \
	     exit 1 ;; \
	esac
	@if [ -z "$(ENV)" ]; then \
	  echo "ERROR: ENV is required, e.g. make storage CLOUD=$(CLOUD) ENV=preprod" >&2; \
	  exit 1; \
	fi
	@case "$(CLOUD)" in \
	  azure) \
	    deployments/storage/storage.sh --cloud azure --env "$(ENV)" ;; \
	  aws) \
	    deployments/storage/storage.sh --cloud aws --env "$(ENV)" ;; \
	  gcp) \
	    deployments/storage/storage.sh --cloud gcp --env "$(ENV)" ;; \
	esac
