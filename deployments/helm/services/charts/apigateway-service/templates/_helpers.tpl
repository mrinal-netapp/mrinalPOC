{{/*
Expand the name of the chart.
*/}}
{{- define "apigateway-service.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "apigateway-service.fullname" -}}
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
{{- define "apigateway-service.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "apigateway-service.labels" -}}
helm.sh/chart: {{ include "apigateway-service.chart" . }}
{{ include "apigateway-service.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "apigateway-service.selectorLabels" -}}
app.kubernetes.io/name: {{ include "apigateway-service.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
component: apigateway-service
{{- end }}

{{/*
S3Gateway credentials secret name (matches s3gateway chart logic)
Computes based on release name to ensure consistency across sub-charts.
This matches the logic in nemo.fullname helper from parent chart.
*/}}
{{- define "nemo.s3gatewayCredentialsName" -}}
{{- printf "%s-s3gateway-credentials" (include "nemo.deploymentName" . | trim) }}
{{- end }}




{{- define "apigateway-service.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "apigateway-service.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}
