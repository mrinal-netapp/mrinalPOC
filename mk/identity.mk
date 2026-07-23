# mk/identity.mk -- Keycloak install / upgrade / template / lint / status
# / logs / port-forward + Azure-side provisioning.
#
# Holds the entire identity tier. Keycloak's per-cloud bodies legitimately
# differ (WI+SPC on AKS, prodMode+sed-rewrite on GKE, chart-rendered on
# local), so they are NOT collapsed into helm_upgrade_tier; instead they
# share the chart guard + hostname-derivation that lives here.
#
# Adding a new cloud install variant: append helm-identity-install-<cloud>
# + helm-identity-template-<cloud> following the existing trio. Adding a
# new cloud's provisioning helpers: keep them under the cloud-specific
# header (<cloud>-keycloak-*) so help-<cloud> can grep them.

# ============================================================================
# Keycloak Helm Commands
#
# Custom in-repo chart at deployments/helm/identity/. Two overlays:
#   - values-local.yaml -- local dev (single replica, chart-rendered Secrets)
#   - values-aks.yaml   -- AKS production (Workload Identity + Key Vault via SPC)
#
# The realm definition (deployments/helm/identity/realms/agent-studio-realm.json)
# is templated into a ConfigMap by realm-bootstrap-configmap.yaml and applied
# via kcadm.sh by realm-bootstrap-job.yaml on every helm install/upgrade.
# ============================================================================

KEYCLOAK_RELEASE_NAME ?= identity
KEYCLOAK_CHART := deployments/helm/identity
# Note: the Keycloak image tag is owned by deployments/helm/identity/
# values.yaml (image.tag) and Chart.yaml (appVersion). There is no
# Makefile-level KEYCLOAK_TAG override -- a duplicate var here would
# create a single-source-of-truth illusion without any wiring.

# Values an operator must hand in for an AKS install. The Entra metadata
# comes from `make aks-keycloak-entra-register` (register-entra-app.sh).
# Each is empty by default so the helm `required()` guards in the chart
# fire with an actionable error if any are missing.
KEYCLOAK_HOSTNAME ?=
KEYCLOAK_TENANT_ID ?=
# Entra App Reg metadata -- needed for the IdP-broker block in the realm.
KEYCLOAK_ENTRA_APP_CLIENT_ID ?=
KEYCLOAK_ENTRA_GROUP_ADMINS_OBJECTID ?=
KEYCLOAK_ENTRA_GROUP_MEMBERS_OBJECTID ?=
# Realm name embedded in the Entra App Registration's redirect URI.
# Must match the realm actually deployed by the chart (see
# `realmBootstrap.realm` in deployments/helm/identity/values.yaml).
KEYCLOAK_REALM ?= nemo

helm-identity-install-local: ## Install Keycloak chart for local dev (single replica, chart-rendered Secrets). Requires shared-postgresql in the database namespace.
	@echo "Installing Keycloak (local dev overlay) into namespace $(KEYCLOAK_NAMESPACE)..."
	@source $(HELPER_SCRIPT) && ensure_namespace $(KEYCLOAK_NAMESPACE) $(KEYCLOAK_NAMESPACE) || true
	@helm upgrade --install $(KEYCLOAK_RELEASE_NAME) $(KEYCLOAK_CHART) \
		--namespace $(KEYCLOAK_NAMESPACE) \
		--create-namespace \
		--timeout $(HELM_UPGRADE_TIMEOUT) \
		-f $(KEYCLOAK_CHART)/values.yaml \
		-f $(KEYCLOAK_CHART)/values-local.yaml \
		--set global.imageRepository=$(CONTAINER_IMAGE_REPO) \
		--set global.endpoint=$(strip $(ENDPOINT)) \
		--set endpoint=$(strip $(ENDPOINT)) \
		--server-side=true --force-conflicts \
		$(HELM_EXTRA_ARGS)
	@echo "Keycloak local install complete."
	@$(MAKE) helm-identity-status

helm-identity-upgrade-local: helm-identity-install-local ## Alias for install-local (idempotent helm upgrade --install)

helm-identity-install-aks: ## Install Keycloak chart against AKS. The DB + bootstrap-admin Secrets are chart-rendered from values-aks.yaml (override via --set postgres.auth.password / keycloak.bootstrapAdmin.password). The Entra broker is OPTIONAL — enabled only when ALL four KEYCLOAK_ENTRA_* identifiers are supplied (then the keycloak-entra-broker Secret is required); with none supplied the realm is bootstrapped WITHOUT the Entra IdP. Optional pre-flight: aks-keycloak-entra-register, aks-keycloak-grafana-proxy-secrets.
	@echo "Installing Keycloak (AKS overlay) into namespace $(KEYCLOAK_NAMESPACE)..."
	@source $(HELPER_SCRIPT) && ensure_namespace $(KEYCLOAK_NAMESPACE) $(KEYCLOAK_NAMESPACE) || true
	@# Label any manually-created keycloak-oidc-secrets for Helm adoption (defensive)
	$(call label-secrets-for-helm,$(KEYCLOAK_RELEASE_NAME),$(KEYCLOAK_NAMESPACE))
	@# ── Entra broker is OPTIONAL on AKS ──────────────────────────────────
	@# Enabled ONLY when the operator/CD hands in the four Entra identifiers
	@# (output of `make aks-keycloak-entra-register`). With none supplied the
	@# realm is bootstrapped WITHOUT the Entra IdP and no keycloak-entra-broker
	@# Secret is required. Supplying SOME but not all is a config error, so we
	@# fail fast (mirrors the GKE/EKS installers and the CD pre-flight).
	@# This validation + broker-secret check is a SEPARATE recipe line from the
	@# helm block below on purpose: it calls $(MAKE) (which GNU make also runs
	@# under `make -n`), whereas the helm block must NOT execute during a dry-run.
	@if [ -n "$(KEYCLOAK_ENTRA_APP_CLIENT_ID)$(KEYCLOAK_TENANT_ID)$(KEYCLOAK_ENTRA_GROUP_ADMINS_OBJECTID)$(KEYCLOAK_ENTRA_GROUP_MEMBERS_OBJECTID)" ]; then \
	  if [ -z "$(KEYCLOAK_ENTRA_APP_CLIENT_ID)" ] || [ -z "$(KEYCLOAK_TENANT_ID)" ] || [ -z "$(KEYCLOAK_ENTRA_GROUP_ADMINS_OBJECTID)" ] || [ -z "$(KEYCLOAK_ENTRA_GROUP_MEMBERS_OBJECTID)" ]; then \
	    echo "ERROR: partial Entra broker configuration for AKS."; \
	    echo "       Set ALL of these (from 'make aks-keycloak-entra-register'), or NONE to skip the Entra IdP entirely:"; \
	    echo "         KEYCLOAK_ENTRA_APP_CLIENT_ID"; \
	    echo "         KEYCLOAK_TENANT_ID"; \
	    echo "         KEYCLOAK_ENTRA_GROUP_ADMINS_OBJECTID"; \
	    echo "         KEYCLOAK_ENTRA_GROUP_MEMBERS_OBJECTID"; \
	    exit 1; \
	  fi; \
	  echo "[install-aks] Entra broker ENABLED (identifiers supplied) -- verifying keycloak-entra-broker Secret"; \
	  $(MAKE) --no-print-directory aks-keycloak-broker-secret-require KEYCLOAK_NAMESPACE=$(KEYCLOAK_NAMESPACE); \
	else \
	  echo "[install-aks] Entra broker DISABLED (no KEYCLOAK_ENTRA_* identifiers supplied) -- realm bootstrapped without the Entra IdP"; \
	fi
	@# Compute the broker --set flags (no $(MAKE) here, so the helm install below
	@# is only printed -- never executed -- under `make -n`).
	@if [ -z "$(KEYCLOAK_HOSTNAME)" ]; then \
	  echo "ERROR: KEYCLOAK_HOSTNAME is required for the AKS install."; \
	  echo "       Example: KEYCLOAK_HOSTNAME=https://auth.<endpoint>"; \
	  echo "       deploy derives this automatically: make deploy CLOUD=azure ENV=<env> IMAGE_TAG=<tag>"; \
	  exit 1; \
	fi
	@if [ -n "$(KEYCLOAK_ENTRA_APP_CLIENT_ID)$(KEYCLOAK_TENANT_ID)$(KEYCLOAK_ENTRA_GROUP_ADMINS_OBJECTID)$(KEYCLOAK_ENTRA_GROUP_MEMBERS_OBJECTID)" ]; then \
	  broker_args="--set realmBootstrap.broker.enabled=true \
	    --set realmBootstrap.broker.clientId=$(KEYCLOAK_ENTRA_APP_CLIENT_ID) \
	    --set realmBootstrap.broker.tenantId=$(KEYCLOAK_TENANT_ID) \
	    --set realmBootstrap.broker.groupAdminsObjectId=$(KEYCLOAK_ENTRA_GROUP_ADMINS_OBJECTID) \
	    --set realmBootstrap.broker.groupMembersObjectId=$(KEYCLOAK_ENTRA_GROUP_MEMBERS_OBJECTID)"; \
	else \
	  broker_args="--set realmBootstrap.broker.enabled=false"; \
	fi; \
	kc_host="$$(printf '%s' '$(KEYCLOAK_HOSTNAME)' | sed -E 's#^https?://##; s#/.*##; s#:[0-9]+$$##' | tr -d '[:space:]')"; \
	echo "Derived httpRoute.hostnames[0]=$$kc_host from KEYCLOAK_HOSTNAME=$(KEYCLOAK_HOSTNAME)"; \
	source $(HELPER_SCRIPT); \
	aks_values="$$(render_gke_keycloak_values '$(KEYCLOAK_HOSTNAME)' '$(ENDPOINT)' '$(KEYCLOAK_CHART)/values-aks.yaml')" || exit 1; \
	helm upgrade --install $(KEYCLOAK_RELEASE_NAME) $(KEYCLOAK_CHART) \
		--namespace $(KEYCLOAK_NAMESPACE) \
		--create-namespace \
		--timeout $(HELM_UPGRADE_TIMEOUT) \
		-f $(KEYCLOAK_CHART)/values.yaml \
		-f "$$aks_values" \
		--set keycloak.hostname=$(KEYCLOAK_HOSTNAME) \
		--set "httpRoute.hostnames[0]=$$kc_host" \
		$$broker_args \
		--set global.imageRepository=$(CONTAINER_IMAGE_REPO) \
		--server-side=true --force-conflicts \
		$(HELM_EXTRA_ARGS); \
	rc=$$?; \
	rm -f "$$aks_values"; \
	[ $$rc -eq 0 ] || exit $$rc
	@echo "Keycloak AKS install complete."
	@$(MAKE) helm-identity-status

helm-identity-upgrade-aks: helm-identity-install-aks ## Alias for install-aks (helm upgrade --install is idempotent)

helm-identity-install-gke: ## Install Keycloak chart against GKE (productionMode + chart-rendered Secrets, no Workload Identity / SPC). Requires KEYCLOAK_HOSTNAME. Optional pre-flight: gke-keycloak-grafana-proxy-secrets (when OBSERVABILITY=1).
	@# Sits between install-local (productionMode=false, no real
	@# hostname) and install-aks (Workload Identity + Key Vault SPC):
	@# productionMode=true with a real hostname so the Keycloak 26
	@# `hostname-backchannel-dynamic must be set to false when no
	@# hostname is provided` boot guard does not crash the pod, but
	@# secrets are still chart-rendered inline (no GCP Secret Manager
	@# integration in this target -- planned follow-up via ESO).
	@if [ -z "$(KEYCLOAK_HOSTNAME)" ]; then \
		echo "ERROR: KEYCLOAK_HOSTNAME is required for the GKE install."; \
		echo "       Example:"; \
		echo "         make helm-identity-install-gke \\"; \
		echo "           KEYCLOAK_HOSTNAME=https://auth.<endpoint>"; \
		echo ""; \
		echo "       The hostname MUST match the FQDN your gateway exposes"; \
		echo "       for the auth.* subdomain AND be covered by a SAN on"; \
		echo "       the gateway wildcard cert. Include an explicit :port"; \
		echo "       (e.g. :8443) only when the gateway listens on a non-standard"; \
		echo "       HTTPS port (e.g. local KIND); cloud LoadBalancers should"; \
		echo "       always be 443 and the port suffix omitted."; \
		exit 1; \
	fi
	@# The Entra broker is OPTIONAL (same policy as AKS): enabled only when all
	@# four KEYCLOAK_ENTRA_* identifiers are supplied (sourced from the dedicated
	@# `agent-studio-dev-gke-broker` app). This validation + broker-secret check
	@# is a SEPARATE recipe line from the helm block below on purpose: it calls
	@# $(MAKE) (which GNU make also runs under `make -n`), whereas the helm block
	@# must NOT execute during a dry-run.
	@if [ -n "$(KEYCLOAK_ENTRA_APP_CLIENT_ID)$(KEYCLOAK_TENANT_ID)$(KEYCLOAK_ENTRA_GROUP_ADMINS_OBJECTID)$(KEYCLOAK_ENTRA_GROUP_MEMBERS_OBJECTID)" ]; then \
	  if [ -z "$(KEYCLOAK_ENTRA_APP_CLIENT_ID)" ] || [ -z "$(KEYCLOAK_TENANT_ID)" ] || [ -z "$(KEYCLOAK_ENTRA_GROUP_ADMINS_OBJECTID)" ] || [ -z "$(KEYCLOAK_ENTRA_GROUP_MEMBERS_OBJECTID)" ]; then \
	    echo "ERROR: partial Entra broker configuration for GKE."; \
	    echo "       Set ALL four (from the 'agent-studio-dev-gke-broker' app), or NONE to skip the Entra IdP:"; \
	    echo "         KEYCLOAK_ENTRA_APP_CLIENT_ID KEYCLOAK_TENANT_ID KEYCLOAK_ENTRA_GROUP_ADMINS_OBJECTID KEYCLOAK_ENTRA_GROUP_MEMBERS_OBJECTID"; \
	    exit 1; \
	  fi; \
	  echo "[install-gke] Entra broker ENABLED (identifiers supplied) -- verifying keycloak-entra-broker Secret"; \
	  $(MAKE) --no-print-directory gke-keycloak-broker-secret-require KEYCLOAK_NAMESPACE=$(KEYCLOAK_NAMESPACE); \
	else \
	  echo "[install-gke] Entra broker DISABLED (no KEYCLOAK_ENTRA_* vars) -- realm bootstrapped without the Entra IdP"; \
	fi
	@echo "Installing Keycloak (GKE overlay) into namespace $(KEYCLOAK_NAMESPACE)..."
	@source $(HELPER_SCRIPT) && ensure_namespace $(KEYCLOAK_NAMESPACE) $(KEYCLOAK_NAMESPACE) || true
	@# Derive httpRoute.hostnames[0] from KEYCLOAK_HOSTNAME by stripping
	@# scheme, path, and :port. Keycloak's KC_HOSTNAME wants the full
	@# URL (`https://auth.<ep>` on cloud, `https://auth.<ep>:8443` on local)
	@# but Gateway API hostnames are
	@# bare hosts (`auth.<ep>`). Without this derivation, every
	@# environment would need its own --set httpRoute.hostnames[0]=...
	@# in HELM_EXTRA_ARGS or the route default (`auth.agentstudio.local`)
	@# would 404 every real install.
	@#
	@# Operator override still wins: $(HELM_EXTRA_ARGS) is appended AFTER
	@# our --set, and helm `--set` is last-write-wins.
	@# values-gke.yaml ships `agentstudio.local` as the chart baseline for every
	@# OIDC redirectUri / webOrigin / httpRoute host (app.*, catalog.*, auth.*).
	@# render_gke_keycloak_values (scripts/helm-common.sh) rewrites that baseline
	@# to the real base endpoint so browser login (gui, swagger, lakekeeper-ui,
	@# gateway) and CORS work on a real cluster -- a global substitution avoids
	@# tracking fragile additionalClients[N] list indices via --set. Base-host
	@# precedence: auth.<endpoint> hostname > ENDPOINT > fail fast (so a custom
	@# auth subdomain doesn't get mis-rewritten). httpRoute.hostnames[0] is the
	@# bare auth host derived from KEYCLOAK_HOSTNAME.
	@source $(HELPER_SCRIPT); \
	if [ -n "$(KEYCLOAK_ENTRA_APP_CLIENT_ID)$(KEYCLOAK_TENANT_ID)$(KEYCLOAK_ENTRA_GROUP_ADMINS_OBJECTID)$(KEYCLOAK_ENTRA_GROUP_MEMBERS_OBJECTID)" ]; then \
	  broker_args="--set realmBootstrap.broker.enabled=true \
	    --set realmBootstrap.broker.clientId=$(KEYCLOAK_ENTRA_APP_CLIENT_ID) \
	    --set realmBootstrap.broker.tenantId=$(KEYCLOAK_TENANT_ID) \
	    --set realmBootstrap.broker.groupAdminsObjectId=$(KEYCLOAK_ENTRA_GROUP_ADMINS_OBJECTID) \
	    --set realmBootstrap.broker.groupMembersObjectId=$(KEYCLOAK_ENTRA_GROUP_MEMBERS_OBJECTID)"; \
	else \
	  broker_args="--set realmBootstrap.broker.enabled=false"; \
	fi; \
	kc_host="$$(printf '%s' '$(KEYCLOAK_HOSTNAME)' | sed -E 's#^https?://##; s#/.*##; s#:[0-9]+$$##' | tr -d '[:space:]')"; \
	gke_values="$$(render_gke_keycloak_values '$(KEYCLOAK_HOSTNAME)' '$(ENDPOINT)' '$(KEYCLOAK_CHART)/values-gke.yaml')" || exit 1; \
	echo "Derived httpRoute.hostnames[0]=$$kc_host from KEYCLOAK_HOSTNAME=$(KEYCLOAK_HOSTNAME)"; \
	helm upgrade --install $(KEYCLOAK_RELEASE_NAME) $(KEYCLOAK_CHART) \
		--namespace $(KEYCLOAK_NAMESPACE) \
		--create-namespace \
		--timeout $(HELM_UPGRADE_TIMEOUT) \
		-f $(KEYCLOAK_CHART)/values.yaml \
		-f "$$gke_values" \
		--set keycloak.hostname=$(KEYCLOAK_HOSTNAME) \
		--set "httpRoute.hostnames[0]=$$kc_host" \
		$$broker_args \
		--set global.imageRepository=$(CONTAINER_IMAGE_REPO) \
		--server-side=true --force-conflicts \
		$(HELM_EXTRA_ARGS); \
	rc=$$?; \
	rm -f "$$gke_values"; \
	[ $$rc -eq 0 ] || exit $$rc
	@echo "Keycloak GKE install complete."
	@$(MAKE) helm-identity-status

helm-identity-upgrade-gke: helm-identity-install-gke ## Alias for install-gke (helm upgrade --install is idempotent)

helm-identity-install-eks: ## Install Keycloak chart against AWS EKS (productionMode + Entra broker). Requires KEYCLOAK_HOSTNAME. Optional pre-flight: eks-keycloak-grafana-proxy-secrets (when OBSERVABILITY=1).
	@# Same shape as helm-identity-install-gke (PR #261): productionMode=true with a
	@# real hostname, chart-rendered confidential-client secrets, and an
	@# externally-managed Entra broker Secret (keycloak-entra-broker). The
	@# values-eks.yaml overlay is rendered through render_gke_keycloak_values so
	@# the agentstudio.local baseline in OIDC redirectUris / webOrigins is
	@# rewritten to the real endpoint.
	@if [ -z "$(KEYCLOAK_HOSTNAME)" ]; then \
		echo "ERROR: KEYCLOAK_HOSTNAME is required for the EKS install."; \
		echo "       Example:"; \
		echo "         make helm-identity-install-eks \\"; \
		echo "           KEYCLOAK_HOSTNAME=https://auth.<endpoint>"; \
		echo ""; \
		echo "       Or use 'make deploy-eks ENDPOINT=<endpoint> ...' to auto-derive it."; \
		echo "       Include :port (e.g. :8443) only on local KIND clusters."; \
		exit 1; \
	fi
	@# The Entra broker is OPTIONAL (same policy as AKS): enabled only when all
	@# four KEYCLOAK_ENTRA_* identifiers are supplied (sourced from the dedicated
	@# `agent-studio-dev-eks-broker` app). This validation + broker-secret check
	@# is a SEPARATE recipe line from the helm block below on purpose: it calls
	@# $(MAKE) (which GNU make also runs under `make -n`), whereas the helm block
	@# must NOT execute during a dry-run.
	@if [ -n "$(KEYCLOAK_ENTRA_APP_CLIENT_ID)$(KEYCLOAK_TENANT_ID)$(KEYCLOAK_ENTRA_GROUP_ADMINS_OBJECTID)$(KEYCLOAK_ENTRA_GROUP_MEMBERS_OBJECTID)" ]; then \
	  if [ -z "$(KEYCLOAK_ENTRA_APP_CLIENT_ID)" ] || [ -z "$(KEYCLOAK_TENANT_ID)" ] || [ -z "$(KEYCLOAK_ENTRA_GROUP_ADMINS_OBJECTID)" ] || [ -z "$(KEYCLOAK_ENTRA_GROUP_MEMBERS_OBJECTID)" ]; then \
	    echo "ERROR: partial Entra broker configuration for EKS."; \
	    echo "       Set ALL four (from the 'agent-studio-dev-eks-broker' app), or NONE to skip the Entra IdP:"; \
	    echo "         KEYCLOAK_ENTRA_APP_CLIENT_ID KEYCLOAK_TENANT_ID KEYCLOAK_ENTRA_GROUP_ADMINS_OBJECTID KEYCLOAK_ENTRA_GROUP_MEMBERS_OBJECTID"; \
	    exit 1; \
	  fi; \
	  echo "[install-eks] Entra broker ENABLED (identifiers supplied) -- verifying keycloak-entra-broker Secret"; \
	  $(MAKE) --no-print-directory eks-keycloak-broker-secret-require KEYCLOAK_NAMESPACE=$(KEYCLOAK_NAMESPACE); \
	else \
	  echo "[install-eks] Entra broker DISABLED (no KEYCLOAK_ENTRA_* vars) -- realm bootstrapped without the Entra IdP"; \
	fi
	@echo "Installing Keycloak (EKS overlay) into namespace $(KEYCLOAK_NAMESPACE)..."
	@source $(HELPER_SCRIPT) && ensure_namespace $(KEYCLOAK_NAMESPACE) $(KEYCLOAK_NAMESPACE) || true
	@source $(HELPER_SCRIPT); \
	if [ -n "$(KEYCLOAK_ENTRA_APP_CLIENT_ID)$(KEYCLOAK_TENANT_ID)$(KEYCLOAK_ENTRA_GROUP_ADMINS_OBJECTID)$(KEYCLOAK_ENTRA_GROUP_MEMBERS_OBJECTID)" ]; then \
	  broker_args="--set realmBootstrap.broker.enabled=true \
	    --set realmBootstrap.broker.clientId=$(KEYCLOAK_ENTRA_APP_CLIENT_ID) \
	    --set realmBootstrap.broker.tenantId=$(KEYCLOAK_TENANT_ID) \
	    --set realmBootstrap.broker.groupAdminsObjectId=$(KEYCLOAK_ENTRA_GROUP_ADMINS_OBJECTID) \
	    --set realmBootstrap.broker.groupMembersObjectId=$(KEYCLOAK_ENTRA_GROUP_MEMBERS_OBJECTID)"; \
	else \
	  broker_args="--set realmBootstrap.broker.enabled=false"; \
	fi; \
	kc_host="$$(printf '%s' '$(KEYCLOAK_HOSTNAME)' | sed -E 's#^https?://##; s#/.*##; s#:[0-9]+$$##' | tr -d '[:space:]')"; \
	eks_values="$$(render_gke_keycloak_values '$(KEYCLOAK_HOSTNAME)' '$(ENDPOINT)' '$(KEYCLOAK_CHART)/values-eks.yaml')" || exit 1; \
	echo "Derived httpRoute.hostnames[0]=$$kc_host from KEYCLOAK_HOSTNAME=$(KEYCLOAK_HOSTNAME)"; \
	helm upgrade --install $(KEYCLOAK_RELEASE_NAME) $(KEYCLOAK_CHART) \
		--namespace $(KEYCLOAK_NAMESPACE) \
		--create-namespace \
		--timeout $(HELM_UPGRADE_TIMEOUT) \
		-f $(KEYCLOAK_CHART)/values.yaml \
		-f "$$eks_values" \
		--set keycloak.hostname=$(KEYCLOAK_HOSTNAME) \
		--set "httpRoute.hostnames[0]=$$kc_host" \
		$$broker_args \
		--set global.imageRepository=$(CONTAINER_IMAGE_REPO) \
		--server-side=true --force-conflicts \
		$(HELM_EXTRA_ARGS); \
	rc=$$?; \
	rm -f "$$eks_values"; \
	[ $$rc -eq 0 ] || exit $$rc
	@echo "Keycloak EKS install complete."
	@$(MAKE) helm-identity-status

helm-identity-upgrade-eks: helm-identity-install-eks ## Alias for install-eks (helm upgrade --install is idempotent)

helm-identity-template-eks: ## Render EKS-overlay manifests to stdout. Requires KEYCLOAK_HOSTNAME.
	@if [ -z "$(KEYCLOAK_HOSTNAME)" ]; then \
		echo "ERROR: KEYCLOAK_HOSTNAME is required (e.g. https://auth.<endpoint>)"; \
		exit 1; \
	fi
	@source $(HELPER_SCRIPT); \
	kc_host="$$(printf '%s' '$(KEYCLOAK_HOSTNAME)' | sed -E 's#^https?://##; s#/.*##; s#:[0-9]+$$##' | tr -d '[:space:]')"; \
	eks_values="$$(render_gke_keycloak_values '$(KEYCLOAK_HOSTNAME)' '$(ENDPOINT)' '$(KEYCLOAK_CHART)/values-eks.yaml')" || exit 1; \
	helm template $(KEYCLOAK_RELEASE_NAME) $(KEYCLOAK_CHART) \
		--namespace $(KEYCLOAK_NAMESPACE) \
		-f $(KEYCLOAK_CHART)/values.yaml \
		-f "$$eks_values" \
		--set keycloak.hostname=$(KEYCLOAK_HOSTNAME) \
		--set "httpRoute.hostnames[0]=$$kc_host" \
		--set realmBootstrap.broker.enabled=true \
		--set realmBootstrap.broker.clientId=$(or $(KEYCLOAK_ENTRA_APP_CLIENT_ID),00000000-0000-0000-0000-000000000000) \
		--set realmBootstrap.broker.tenantId=$(or $(KEYCLOAK_TENANT_ID),00000000-0000-0000-0000-000000000000) \
		--set realmBootstrap.broker.groupAdminsObjectId=$(or $(KEYCLOAK_ENTRA_GROUP_ADMINS_OBJECTID),00000000-0000-0000-0000-000000000000) \
		--set realmBootstrap.broker.groupMembersObjectId=$(or $(KEYCLOAK_ENTRA_GROUP_MEMBERS_OBJECTID),00000000-0000-0000-0000-000000000000) \
		--set global.imageRepository=$(CONTAINER_IMAGE_REPO); \
	rc=$$?; \
	rm -f "$$eks_values"; \
	exit $$rc

helm-identity-template-local: ## Render local-overlay manifests to stdout for verification (no apply)
	@helm template $(KEYCLOAK_RELEASE_NAME) $(KEYCLOAK_CHART) \
		--namespace $(KEYCLOAK_NAMESPACE) \
		-f $(KEYCLOAK_CHART)/values.yaml \
		-f $(KEYCLOAK_CHART)/values-local.yaml \
		--set global.imageRepository=$(CONTAINER_IMAGE_REPO)

helm-identity-template-aks: ## Render AKS-overlay manifests to stdout. Always renders WITH the Entra broker (placeholder GUIDs when KEYCLOAK_ENTRA_* unset) so the broker path stays covered; the real install-aks makes the broker optional.
	@# The broker is disabled by default in values-aks.yaml (optional on AKS),
	@# so force it on here with placeholder GUIDs — mirroring the eks/gke
	@# template targets — to keep the render smoke test exercising the IdP,
	@# mappers, and broker-secret wiring regardless of the caller's env.
	@kc_host="$$(printf '%s' '$(KEYCLOAK_HOSTNAME)' | sed -E 's#^https?://##; s#/.*##; s#:[0-9]+$$##' | tr -d '[:space:]')"; \
	[ -n "$$kc_host" ] || kc_host="auth.example.com"; \
	kc_url="$$(printf '%s' '$(KEYCLOAK_HOSTNAME)' | tr -d '[:space:]')"; \
	[ -n "$$kc_url" ] || kc_url="https://$$kc_host"; \
	source $(HELPER_SCRIPT); \
	aks_values="$$(render_gke_keycloak_values '$$kc_url' '$(ENDPOINT)' '$(KEYCLOAK_CHART)/values-aks.yaml' 2>/dev/null || true)"; \
	if [ -z "$$aks_values" ] || [ ! -f "$$aks_values" ]; then \
	  aks_values="$(KEYCLOAK_CHART)/values-aks.yaml"; \
	fi; \
	helm template $(KEYCLOAK_RELEASE_NAME) $(KEYCLOAK_CHART) \
		--namespace $(KEYCLOAK_NAMESPACE) \
		-f $(KEYCLOAK_CHART)/values.yaml \
		-f "$$aks_values" \
		--set keycloak.hostname=$$kc_url \
		--set "httpRoute.hostnames[0]=$$kc_host" \
		--set realmBootstrap.broker.enabled=true \
		--set realmBootstrap.broker.clientId=$(or $(KEYCLOAK_ENTRA_APP_CLIENT_ID),00000000-0000-0000-0000-000000000000) \
		--set realmBootstrap.broker.tenantId=$(or $(KEYCLOAK_TENANT_ID),00000000-0000-0000-0000-000000000000) \
		--set realmBootstrap.broker.groupAdminsObjectId=$(or $(KEYCLOAK_ENTRA_GROUP_ADMINS_OBJECTID),00000000-0000-0000-0000-000000000000) \
		--set realmBootstrap.broker.groupMembersObjectId=$(or $(KEYCLOAK_ENTRA_GROUP_MEMBERS_OBJECTID),00000000-0000-0000-0000-000000000000) \
		--set global.imageRepository=$(CONTAINER_IMAGE_REPO); \
	rc=$$?; \
	if [ "$$aks_values" != "$(KEYCLOAK_CHART)/values-aks.yaml" ]; then rm -f "$$aks_values"; fi; \
	exit $$rc

helm-identity-template-gke: ## Render GKE-overlay manifests to stdout. Requires KEYCLOAK_HOSTNAME.
	@if [ -z "$(KEYCLOAK_HOSTNAME)" ]; then \
		echo "ERROR: KEYCLOAK_HOSTNAME is required (e.g. https://auth.<endpoint>)"; \
		exit 1; \
	fi
	@# Same host derivation AND agentstudio.local rewrite as
	@# helm-identity-install-gke (both via render_gke_keycloak_values in
	@# scripts/helm-common.sh) so `template` output matches what `install`
	@# would actually apply -- including the real redirectUris / webOrigins.
	@source $(HELPER_SCRIPT); \
	kc_host="$$(printf '%s' '$(KEYCLOAK_HOSTNAME)' | sed -E 's#^https?://##; s#/.*##; s#:[0-9]+$$##' | tr -d '[:space:]')"; \
	gke_values="$$(render_gke_keycloak_values '$(KEYCLOAK_HOSTNAME)' '$(ENDPOINT)' '$(KEYCLOAK_CHART)/values-gke.yaml')" || exit 1; \
	helm template $(KEYCLOAK_RELEASE_NAME) $(KEYCLOAK_CHART) \
		--namespace $(KEYCLOAK_NAMESPACE) \
		-f $(KEYCLOAK_CHART)/values.yaml \
		-f "$$gke_values" \
		--set keycloak.hostname=$(KEYCLOAK_HOSTNAME) \
		--set "httpRoute.hostnames[0]=$$kc_host" \
		--set realmBootstrap.broker.enabled=true \
		--set realmBootstrap.broker.clientId=$(or $(KEYCLOAK_ENTRA_APP_CLIENT_ID),00000000-0000-0000-0000-000000000000) \
		--set realmBootstrap.broker.tenantId=$(or $(KEYCLOAK_TENANT_ID),00000000-0000-0000-0000-000000000000) \
		--set realmBootstrap.broker.groupAdminsObjectId=$(or $(KEYCLOAK_ENTRA_GROUP_ADMINS_OBJECTID),00000000-0000-0000-0000-000000000000) \
		--set realmBootstrap.broker.groupMembersObjectId=$(or $(KEYCLOAK_ENTRA_GROUP_MEMBERS_OBJECTID),00000000-0000-0000-0000-000000000000) \
		--set global.imageRepository=$(CONTAINER_IMAGE_REPO); \
	rc=$$?; \
	rm -f "$$gke_values"; \
	exit $$rc

helm-identity-lint: ## Run helm lint against all overlays
	@# Sentinel value for the post-realm-bootstrap Job's init-tools image
	@# repository guard (post-realm-bootstrap-job.yaml fails fast at render
	@# time when global.imageRepository is empty -- install/template targets
	@# inject CONTAINER_IMAGE_REPO automatically; lint runs against a
	@# placeholder so the chart renders without a real registry path).
	@echo "Linting Keycloak chart (no overlay -- expect render-time fail for missing creds)..."
	@helm lint $(KEYCLOAK_CHART) --set global.imageRepository=lint.example.com/ns || true
	@echo "Linting with values-local.yaml..."
	@helm lint $(KEYCLOAK_CHART) -f $(KEYCLOAK_CHART)/values-local.yaml \
		--set global.imageRepository=lint.example.com/ns
	@echo "Linting with values-aks.yaml (with sentinel values to satisfy required guards)..."
	@helm lint $(KEYCLOAK_CHART) \
		-f $(KEYCLOAK_CHART)/values-aks.yaml \
		--set keycloak.hostname=auth.example.com \
		--set realmBootstrap.broker.clientId=00000000-0000-0000-0000-000000000000 \
		--set realmBootstrap.broker.tenantId=00000000-0000-0000-0000-000000000000 \
		--set realmBootstrap.broker.groupAdminsObjectId=00000000-0000-0000-0000-000000000000 \
		--set realmBootstrap.broker.groupMembersObjectId=00000000-0000-0000-0000-000000000000 \
		--set global.imageRepository=lint.example.com/ns
	@echo "Linting with values-gke.yaml (with sentinel hostname + broker IDs to satisfy required guards)..."
	@helm lint $(KEYCLOAK_CHART) \
		-f $(KEYCLOAK_CHART)/values-gke.yaml \
		--set keycloak.hostname=https://auth.example.com \
		--set realmBootstrap.broker.clientId=00000000-0000-0000-0000-000000000000 \
		--set realmBootstrap.broker.tenantId=00000000-0000-0000-0000-000000000000 \
		--set realmBootstrap.broker.groupAdminsObjectId=00000000-0000-0000-0000-000000000000 \
		--set realmBootstrap.broker.groupMembersObjectId=00000000-0000-0000-0000-000000000000 \
		--set global.imageRepository=lint.example.com/ns
	@if [ -f $(KEYCLOAK_CHART)/values-eks.yaml ]; then \
		echo "Linting with values-eks.yaml (with sentinel hostname + Entra broker guards)..."; \
		helm lint $(KEYCLOAK_CHART) \
			-f $(KEYCLOAK_CHART)/values-eks.yaml \
			--set keycloak.hostname=https://auth.example.com \
			--set realmBootstrap.broker.clientId=00000000-0000-0000-0000-000000000000 \
			--set realmBootstrap.broker.tenantId=00000000-0000-0000-0000-000000000000 \
			--set realmBootstrap.broker.groupAdminsObjectId=00000000-0000-0000-0000-000000000000 \
			--set realmBootstrap.broker.groupMembersObjectId=00000000-0000-0000-0000-000000000000 \
			--set global.imageRepository=lint.example.com/ns; \
	fi

helm-identity-uninstall: ## Uninstall Keycloak chart (keeps the agentstudio-identity namespace)
	@echo "Uninstalling Keycloak release '$(KEYCLOAK_RELEASE_NAME)' from $(KEYCLOAK_NAMESPACE)..."
	@helm uninstall $(KEYCLOAK_RELEASE_NAME) --namespace $(KEYCLOAK_NAMESPACE) 2>/dev/null || echo "Release may not exist"
	@echo "Cleaning up StatefulSet PVCs (Keycloak uses an in-memory data dir; safe to delete)..."
	@kubectl delete pvc -n $(KEYCLOAK_NAMESPACE) -l app.kubernetes.io/name=keycloak 2>/dev/null || echo "No PVCs found"

helm-identity-status: ## Show Keycloak release + pod + bootstrap job status
	@echo "=== Helm release ==="
	@helm status $(KEYCLOAK_RELEASE_NAME) --namespace $(KEYCLOAK_NAMESPACE) 2>/dev/null || echo "Release not found"
	@echo ""
	@echo "=== StatefulSet ==="
	@kubectl get statefulset -n $(KEYCLOAK_NAMESPACE) keycloak 2>/dev/null || echo "No statefulset found"
	@echo ""
	@echo "=== Pods ==="
	@kubectl get pods -n $(KEYCLOAK_NAMESPACE) -l app.kubernetes.io/name=keycloak 2>/dev/null || echo "No pods found"
	@echo ""
	@echo "=== Realm-bootstrap Job ==="
	@kubectl get jobs -n $(KEYCLOAK_NAMESPACE) -l app.kubernetes.io/component=realm-bootstrap 2>/dev/null || echo "No realm-bootstrap jobs found"

helm-identity-logs: ## Show recent Keycloak server logs
	@POD=$$(kubectl get pods -n $(KEYCLOAK_NAMESPACE) -l app.kubernetes.io/name=keycloak -o jsonpath='{.items[0].metadata.name}' 2>/dev/null); \
	if [ -n "$$POD" ]; then \
		echo "Logs for pod: $$POD"; \
		kubectl logs -n $(KEYCLOAK_NAMESPACE) $$POD --tail=100 || echo "Could not fetch logs"; \
	else \
		echo "No Keycloak pods found"; \
	fi

helm-identity-bootstrap-logs: ## Show realm-bootstrap Job logs (most recent run)
	@# kubectl JSONPath does not support negative slice indices ({.items[-1:].x}),
	@# so use `-o name | tail -n 1` after --sort-by to pick the newest pod.
	@POD=$$(kubectl get pods -n $(KEYCLOAK_NAMESPACE) -l app.kubernetes.io/component=realm-bootstrap --sort-by=.metadata.creationTimestamp -o name 2>/dev/null | tail -n 1 | sed 's|^pod/||'); \
	if [ -n "$$POD" ]; then \
		echo "Logs for realm-bootstrap pod: $$POD"; \
		kubectl logs -n $(KEYCLOAK_NAMESPACE) $$POD --tail=200 || echo "Could not fetch logs"; \
	else \
		echo "No realm-bootstrap pods found"; \
	fi

helm-identity-port-forward: ## Port-forward Keycloak HTTP (8080) and management (9000)
	@echo "Keycloak HTTP: http://localhost:8080"
	@echo "Keycloak mgmt: http://localhost:9000 (/health/live, /metrics)"
	@echo "Press Ctrl+C to stop."
	@kubectl port-forward -n $(KEYCLOAK_NAMESPACE) svc/keycloak 8080:8080 9000:9000

# ────────────────── EKS Keycloak provisioning helpers (eks-keycloak-*) ───
# EKS has no Key Vault / SecretProviderClass, so the Entra broker client
# secret is delivered via a plain pre-created K8s Secret rather than an
# SPC-materialised one. values-eks.yaml sets
# realmBootstrap.broker.existingSecret=keycloak-entra-broker, so the chart
# does NOT render an inline secret and the realm-bootstrap Job reads
# KC_ENTRA_CLIENT_SECRET (key: clientSecret) off this Secret.
#
# Idempotent (dry-run | apply), so re-running with a rotated secret value
# updates the Secret in place. This Secret is EXTERNALLY MANAGED: an operator
# runs this target once (out of band) before any EKS deploy. deploy-all-tiers-eks
# does NOT invoke it — it only verifies the Secret is present via
# eks-keycloak-broker-secret-require and never creates or overwrites it, so CD
# can't clobber a rotated secret. The secret name is kept in sync with
# values-eks.yaml. Mirrors gke-keycloak-broker-secret (PR #261).
EKS_KEYCLOAK_BROKER_SECRET_NAME ?= keycloak-entra-broker
eks-keycloak-broker-secret: ## Create/update the Entra broker client-secret K8s Secret for EKS (no Key Vault). Required (env): KEYCLOAK_ENTRA_CLIENT_SECRET. Optional: KEYCLOAK_NAMESPACE.
	@# KEYCLOAK_ENTRA_CLIENT_SECRET is read from the SHELL ENVIRONMENT
	@# ($$KEYCLOAK_ENTRA_CLIENT_SECRET), never via Make expansion — a client
	@# secret containing `$$` would otherwise be mangled by GNU Make before
	@# reaching kubectl. Pass it as an env-var PREFIX, not a make var:
	@#   KEYCLOAK_ENTRA_CLIENT_SECRET='<secret>' make eks-keycloak-broker-secret
	@if [ -z "$${KEYCLOAK_ENTRA_CLIENT_SECRET:-}" ]; then \
		echo "ERROR: KEYCLOAK_ENTRA_CLIENT_SECRET must be set in the environment to create the '$(EKS_KEYCLOAK_BROKER_SECRET_NAME)' Secret."; \
		echo "       Fetch it from the dedicated 'agent-studio-dev-eks-broker' app registration"; \
		echo "       (Certificates & secrets blade) and pass it as an ENV VAR prefix (not a make"; \
		echo "       var, so values containing '$$' are not mangled by Make):"; \
		echo "         KEYCLOAK_ENTRA_CLIENT_SECRET='<secret>' make eks-keycloak-broker-secret KEYCLOAK_NAMESPACE=$(KEYCLOAK_NAMESPACE)"; \
		exit 1; \
	fi
	@echo "[eks-broker-secret] creating/updating Secret '$(EKS_KEYCLOAK_BROKER_SECRET_NAME)' in $(KEYCLOAK_NAMESPACE)..."
	@source $(HELPER_SCRIPT) && ensure_namespace $(KEYCLOAK_NAMESPACE) $(KEYCLOAK_NAMESPACE) || true
	@kubectl create secret generic $(EKS_KEYCLOAK_BROKER_SECRET_NAME) \
		--namespace $(KEYCLOAK_NAMESPACE) \
		--from-literal=clientSecret="$$KEYCLOAK_ENTRA_CLIENT_SECRET" \
		--dry-run=client -o yaml \
	  | kubectl label --local -f - \
		app.kubernetes.io/managed-by=eks-keycloak-broker-secret \
		app.kubernetes.io/part-of=keycloak \
		--dry-run=client -o yaml \
	  | kubectl apply -f -

# Pre-flight used by helm-identity-install-eks: the broker Secret is externally
# managed (operator runs eks-keycloak-broker-secret once; CD never creates or
# overwrites it). Fail fast with actionable instructions if it is missing OR
# lacks the clientSecret key.
eks-keycloak-broker-secret-require: ## Verify the pre-created Entra broker Secret exists (deploy pre-flight; does NOT create it). Optional: KEYCLOAK_NAMESPACE.
	@if ! kubectl get secret $(EKS_KEYCLOAK_BROKER_SECRET_NAME) -n $(KEYCLOAK_NAMESPACE) >/dev/null 2>&1; then \
		echo "ERROR: required Secret '$(EKS_KEYCLOAK_BROKER_SECRET_NAME)' not found in namespace '$(KEYCLOAK_NAMESPACE)'."; \
		echo "       values-eks.yaml references it via realmBootstrap.broker.existingSecret, so it"; \
		echo "       must be created once (out of band) before any EKS deploy. EKS has no Key Vault:"; \
		echo "         KEYCLOAK_ENTRA_CLIENT_SECRET='<secret>' make eks-keycloak-broker-secret KEYCLOAK_NAMESPACE=$(KEYCLOAK_NAMESPACE)"; \
		echo "       (<secret> = client secret of the 'agent-studio-dev-eks-broker' app registration)."; \
		exit 1; \
	fi
	@if [ -z "$$(kubectl get secret $(EKS_KEYCLOAK_BROKER_SECRET_NAME) -n $(KEYCLOAK_NAMESPACE) -o jsonpath='{.data.clientSecret}' 2>/dev/null)" ]; then \
		echo "ERROR: Secret '$(EKS_KEYCLOAK_BROKER_SECRET_NAME)' in '$(KEYCLOAK_NAMESPACE)' is missing the 'clientSecret' key."; \
		echo "       The realm-bootstrap Job reads KC_ENTRA_CLIENT_SECRET off that key. Recreate it:"; \
		echo "         KEYCLOAK_ENTRA_CLIENT_SECRET='<secret>' make eks-keycloak-broker-secret KEYCLOAK_NAMESPACE=$(KEYCLOAK_NAMESPACE)"; \
		exit 1; \
	fi
	@echo "[eks-broker-secret] OK: Secret '$(EKS_KEYCLOAK_BROKER_SECRET_NAME)' present in $(KEYCLOAK_NAMESPACE) with clientSecret key."

# ───────────────── Keycloak DB + bootstrap-admin secret management ──────────
# Unified across ALL clouds (aks/gke/eks); NOT cloud-specific.
#
# DB password -- SINGLE SOURCE OF TRUTH:
#   Keycloak reads its DB password directly from the database tier's own
#   $(SHARED_PG_SECRET_NAME) (namespace $(DATABASE_NAMESPACE), key
#   'postgres-password'). Because a secretKeyRef is namespace-local, the
#   `keycloak-db-secret-sync` target copies that Secret VERBATIM into the
#   identity namespace, and the overlays point postgres.auth.existingSecret at
#   it (with secretKeys.passwordKey=postgres-password). The chart takes the DB
#   username from the postgres.auth.username LITERAL, so no transformed
#   keycloak-postgres-auth duplicate is ever created -- there is exactly one
#   place the DB password lives. (values-local.yaml keeps the inline-password /
#   chart-rendered path for self-contained dev installs.)
#
# Bootstrap admin -- default vs opt-in:
#   Default: the chart RENDERS keycloak-bootstrap-admin from the inline
#   keycloak.bootstrapAdmin.password in values-<cloud>.yaml. Opt-in to an
#   EXTERNAL Secret with --set keycloak.bootstrapAdmin.existingSecret=<name>,
#   produced by `make keycloak-admin-secret` (any cloud) or, on Azure, by the
#   SecretProviderClass (secretProviderClass.enabled=true + keyvaultName/...).
KEYCLOAK_ADMIN_SECRET_NAME ?= keycloak-bootstrap-admin
SHARED_PG_SECRET_NAME ?= shared-postgresql-secret

keycloak-db-secret-sync: ## Copy the DB tier's $(SHARED_PG_SECRET_NAME) (key postgres-password) from $(DATABASE_NAMESPACE) into KEYCLOAK_NAMESPACE so Keycloak consumes the DB password via postgres.auth.existingSecret (single source of truth; no transformed duplicate). Idempotent. Optional: KEYCLOAK_NAMESPACE.
	@source $(HELPER_SCRIPT) && ensure_namespace $(KEYCLOAK_NAMESPACE) $(KEYCLOAK_NAMESPACE) || true
	@$(MAKE) ensure-shared-postgresql-secret >/dev/null
	@set -e; \
	pg_b64="$$(kubectl get secret $(SHARED_PG_SECRET_NAME) -n $(DATABASE_NAMESPACE) -o jsonpath='{.data.postgres-password}' 2>/dev/null || true)"; \
	if [ -z "$$pg_b64" ]; then \
	  echo "ERROR: $(SHARED_PG_SECRET_NAME) not found (or missing key 'postgres-password') in namespace $(DATABASE_NAMESPACE)."; \
	  echo "       Deploy the database tier first (make helm-database-* / scripts/ensure-shared-databases.sh)."; \
	  exit 1; \
	fi; \
	echo "[keycloak-db-secret-sync] copying $(SHARED_PG_SECRET_NAME): $(DATABASE_NAMESPACE) -> $(KEYCLOAK_NAMESPACE)"; \
	printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: %s\n  namespace: %s\n  labels:\n    app.kubernetes.io/managed-by: keycloak-db-secret-sync\n    app.kubernetes.io/part-of: keycloak\ntype: Opaque\ndata:\n  postgres-password: %s\n' \
	  "$(SHARED_PG_SECRET_NAME)" "$(KEYCLOAK_NAMESPACE)" "$$pg_b64" \
	  | kubectl apply -f -

# With KEYCLOAK_ADMIN_PASSWORD set -> create/rotate. Without it -> create-if-absent
# with a generated password; an existing Secret is left untouched (a re-run must
# NOT rotate a running Keycloak's admin out from under it).
keycloak-admin-secret: ## Create/update the Keycloak bootstrap admin K8s Secret (any cloud; pair with --set keycloak.bootstrapAdmin.existingSecret=keycloak-bootstrap-admin). With KEYCLOAK_ADMIN_PASSWORD: create/rotate. Without it: create-if-absent with a generated password (existing Secret untouched). Optional: KEYCLOAK_ADMIN_USERNAME (default: admin), KEYCLOAK_NAMESPACE.
	@source $(HELPER_SCRIPT) && ensure_namespace $(KEYCLOAK_NAMESPACE) $(KEYCLOAK_NAMESPACE) || true
	@# KEYCLOAK_ADMIN_PASSWORD is read via env (not a Make var) so values with '$$' aren't mangled.
	@set -e; \
	if [ -z "$${KEYCLOAK_ADMIN_PASSWORD:-}" ] && kubectl get secret $(KEYCLOAK_ADMIN_SECRET_NAME) -n $(KEYCLOAK_NAMESPACE) >/dev/null 2>&1; then \
	  echo "[keycloak-admin-secret] $(KEYCLOAK_ADMIN_SECRET_NAME) already exists -- leaving as-is (set KEYCLOAK_ADMIN_PASSWORD to rotate)"; \
	  exit 0; \
	fi; \
	if [ -n "$${KEYCLOAK_ADMIN_PASSWORD:-}" ]; then \
	  admin_pw="$$KEYCLOAK_ADMIN_PASSWORD"; \
	  echo "[keycloak-admin-secret] setting $(KEYCLOAK_ADMIN_SECRET_NAME) from KEYCLOAK_ADMIN_PASSWORD"; \
	else \
	  admin_pw="$$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | cut -c1-24)"; \
	  echo "[keycloak-admin-secret] generating a random password for $(KEYCLOAK_ADMIN_SECRET_NAME) (first create)"; \
	fi; \
	kubectl create secret generic $(KEYCLOAK_ADMIN_SECRET_NAME) \
		--namespace $(KEYCLOAK_NAMESPACE) \
		--from-literal=username="$${KEYCLOAK_ADMIN_USERNAME:-admin}" \
		--from-literal=password="$$admin_pw" \
		--dry-run=client -o yaml \
	  | kubectl label --local -f - \
		app.kubernetes.io/managed-by=keycloak-admin-secret \
		app.kubernetes.io/part-of=keycloak \
		--dry-run=client -o yaml \
	  | kubectl apply -f -

# Mirror the bootstrap admin secret from the Keycloak namespace into
# SERVICES_NAMESPACE so the platform tier post-upgrade hook job
# (templates/keycloak-setup-job.yaml) can authenticate against the
# Keycloak Admin API. There is no native cross-namespace secretKeyRef.
# Idempotent: rewrites the destination Secret each call so a rotated
# password flows through on the next invocation.
aks-keycloak-mirror-bootstrap-admin: ## Copy keycloak-bootstrap-admin from KEYCLOAK_NAMESPACE -> SERVICES_NAMESPACE so the platform tier's keycloak-setup-job can auth.
	@if ! kubectl get secret $(KEYCLOAK_ADMIN_SECRET_NAME) -n $(KEYCLOAK_NAMESPACE) >/dev/null 2>&1; then \
	  echo "[mirror-admin] source Secret $(KEYCLOAK_ADMIN_SECRET_NAME) not found in $(KEYCLOAK_NAMESPACE); skipping (install the identity chart first -- it chart-renders this Secret)"; \
	  exit 0; \
	fi
	@echo "[mirror-admin] copying $(KEYCLOAK_ADMIN_SECRET_NAME): $(KEYCLOAK_NAMESPACE) -> $(SERVICES_NAMESPACE)"
	@source $(HELPER_SCRIPT) && ensure_namespace $(SERVICES_NAMESPACE) $(SERVICES_NAMESPACE) || true
	@kubectl get secret $(KEYCLOAK_ADMIN_SECRET_NAME) -n $(KEYCLOAK_NAMESPACE) -o json \
	  | python3 -c "import json,sys; d=json.load(sys.stdin); d.pop('metadata',None); d['metadata']={'name':'$(KEYCLOAK_ADMIN_SECRET_NAME)','namespace':'$(SERVICES_NAMESPACE)','labels':{'app.kubernetes.io/managed-by':'aks-keycloak-mirror-bootstrap-admin','app.kubernetes.io/part-of':'keycloak'},'annotations':{'keycloak.agentstudio.io/source-namespace':'$(KEYCLOAK_NAMESPACE)'}}; print(json.dumps(d))" \
	  | kubectl apply -f -

# ── Entra broker secret ──────────────────────────────────────────────────────
# Mirrors the EKS/GKE pattern: the operator runs register-entra-app.sh (via
# aks-keycloak-entra-register) which writes the Entra broker client secret
# directly into a K8s Secret. No Key Vault involved.
AKS_KEYCLOAK_BROKER_SECRET_NAME ?= keycloak-entra-broker
aks-keycloak-entra-register: ## Register the Entra ID App Registration and write the broker client secret directly to K8s. Required: KEYCLOAK_HOSTNAME. Optional: KEYCLOAK_REALM (defaults to nemo), KEYCLOAK_NAMESPACE.
	@KEYCLOAK_HOSTNAME="$(KEYCLOAK_HOSTNAME)" \
	 KEYCLOAK_NS="$(KEYCLOAK_NAMESPACE)" \
	 KEYCLOAK_REALM="$(KEYCLOAK_REALM)" \
	   bash deployments/scripts/keycloak/register-entra-app.sh

aks-keycloak-broker-secret-require: ## Verify the pre-created Entra broker Secret exists (deploy pre-flight; does NOT create it). Optional: KEYCLOAK_NAMESPACE.
	@if ! kubectl get secret $(AKS_KEYCLOAK_BROKER_SECRET_NAME) -n $(KEYCLOAK_NAMESPACE) >/dev/null 2>&1; then \
		echo "ERROR: required Secret '$(AKS_KEYCLOAK_BROKER_SECRET_NAME)' not found in namespace '$(KEYCLOAK_NAMESPACE)'."; \
		echo "       values-aks.yaml references it via realmBootstrap.broker.existingSecret, so it"; \
		echo "       must be created once (out of band) before any AKS deploy:"; \
		echo "         make aks-keycloak-entra-register KEYCLOAK_HOSTNAME=$(KEYCLOAK_HOSTNAME) KEYCLOAK_NAMESPACE=$(KEYCLOAK_NAMESPACE)"; \
		exit 1; \
	fi
	@if [ -z "$$(kubectl get secret $(AKS_KEYCLOAK_BROKER_SECRET_NAME) -n $(KEYCLOAK_NAMESPACE) -o jsonpath='{.data.clientSecret}' 2>/dev/null)" ]; then \
		echo "ERROR: Secret '$(AKS_KEYCLOAK_BROKER_SECRET_NAME)' in '$(KEYCLOAK_NAMESPACE)' is missing the 'clientSecret' key."; \
		echo "       Re-create it: make aks-keycloak-entra-register KEYCLOAK_HOSTNAME=$(KEYCLOAK_HOSTNAME)"; \
		exit 1; \
	fi
	@echo "[aks-broker-secret] OK: Secret '$(AKS_KEYCLOAK_BROKER_SECRET_NAME)' present in $(KEYCLOAK_NAMESPACE) with clientSecret key."

# ── Grafana-proxy session + internal-token secrets ───────────────────────────
# Random values generated on first run; stable across pod restarts because
# they live as K8s Secrets (not in-pod env vars). Re-run only when rotating.
# Secrets are created in OBSERVABILITY_NAMESPACE (monitoring) since that is
# where the grafana-proxy and prometheus-proxy pods run.
#
# Cloud entry points (aks-keycloak-grafana-proxy-secrets,
# gke-keycloak-grafana-proxy-secrets, eks-keycloak-grafana-proxy-secrets) delegate
# here with per-cloud log prefix and managed-by label.
GRAFANA_PROXY_SECRETS_LOG_PREFIX ?=
GRAFANA_PROXY_SECRETS_MANAGED_BY ?=

keycloak-grafana-proxy-secrets: ## Shared grafana-proxy session/token secret bootstrap (create-if-absent). Invoked via aks-keycloak-grafana-proxy-secrets / gke-keycloak-grafana-proxy-secrets.
	@if [ -z "$(GRAFANA_PROXY_SECRETS_LOG_PREFIX)" ] || [ -z "$(GRAFANA_PROXY_SECRETS_MANAGED_BY)" ]; then \
	  echo "ERROR: keycloak-grafana-proxy-secrets requires GRAFANA_PROXY_SECRETS_LOG_PREFIX and GRAFANA_PROXY_SECRETS_MANAGED_BY."; \
	  echo "       Use: make aks-keycloak-grafana-proxy-secrets  or  make gke-keycloak-grafana-proxy-secrets  or  make eks-keycloak-grafana-proxy-secrets"; \
	  exit 1; \
	fi
	@source $(HELPER_SCRIPT) && ensure_namespace $(OBSERVABILITY_NAMESPACE) $(OBSERVABILITY_NAMESPACE) || true
	@set -e; \
	if [ -z "$${GRAFANA_PROXY_SESSION_HASH_KEY:-}" ] && [ -z "$${GRAFANA_PROXY_SESSION_BLOCK_KEY:-}" ] \
	    && kubectl get secret grafana-proxy-session-secret -n $(OBSERVABILITY_NAMESPACE) >/dev/null 2>&1; then \
	  echo "[$(GRAFANA_PROXY_SECRETS_LOG_PREFIX)] grafana-proxy-session-secret already exists in $(OBSERVABILITY_NAMESPACE) -- leaving as-is (set GRAFANA_PROXY_SESSION_HASH_KEY / GRAFANA_PROXY_SESSION_BLOCK_KEY to rotate)"; \
	else \
	  echo "[$(GRAFANA_PROXY_SECRETS_LOG_PREFIX)] creating/updating grafana-proxy-session-secret in $(OBSERVABILITY_NAMESPACE)..."; \
	  hash_key="$${GRAFANA_PROXY_SESSION_HASH_KEY:-$$(openssl rand -hex 32)}"; \
	  block_key="$${GRAFANA_PROXY_SESSION_BLOCK_KEY:-$$(openssl rand -hex 16)}"; \
	  kubectl create secret generic grafana-proxy-session-secret \
		--namespace $(OBSERVABILITY_NAMESPACE) \
		--from-literal=sessionHashKey="$$hash_key" \
		--from-literal=sessionBlockKey="$$block_key" \
		--dry-run=client -o yaml \
	  | kubectl label --local -f - \
		app.kubernetes.io/managed-by=$(GRAFANA_PROXY_SECRETS_MANAGED_BY) \
		app.kubernetes.io/part-of=keycloak \
		--dry-run=client -o yaml \
	  | kubectl apply -f -; \
	fi; \
	if [ -z "$${GRAFANA_PROXY_INTERNAL_TOKEN:-}" ] \
	    && kubectl get secret grafana-proxy-internal-token -n $(OBSERVABILITY_NAMESPACE) >/dev/null 2>&1; then \
	  echo "[$(GRAFANA_PROXY_SECRETS_LOG_PREFIX)] grafana-proxy-internal-token already exists in $(OBSERVABILITY_NAMESPACE) -- leaving as-is (set GRAFANA_PROXY_INTERNAL_TOKEN to rotate)"; \
	else \
	  echo "[$(GRAFANA_PROXY_SECRETS_LOG_PREFIX)] creating/updating grafana-proxy-internal-token in $(OBSERVABILITY_NAMESPACE)..."; \
	  token="$${GRAFANA_PROXY_INTERNAL_TOKEN:-$$(openssl rand -hex 32)}"; \
	  kubectl create secret generic grafana-proxy-internal-token \
		--namespace $(OBSERVABILITY_NAMESPACE) \
		--from-literal=internalToken="$$token" \
		--dry-run=client -o yaml \
	  | kubectl label --local -f - \
		app.kubernetes.io/managed-by=$(GRAFANA_PROXY_SECRETS_MANAGED_BY) \
		app.kubernetes.io/part-of=keycloak \
		--dry-run=client -o yaml \
	  | kubectl apply -f -; \
	fi

aks-keycloak-grafana-proxy-secrets: ## Create grafana-proxy session (hash/block) and internalToken K8s Secrets for AKS (create-if-absent). Generates random values on first create. Optional env to create/rotate: GRAFANA_PROXY_SESSION_HASH_KEY, GRAFANA_PROXY_SESSION_BLOCK_KEY, GRAFANA_PROXY_INTERNAL_TOKEN. Optional: OBSERVABILITY_NAMESPACE.
	$(MAKE) keycloak-grafana-proxy-secrets \
		GRAFANA_PROXY_SECRETS_LOG_PREFIX=aks-grafana-proxy-secrets \
		GRAFANA_PROXY_SECRETS_MANAGED_BY=aks-keycloak-grafana-proxy-secrets

gke-keycloak-grafana-proxy-secrets: ## Create grafana-proxy session (hash/block) and internalToken K8s Secrets for GKE (create-if-absent). Generates random values on first create. Optional env to create/rotate: GRAFANA_PROXY_SESSION_HASH_KEY, GRAFANA_PROXY_SESSION_BLOCK_KEY, GRAFANA_PROXY_INTERNAL_TOKEN. Optional: OBSERVABILITY_NAMESPACE.
	$(MAKE) keycloak-grafana-proxy-secrets \
		GRAFANA_PROXY_SECRETS_LOG_PREFIX=gke-grafana-proxy-secrets \
		GRAFANA_PROXY_SECRETS_MANAGED_BY=gke-keycloak-grafana-proxy-secrets

eks-keycloak-grafana-proxy-secrets: ## Create grafana-proxy session (hash/block) and internalToken K8s Secrets for EKS (create-if-absent). Generates random values on first create. Optional env to create/rotate: GRAFANA_PROXY_SESSION_HASH_KEY, GRAFANA_PROXY_SESSION_BLOCK_KEY, GRAFANA_PROXY_INTERNAL_TOKEN. Optional: OBSERVABILITY_NAMESPACE.
	$(MAKE) keycloak-grafana-proxy-secrets \
		GRAFANA_PROXY_SECRETS_LOG_PREFIX=eks-grafana-proxy-secrets \
		GRAFANA_PROXY_SECRETS_MANAGED_BY=eks-keycloak-grafana-proxy-secrets

# ----------------------------------------------------------------------------
# GKE Keycloak provisioning helpers (gke-keycloak-*)
# ----------------------------------------------------------------------------
# GKE has no Key Vault / SecretProviderClass, so the Entra broker client
# secret is delivered via a plain pre-created K8s Secret rather than an
# SPC-materialised one. values-gke.yaml sets
# realmBootstrap.broker.existingSecret=keycloak-entra-broker, so the chart
# does NOT render an inline secret and the realm-bootstrap Job reads
# KC_ENTRA_CLIENT_SECRET (key: clientSecret) off this Secret.
#
# Idempotent (dry-run | apply), so re-running with a rotated secret value
# updates the Secret in place. This Secret is EXTERNALLY MANAGED: an operator
# runs this target once (out of band) before any GKE deploy. deploy-all-tiers-gke
# does NOT invoke it -- it only verifies the Secret is present via
# gke-keycloak-broker-secret-require and never creates or overwrites it, so CD
# can't clobber a rotated secret. The secret name is kept in sync with
# values-gke.yaml.
GKE_KEYCLOAK_BROKER_SECRET_NAME ?= keycloak-entra-broker
gke-keycloak-broker-secret: ## Create/update the Entra broker client-secret K8s Secret for GKE (no Key Vault). Required (env): KEYCLOAK_ENTRA_CLIENT_SECRET. Optional: KEYCLOAK_NAMESPACE.
	@# KEYCLOAK_ENTRA_CLIENT_SECRET is read from the SHELL ENVIRONMENT
	@# ($$KEYCLOAK_ENTRA_CLIENT_SECRET), never via Make expansion of
	@# $$(KEYCLOAK_ENTRA_CLIENT_SECRET): a client secret containing `$$` or
	@# `$$(...)` would otherwise be mangled by GNU Make (and then the shell)
	@# before reaching kubectl, producing a corrupted Secret and confusing
	@# auth failures. Pass it as an env-var PREFIX, not a make var:
	@#   KEYCLOAK_ENTRA_CLIENT_SECRET='<secret>' make gke-keycloak-broker-secret
	@if [ -z "$${KEYCLOAK_ENTRA_CLIENT_SECRET:-}" ]; then \
		echo "ERROR: KEYCLOAK_ENTRA_CLIENT_SECRET must be set in the environment to create the '$(GKE_KEYCLOAK_BROKER_SECRET_NAME)' Secret."; \
		echo "       Fetch it from the dedicated 'agent-studio-dev-gke-broker' app registration"; \
		echo "       (Certificates & secrets blade) and pass it as an ENV VAR prefix (not a make"; \
		echo "       var, so values containing '$$' are not mangled by Make):"; \
		echo "         KEYCLOAK_ENTRA_CLIENT_SECRET='<secret>' make gke-keycloak-broker-secret KEYCLOAK_NAMESPACE=$(KEYCLOAK_NAMESPACE)"; \
		exit 1; \
	fi
	@echo "[gke-broker-secret] creating/updating Secret '$(GKE_KEYCLOAK_BROKER_SECRET_NAME)' in $(KEYCLOAK_NAMESPACE)..."
	@source $(HELPER_SCRIPT) && ensure_namespace $(KEYCLOAK_NAMESPACE) $(KEYCLOAK_NAMESPACE) || true
	@kubectl create secret generic $(GKE_KEYCLOAK_BROKER_SECRET_NAME) \
		--namespace $(KEYCLOAK_NAMESPACE) \
		--from-literal=clientSecret="$$KEYCLOAK_ENTRA_CLIENT_SECRET" \
		--dry-run=client -o yaml \
	  | kubectl label --local -f - \
		app.kubernetes.io/managed-by=gke-keycloak-broker-secret \
		app.kubernetes.io/part-of=keycloak \
		--dry-run=client -o yaml \
	  | kubectl apply -f -

# Pre-flight used by deploy-all-tiers-gke: the broker Secret is externally
# managed (operator runs gke-keycloak-broker-secret once; CD never creates or
# overwrites it). Fail fast with actionable instructions if it is missing OR
# lacks the clientSecret key, rather than letting the realm-bootstrap Job hang
# on a Secret its pod can't mount.
gke-keycloak-broker-secret-require: ## Verify the pre-created Entra broker Secret exists (deploy pre-flight; does NOT create it). Optional: KEYCLOAK_NAMESPACE.
	@if ! kubectl get secret $(GKE_KEYCLOAK_BROKER_SECRET_NAME) -n $(KEYCLOAK_NAMESPACE) >/dev/null 2>&1; then \
		echo "ERROR: required Secret '$(GKE_KEYCLOAK_BROKER_SECRET_NAME)' not found in namespace '$(KEYCLOAK_NAMESPACE)'."; \
		echo "       values-gke.yaml references it via realmBootstrap.broker.existingSecret, so it"; \
		echo "       must be created once (out of band) before any GKE deploy. GKE has no Key Vault:"; \
		echo "         KEYCLOAK_ENTRA_CLIENT_SECRET='<secret>' make gke-keycloak-broker-secret KEYCLOAK_NAMESPACE=$(KEYCLOAK_NAMESPACE)"; \
		echo "       (<secret> = client secret of the 'agent-studio-dev-gke-broker' app registration)."; \
		exit 1; \
	fi
	@if [ -z "$$(kubectl get secret $(GKE_KEYCLOAK_BROKER_SECRET_NAME) -n $(KEYCLOAK_NAMESPACE) -o jsonpath='{.data.clientSecret}' 2>/dev/null)" ]; then \
		echo "ERROR: Secret '$(GKE_KEYCLOAK_BROKER_SECRET_NAME)' in '$(KEYCLOAK_NAMESPACE)' is missing the 'clientSecret' key."; \
		echo "       The realm-bootstrap Job reads KC_ENTRA_CLIENT_SECRET off that key. Recreate it:"; \
		echo "         KEYCLOAK_ENTRA_CLIENT_SECRET='<secret>' make gke-keycloak-broker-secret KEYCLOAK_NAMESPACE=$(KEYCLOAK_NAMESPACE)"; \
		exit 1; \
	fi
	@echo "[gke-broker-secret] OK: Secret '$(GKE_KEYCLOAK_BROKER_SECRET_NAME)' present in $(KEYCLOAK_NAMESPACE) with clientSecret key."

# Smoke test for the per-project authorization design (docs/design/
# keycloak-per-project-authorization.md). Exercises the §6 lifecycle
# (create project -> add user -> change scope -> remove user -> delete
# project) against a live Keycloak instance and asserts acceptance
# criteria A-1 through A-11.
#
# Required env:
#   KC_BASE                  Keycloak base URL (e.g. https://auth.<endpoint>)
#   KC_SVC_CONFIG_SECRET     client_secret for agentstudio-config-service
#                            (an authzAdminClient — its SA holds
#                            manage-authorization + uma_protection)
# Optional env:
#   REALM                    realm name (default: nemo)
#   KC_ADMIN_USER            admin user (default: admin)
#   KC_ADMIN_PASSWORD        admin password (default: from KC_BASE prompt)
keycloak-per-project-smoke: ## Run per-project authorization smoke test against a deployed Keycloak. Required: KC_BASE, KC_SVC_CONFIG_SECRET. Optional: REALM, KC_ADMIN_USER, KC_ADMIN_PASSWORD.
	@KC_BASE="$(KC_BASE)" \
	 KC_SVC_CONFIG_SECRET="$(KC_SVC_CONFIG_SECRET)" \
	 REALM="$(or $(REALM),nemo)" \
	 KC_ADMIN_USER="$(KC_ADMIN_USER)" \
	 KC_ADMIN_PASSWORD="$(KC_ADMIN_PASSWORD)" \
	   bash deployments/scripts/keycloak/per-project-smoke.sh


