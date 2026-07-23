{{/*
Expand the name of the chart.
*/}}
{{- define "processing-workers.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "processing-workers.fullname" -}}
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
{{- define "processing-workers.labels" -}}
helm.sh/chart: {{ include "processing-workers.name" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: nemo
{{- end }}

{{/*
Dataset worker selector labels
*/}}
{{- define "processing-workers.datasetWorker.selectorLabels" -}}
app.kubernetes.io/name: dataset-worker
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
KB worker selector labels
*/}}
{{- define "processing-workers.kbWorker.selectorLabels" -}}
app.kubernetes.io/name: kb-worker
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Connector worker selector labels
*/}}
{{- define "processing-workers.connectorWorker.selectorLabels" -}}
app.kubernetes.io/name: connector-worker
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Eval worker selector labels
*/}}
{{- define "processing-workers.evalWorker.selectorLabels" -}}
app.kubernetes.io/name: eval-worker
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
