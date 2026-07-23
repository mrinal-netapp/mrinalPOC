{{/*
Tier-specific helpers. The "nemo.*" names are preserved so subchart templates
(which call include "nemo.*" .) continue to resolve correctly.
*/}}

{{- define "nemo.namespace" -}}
{{- .Release.Namespace }}
{{- end }}

{{- define "nemo.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

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

{{- define "nemo.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "nemo.labels" -}}
helm.sh/chart: {{ include "nemo.chart" . }}
{{ include "nemo.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "nemo.selectorLabels" -}}
app.kubernetes.io/name: {{ include "nemo.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "nemo.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "nemo.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "nemo.deploymentName" -}}
{{- if .Values.deploymentName }}
{{- .Values.deploymentName }}
{{- else if and .Values.global .Values.global.deploymentName }}
{{- .Values.global.deploymentName }}
{{- else }}
{{- "nemo" }}
{{- end }}
{{- end }}

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

{{- define "nemo.workspaceLabelPrefix" -}}
{{- $prefix := "" }}
{{- if .Values.workspaceLabelPrefix }}
  {{- $prefix = .Values.workspaceLabelPrefix }}
{{- else if and .Values.global .Values.global.workspaceLabelPrefix }}
  {{- $prefix = .Values.global.workspaceLabelPrefix }}
{{- end }}
{{- $prefix | default "ws-" }}
{{- end }}

{{- define "nemo.keycloakHttpBaseUrl" -}}
{{- $keycloakNs := .Values.keycloakNamespace | default "agentstudio-identity" }}
{{- if and .Values.keycloak .Values.keycloak.setup .Values.keycloak.setup.keycloakNamespace }}
  {{- $keycloakNs = .Values.keycloak.setup.keycloakNamespace }}
{{- end }}
{{- printf "http://keycloak.%s.svc.cluster.local:8080" $keycloakNs }}
{{- end }}

{{- define "nemo.keycloakInternalIssuer" -}}
{{- $base := include "nemo.keycloakHttpBaseUrl" . | trimSuffix "/" }}
{{- if and .Values.keycloak .Values.keycloak.setup .Values.keycloak.setup.keycloakUrl }}
  {{- $base = .Values.keycloak.setup.keycloakUrl | trimSuffix "/" }}
{{- end }}
{{- printf "%s/realms/nemo" $base }}
{{- end }}

{{- define "nemo.lakekeeperHttpInternalBase" -}}
{{- $platformNs := .Values.platformNamespace | default "agentstudio-platform" -}}
http://lakekeeper.{{ $platformNs }}.svc.cluster.local:8181
{{- end }}

{{- define "nemo.lakekeeperCatalogRestUrl" -}}
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

{{- define "nemo.s3gatewayCredentialsName" -}}
{{- printf "%s-s3gateway-credentials" (include "nemo.deploymentName" . | trim) }}
{{- end }}

{{- define "nemo.defaultBucketName" -}}
{{- printf "default-%s" (include "nemo.deploymentName" . | trim) }}
{{- end }}

{{- define "nemo.s3gatewayFullname" -}}
{{- $g := "" }}
{{- if and .Values.global .Values.global.s3gatewayFullname }}
{{- $g = .Values.global.s3gatewayFullname | toString | trim }}
{{- end }}
{{- if $g }}
{{- $g | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- "s3gateway" }}
{{- end }}
{{- end }}

{{- define "nemo.defaultBucketPvcName" -}}
{{- printf "%s-default-bucket" (include "nemo.s3gatewayFullname" .) }}
{{- end }}

{{- define "nemo.configServiceClusterURL" -}}
{{- $servicesNs := .Values.servicesNamespace | default "agentstudio-services" }}
{{- printf "http://config-service.%s.svc.cluster.local:3000" $servicesNs }}
{{- end }}

{{/*
Public HTTPS port. Reads global.gatewayHttpsPort (same key as
gui.workspacePublicPort); default 443. Local overrides to 8443.
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
URLs match Keycloak's iss claim (KC_HOSTNAME omits :443 on cloud); explicit
:443 breaks strict-string JWT validators in workflow-engine et al.
*/}}
{{- define "nemo.gatewayPortSuffix" -}}
{{- $port := int (include "nemo.gatewayHttpsPort" .) -}}
{{- if ne $port 443 -}}{{- printf ":%d" $port -}}{{- end -}}
{{- end }}

{{- define "nemo.keycloakIssuer" -}}
{{- printf "https://%s%s/realms/nemo" (include "nemo.authSubdomain" .) (include "nemo.gatewayPortSuffix" .) }}
{{- end }}
