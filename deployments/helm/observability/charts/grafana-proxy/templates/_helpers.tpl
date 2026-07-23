{{/*
Expand the name of the chart.
*/}}
{{- define "grafana-proxy.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "grafana-proxy.fullname" -}}
{{- default "grafana-proxy" .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "grafana-proxy.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
app.kubernetes.io/name: {{ include "grafana-proxy.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "grafana-proxy.selectorLabels" -}}
app.kubernetes.io/name: {{ include "grafana-proxy.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Name of the K8s Secret holding the Keycloak client secret.
Uses existingSecret when set, otherwise defaults to the chart-rendered secret.
*/}}
{{- define "grafana-proxy.keycloakSecretName" -}}
{{- if .Values.keycloak.existingSecret -}}
{{ .Values.keycloak.existingSecret }}
{{- else -}}
{{ include "grafana-proxy.fullname" . }}-keycloak
{{- end }}
{{- end }}

{{/*
Name of the K8s Secret holding the session keys.
*/}}
{{- define "grafana-proxy.sessionSecretName" -}}
{{- if .Values.session.existingSecret -}}
{{ .Values.session.existingSecret }}
{{- else -}}
{{ include "grafana-proxy.fullname" . }}-session
{{- end }}
{{- end }}

{{/*
Name of the K8s Secret holding the internal token shared with prometheus-proxy.
*/}}
{{- define "grafana-proxy.internalTokenSecretName" -}}
{{- if .Values.internalToken.existingSecret -}}
{{ .Values.internalToken.existingSecret }}
{{- else -}}
{{ include "grafana-proxy.fullname" . }}-internal
{{- end }}
{{- end }}

{{/*
Redirect URI derived from the configured hostname.
If redirectURIPort is set (e.g. "8443"), it is appended as :<port>.
*/}}
{{- define "grafana-proxy.redirectURI" -}}
{{- if .Values.redirectURIPort -}}
https://{{ .Values.hostname }}:{{ .Values.redirectURIPort }}/oauth2/callback
{{- else -}}
https://{{ .Values.hostname }}/oauth2/callback
{{- end -}}
{{- end }}
