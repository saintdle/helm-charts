# helm-charts

Helm chart repository for [saintdle](https://github.com/saintdle) projects,
served via GitHub Pages at <https://saintdle.github.io/helm-charts>.

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

- `charts/<name>/`: chart sources (the only thing you edit).
- `gh-pages` branch: the published Helm repo (`index.yaml` plus packaged `.tgz`
  files). GitHub Pages serves this branch. Do not edit it by hand; the release
  workflow maintains it.

## Releasing a chart

Publishing is automated. To ship a new version:

1. Make your chart changes under `charts/<name>/`.
2. Bump `version` in `charts/<name>/Chart.yaml` to a new value.
3. Open a pull request. Two required checks run:
   - **version-gate** fails unless `version` is bumped to a new, unreleased
     value. This is the flag that must be green before the PR can merge.
   - **manifests** lints the chart, posts a rendered-manifest preview (diffed
     against the base branch) as a PR comment, and uploads the full rendered
     manifests for both backends as a downloadable artifact.
4. Review the preview, then merge.

On merge to `main`, the release workflow packages the chart, creates a
`<name>-<version>` GitHub release with the `.tgz` attached, and publishes the
`.tgz` plus a refreshed `index.yaml` to the `gh-pages` branch. The step is
idempotent, so nothing happens if that version is already released.

## Workflows

- [`.github/workflows/chart-ci.yml`](.github/workflows/chart-ci.yml): PR
  validation and manifest preview.
- [`.github/workflows/chart-release.yml`](.github/workflows/chart-release.yml):
  packaging and publishing on merge.

