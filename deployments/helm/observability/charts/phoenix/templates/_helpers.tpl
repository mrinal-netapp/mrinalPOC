{{- define "phoenix.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "phoenix.fullname" -}}
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

{{- define "phoenix.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "phoenix.labels" -}}
helm.sh/chart: {{ include "phoenix.chart" . }}
{{ include "phoenix.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "phoenix.selectorLabels" -}}
app.kubernetes.io/name: {{ include "phoenix.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Fully-qualified image reference, respecting an optional global registry prefix.
Set .Values.global.imageRegistry in the parent chart to redirect all pulls to
a corporate mirror (e.g. docker.repo.eng.netapp.com).
*/}}
{{- define "phoenix.image" -}}
{{- $registry := "" -}}
{{- with .Values.global -}}{{- $registry = (.imageRegistry | default "") -}}{{- end -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" $registry .Values.image.repository .Values.image.tag -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag -}}
{{- end -}}
{{- end }}

{{/*
Render Phoenix environment variables (shared between the main container and
the migration-guard init container so both see identical DB connection config).
*/}}
{{- define "phoenix.env" -}}
{{- $backend := .Values.database.backend | default "sqlite" }}
{{- $mount := .Values.persistence.mountPath | default "/data" }}
{{- $computedPg := printf "postgresql://%s:%s@%s:%v/%s" .Values.database.user .Values.database.password .Values.database.host (.Values.database.port | int) .Values.database.name }}
{{- $computedSqlite := printf "sqlite:///%s/phoenix.db" $mount }}
{{- range .Values.env }}
{{- if eq .name "PHOENIX_SQL_DATABASE_URL" }}
- name: PHOENIX_SQL_DATABASE_URL
  {{- if .value }}
  value: {{ .value | quote }}
  {{- else if eq $backend "postgresql" }}
  value: {{ $computedPg | quote }}
  {{- else }}
  value: {{ $computedSqlite | quote }}
  {{- end }}
{{- else }}
- name: {{ .name }}
  {{- if .value }}
  value: {{ .value | quote }}
  {{- else if .valueFrom }}
  valueFrom:
    {{- toYaml .valueFrom | nindent 4 }}
  {{- end }}
{{- end }}
{{- end }}
{{- end }}
