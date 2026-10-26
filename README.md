# helm-charts

Helm chart distribution for [saintdle](https://github.com/saintdle) projects,
served at <https://saintdle.github.io/helm-charts>. This repository owns the
public chart packages and their historical Pages index. The app and editable
chart source live in [`saintdle/pacman`](https://github.com/saintdle/pacman);
platform installs and scenarios live in
[`saintdle/pacman-for-k8s`](https://github.com/saintdle/pacman-for-k8s).

The chart-source retirement is a held change. The source and legacy publisher
remain on `main` until a separately approved generated publication passes the
complete public verification gate and this retirement change is approved to
merge. A green pull request alone does not authorize that merge. See the
[publisher cutover guide](docs/chart-publisher-cutover.md).

## Usage

```sh
helm repo add saintdle https://saintdle.github.io/helm-charts
helm repo update
helm search repo saintdle
```

The `pacman` chart supports MongoDB and PostgreSQL backends.

## Distribution and history

The generated receiver validates an exact successful `chart-ci.yml` run for a
full `main` commit in `saintdle/pacman`, then verifies the package, immutable
release identity, chart record, and compatibility lock before publication.
After the separately approved cutover, set
`PACMAN_CHART_PUBLISHER_AUTHORITY=pacman` so the receiver is active. The
retirement change removes editable source and the former source publisher only
after that public chain has been verified.

The public `pacman-0.7.17` chart source tag resolves to
[`saintdle/helm-charts` commit `1d11684428b2069aef8d4e69c37237b5b3c910a5`](https://github.com/saintdle/helm-charts/commit/1d11684428b2069aef8d4e69c37237b5b3c910a5).
The later `c24c5267340a58259cf3d7c8f337ace4c19d1d7a` commit is a migration
donor for a chart copy, not the published release source. Keep existing chart
tags, releases, package assets, Pages entries, and the stable install URL.

GitHub Pages serves the `gh-pages` branch. Do not edit that branch by hand; the
release publisher maintains the index and preserves historical entries.

## Workflows

- [`.github/workflows/chart-ci.yml`](.github/workflows/chart-ci.yml): keeps the
  `version-gate` and `manifests` check names and validates generated-only
  ownership, artifact authority, immutable records, retries, and history.
- [`.github/workflows/chart-artifact-publish.yml`](.github/workflows/chart-artifact-publish.yml):
  validates and publishes generated chart artifacts after the separately
  approved authority switch.
