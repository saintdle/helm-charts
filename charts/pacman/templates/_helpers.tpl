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

{{- define "pacman.labels" -}}
helm.sh/chart: {{ include "pacman.chart" . }}
{{ include "pacman.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: pacman
{{- end -}}

{{- define "pacman.selectorLabels" -}}
app.kubernetes.io/name: {{ include "pacman.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
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

{{- define "pacman.validate" -}}
{{- $db := .Values.database -}}
{{- if not (or (eq $db "mongo") (eq $db "postgres")) -}}
{{- fail (printf ".Values.database must be 'mongo' or 'postgres', got %q" $db) -}}
{{- end -}}
{{- end -}}
