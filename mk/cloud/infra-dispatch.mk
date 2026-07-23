# mk/cloud/infra-dispatch.mk -- single entry point for infrastructure provisioning.
#
# Mirrors the `make deploy CLOUD=<cloud>` facade in mk/dispatch.mk, but for
# the cloud INFRASTRUCTURE layer (clusters, registries, networking, identity)
# rather than the application Helm tiers. One normalized verb set works the
# same regardless of cloud:
#
#   make infra CLOUD=azure ENV=preprod ACTION=plan
#   make infra CLOUD=azure ENV=preprod ACTION=apply
#   make infra CLOUD=azure ENV=preprod ACTION=destroy [UNMANAGE=detachAll]
#
# ACTION=create is accepted as a deprecated alias for apply.
#
# The unified layer is THIS interface + the per-env yaml config under
# deployments/<cloud>/envs/<env>.yaml + the plan/apply/destroy verbs --
# NOT a shared template language. Each cloud's runner maps the verbs to its
# own native tool (Azure -> Deployment Stacks over deployments/azure/stacks/;
# AWS -> CloudFormation over deployments/aws/stacks/; GCP -> Infrastructure Manager
# over deployments/gcp/stacks/).
#
# ENV is a free variable, not a hardcoded allowlist: the per-cloud runner
# validates it by checking that deployments/<cloud>/envs/<env>.yaml exists,
# so a new environment (prod, staging, sandbox, ...) works with no Make edit.
#
# Adding a new cloud: implement deployments/<cloud>/scripts/infra.sh and add
# the cloud token + a dispatch arm below.

# Valid infra clouds. `local` is intentionally absent -- there is no infra to
# provision for a local cluster. azure (Bicep/Deployment Stacks) and aws
# (CloudFormation) are wired; gcp (Infrastructure Manager) is wired.
INFRA_VALID_CLOUDS := azure aws gcp
INFRA_VALID_ACTIONS := plan apply destroy

# Default action is the read-only diff so a bare invocation can never mutate
# infrastructure by accident.
ACTION ?= plan

# Optional per-run override for Deployment Stacks unmanage behaviour
# (detachAll | deleteResources | deleteAll). Empty -> defer to the env yaml's
# actionOnUnmanage, which itself defaults to deleteResources in the runner.
UNMANAGE ?=

infra: ## Provision cloud infra: make infra CLOUD=azure ENV=<env> ACTION=plan|apply|destroy [UNMANAGE=...]
	@infra_action="$(ACTION)"; \
	if [ "$$infra_action" = "create" ]; then \
	  echo "[infra] WARNING: ACTION=create is deprecated; use ACTION=apply" >&2; \
	  infra_action=apply; \
	fi; \
	case " $(INFRA_VALID_CLOUDS) " in \
	  *" $(CLOUD) "*) ;; \
	  *) echo "ERROR: CLOUD=$(CLOUD) is not a valid infra cloud {$(INFRA_VALID_CLOUDS)}." >&2; \
	     echo "       Pass CLOUD=azure, CLOUD=aws, or CLOUD=gcp. 'local' has no infra to provision." >&2; \
	     exit 1 ;; \
	esac; \
	case " $(INFRA_VALID_ACTIONS) " in \
	  *" $$infra_action "*) ;; \
	  *) echo "ERROR: ACTION=$(ACTION) is not valid {$(INFRA_VALID_ACTIONS)} (create is a deprecated alias for apply)." >&2; exit 1 ;; \
	esac; \
	if [ -z "$(ENV)" ]; then \
	  echo "ERROR: ENV is required, e.g. make infra CLOUD=$(CLOUD) ENV=preprod ACTION=$$infra_action" >&2; \
	  exit 1; \
	fi; \
	case "$(CLOUD)" in \
	  azure) \
	    UNMANAGE="$(UNMANAGE)" deployments/azure/scripts/infra.sh \
	      --env "$(ENV)" --action "$$infra_action" ;; \
	  aws) \
	    deployments/aws/scripts/infra.sh \
	      --env "$(ENV)" --action "$$infra_action" ;; \
	  gcp) \
	    deployments/gcp/scripts/infra.sh \
	      --env "$(ENV)" --action "$$infra_action" ;; \
	esac
