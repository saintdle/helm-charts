# helm-charts

Generated Helm chart packages for [saintdle](https://github.com/saintdle)
projects, served at <https://saintdle.github.io/helm-charts>. This repository
keeps the public packages and historical Pages index. The editable Pac-Man
chart source and artifact producer live in
[`saintdle/pacman`](https://github.com/saintdle/pacman); platform installs and
scenarios live in
[`saintdle/pacman-for-k8s`](https://github.com/saintdle/pacman-for-k8s).

This tree is generated-only: it has no editable chart source or legacy
source-publishing workflow. The generated artifact receiver is the sole chart
publisher here. It accepts generated artifacts only when
`PACMAN_CHART_PUBLISHER_AUTHORITY=pacman`. See the
[publisher operations guide](docs/chart-publisher-cutover.md) for recovery and
the history of the cutover.

## Usage

```sh
helm repo add saintdle https://saintdle.github.io/helm-charts
helm repo update
helm search repo saintdle
```

The `pacman` chart supports MongoDB and PostgreSQL backends.

## Verified migration reference

The explicitly pinned, verified migration/reference pair is app `0.7.17` and
chart `0.7.20`. This is a stable reference to one verified public bundle, not
a pointer to the latest release. Use the
[public Pages index](https://saintdle.github.io/helm-charts/index.yaml) to
find the latest published chart version. For generated releases, verify it
against the immutable chart release record and compatibility lock attached to
that version's GitHub release. The pinned chart `0.7.20` record and lock are
[available here](https://github.com/saintdle/helm-charts/releases/download/pacman-0.7.20/chart-release-record.json)
and
[here](https://github.com/saintdle/helm-charts/releases/download/pacman-0.7.20/consumer-compatibility-lock.json).

The generated chart came from
[`saintdle/pacman` commit `a405d8d66d63c8d121ed993f55583a6ff634c86d`](https://github.com/saintdle/pacman/commit/a405d8d66d63c8d121ed993f55583a6ff634c86d)
and is published as the
[`pacman-0.7.20` release](https://github.com/saintdle/helm-charts/releases/tag/pacman-0.7.20).
The package SHA-256 is
`07544a4b0d1279d2310a61f065140a2a5c6b12d13ca45017f920188990dd6e58`; its
chart record SHA-256 is
`75698e5320b948caa7411f8f2a4b1b011860248fc2302cfb95441fa39511350c`, and its
compatibility lock SHA-256 is
`c4713869cdabf71cb68818c1abcce36a72d85ff210788ffd6f448b186541337b`. These
identities describe the public bundle; by themselves they do not establish
consumer acceptance or a runtime install result.

## Distribution and history

The generated receiver validates an exact successful `chart-ci.yml` run for a
full `main` commit in `saintdle/pacman`, then verifies the package, immutable
release identity, chart record, and compatibility lock before publication.
Keep the stable install URL, existing chart tags, releases, package assets,
and Pages entries. Do not edit the `gh-pages` branch by hand; the release
publisher maintains the index and preserves historical entries.

## Workflows

- [`.github/workflows/chart-ci.yml`](.github/workflows/chart-ci.yml) keeps the
  `version-gate` and `manifests` check names and validates generated-only
  ownership, artifact authority, immutable records, retries, and history.
- [`.github/workflows/chart-artifact-publish.yml`](.github/workflows/chart-artifact-publish.yml)
  validates and publishes generated chart artifacts when the generated
  publisher authority is selected.
