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

## Multi-role (scaled-out) deployment

By default the chart deploys a single all-in-one frontend. Set `roles.enabled=true`
to split it into cooperating **web**, **score**, and **user** roles, each its own
Deployment and Service, so east-west API traffic flows between separate services
(useful for Cilium/Hubble L7 flow demos). The same image runs every role; the
`APP_ROLE` env var selects the behaviour, and the web role is wired to the
backends automatically via `SCORE_SERVICE_URL`/`USER_SERVICE_URL`.

```bash
helm install pacman infra-charts/pacman --set roles.enabled=true
```

An optional load generator (`node tools/simulate-users.js`) drives gameplay
traffic through the frontend Service:

```bash
helm install pacman infra-charts/pacman \
  --set roles.enabled=true \
  --set simulator.enabled=true
```

| Key                        | Description                                    | Default |
|----------------------------|------------------------------------------------|---------|
| `roles.enabled`            | Deploy web/score/user as separate tiers        | `false` |
| `roles.score.replicas`     | Score backend replicas                         | `1`     |
| `roles.user.replicas`      | User backend replicas                          | `1`     |
| `roles.<role>.resources`   | Per-role resources (falls back to `resources`) | `{}`    |
| `simulator.enabled`        | Run the load generator Deployment              | `false` |
| `simulator.replicas`       | Load generator replicas                        | `1`     |
| `simulator.users`          | Concurrent simulated users per replica         | `20`    |
| `simulator.baseUrl`        | Target URL (defaults to the frontend Service)  | `""`    |

Every role reuses the same database backend (`database`), pod securityContext,
and OpenShift handling as the frontend, so no extra wiring is required.

## Workload labels

Every workload is given a distinct identity so observability tools such as
Hubble render them as separate services instead of collapsing every pod under
the chart name. Alongside the standard `app.kubernetes.io/*` labels, each object
carries a short `app` and `role` pair:

| Workload           | `app`             | `role`     |
|--------------------|-------------------|------------|
| Pac-Man            | `pacman-frontend` | `frontend` |
| Score role         | `pacman-score`    | `score`    |
| User role          | `pacman-user`     | `user`     |
| Load simulator     | `pacman-simulator`| `load-generator` |
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

## OpenShift

OpenShift's `restricted-v2` SCC assigns each pod a random UID from the
namespace's pre-allocated range and rejects pods that request a fixed
`runAsUser`, `runAsGroup`, or `fsGroup` outside that range. The fixed IDs this
chart normally sets (Pac-Man and the databases) would otherwise fail admission.

The chart auto-detects OpenShift (it probes for the
`security.openshift.io/v1` API group) and, when detected, drops
`runAsUser`/`runAsGroup`/`fsGroup` from every pod so the SCC can inject its own.
`runAsNonRoot`, `seccompProfile`, dropped capabilities, and
`readOnlyRootFilesystem` are all preserved, so the workloads still satisfy the
`restricted-v2` SCC. No configuration is required:

```bash
helm install pacman infra-charts/pacman
```

Override the detection with `openShift.enabled`:

- `auto` (default) &mdash; probe the API server.
- `true` &mdash; force OpenShift behaviour (useful for `helm template`).
- `false` &mdash; never drop the fixed IDs.

If you would rather keep the chart's fixed UIDs, grant the workloads the
`nonroot-v2` SCC instead by creating a RoleBinding:

```bash
helm install pacman infra-charts/pacman \
  --set openShift.sccRoleBinding.create=true
```

This binds the Pac-Man ServiceAccount (and the namespace `default`
ServiceAccount used by MongoDB/PostgreSQL) to the
`system:openshift:scc:nonroot-v2` ClusterRole and leaves the fixed IDs in place.
Creating SCC RoleBindings requires cluster-admin.

## Existing secrets

Set `mongo.existingSecret` or `postgres.existingSecret` to use a pre-created
Secret. Expected keys:

- Mongo: `database-admin-name`, `database-admin-password`, `database-name`,
  `database-user`, `database-password`
- Postgres: `username`, `password`, `database`

## Upgrading to 0.7.0

0.7.0 gives each workload a distinct `app.kubernetes.io/name` (previously every
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
