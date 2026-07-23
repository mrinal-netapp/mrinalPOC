{{/*
Expand the name of the chart.
*/}}
{{- define "otel-collector.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "otel-collector.fullname" -}}
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
Common labels.
*/}}
{{- define "otel-collector.labels" -}}
helm.sh/chart: {{ include "otel-collector.name" . }}-{{ .Chart.Version | replace "+" "_" }}
{{ include "otel-collector.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "otel-collector.selectorLabels" -}}
app.kubernetes.io/name: {{ include "otel-collector.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Name for the per-node DaemonSet log collector (appends "-logs" to the central
collector name so both can coexist in the same namespace).
*/}}
{{- define "otel-collector.daemonsetName" -}}
{{- printf "%s-logs" (include "otel-collector.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Selector labels for the DaemonSet pods (distinct from the central Deployment
so kube-proxy routes traffic correctly and HPAs/PDBs stay independent).
*/}}
{{- define "otel-collector.daemonsetSelectorLabels" -}}
app.kubernetes.io/name: {{ include "otel-collector.name" . }}-logs
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Fully-qualified image reference, respecting an optional global registry prefix.
When .Values.global.imageRegistry is set (e.g. docker.repo.eng.netapp.com) the
registry is prepended to the repository so the parent chart can redirect all
image pulls to a corporate mirror with a single --set override.
*/}}
{{- define "otel-collector.image" -}}
{{- $registry := "" -}}
{{- with .Values.global -}}{{- $registry = (.imageRegistry | default "") -}}{{- end -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" $registry .Values.image.repository .Values.image.tag -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag -}}
{{- end -}}
{{- end }}

{{/*
imagePullSecrets block (empty when not set, so callers can unconditionally
nindent the output without an extra {{- if }} guard).
*/}}
{{- define "otel-collector.imagePullSecrets" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
{{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}
