# helm-charts

Helm chart repository for [saintdle](https://github.com/saintdle) projects,
served via GitHub Pages at <https://saintdle.github.io/helm-charts>.

This repository owns the public chart distribution and its historical Pages
index. `saintdle/pacman` maintains the app and editable chart source;
`saintdle/pacman-for-k8s` maintains platform installs and scenarios. During the
publisher transition, the legacy source publisher remains the sole live
authority while the setting is unset or `helm-charts`. An approved switch
selects the generated receiver; verify its public output before retiring the
legacy source.

## Usage

```sh
helm repo add saintdle https://saintdle.github.io/helm-charts
helm repo update
helm search repo saintdle
```

Charts:

- [`pacman`](charts/pacman): Pac-Man (Node.js + Express) on Kubernetes with a
  MongoDB or PostgreSQL backend.

## Repository layout

- `charts/pacman/`: legacy chart source used while `helm-charts` is the selected
  publisher. After an approved authority switch, generated packages come from
  the validated source in `saintdle/pacman`.
- `gh-pages` branch: the published Helm repo (`index.yaml` plus packaged `.tgz`
  files). GitHub Pages serves this branch. Do not edit it by hand; the release
  publisher maintains it and preserves historical entries.

The currently published compatibility pair is app `0.7.16` and chart
`0.7.17`. The app image is pinned as
`docker.io/saintdle/pacman@sha256:592740129bce7530a347146b86647f8b516df3c19105aa4c2fe40b878840fccf`
and was built from
[`saintdle/pacman` commit `13f04d6e6aea62f1d32d57d90e4eff786083c02e`](https://github.com/saintdle/pacman/commit/13f04d6e6aea62f1d32d57d90e4eff786083c02e).
It includes the opt-in fault and synthetic security-probe runtime. The public
`pacman-0.7.17` chart source tag resolves to
[`saintdle/helm-charts` commit `1d11684428b2069aef8d4e69c37237b5b3c910a5`](https://github.com/saintdle/helm-charts/commit/1d11684428b2069aef8d4e69c37237b5b3c910a5).
The later `c24c5267340a58259cf3d7c8f337ace4c19d1d7a` commit is a migration
donor for a chart copy, not the published release source. These legacy releases
predate schema-v1 records and have no v1 consumer lock; their record format does
not erase the independently verified runtime evidence in the
[public native run](https://github.com/saintdle/pacman-for-k8s/actions/runs/40221882676).

## Publishing a chart

While `PACMAN_CHART_PUBLISHER_AUTHORITY` is unset or `helm-charts`, the legacy
`chart-release.yml` workflow is the only active publisher. It packages the
chart source on `main`, creates an immutable version release, verifies the
package, and updates the Pages index. To ship a new legacy-source version:

1. Make your chart changes under `charts/<name>/`.
2. Bump `version` in `charts/<name>/Chart.yaml` to a new value.
3. Open a pull request. Two required checks run:
   - **version-gate** fails unless `version` is bumped to a new, unreleased
     value. This is the flag that must be green before the PR can merge.
   - **manifests** lints the chart, posts a rendered-manifest preview (diffed
     against the base branch) as a PR comment, and uploads the full rendered
     manifests for both backends as a downloadable artifact.
4. Review the preview, then merge.

On merge to `main`, the legacy release workflow packages the chart, creates a
`<name>-<version>` GitHub release with the `.tgz` attached, and publishes the
`.tgz` plus a refreshed `index.yaml` to the `gh-pages` branch. The step is
idempotent: a retry verifies or repairs that immutable version and does not
replace it with different bytes.

The generated publisher is a separate prepared path. The Pac-Man
`chart-artifact-source.yml` workflow validates an exact successful
`chart-ci.yml` run for a full Pac-Man `main` commit and packages that source;
this repository's `chart-artifact-publish.yml` verifies the immutable package
and release identity before publishing it to the same Pages index. Both paths
share the non-cancelling `pacman-chart-publisher` concurrency group. The
generated receiver remains dormant until the authority variable is explicitly
set to `pacman`; merging its workflow alone does not activate it. Follow the
[publisher cutover guide](docs/chart-publisher-cutover.md) before changing
authority or retrying a publication.

## Workflows

- [`.github/workflows/chart-ci.yml`](.github/workflows/chart-ci.yml): PR
  validation and manifest preview.
- [`.github/workflows/chart-release.yml`](.github/workflows/chart-release.yml):
  current legacy packaging and publishing on merge while `helm-charts` owns
  publication.
- [`.github/workflows/chart-artifact-publish.yml`](.github/workflows/chart-artifact-publish.yml):
  prepared generated-artifact receiver, dormant until `pacman` is selected.

