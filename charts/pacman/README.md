# pacman

Pac-Man on Kubernetes, hardened to the Pod Security Standards `restricted`
profile, with a choice of MongoDB or PostgreSQL backend.

App image: [`docker.io/saintdle/pacman`](https://hub.docker.com/r/saintdle/pacman)
(pinned by digest by default).
Source: [`saintdle/pacman`](https://github.com/saintdle/pacman),
deployment surface: [`saintdle/pacman-for-k8s`](https://github.com/saintdle/pacman-for-k8s).

## TL;DR

```bash
helm repo add veducate https://saintdle.github.io/helm-charts/
helm repo update
helm install pacman veducate/pacman \
  --namespace pacman-demo --create-namespace
```

## Switch backend to PostgreSQL

```bash
helm install pacman veducate/pacman \
  --namespace pacman-demo --create-namespace \
  --set database=postgres
```

A schema migration `Job` runs as a Helm `pre-install` / `pre-upgrade` hook
against the postgres `Service` and applies any pending migrations.

## Common overrides

| Key                                | Description                                       | Default                  |
|------------------------------------|---------------------------------------------------|--------------------------|
| `database`                         | `mongo` or `postgres`                             | `mongo`                  |
| `image.repository`                 | Pac-Man image repo                                | `docker.io/saintdle/pacman` |
| `image.tag`                        | Tag override (set to skip the digest)             | `""`                     |
| `image.digest`                     | Image digest (used when `tag` is empty)           | pinned 1.0.0 digest      |
| `replicaCount`                     | Pac-Man pods                                      | `1`                      |
| `service.type`                     | `LoadBalancer`, `NodePort`, `ClusterIP`           | `LoadBalancer`           |
| `service.port`                     | Service port                                      | `80`                     |
| `ingress.enabled`                  | Enable an Ingress                                 | `false`                  |
| `autoscaling.enabled`              | Enable HPA                                        | `false`                  |
| `rbac.create`                      | ClusterRole+CRB for in-app pod/node probe         | `true`                   |
| `serviceAccount.create`            | Dedicated SA for pacman                           | `true`                   |
| `mongo.auth.*`                     | Mongo credentials (root + app user)               | demo values              |
| `mongo.persistence.size`           | Mongo PVC size                                    | `1Gi`                    |
| `mongo.existingSecret`             | Use a pre-created Secret instead                  | `""`                     |
| `mongo.livenessProbe` / `mongo.readinessProbe` | Mongo health probes; `mongosh` needs a generous `timeoutSeconds` | `10s` timeout |
| `postgres.auth.*`                  | Postgres credentials                              | demo values              |
| `postgres.migration.enabled`       | Run `node src/db/migrate.js` as Helm hook         | `true`                   |

The complete list is in [`values.yaml`](values.yaml).

## Workload labels

Every workload is given a distinct identity so observability tools such as
Hubble render them as separate services instead of collapsing every pod under
the chart name. Alongside the standard `app.kubernetes.io/*` labels, each object
carries a short `app` and `role` pair:

| Workload           | `app`             | `role`     |
|--------------------|-------------------|------------|
| Pac-Man            | `pacman-frontend` | `frontend` |
| MongoDB            | `mongodb`         | `database` |
| PostgreSQL         | `postgres`        | `database` |
| Postgres migration | `pacman-migrate`  | `migrate`  |

`app.kubernetes.io/name` matches the `app` value, `app.kubernetes.io/component`
matches the `role` value, and every object shares
`app.kubernetes.io/part-of: pacman` so the whole release can still be selected
together.

## Pod Security Standards `restricted`

Every workload in this chart sets:

- `runAsNonRoot: true`, `runAsUser`, `runAsGroup`, `fsGroup`
- `seccompProfile.type: RuntimeDefault`
- `allowPrivilegeEscalation: false`
- `capabilities.drop: [ALL]`
- `readOnlyRootFilesystem: true` on the Pac-Man container

Apply the namespace labels yourself when you want enforcement to be hard:

```bash
kubectl label ns pacman-demo \
  pod-security.kubernetes.io/enforce=baseline \
  pod-security.kubernetes.io/audit=restricted \
  pod-security.kubernetes.io/warn=restricted \
  --overwrite
```

## Existing secrets

Set `mongo.existingSecret` or `postgres.existingSecret` to use a pre-created
Secret. Expected keys:

- Mongo: `database-admin-name`, `database-admin-password`, `database-name`,
  `database-user`, `database-password`
- Postgres: `username`, `password`, `database`

## Upgrading to 6.1.2

6.1.2 gives each workload a distinct `app.kubernetes.io/name` (previously every
pod shared `pacman`). A Deployment's label selector is immutable, so an
in-place `helm upgrade` from an earlier version is rejected by the API server.
Uninstall and reinstall instead:

```bash
helm uninstall pacman --namespace pacman-demo
helm install pacman veducate/pacman --namespace pacman-demo
```

The Mongo and Postgres PVCs are retained across an uninstall, so high scores
survive the reinstall.

## Uninstall

```bash
helm uninstall pacman --namespace pacman-demo
# Mongo / Postgres PVCs are intentionally left behind so high scores survive
# a reinstall. Delete them explicitly to wipe the data:
kubectl -n pacman-demo delete pvc -l app.kubernetes.io/instance=pacman
```
