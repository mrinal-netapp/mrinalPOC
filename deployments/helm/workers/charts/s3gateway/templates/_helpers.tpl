{{/*
Expand the name of the chart.
*/}}
{{- define "s3gateway.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "s3gateway.fullname" -}}
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
{{- define "s3gateway.labels" -}}
helm.sh/chart: {{ include "s3gateway.name" . }}-{{ .Chart.Version | replace "+" "_" }}
{{ include "s3gateway.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "s3gateway.selectorLabels" -}}
app.kubernetes.io/name: {{ include "s3gateway.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
component: s3gateway
{{- end }}

{{/*
ServiceAccount name resolution — replaced by WI-compatible version below.
*/}}

{{/*
S3Gateway service name
*/}}
{{- define "nemo.s3gatewayServiceName" -}}
{{- printf "s3gateway" }}
{{- end }}

{{/*
S3Gateway credentials secret name
This helper is kept for backward compatibility but should use the parent chart's helper
The parent chart's helper ensures consistency across all subcharts
*/}}
{{- define "nemo.s3gatewayCredentialsName" -}}
{{- printf "%s-s3gateway-credentials" (include "nemo.deploymentName" . | trim) }}
{{- end }}

{{- define "s3gateway.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "s3gateway.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}
