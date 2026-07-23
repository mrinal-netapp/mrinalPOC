{{/*
Expand the name of the chart.
*/}}
{{- define "analytics-engine.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "analytics-engine.fullname" -}}
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
{{- define "analytics-engine.labels" -}}
helm.sh/chart: {{ include "analytics-engine.name" . }}-{{ .Chart.Version | replace "+" "_" }}
{{ include "analytics-engine.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "analytics-engine.selectorLabels" -}}
app.kubernetes.io/name: {{ include "analytics-engine.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
component: analytics-engine
{{- end }}


{{- define "analytics-engine.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "analytics-engine.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}
