{{/*
Expand the name of the chart.
*/}}
{{- define "artifact-service.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "artifact-service.fullname" -}}
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
Common labels
*/}}
{{- define "artifact-service.labels" -}}
helm.sh/chart: {{ include "artifact-service.name" . }}-{{ .Chart.Version | replace "+" "_" }}
{{ include "artifact-service.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "artifact-service.selectorLabels" -}}
app.kubernetes.io/name: {{ include "artifact-service.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
component: artifact-service
{{- end }}

{{/*
Service account name.
When serviceAccount.create=true  → uses .Values.serviceAccount.name if set, otherwise fullname.
When serviceAccount.create=false → uses .Values.serviceAccount.name if set, otherwise "default".
*/}}
{{- define "artifact-service.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "artifact-service.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Artifact service stable name (referenced by config-service via
ARTIFACT_SERVICE_URL and by Bifrost for MCP routing).
*/}}
{{- define "nemo.artifactServiceName" -}}
{{- printf "artifact-service" }}
{{- end }}
