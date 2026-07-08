<!--
This repository publishes charts automatically. Do NOT package the chart, edit
index.yaml, create tags, or upload .tgz files by hand. The release workflow does
all of that when this PR merges. Just bump the version and describe the change.
-->

**Chart:** `pacman`
**New version:** `x.y.z` <!-- e.g. 0.7.1. Must match charts/pacman/Chart.yaml -->

## What changed

<!-- Briefly describe the change and its impact on users of the chart. -->

## Release checklist

- [ ] Bumped `version` in `charts/pacman/Chart.yaml` to the **New version** above.
- [ ] Version follows semver: patch for fixes, minor for features or any breaking
      selector/label change while on `0.x`.
- [ ] Updated `appVersion` only if the application image changed (otherwise leave it).
- [ ] Updated the chart `README.md` (and its "Upgrading" note) if behaviour changed.
- [ ] Reviewed the **manifests** preview comment / artifact on this PR.
- [ ] The `version-gate` and `manifests` checks are green.

## Happens automatically on merge (nothing to do by hand)

1. Packages the chart and creates the `pacman-<version>` GitHub release with the `.tgz`.
2. Publishes the `.tgz` and a refreshed `index.yaml` to the `gh-pages` branch, which
   GitHub Pages serves as the Helm repository.
