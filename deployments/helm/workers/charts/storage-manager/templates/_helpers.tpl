{{/*
Expand the name of the chart.
*/}}
{{- define "storage-manager.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "storage-manager.fullname" -}}
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
{{- define "storage-manager.labels" -}}
helm.sh/chart: {{ include "storage-manager.name" . }}-{{ .Chart.Version | replace "+" "_" }}
{{ include "storage-manager.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "storage-manager.selectorLabels" -}}
app.kubernetes.io/name: {{ include "storage-manager.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
component: storage-manager
{{- end }}

{{/*
Service account name - matches the logic from deployment.yaml
*/}}
{{- define "storage-manager.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "storage-manager.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Storage Manager service name
*/}}
{{- define "nemo.storageManagerServiceName" -}}
{{- printf "storage-manager" }}
{{- end }}

