# Mirror of upstream Bifrost for AgentStudio registries (ACR / NetApp eng).
#
# Pins a specific upstream release for reproducible deploys AND bakes in
# the model-pricing datasheets that bifrost normally fetches from
# `https://getbifrost.ai/datasheet` on startup.
#
# Why bake them in:
#   - Air-gapped clusters have no outbound internet — bifrost's pricing
#     manager init fails and the container goes fatal.
#   - MITM HTTPS egress proxies (e.g. NetApp openeng) intercept the
#     getbifrost.ai connection with a cert valid for *.openeng.netapp.com,
#     not getbifrost.ai. Bifrost trusts the proxy's CA but Go's hostname
#     verification still rejects the cert → same fatal result.
#     Adding more CAs doesn't fix a SAN mismatch.
#
# The Helm chart points bifrost at `file:///app/builtin-pricing/*.json`
# via `framework.pricing.{pricing_url,model_parameters_url}` (see
# deployments/helm/llm-gateway/charts/bifrost/values.yaml → `pricing`).
# Bifrost re-reads these files on its sync interval (default 24h); since
# the files are static in the image, refreshing pricing == rebuilding
# this mirror image (`make bifrost-build-push`).
#
# Pricing data changes slowly (months), so the rebuild cadence is fine.

# Bumped from v1.5.7 → v1.5.16: v1.5.7 fatal-crashes at startup with
# "unsupported protocol scheme \"file\"" because Go's net/http rejects
# file:// URLs. Upstream's airgapped pricing-load feature
# (transports/v1.5.16 release notes: "Model catalog pricing and model
# parameters can now sync from local files for airgapped deployments")
# is the chart's design intent — the mirror Dockerfile below bakes the
# JSON datasheets into /app/builtin-pricing/ and the chart's
# `framework.pricing.{pricing_url,model_parameters_url}` point at them
# via file://. Without this version bump, bifrost-proxy crashloops and
# every project workflow's SetupProjectLLMGateway step 503's.
#
# v1.5.16 chosen over v1.6.0 deliberately: it's the *minimum* version
# that ships the feature, so we get the fix with the smallest surface
# of accumulated upstream change. Bump to v1.6.x when there's a
# concrete reason to (new feature needed, security patch, etc.).
#
# Lockstep — this version must stay in sync with three other places:
#   * `BIFROST_UPSTREAM_VERSION` default in src/images/bifrost/Makefile
#   * `BIFROST_TAG` default in mk/build.mk
#   * `image.tag` in deployments/helm/llm-gateway/values.yaml
# When bumping, update all four; CI does NOT enforce this and a drift
# silently leaves the chart pulling an old image while the rebuild
# produced a new one (or vice-versa).
ARG BIFROST_UPSTREAM_VERSION=v1.5.16

# --- Stage 1: fetch upstream datasheets at build time.
# Runs on the build host, which is expected to have unrestricted egress.
# If the build is itself running behind a MITM proxy, an operator can
# pre-stage the JSON files alongside this Dockerfile and switch the COPY
# below to a local file (see commented alternative).
FROM docker.repo.eng.netapp.com/alpine:3.20 AS datasheet
RUN apk add --no-cache curl ca-certificates
RUN mkdir -p /datasheet && \
    curl -fsSL -m 60 \
      -o /datasheet/pricing.json \
      https://getbifrost.ai/datasheet && \
    curl -fsSL -m 60 \
      -o /datasheet/model-parameters.json \
      https://getbifrost.ai/datasheet/model-parameters && \
    # Sanity check — refuse to produce a broken image if either fetch
    # returned an empty or non-JSON response.
    head -c 1 /datasheet/pricing.json | grep -q '[\[{]' && \
    head -c 1 /datasheet/model-parameters.json | grep -q '[\[{]'

# --- Stage 2: AgentStudio mirror of upstream bifrost, with datasheets baked in.
FROM docker.repo.eng.netapp.com/maximhq/bifrost:${BIFROST_UPSTREAM_VERSION}
COPY --from=datasheet /datasheet/pricing.json           /app/builtin-pricing/pricing.json
COPY --from=datasheet /datasheet/model-parameters.json  /app/builtin-pricing/model-parameters.json
