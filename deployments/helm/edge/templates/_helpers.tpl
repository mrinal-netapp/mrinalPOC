{{/*
Tier: edge (agentstudio-edge namespace)

Holds the ingress Gateway (Istio or NGF), every HTTPRoute except
auth.* (which lives in agentstudio-identity), edge JWT validation
(RequestAuthentication), edge gating (AuthorizationPolicy), parity
header injection (EnvoyFilter), and per-namespace ReferenceGrants
allowing HTTPRoutes in agentstudio-edge to reach Services in the
backend namespaces (services / console / platform / monitoring).

Helper template names retain the historical `nemo.*` prefix because
they're consumed across other charts (services subcharts, identity
chart) — renaming the helper namespace would be a much wider sweep.
Resource names rendered by these helpers (Gateway, HTTPRoutes, ...)
have been rebranded to `agentstudio-*`.
*/}}

{{- define "edge.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "edge.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "edge.labels" -}}
helm.sh/chart: {{ include "edge.chart" . }}
app.kubernetes.io/name: {{ include "edge.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: edge
{{- end }}

{{/*
Backwards-compatibility shims so subchart-style includes that read
"nemo.labels" / "nemo.namespace" continue to work after the move
from services chart.
*/}}
{{- define "nemo.labels" -}}
{{- include "edge.labels" . }}
{{- end }}

{{- define "nemo.namespace" -}}
{{- .Release.Namespace }}
{{- end }}

{{/*
Endpoint helpers (mirror services/_helpers.tpl).
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

{{- define "nemo.consoleSubdomain" -}}
{{- $sub := "" }}
{{- if .Values.consoleSubdomain }}
  {{- $sub = .Values.consoleSubdomain }}
{{- else if and .Values.global .Values.global.consoleSubdomain }}
  {{- $sub = .Values.global.consoleSubdomain }}
{{- end }}
{{- $sub | default "app" }}
{{- end }}

{{- define "nemo.consoleHost" -}}
{{- printf "%s.%s" (include "nemo.consoleSubdomain" .) (include "nemo.endpoint" .) }}
{{- end }}

{{- define "nemo.workspaceLabelPrefix" -}}
{{- $prefix := "" }}
{{- if .Values.workspaceLabelPrefix }}
  {{- $prefix = .Values.workspaceLabelPrefix }}
{{- else if and .Values.global .Values.global.workspaceLabelPrefix }}
  {{- $prefix = .Values.global.workspaceLabelPrefix }}
{{- end }}
{{- $prefix | default "ws-" }}
{{- end }}

{{- define "nemo.authSubdomain" -}}
{{- $prefix := "auth" }}
{{- if and .Values.keycloak .Values.keycloak.authSubdomain }}
  {{- $prefix = .Values.keycloak.authSubdomain }}
{{- end }}
{{- printf "%s.%s" $prefix (include "nemo.endpoint" .) }}
{{- end }}

{{- define "nemo.s3Subdomain" -}}
{{- printf "s3.%s" (include "nemo.endpoint" .) }}
{{- end }}

{{- define "nemo.catalogSubdomain" -}}
{{- printf "catalog.%s" (include "nemo.endpoint" .) }}
{{- end }}

{{- define "nemo.workflowsSubdomain" -}}
{{- printf "workflows.%s" (include "nemo.endpoint" .) }}
{{- end }}

{{- define "nemo.phoenixSubdomain" -}}
{{- printf "phoenix.%s" (include "nemo.endpoint" .) }}
{{- end }}

{{- define "nemo.grafanaSubdomain" -}}
{{- printf "grafana.%s" (include "nemo.endpoint" .) }}
{{- end }}

{{- define "nemo.workspaceWildcardHost" -}}
{{- printf "%s*.%s" (include "nemo.workspaceLabelPrefix" .) (include "nemo.endpoint" .) }}
{{- end }}

{{- define "nemo.gatewayName" -}}
{{- .Values.gateway.name | default "agentstudio-gateway" }}
{{- end }}

{{- define "nemo.gatewayClassName" -}}
{{- if eq (.Values.gateway.provider | default "nginx") "istio" }}
{{- .Values.gateway.istio.className | default "istio" }}
{{- else }}
{{- .Values.gateway.className | default "nginx" }}
{{- end }}
{{- end }}

{{- define "nemo.defaultGatewayHostnames" -}}
{{- $endpoint := include "nemo.endpoint" . }}
{{- $consoleHost := include "nemo.consoleHost" . }}
{{- $authSubdomain := include "nemo.authSubdomain" . }}
{{- $catalogSubdomain := include "nemo.catalogSubdomain" . }}
{{- $workflowsSubdomain := include "nemo.workflowsSubdomain" . }}
{{- $phoenixSubdomain := include "nemo.phoenixSubdomain" . }}
{{- $s3Subdomain := include "nemo.s3Subdomain" . }}
- {{ $consoleHost | quote }}
- {{ $catalogSubdomain | quote }}
- {{ $workflowsSubdomain | quote }}
- {{ $phoenixSubdomain | quote }}
- {{ $s3Subdomain | quote }}
- {{ printf "*.%s" $endpoint | quote }}
{{- end }}

{{/*
Selector label set used by RequestAuthentication / AuthorizationPolicy /
EnvoyFilter to bind to the Istio-auto-provisioned gateway pod. The
istiod Gateway API controller sets this label on the gateway
Deployment + Service when it reconciles the Gateway resource.
*/}}
{{- define "nemo.istioGatewaySelector" -}}
gateway.networking.k8s.io/gateway-name: {{ include "nemo.gatewayName" . }}
{{- end }}

{{/*
Backend Service references.
*/}}
{{- define "nemo.servicesNamespace" -}}
{{- .Values.servicesNamespace | default "agentstudio-services" }}
{{- end }}

{{- define "nemo.consoleNamespace" -}}
{{- .Values.consoleNamespace | default "agentstudio-console" }}
{{- end }}

{{- define "nemo.platformNamespace" -}}
{{- .Values.platformNamespace | default "agentstudio-platform" }}
{{- end }}

{{- define "nemo.monitoringNamespace" -}}
{{- .Values.monitoringNamespace | default "monitoring" }}
{{- end }}

{{- define "nemo.identityNamespace" -}}
{{- .Values.identityNamespace | default "agentstudio-identity" }}
{{- end }}

{{/*
Keycloak JWT validation rules (jwtRules[] body).

Single source of truth for the providers Istio's jwt_authn filter trusts,
shared by BOTH the edge RequestAuthentication (gateway pod) and the in-mesh
per-hop RequestAuthentication (workload sidecars). Emitting the identical
block in both places is what makes §5.2 of docs/design/agent-studio-security-stack.md
literally true: "Every workload sidecar in the application namespace enforces
the same RequestAuthentication rule as the edge — same issuer, audience, and
JWKS."

Renders the list items at column 0; callers indent with `nindent`, e.g.
  jwtRules:
    {{- include "edge.keycloakJwtRules" . | nindent 4 }}

See request-authn-istio.yaml for the rationale behind the master-realm and
extraJwtRules entries.

SYNC: edge-side rules. The in-mesh per-hop equivalent is rendered by the
istio-mesh-policies chart from `meshJwt.*` (helper istio-mesh-policies.keycloakJwtRules).
They are independent by design; keep them in sync unless divergence is intended.
*/}}
{{- define "edge.keycloakJwtRules" -}}
{{- $ra := .Values.gateway.istio.requestAuthentication -}}
{{- /*
Substitute `agentstudio.local` → `global.endpoint` so the issuer URL
matches the actual token `iss` claim Keycloak mints on this cluster.
Without this, the per-cloud overlays (values-local / -aks / -gke / -eks)
keep the literal `auth.agentstudio.local:8443` in the issuer and any
deploy whose KC_HOSTNAME was rewritten via global.endpoint produces
tokens Istio rejects with "Jwt issuer is not configured" 401 — verified
on sks6316 where the keycloak admin UI was unreachable.
The jwksUri stays untouched: it's an in-cluster Service URL, never
needs the public-endpoint substitution.
*/ -}}
{{- $deployEndpoint := "" -}}
{{- with .Values.global }}{{- with .endpoint }}{{- $deployEndpoint = . }}{{- end }}{{- end -}}
{{- $issuer := $ra.issuer -}}
{{- if and $deployEndpoint (ne $deployEndpoint "agentstudio.local") -}}
{{- $issuer = replace "agentstudio.local" $deployEndpoint $issuer -}}
{{- end -}}
{{- $jwksUri := $ra.jwksUri -}}
{{- $forward := $ra.forwardOriginalToken | default true -}}
- issuer: {{ $issuer | quote }}
  jwksUri: {{ $jwksUri | quote }}
  {{- with $ra.audiences }}
  audiences:
    {{- range . }}
    - {{ . | quote }}
    {{- end }}
  {{- end }}
  forwardOriginalToken: {{ $forward }}
{{- if $ra.includeKeycloakMasterRealm | default true }}
{{- $masterIssuer := regexReplaceAll "/realms/[^/]+$" $issuer "/realms/master" }}
{{- $masterJwks := regexReplaceAll "/realms/[^/]+/" $jwksUri "/realms/master/" }}
- issuer: {{ $masterIssuer | quote }}
  jwksUri: {{ $masterJwks | quote }}
  forwardOriginalToken: {{ $forward }}
{{- end }}
{{- range $ra.extraJwtRules }}
- issuer: {{ .issuer | quote }}
  {{- with .jwksUri }}
  jwksUri: {{ . | quote }}
  {{- end }}
  {{- with .audiences }}
  audiences:
    {{- range . }}
    - {{ . | quote }}
    {{- end }}
  {{- end }}
  forwardOriginalToken: {{ .forwardOriginalToken | default true }}
{{- end }}
{{- end }}
