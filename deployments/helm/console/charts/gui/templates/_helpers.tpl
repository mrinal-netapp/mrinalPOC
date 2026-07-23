{{/*
Expand the name of the chart.
*/}}
{{- define "gui.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "gui.fullname" -}}
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
{{- define "gui.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "gui.labels" -}}
helm.sh/chart: {{ include "gui.chart" . }}
{{ include "gui.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "gui.selectorLabels" -}}
app.kubernetes.io/name: {{ include "gui.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
component: gui
{{- end }}

{{/*
Workspace URL port suffix for the agent-studio-ui's `https://ws-<id>.<endpoint>:<port>/`
runtime URL builder. Reads .Values.workspacePublicPort, else global.gatewayHttpsPort
(default 443). Returns "" when port == 443 (omit-:port rule) so cloud URLs don't
include explicit :443 — matches browser behaviour and downstream strict-compare
consumers (CORS / OAuth allowlists / JWT iss).
*/}}
{{- define "gui.workspacePublicPort" -}}
{{- if and .Values.workspacePublicPort (ne (.Values.workspacePublicPort | toString) "") -}}
{{- .Values.workspacePublicPort | toString -}}
{{- else -}}
{{- $proto := .Values.workspaceSubdomainProtocol | default "https" -}}
{{- $g := .Values.global | default dict -}}
{{- if eq ($proto | lower) "https" -}}
  {{- $port := index $g "gatewayHttpsPort" | default "443" | toString -}}
  {{- if eq $port "443" -}}{{- else -}}{{- $port -}}{{- end -}}
{{- else -}}
  {{- $port := index $g "gatewayHttpPort" | default "80" | toString -}}
  {{- if eq $port "80" -}}{{- else -}}{{- $port -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- end }}


{{- define "gui.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "gui.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}
