# Pac-Man chart publisher cutover

The public Helm repository remains
<https://saintdle.github.io/helm-charts>. During expansion, the Actions
variable `PACMAN_CHART_PUBLISHER_AUTHORITY` is unset or `helm-charts`, so the
legacy publisher in this repository is the sole live publication authority.
The generated receiver accepts only `helm-charts` or `pacman` and is dormant
until an approved switch selects `pacman`.

The current published compatibility pair is app `0.7.16` and chart `0.7.17`.
App `0.7.16` was built from
[`saintdle/pacman` commit `13f04d6e6aea62f1d32d57d90e4eff786083c02e`](https://github.com/saintdle/pacman/commit/13f04d6e6aea62f1d32d57d90e4eff786083c02e)
as `docker.io/saintdle/pacman@sha256:592740129bce7530a347146b86647f8b516df3c19105aa4c2fe40b878840fccf`.
Chart `0.7.17` uses source from
[`saintdle/helm-charts` commit `c24c5267340a58259cf3d7c8f337ace4c19d1d7a`](https://github.com/saintdle/helm-charts/tree/c24c5267340a58259cf3d7c8f337ace4c19d1d7a/charts/pacman).
These releases predate schema-v1 records, so do not create or relabel a v1
record or compatibility lock for them. The legacy format's missing v1 proofs
do not mean platform manifests are absent: the public
[native runtime run](https://github.com/saintdle/pacman-for-k8s/actions/runs/40221882676)
resolved the image index to its amd64 child/config and exercised it in the
owned container runtime. Preserve the existing package tags and Pages index
history.

## Expand

Merge and validate the Pac-Man source publisher and this generated receiver
while the authority remains unset or `helm-charts`. This prepares both paths
without publishing a package or changing the public index. Confirm the
cross-repository automation token can read Actions variables before interpreting
a missing variable as the legacy default; the publisher checks this access.

At this stage, the legacy `chart-release.yml` workflow on chart-source changes
and `pacman-promotion.yml` for app-to-chart reconciliation remain authoritative.
The latter's `workflow_dispatch` modes are `reconcile`, `rollback`, and
`resume`; rollback takes `rollback_app_record_ref`,
`rollback_app_record_sha256`, and `rollback_reason`. Its rollback input may
identify an immutable app record or a verified legacy metadata asset. Source
updates are proposed as pull requests and still require normal review and
merge. Replaying a chart publication is safe only after confirming its
immutable release metadata and current publisher authority.

## Switch and verify

Set `PACMAN_CHART_PUBLISHER_AUTHORITY` in `saintdle/helm-charts` to `pacman`
only after the generated path is ready and the separately approved cutover is
authorized. This disables the legacy source publisher and enables the
generated receiver. The source workflow
[`chart-artifact-source.yml`](https://github.com/saintdle/pacman/blob/main/.github/workflows/chart-artifact-source.yml)
accepts a `source_commit` workflow-dispatch input only for a full Pac-Man
`main` SHA with a successful `chart-ci.yml` push run. The receiver
[`chart-artifact-publish.yml`](../.github/workflows/chart-artifact-publish.yml)
verifies that exact package and its immutable identity before publishing.

Both publication workflows use the non-cancelling
`pacman-chart-publisher` concurrency group and recheck authority when a job
starts. Let an active publication finish before changing authority; queued
work serializes behind it and exits before publication effects if its selected
authority is stale. A successful merge or rendered chart alone does not prove
the cutover. Verify the generated chart release assets and checksums, the
package served from Pages, and the updated `index.yaml` together. Treat the
legacy publisher as retired only after that complete public chain is verified.

## Recovery and rollback

For a failed legacy publication, verify that `helm-charts` remains authoritative
and rerun the failed `chart-release.yml` attempt. Its publication step verifies
and repairs missing public assets for the immutable version; it will not
overwrite an existing version with different bytes. For a failed generated
publication, first verify `pacman` remains authoritative and inspect whether
the version already reached the release assets and Pages. Then retry the
Pac-Man `chart-artifact-source.yml` workflow with the same `source_commit`;
the exact-source and immutable-package checks decide whether publication can
resume safely. Do not reuse a released version for different source bytes.

To roll publisher authority back, wait for any active publication to finish,
then set the same variable to `helm-charts`. This disables the generated
receiver and restores the legacy publisher as the sole authority. Confirm the
selected value before reconciling any pending event. The public repository URL,
chart names, release tags, and historical index entries remain the same across
the switch.
