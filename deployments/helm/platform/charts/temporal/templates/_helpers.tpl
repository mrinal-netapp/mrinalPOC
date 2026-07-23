{{/*
Expand the name of the chart.
*/}}
{{- define "temporal.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "temporal.fullname" -}}
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
{{- define "temporal.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "temporal.labels" -}}
helm.sh/chart: {{ include "temporal.chart" . }}
{{ include "temporal.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "temporal.selectorLabels" -}}
app.kubernetes.io/name: {{ include "temporal.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
component: temporal
{{- end }}

{{/*
UI Selector labels
*/}}
{{- define "temporal.uiSelectorLabels" -}}
app.kubernetes.io/name: {{ include "temporal.name" . }}-ui
app.kubernetes.io/instance: {{ .Release.Name }}
component: temporal-ui
{{- end }}


{{- define "temporal.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "temporal.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}
