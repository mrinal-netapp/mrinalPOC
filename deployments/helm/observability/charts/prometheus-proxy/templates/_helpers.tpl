{{/*
Expand the name of the chart.
*/}}
{{- define "prometheus-proxy.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "prometheus-proxy.fullname" -}}
{{- default "prometheus-proxy" .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "prometheus-proxy.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
app.kubernetes.io/name: {{ include "prometheus-proxy.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "prometheus-proxy.selectorLabels" -}}
app.kubernetes.io/name: {{ include "prometheus-proxy.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Name of the K8s Secret holding the internal token.
Uses existingSecret when set; otherwise the chart renders its own secret.
*/}}
{{- define "prometheus-proxy.internalTokenSecretName" -}}
{{- if .Values.internalToken.existingSecret -}}
{{ .Values.internalToken.existingSecret }}
{{- else -}}
{{ include "prometheus-proxy.fullname" . }}-internal
{{- end }}
{{- end }}
