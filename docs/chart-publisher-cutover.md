# Pac-Man chart publisher cutover

The public Helm repository remains <https://saintdle.github.io/helm-charts>.
While `PACMAN_CHART_PUBLISHER_AUTHORITY` is unset or `helm-charts`, the legacy
publisher in this repository is the sole live publication authority. The
generated receiver accepts only `helm-charts` or `pacman` and remains dormant
until an explicitly approved switch selects `pacman`. This guide describes
prospective rollout gates; it is not live-change approval.

The currently published compatibility pair is app `0.7.16` and chart `0.7.17`.
App `0.7.16` was built from
[`saintdle/pacman` commit `13f04d6e6aea62f1d32d57d90e4eff786083c02e`](https://github.com/saintdle/pacman/commit/13f04d6e6aea62f1d32d57d90e4eff786083c02e)
as `docker.io/saintdle/pacman@sha256:592740129bce7530a347146b86647f8b516df3c19105aa4c2fe40b878840fccf`.
The public `pacman-0.7.17` chart source tag resolves to
[`saintdle/helm-charts` commit `1d11684428b2069aef8d4e69c37237b5b3c910a5`](https://github.com/saintdle/helm-charts/commit/1d11684428b2069aef8d4e69c37237b5b3c910a5).
Commit `c24c5267340a58259cf3d7c8f337ace4c19d1d7a` is a later migration donor
for a chart copy, not the release source. These releases predate schema-v1
records, so do not create or relabel v1 records or a compatibility lock for
them. The missing historical record proofs do not mean the image lacks platform
manifests: the public
[native runtime run](https://github.com/saintdle/pacman-for-k8s/actions/runs/40221882676)
resolved its index to the amd64 child/config and exercised it in the owned
container runtime. Preserve the released package identity, tags, and Pages
index history.

## Expand and prepare

Before each merge, review the exact head and its checks. Refresh approvals and
CI after material changes. A merge to `main` can publish: while
`helm-charts` is authoritative, chart-source changes can trigger the legacy
`chart-release.yml` publisher. Review and explicitly approve the publication
effect of any such merge; do not assume that merging publisher preparation is
publication-free.

Merge the approved publisher preparation in stack order while the authority
remains unset or `helm-charts`, and retain the legacy source plus all historical
packages, tags, releases, and Pages entries. Before proposing a switch, verify
the final `main` workflows and stable checks, the actual cross-repository
token's `Variables:read` capability, and availability of an immutable schema-v1
app record accepted by the generated path. A mocked capability check does not
prove the token has that permission. These conditions do not themselves
approve a merge, release, or authority change.

The legacy `chart-release.yml` workflow publishes chart-source changes. The
app-to-chart `pacman-promotion.yml` workflow supports `reconcile`, `rollback`,
and `resume`; its rollback inputs are `rollback_app_record_ref`,
`rollback_app_record_sha256`, and `rollback_reason`. It can use verified legacy
metadata during compatibility, but those fields do not create a schema-v1
record. Source changes still require a reviewable pull request and normal
approval.

## Switch and verify

Obtain separate explicit live approval tied to the exact final-main identities,
release candidate, rollout conditions, and variable payload
`{"name":"PACMAN_CHART_PUBLISHER_AUTHORITY","value":"pacman"}`. Before
changing authority, drain both the old distribution publisher and Pac-Man
source-publisher runs and queues. Snapshot the current variable and public
`index.yaml` plus release assets. Change only the distribution authority so
exactly one publisher is selected.

Approve any source replay or dispatch separately. The source workflow
[`chart-artifact-source.yml`](https://github.com/saintdle/pacman/blob/main/.github/workflows/chart-artifact-source.yml)
accepts `source_commit` only for a full Pac-Man `main` SHA with a successful
`chart-ci.yml` push run. The receiver
[`chart-artifact-publish.yml`](../.github/workflows/chart-artifact-publish.yml)
verifies the exact package and immutable release identity before publishing.
The two publication workflows in `saintdle/helm-charts`,
`chart-release.yml` and `chart-artifact-publish.yml`, share the non-cancelling
`pacman-chart-publisher` concurrency group and recheck authority when a job
starts. Pac-Man's `chart-artifact-source.yml` uses the same group name in a
different repository; GitHub concurrency groups are repository-scoped, so that
name does not coordinate source and distribution jobs. Drain both repositories'
runs and queues separately before changing authority; queued work must exit
before publication effects under stale authority.

Verify the exact source SHA, package and sidecar checksums, app/chart records
and compatibility lock, release assets, Pages package and updated `index.yaml`,
consumer event, and a public install. Keep the old source and any held
retirement change until that complete public chain and rollback conditions have
been accepted. A merge, workflow run, or rendered candidate alone is not proof
that the generated publication succeeded or that the legacy publisher can be
retired.

## Recovery and rollback

For an interrupted publication, first confirm current authority and inspect the
exact immutable release and Pages bytes. A retry or replay must be separately
approved; reuse only the exact same source and package identity. Never replace
released bytes, relabel source provenance, or reuse a version for different
contents.

A publisher rollback requires separate explicit approval. Drain both source
and distribution work before changing authority, and preserve all generated
packages, records, tags, and history. Revalidate the retained legacy chart
source and its version axis before switching back. If generated publication
has advanced that axis, prepare, review, and approve a compatibility bridge
pull request first; do not assume the retained legacy source is current.

Only with the exact approved legacy source may the authority payload be changed
to `{"name":"PACMAN_CHART_PUBLISHER_AUTHORITY","value":"helm-charts"}`.
This restores one legacy authority; approve any replay separately, then verify
the public artifacts and monotonic consumer state. After source retirement,
rollback requires a separately reviewed restoration plan; the retained-source
procedure is no longer available by assumption.
