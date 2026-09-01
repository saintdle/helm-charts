{{/*
Common helpers
*/}}

{{- define "pacman.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "pacman.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "pacman.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels shared by every rendered object, independent of which
workload/component they belong to. Call with the root context.
*/}}
{{- define "pacman.commonLabels" -}}
helm.sh/chart: {{ include "pacman.chart" . }}
app.kubernetes.io/part-of: pacman
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
{{- end -}}

{{/*
Full label set for a single workload/component.

Each workload is given a distinct identity so observability tools such as
Hubble render them as separate services instead of collapsing every pod
under the chart name. Call with a dict:

  (dict "root" $ "name" "mongodb" "role" "database")

  - name: value for app.kubernetes.io/name and the app label.
  - role: value for app.kubernetes.io/component and the role label.
*/}}
{{- define "pacman.labels" -}}
{{ include "pacman.commonLabels" .root }}
{{ include "pacman.selectorLabels" . }}
app: {{ .name }}
role: {{ .role }}
{{- end -}}

{{/*
Immutable selector labels for a single workload/component. Limited to the
stable identity keys (name, instance, component).
*/}}
{{- define "pacman.selectorLabels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .role }}
{{- end -}}

{{/*
Per-workload label helpers. These centralise the app name and role for each
component so the identity is defined in exactly one place. Call with the
root context, e.g. {{ include "pacman.frontend.labels" $ }}.
*/}}
{{- define "pacman.frontend.labels" -}}
{{ include "pacman.labels" (dict "root" . "name" "pacman-frontend" "role" "frontend") }}
{{- end -}}
{{- define "pacman.frontend.selectorLabels" -}}
{{ include "pacman.selectorLabels" (dict "root" . "name" "pacman-frontend" "role" "frontend") }}
{{- end -}}

{{- define "pacman.mongo.labels" -}}
{{ include "pacman.labels" (dict "root" . "name" "mongodb" "role" "database") }}
{{- end -}}
{{- define "pacman.mongo.selectorLabels" -}}
{{ include "pacman.selectorLabels" (dict "root" . "name" "mongodb" "role" "database") }}
{{- end -}}

{{- define "pacman.postgres.labels" -}}
{{ include "pacman.labels" (dict "root" . "name" "postgres" "role" "database") }}
{{- end -}}
{{- define "pacman.postgres.selectorLabels" -}}
{{ include "pacman.selectorLabels" (dict "root" . "name" "postgres" "role" "database") }}
{{- end -}}

{{- define "pacman.migrate.labels" -}}
{{ include "pacman.labels" (dict "root" . "name" "pacman-migrate" "role" "migrate") }}
{{- end -}}

{{- define "pacman.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "pacman.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* Pacman container image reference. Uses digest unless tag is set. */}}
{{- define "pacman.image" -}}
{{- if .Values.image.tag -}}
{{ .Values.image.repository }}:{{ .Values.image.tag }}
{{- else if .Values.image.digest -}}
{{ .Values.image.repository }}@{{ .Values.image.digest }}
{{- else -}}
{{ .Values.image.repository }}:latest
{{- end -}}
{{- end -}}

{{- define "pacman.mongo.fullname" -}}
{{- printf "%s-mongo" (include "pacman.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "pacman.postgres.fullname" -}}
{{- printf "%s-postgres" (include "pacman.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "pacman.mongo.secretName" -}}
{{- if .Values.mongo.existingSecret -}}
{{ .Values.mongo.existingSecret }}
{{- else -}}
{{ include "pacman.mongo.fullname" . }}
{{- end -}}
{{- end -}}

{{- define "pacman.postgres.secretName" -}}
{{- if .Values.postgres.existingSecret -}}
{{ .Values.postgres.existingSecret }}
{{- else -}}
{{ include "pacman.postgres.fullname" . }}
{{- end -}}
{{- end -}}

{{/*
Whether the target cluster is OpenShift. Returns a non-empty string ("true")
when so. .Values.openShift.enabled may be true, false, or "auto" (in which case
the security.openshift.io/v1 API group is probed). Call with the root context.
*/}}
{{- define "pacman.isOpenShift" -}}
{{- $mode := toString (.Values.openShift).enabled -}}
{{- if eq $mode "true" -}}
true
{{- else if eq $mode "false" -}}
{{- else if .Capabilities.APIVersions.Has "security.openshift.io/v1" -}}
true
{{- end -}}
{{- end -}}

{{/*
Whether to drop the fixed runAsUser/runAsGroup/fsGroup so OpenShift's SCC can
inject them. True on OpenShift unless the user opts to keep them via a
nonroot-v2 RoleBinding. Call with the root context.
*/}}
{{- define "pacman.dropFixedIDs" -}}
{{- if and (include "pacman.isOpenShift" .) (not (.Values.openShift).sccRoleBinding.create) -}}
true
{{- end -}}
{{- end -}}

{{/*
Render a pod-level securityContext, stripping runAsUser/runAsGroup/fsGroup when
running on OpenShift (see pacman.dropFixedIDs). Call with:
  (dict "root" $ "ctx" <securityContext map>)
*/}}
{{- define "pacman.podSecurityContext" -}}
{{- $ctx := deepCopy .ctx -}}
{{- if include "pacman.dropFixedIDs" .root -}}
{{- $_ := unset $ctx "runAsUser" -}}
{{- $_ := unset $ctx "runAsGroup" -}}
{{- $_ := unset $ctx "fsGroup" -}}
{{- end -}}
{{- toYaml $ctx -}}
{{- end -}}

{{- define "pacman.validate" -}}
{{- $db := .Values.database -}}
{{- if not (or (eq $db "mongo") (eq $db "postgres")) -}}
{{- fail (printf ".Values.database must be 'mongo' or 'postgres', got %q" $db) -}}
{{- end -}}
{{- end -}}
