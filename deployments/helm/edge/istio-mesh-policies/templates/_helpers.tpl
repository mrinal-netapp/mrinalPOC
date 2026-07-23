{{/*
Expand the name of the chart.
*/}}
{{- define "istio-mesh-policies.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels applied to every resource rendered by this chart.
*/}}
{{- define "istio-mesh-policies.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: agentstudio
{{- end }}

{{- define "istio-mesh-policies.gatewayPortSuffix" -}}
{{- $port := "" -}}
{{- with .Values.global }}{{- with .gatewayHttpsPort }}{{- $port = toString . }}{{- end }}{{- end -}}
{{- if and $port (ne $port "443") }}{{- printf ":%s" $port }}{{- end -}}
{{- end }}

{{- define "istio-mesh-policies.meshJwtIssuer" -}}
{{- $mj := .Values.meshJwt | default dict -}}
{{- if $mj.issuer -}}
{{- $mj.issuer -}}
{{- else -}}
{{- $endpoint := "agentstudio.local" -}}
{{- with .Values.global }}{{- with .endpoint }}{{- $endpoint = . }}{{- end }}{{- end -}}
{{- printf "https://auth.%s%s/realms/nemo" $endpoint (include "istio-mesh-policies.gatewayPortSuffix" .) -}}
{{- end -}}
{{- end }}

{{- define "istio-mesh-policies.meshJwtJwksUri" -}}
{{- $mj := .Values.meshJwt | default dict -}}
{{- $mj.jwksUri | default (printf "http://keycloak.%s.svc.cluster.local:8080/realms/nemo/protocol/openid-connect/certs" ($mj.identityNamespace | default "agentstudio-identity")) -}}
{{- end }}

{{/*
SYNC: mesh-side per-hop rules (from meshJwt.*). The edge gateway equivalent is
edge chart helper `edge.keycloakJwtRules` (from gateway.istio.requestAuthentication.*).
Independent by design; keep in sync unless divergence is intended.
*/}}
{{- define "istio-mesh-policies.keycloakJwtRules" -}}
{{- $mj := .Values.meshJwt | default dict -}}
{{- $issuer := include "istio-mesh-policies.meshJwtIssuer" . -}}
{{- $jwksUri := include "istio-mesh-policies.meshJwtJwksUri" . -}}
{{- $forward := $mj.forwardOriginalToken | default true -}}
- issuer: {{ $issuer | quote }}
  jwksUri: {{ $jwksUri | quote }}
  {{- with $mj.audiences }}
  audiences:
    {{- range . }}
    - {{ . | quote }}
    {{- end }}
  {{- end }}
  forwardOriginalToken: {{ $forward }}
{{- if $mj.includeKeycloakMasterRealm | default true }}
- issuer: {{ regexReplaceAll "/realms/[^/]+$" $issuer "/realms/master" | quote }}
  jwksUri: {{ regexReplaceAll "/realms/[^/]+/" $jwksUri "/realms/master/" | quote }}
  forwardOriginalToken: {{ $forward }}
{{- end }}
{{- range $mj.extraJwtRules }}
- issuer: {{ .issuer | quote }}
  {{- with .jwksUri }}
  jwksUri: {{ . | quote }}
  {{- end }}
  {{- with .audiences }}
  audiences:
    {{- range . }}
    - {{ . | quote }}
    {{- end }}
  {{- end }}
  forwardOriginalToken: {{ .forwardOriginalToken | default true }}
{{- end }}
{{- end }}
