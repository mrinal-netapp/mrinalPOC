{{/*
Logical deployment identity — release-independent name used for data-plane
objects (Iceberg warehouse, S3 bucket, cross-release secret prefixes).
Checks .Values.deploymentName first, then .Values.global.deploymentName
(for subchart access), and falls back to "nemo".
*/}}
{{- define "nemo.deploymentName" -}}
{{- if .Values.deploymentName }}
  {{- .Values.deploymentName }}
{{- else if and .Values.global .Values.global.deploymentName }}
  {{- .Values.global.deploymentName }}
{{- else }}
  {{- "nemo" }}
{{- end }}
{{- end }}

{{/*
Expand the name of the chart.
*/}}
{{- define "nemo.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "nemo.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "nemo.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "nemo.labels" -}}
helm.sh/chart: {{ include "nemo.chart" . }}
{{ include "nemo.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "nemo.selectorLabels" -}}
app.kubernetes.io/name: {{ include "nemo.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "nemo.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "nemo.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Generate service name for apigateway-service
*/}}
{{- define "nemo.gatewayServiceName" -}}
{{- printf "apigateway-service" }}
{{- end }}

{{/*
Generate namespace
*/}}
{{- define "nemo.namespace" -}}
{{- default .Release.Namespace .Values.namespace }}
{{- end }}

{{/*
In-cluster HTTP URL for config-service (same namespace as release / .Values.namespace).
Short names like http://config-service:3000 fail DNS when the pod namespace does not
match where config-service runs; FQDN is reliable across Helm release layouts.
*/}}
{{- define "nemo.configServiceClusterURL" -}}
{{- $ns := include "nemo.namespace" . }}
{{- printf "http://config-service.%s.svc.cluster.local:3000" $ns }}
{{- end }}

{{/*
Generate endpoint URL (HTTPS)
Format: https://{consoleHost}:{port}
Example: https://app.agentstudio.local:8443

Uses nemo.consoleHost (single-label subdomain) instead of the bare endpoint so
that the canonical browser URL is reachable on clusters whose wildcard DNS
covers only single-label subdomains (the apex `{endpoint}` itself does not
resolve in that case).
*/}}
{{- define "nemo.endpointUrl" -}}
{{- $consoleHost := include "nemo.consoleHost" . }}
{{- $httpsPort := 8443 }}
{{- $apigatewayService := index .Values "apigateway-service" }}
{{- if and $apigatewayService $apigatewayService.service $apigatewayService.service.httpsPort }}
  {{- $httpsPort = $apigatewayService.service.httpsPort }}
{{- end }}
{{- printf "https://%s:%d" $consoleHost $httpsPort }}
{{- end }}

{{/*
Generate endpoint URL (HTTP)
Format: http://{consoleHost}:{port}
Example: http://app.agentstudio.local:8080
*/}}
{{- define "nemo.endpointUrlHttp" -}}
{{- $consoleHost := include "nemo.consoleHost" . }}
{{- $httpPort := 8080 }}
{{- $apigatewayService := index .Values "apigateway-service" }}
{{- if and $apigatewayService $apigatewayService.service $apigatewayService.service.port }}
  {{- $httpPort = $apigatewayService.service.port }}
{{- end }}
{{- printf "http://%s:%d" $consoleHost $httpPort }}
{{- end }}

{{/*
Generate Gateway resource name
*/}}
{{- define "nemo.gatewayName" -}}
{{- printf "%s-gateway" (include "nemo.fullname" .) }}
{{- end }}

{{/*
Generate HTTPRoute resource name
*/}}
{{- define "nemo.httprouteName" -}}
{{- printf "%s-httproute" (include "nemo.fullname" .) }}
{{- end }}

{{/*
Generate GatewayClass name from values
*/}}
{{- define "nemo.gatewayClassName" -}}
{{- .Values.gateway.className | default "nginx" }}
{{- end }}

{{/*
Get gateway service port safely
The gateway service always runs on port 8080 (defined in gateway subchart)
This helper exists for consistency and potential future customization
*/}}
{{- define "nemo.gatewayServicePort" -}}
{{- 8080 }}
{{- end }}

{{/*
S3Gateway credentials secret name
This should match the secret name created by the s3gateway chart
Always uses "nemo" as the chart name to ensure consistency across all subcharts
This ensures the secret name is the same regardless of which subchart references it
*/}}
{{- define "nemo.s3gatewayCredentialsName" -}}
{{- printf "%s-s3gateway-credentials" (include "nemo.deploymentName" . | trim) }}
{{- end }}

{{/*
Default S3 bucket name — follows deploymentName: default-{deploymentName}.
*/}}
{{- define "nemo.defaultBucketName" -}}
{{- printf "default-%s" (include "nemo.deploymentName" . | trim) }}
{{- end }}

{{/*
S3 gateway chart fullname (must match charts/s3gateway/templates/_helpers.tpl logic for subchart values).
Used for default-bucket PVC claimName on worker pods.
*/}}
{{- define "nemo.s3gatewayFullname" -}}
{{- /* Default-bucket PVC is named {s3gateway.fullname}-default-bucket. Data-plane charts are subcharts and do not receive the parent "s3gateway:" values key — use global.s3gatewayFullname (must match s3gateway.fullnameOverride). */}}
{{- $g := "" }}
{{- if and .Values.global .Values.global.s3gatewayFullname }}
{{- $g = .Values.global.s3gatewayFullname | toString | trim }}
{{- end }}
{{- if $g }}
{{- $g | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $s3 := index $.Values "s3gateway" | default dict }}
{{- if and (kindIs "map" $s3) $s3.fullnameOverride }}
{{- $s3.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $chartName := "s3gateway" }}
{{- if contains $chartName .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $chartName | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}

{{/*
PVC name for the VersityGW default bucket (ReadWriteMany). Matches s3gateway chart default-bucket-pvc.yaml.
*/}}
{{- define "nemo.defaultBucketPvcName" -}}
{{- printf "%s-default-bucket" (include "nemo.s3gatewayFullname" .) }}
{{- end }}

{{/*
Get endpoint domain (base domain for TLS certs and all subdomains)
Default: agentstudio.local
Can be overridden via ENDPOINT environment variable
Supports both root-level endpoint and global.endpoint (for subchart access)
*/}}
{{- define "nemo.endpoint" -}}
{{- $endpoint := "" }}
{{- if .Values.endpoint }}
  {{- $endpoint = .Values.endpoint }}
{{- else if and .Values.global .Values.global.endpoint }}
  {{- $endpoint = .Values.global.endpoint }}
{{- end }}
{{- $endpoint | default "agentstudio.local" }}
{{- end }}

{{/*
Get the console subdomain label (single label, no dots).
Default: "app". Overridable via .Values.consoleSubdomain or .Values.global.consoleSubdomain
(for subchart access).
*/}}
{{- define "nemo.consoleSubdomain" -}}
{{- $sub := "" }}
{{- if .Values.consoleSubdomain }}
  {{- $sub = .Values.consoleSubdomain }}
{{- else if and .Values.global .Values.global.consoleSubdomain }}
  {{- $sub = .Values.global.consoleSubdomain }}
{{- end }}
{{- $sub | default "app" }}
{{- end }}

{{/*
Get the console host (single-label public hostname for the console + API gateway).
Format: {consoleSubdomain}.{endpoint}
Example: app.agentstudio.local

This is the canonical browser-facing host. It is intentionally NOT the apex
(bare {endpoint}), because environments whose wildcard DNS only covers single
labels (`*.{endpoint}`) cannot resolve the apex.
*/}}
{{- define "nemo.consoleHost" -}}
{{- printf "%s.%s" (include "nemo.consoleSubdomain" .) (include "nemo.endpoint" .) }}
{{- end }}

{{/*
Get the workspace label prefix used to build per-workspace public hostnames.
Workspace public hosts are: {workspaceLabelPrefix}<workspaceId>.{endpoint}
Default: "ws-". Must be RFC-1035 hostname-safe (letters/digits/hyphen).
*/}}
{{- define "nemo.workspaceLabelPrefix" -}}
{{- $prefix := "" }}
{{- if .Values.workspaceLabelPrefix }}
  {{- $prefix = .Values.workspaceLabelPrefix }}
{{- else if and .Values.global .Values.global.workspaceLabelPrefix }}
  {{- $prefix = .Values.global.workspaceLabelPrefix }}
{{- end }}
{{- $prefix | default "ws-" }}
{{- end }}

{{/*
Get auth subdomain (Keycloak)
Format: auth.{endpoint}
Example: auth.agentstudio.local
*/}}
{{- define "nemo.authSubdomain" -}}
{{- printf "auth.%s" (include "nemo.endpoint" .) }}
{{- end }}

{{/*
Get S3 subdomain
Format: s3.{endpoint}
Example: s3.agentstudio.local
*/}}
{{- define "nemo.s3Subdomain" -}}
{{- printf "s3.%s" (include "nemo.endpoint" .) }}
{{- end }}

{{/*
Get Catalog subdomain (Lakekeeper)
Format: catalog.{endpoint}
Example: catalog.agentstudio.local
*/}}
{{- define "nemo.catalogSubdomain" -}}
{{- printf "catalog.%s" (include "nemo.endpoint" .) }}
{{- end }}

{{/*
Get Workflows subdomain (Temporal UI)
Format: workflows.{endpoint}
Example: workflows.agentstudio.local
*/}}
{{- define "nemo.workflowsSubdomain" -}}
{{- printf "workflows.%s" (include "nemo.endpoint" .) }}
{{- end }}

{{/*
Get Phoenix subdomain (Arize Phoenix UI)
Format: phoenix.{endpoint}
Example: phoenix.agentstudio.local
*/}}
{{- define "nemo.phoenixSubdomain" -}}
{{- printf "phoenix.%s" (include "nemo.endpoint" .) }}
{{- end }}

{{/*
Get workspace subdomain base
Format: ws.{endpoint}
Example: ws.agentstudio.local
*/}}
{{- define "nemo.workspaceSubdomainBase" -}}
{{- printf "ws.%s" (include "nemo.endpoint" .) }}
{{- end }}

{{/*
Default Gateway/HTTPRoute hostnames derived from endpoint.

Single-label wildcard DNS contract:
  - The chart is designed for clusters whose wildcard DNS covers ONLY
    single-label subdomains (i.e. *.{endpoint} resolves, but {endpoint} apex
    and *.ws.{endpoint} / *.s3.{endpoint} two-deep names do NOT resolve).
  - Therefore this list intentionally OMITS:
      * the apex {endpoint} itself (canonical UI moves to {consoleHost})
      * *.ws.{endpoint} and ws.{endpoint} (workspaces use {workspaceLabelPrefix}<id>.{endpoint})
      * *.s3.{endpoint} (S3 virtual-hosted addressing is dropped; clients use path-style)
  - It INCLUDES "*.{endpoint}" so the gateway accepts any single-label
    subdomain, which covers per-workspace hosts (ws-<id>.{endpoint}) as
    well as future single-label apps without re-listing them here.
*/}}
{{- define "nemo.defaultGatewayHostnames" -}}
{{- $endpoint := include "nemo.endpoint" . }}
{{- $consoleHost := include "nemo.consoleHost" . }}
{{- $workflowsSubdomain := include "nemo.workflowsSubdomain" . }}
{{- $phoenixSubdomain := include "nemo.phoenixSubdomain" . }}
{{- $s3Subdomain := include "nemo.s3Subdomain" . }}
- {{ $consoleHost | quote }}
- {{ $workflowsSubdomain | quote }}
- {{ $phoenixSubdomain | quote }}
- {{ $s3Subdomain | quote }}
- {{ printf "*.%s" $endpoint | quote }}
{{- end }}

{{/*
Effective Gateway/HTTPRoute hostnames:
- Uses .Values.httproute.hosts when provided.
- Falls back to default helper-derived hostnames.
*/}}
{{- define "nemo.effectiveGatewayHostnames" -}}
{{- $hasHosts := and .Values.httproute.hosts (gt (len .Values.httproute.hosts) 0) }}
{{- if $hasHosts }}
{{- toYaml .Values.httproute.hosts }}
{{- else }}
{{- include "nemo.defaultGatewayHostnames" . }}
{{- end }}
{{- end }}

{{/*
Public HTTPS port. Reads global.gatewayHttpsPort; default 443. Local overrides to 8443.
*/}}
{{- define "nemo.gatewayHttpsPort" -}}
{{- $port := 443 -}}
{{- if and .Values.global (index .Values.global "gatewayHttpsPort") -}}
  {{- $port = int (index .Values.global "gatewayHttpsPort") -}}
{{- end -}}
{{- $port -}}
{{- end }}

{{/*
URL port suffix: ":N" when port != 443, empty otherwise. Required so emitted
URLs match Keycloak's iss claim (KC_HOSTNAME omits :443 on cloud).
*/}}
{{- define "nemo.gatewayPortSuffix" -}}
{{- $port := int (include "nemo.gatewayHttpsPort" .) -}}
{{- if ne $port 443 -}}{{- printf ":%d" $port -}}{{- end -}}
{{- end }}

{{/*
Keycloak issuer URL: https://auth.<endpoint>[:port]/realms/<realm>.
Port omitted on cloud (443 default); ":8443" on local.
*/}}
{{- define "nemo.keycloakIssuer" -}}
{{- /* Realm segment: see nemo.keycloakInternalIssuer for the same lookup chain. */ -}}
{{- $realmName := "nemo" -}}
{{- if and .Values.keycloak .Values.keycloak.setup .Values.keycloak.setup.realmName -}}
  {{- $realmName = .Values.keycloak.setup.realmName -}}
{{- else if and .Values.global .Values.global.keycloak .Values.global.keycloak.setup .Values.global.keycloak.setup.realmName -}}
  {{- $realmName = .Values.global.keycloak.setup.realmName -}}
{{- end -}}
{{- printf "https://%s%s/realms/%s" (include "nemo.authSubdomain" .) (include "nemo.gatewayPortSuffix" .) $realmName }}
{{- end }}

{{/*
Lakekeeper HTTP base (management + catalog on same Service; chart uses fullnameOverride: lakekeeper).
Use short DNS within the release namespace — matches LAKEKEEPER__BASE_URI in lakekeeper.catalog.extraEnv.
Override global.lakekeeperCatalogUrl only if Lakekeeper runs elsewhere or uses a non-default Service name.
*/}}
{{- define "nemo.lakekeeperHttpInternalBase" -}}
http://lakekeeper:8181
{{- end }}

{{- define "nemo.lakekeeperCatalogRestUrl" -}}
{{- /* Explicit non-empty: YAML "" must fall through to default (Helm coalesce can make bare `if .Values.global.lakekeeperCatalogUrl` unreliable). */ -}}
{{- $url := "" }}
{{- if .Values.global }}
  {{- $url = index .Values.global "lakekeeperCatalogUrl" | default "" | trim }}
{{- end }}
{{- if ne $url "" }}
{{- $url | trimSuffix "/" -}}
{{- else -}}
{{ include "nemo.lakekeeperHttpInternalBase" . }}/catalog
{{- end -}}
{{- end }}

{{/*
Keycloak Admin API base URL (in-cluster HTTP, port 8080).
Service name is `keycloak` (the in-repo Keycloak chart pins fullnameOverride
to `keycloak`). By default Keycloak runs in the `agentstudio-identity`
namespace; override via `keycloak.setup.keycloakNamespace` or set
`keycloak.setup.keycloakUrl` explicitly to point at a Keycloak in a
different cluster / Service name.
*/}}
{{- define "nemo.keycloakHttpBaseUrl" -}}
{{- $kcNs := "agentstudio-identity" }}
{{- if and .Values.keycloak .Values.keycloak.setup .Values.keycloak.setup.keycloakNamespace }}
  {{- $kcNs = .Values.keycloak.setup.keycloakNamespace }}
{{- end }}
{{- printf "http://keycloak.%s.svc.cluster.local:8080" $kcNs }}
{{- end }}

{{/*
Get Keycloak internal issuer URL (for service-to-service authentication)
Must match Lakekeeper's LAKEKEEPER__OPENID_PROVIDER_URI so tokens are accepted (JWT "iss" claim).
Uses FQDN by default: http://keycloak.agentstudio-identity.svc.cluster.local:8080/realms/{realm}
Supports override via keycloak.setup.keycloakUrl (root or global) for subchart access.
*/}}
{{- define "nemo.keycloakInternalIssuer" -}}
{{- $defaultNs := "agentstudio-identity" }}
{{- $keycloakServiceUrl := printf "http://keycloak.%s.svc.cluster.local:8080" $defaultNs }}
{{- if and .Values.keycloak .Values.keycloak.setup .Values.keycloak.setup.keycloakNamespace }}
  {{- $keycloakServiceUrl = printf "http://keycloak.%s.svc.cluster.local:8080" .Values.keycloak.setup.keycloakNamespace }}
{{- end }}
{{- /* Check root-level keycloak.setup.keycloakUrl first */}}
{{- if .Values.keycloak }}
  {{- if .Values.keycloak.setup }}
    {{- if .Values.keycloak.setup.keycloakUrl }}
      {{- $keycloakServiceUrl = .Values.keycloak.setup.keycloakUrl }}
    {{- end }}
  {{- end }}
{{- end }}
{{- /* Fallback to global values if root-level not found (for subchart access) */}}
{{- if and (eq $keycloakServiceUrl (printf "http://keycloak.%s.svc.cluster.local:8080" $defaultNs)) .Values.global }}
  {{- if .Values.global.keycloak }}
    {{- if .Values.global.keycloak.setup }}
      {{- if .Values.global.keycloak.setup.keycloakUrl }}
        {{- $keycloakServiceUrl = .Values.global.keycloak.setup.keycloakUrl }}
      {{- end }}
    {{- end }}
  {{- end }}
{{- end }}
{{- /*
Realm segment: read from `keycloak.setup.realmName` (root or global)
with `nemo` as the default, so renaming the realm in one place flows
to every issuer URL the helpers emit. Matches lakekeeper-bootstrap
and Lakekeeper OPENID_PROVIDER_URI.
*/}}
{{- $realmName := "nemo" -}}
{{- if and .Values.keycloak .Values.keycloak.setup .Values.keycloak.setup.realmName -}}
  {{- $realmName = .Values.keycloak.setup.realmName -}}
{{- else if and .Values.global .Values.global.keycloak .Values.global.keycloak.setup .Values.global.keycloak.setup.realmName -}}
  {{- $realmName = .Values.global.keycloak.setup.realmName -}}
{{- end -}}
{{- $base := $keycloakServiceUrl | trimSuffix "/" }}
{{- printf "%s/realms/%s" $base $realmName }}
{{- end }}

{{/*
Cluster-local Bifrost base URL (no path suffix). Reads
(global.)llmGateway.bifrost.url; falls back to the in-cluster
bifrost-proxy Service when unset.
*/}}
{{- define "nemo.llmGatewayUrl" -}}
{{- $ns := include "nemo.namespace" . }}
{{- if and .Values.global .Values.global.llmGateway .Values.global.llmGateway.bifrost .Values.global.llmGateway.bifrost.url }}
{{- .Values.global.llmGateway.bifrost.url }}
{{- else if and .Values.llmGateway .Values.llmGateway.bifrost .Values.llmGateway.bifrost.url }}
{{- .Values.llmGateway.bifrost.url }}
{{- else }}
{{- printf "http://bifrost-proxy.%s.svc.cluster.local:8080" $ns }}
{{- end }}
{{- end }}
