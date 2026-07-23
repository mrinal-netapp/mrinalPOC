{{/*
Expand the name of the chart.
*/}}
{{- define "keycloak.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Public Keycloak hostname URL (used for KC_HOSTNAME).

Substitution semantics — mirror what agent-studio-realm.json does for
client redirectUris so the entire chart agrees on one endpoint:

  global.endpoint unset (or == "agentstudio.local")
    → use keycloak.hostname verbatim (typically the kind-dev value
      `https://auth.agentstudio.local:8443`).

  global.endpoint set (e.g. "sks6316.sks.rtp.openeng.netapp.com")
    → replace the literal `agentstudio.local` with the deploy endpoint,
      PRESERVING the port. The `:8443` in values-local.yaml is the
      kind-cluster host port; some real-endpoint deploys (this one
      included) keep that port on the LB rather than terminating on
      standard 443. Cross-chart helpers (services/_helpers.tpl
      `nemo.keycloakIssuer`) hardcode `:8443` in the expected issuer
      URL, so KC_HOSTNAME must keep `:8443` for token `iss` claims to
      line up — otherwise JWT validation fails with 401 on every API
      call.

If a deploy actually does TLS on standard 443 (no port suffix), set
keycloak.hostname explicitly via --set, e.g.
  --set keycloak.hostname=https://auth.<host>
and override the issuer helper consumers similarly (this is the
AKS/EKS path; those overlays already pin keycloak.hostname directly).
*/}}
{{- define "keycloak.publicKcHostname" -}}
{{- $h := .Values.keycloak.hostname | default "" -}}
{{- $deployEndpoint := "" -}}
{{- with .Values.global }}{{- with .endpoint }}{{- $deployEndpoint = . }}{{- end }}{{- end -}}
{{- if and $deployEndpoint (ne $deployEndpoint "agentstudio.local") -}}
  {{- $h = replace "agentstudio.local" $deployEndpoint $h -}}
{{- end -}}
{{- $h -}}
{{- end }}

{{/*
HTTPRoute hostnames list with the same endpoint substitution applied.
Returns a YAML list. Empty if httpRoute.hostnames is unset.
*/}}
{{- define "keycloak.publicHttpRouteHostnames" -}}
{{- $deployEndpoint := "" -}}
{{- with .Values.global }}{{- with .endpoint }}{{- $deployEndpoint = . }}{{- end }}{{- end -}}
{{- $hostnames := .Values.httpRoute.hostnames | default list -}}
{{- $result := list -}}
{{- if and $deployEndpoint (ne $deployEndpoint "agentstudio.local") -}}
  {{- range $h := $hostnames -}}
    {{- $result = append $result (replace "agentstudio.local" $deployEndpoint $h) -}}
  {{- end -}}
{{- else -}}
  {{- $result = $hostnames -}}
{{- end -}}
{{- $result | uniq | toYaml -}}
{{- end }}

{{/*
Create a default fully qualified app name. Truncated at 63 chars per the
DNS naming spec. With `fullnameOverride: keycloak` (the chart default),
this resolves to `keycloak` regardless of release name, which keeps
in-cluster Service DNS predictable: `keycloak.<namespace>.svc.cluster.local`.
*/}}
{{- define "keycloak.fullname" -}}
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
Chart label.
*/}}
{{- define "keycloak.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels (Keycloak server pods).
*/}}
{{- define "keycloak.labels" -}}
helm.sh/chart: {{ include "keycloak.chart" . }}
{{ include "keycloak.selectorLabels" . }}
app.kubernetes.io/version: {{ coalesce (get (.Values.global | default dict) "imageTag") .Values.image.tag .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels (Keycloak server pods).
*/}}
{{- define "keycloak.selectorLabels" -}}
app.kubernetes.io/name: {{ include "keycloak.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
ServiceAccount name (used by Keycloak pods + bootstrap Job).
*/}}
{{- define "keycloak.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "keycloak.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Keycloak container image. Honors global.imageRegistry and global.imageTag
overrides so an enclosing umbrella chart can pin a single tag fleet-wide
without per-subchart edits.
*/}}
{{- define "keycloak.image" -}}
{{- $g := .Values.global | default dict -}}
{{- $tag := coalesce $g.imageTag .Values.image.tag | toString -}}
{{- if $g.imageRegistry }}
{{- printf "%s/%s:%s" $g.imageRegistry .Values.image.repository $tag }}
{{- else }}
{{- printf "%s:%s" .Values.image.repository $tag }}
{{- end }}
{{- end }}

{{/*
imagePullSecrets block emitter. Yields the full `imagePullSecrets:` key
(or nothing) so call sites can `{{- include "keycloak.imagePullSecrets" . | nindent N }}`
without conditionals at the call site.
*/}}
{{- define "keycloak.imagePullSecrets" -}}
{{- $g := .Values.global | default dict -}}
{{- with $g.imagePullSecrets }}
imagePullSecrets:
{{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{/* ----------------------------------------------------------------- */}}
{{/* PostgreSQL backing-store helpers (shared PostgreSQL only)         */}}
{{/* ----------------------------------------------------------------- */}}

{{/*
keycloak.postgres.secretName -- name of the K8s Secret holding the
Postgres credentials Keycloak should use. When postgres.auth.existingSecret
is set we reference it as-is; otherwise we fall back to a chart-rendered
Secret named `<fullname>-postgres-auth`.
*/}}
{{- define "keycloak.postgres.secretName" -}}
{{- if .Values.postgres.auth.existingSecret }}
{{- .Values.postgres.auth.existingSecret }}
{{- else }}
{{- printf "%s-postgres-auth" (include "keycloak.fullname" .) }}
{{- end }}
{{- end }}

{{/*
keycloak.postgres.host -- FQDN of the Postgres server Keycloak talks to.
Always external in this chart (shared PostgreSQL in the `database`
namespace by default). Required so a missing value fails at render time
with an actionable message rather than at pod start with a JDBC error.
*/}}
{{- define "keycloak.postgres.host" -}}
{{- required "postgres.host is required (the FQDN of the PostgreSQL server Keycloak should connect to, e.g. shared-postgresql.database.svc.cluster.local)" .Values.postgres.host -}}
{{- end }}

{{- define "keycloak.postgres.port" -}}
{{- .Values.postgres.port | default 5432 -}}
{{- end }}

{{- define "keycloak.postgres.database" -}}
{{- .Values.postgres.database | default "keycloak" -}}
{{- end }}

{{/*
Bootstrap-admin secret name. Used by the StatefulSet env for
KC_BOOTSTRAP_ADMIN_USERNAME / KC_BOOTSTRAP_ADMIN_PASSWORD.
*/}}
{{- define "keycloak.bootstrapAdminSecretName" -}}
{{- if .Values.keycloak.bootstrapAdmin.existingSecret }}
{{- .Values.keycloak.bootstrapAdmin.existingSecret }}
{{- else }}
{{- printf "%s-bootstrap-admin" (include "keycloak.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Entra broker secret name. Used by the realm-bootstrap Job env for
KC_ENTRA_CLIENT_SECRET. Same resolution shape as bootstrapAdminSecretName.
*/}}
{{- define "keycloak.brokerSecretName" -}}
{{- if .Values.realmBootstrap.broker.existingSecret }}
{{- .Values.realmBootstrap.broker.existingSecret }}
{{- else }}
{{- printf "%s-broker-entra" (include "keycloak.fullname" .) }}
{{- end }}
{{- end }}

{{/*
keycloak.additionalClient.secretName -- resolves the K8s Secret name an
additional-client (kind != public-spa) sources its client secret from.

Same shape as the svc-* helpers: pre-existing operator-supplied Secret
wins, otherwise we fall back to a chart-rendered Secret named
`<fullname>-addl-<sanitised-client-name>`.

Usage: {{ include "keycloak.additionalClient.secretName" (dict "ctx" $ "client" $entry) }}
*/}}
{{- define "keycloak.additionalClient.secretName" -}}
{{- $ctx := .ctx -}}
{{- $client := .client -}}
{{- if $client.existingSecret -}}
{{- $client.existingSecret -}}
{{- else -}}
{{- $sanitised := $client.name | replace "_" "-" | replace "." "-" -}}
{{- printf "%s-addl-%s" (include "keycloak.fullname" $ctx) $sanitised | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end }}

{{/*
JAVA_OPTS_APPEND for the Keycloak container. JGroups DNS is only needed for
distributed Infinispan (cache=ispn); local dev uses cache=local and a smaller heap.
*/}}
{{- define "keycloak.javaOptsAppend" -}}
{{- $extra := .Values.keycloak.javaOptsAppend | default "" -}}
{{- if eq .Values.keycloak.cache "ispn" -}}
{{- $jgroups := printf "-Djgroups.dns.query=%s-headless.%s.svc.cluster.local" (include "keycloak.fullname" .) .Release.Namespace -}}
{{- if $extra -}}
{{- printf "%s %s" $jgroups $extra -}}
{{- else -}}
{{- $jgroups -}}
{{- end -}}
{{- else -}}
{{- $extra -}}
{{- end -}}
{{- end }}
