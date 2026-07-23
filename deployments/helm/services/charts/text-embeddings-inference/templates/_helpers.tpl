{{- define "tei.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "tei.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "tei.modelFullname" -}}
{{- printf "tei-%s" .modelKey | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "tei.commonLabels" -}}
helm.sh/chart: {{ include "tei.chart" .root }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- if .root.Chart.AppVersion }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
{{- end }}
{{- end }}

{{- define "tei.selectorLabels" -}}
app.kubernetes.io/name: {{ include "tei.name" .root }}
app.kubernetes.io/component: {{ include "tei.modelFullname" . }}
component: tei
model-key: {{ .modelKey | quote }}
{{- end }}
