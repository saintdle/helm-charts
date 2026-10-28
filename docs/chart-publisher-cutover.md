# Pac-Man chart publisher operations

The public Helm repository is <https://saintdle.github.io/helm-charts>. This
repository's generated-only tree has no editable Pac-Man chart source or legacy
source publisher. Its generated artifact receiver is the sole chart publisher
and accepts an artifact only when
`PACMAN_CHART_PUBLISHER_AUTHORITY=pacman`. This guide describes that
post-retirement state. It does not approve a merge, release, replay, or
authority change.

## Verified migration reference bundle

The explicitly pinned, verified migration/reference pair is app `0.7.17` and
chart `0.7.20`. This documents one stable reference bundle, not the latest
release. Use the [public Pages index](https://saintdle.github.io/helm-charts/index.yaml)
to find the latest published chart version. For generated releases, verify it
against the immutable chart release record and compatibility lock attached to
that version's GitHub release. The pinned chart `0.7.20` [chart record](https://github.com/saintdle/helm-charts/releases/download/pacman-0.7.20/chart-release-record.json)
and [compatibility lock](https://github.com/saintdle/helm-charts/releases/download/pacman-0.7.20/consumer-compatibility-lock.json)
are direct examples.

The generated chart was built from
[`saintdle/pacman` commit `a405d8d66d63c8d121ed993f55583a6ff634c86d`](https://github.com/saintdle/pacman/commit/a405d8d66d63c8d121ed993f55583a6ff634c86d)
and published from distribution commit
[`1381632438f8f54088996d0cb86bf6f1d16e8602`](https://github.com/saintdle/helm-charts/commit/1381632438f8f54088996d0cb86bf6f1d16e8602)
as the [`pacman-0.7.20` release](https://github.com/saintdle/helm-charts/releases/tag/pacman-0.7.20).
The package SHA-256 is
`07544a4b0d1279d2310a61f065140a2a5c6b12d13ca45017f920188990dd6e58`, the
chart record SHA-256 is
`75698e5320b948caa7411f8f2a4b1b011860248fc2302cfb95441fa39511350c`, and the
compatibility lock SHA-256 is
`c4713869cdabf71cb68818c1abcce36a72d85ff210788ffd6f448b186541337b`. The
published image digest is
`sha256:2a55f4d74bc05dea3ae05912fbdcbe9348f9aafb752902054a7f066cfa112f68`.
The [public Pages index](https://saintdle.github.io/helm-charts/index.yaml)
contains the published chart versions. These identities verify the public
bundle and its history; they do not establish consumer acceptance or a
runtime install result.

## Generated-only publication path

The [Pac-Man source workflow](https://github.com/saintdle/pacman/blob/main/.github/workflows/chart-artifact-source.yml)
accepts a full Pac-Man `main` commit only after its `chart-ci.yml` push run
succeeds. It sends the generated artifact to this repository's
[`chart-artifact-publish.yml`](../.github/workflows/chart-artifact-publish.yml)
receiver, which verifies the package, immutable release identity, chart
record, and compatibility lock before publication. The receiver listens only
for the generated artifact dispatch and runs only when its repository's
`PACMAN_CHART_PUBLISHER_AUTHORITY` value is `pacman`.

Keep exactly one publisher authority selected at a time. The Pac-Man source
workflow and this distribution receiver use the same concurrency group name,
but GitHub concurrency groups are repository-scoped. Before any approved
authority migration, drain runs and queues in both repositories separately.
Snapshot the authority value and public index before making an approved
change.

## Recovery after source retirement

For an interrupted generated publication, first check the selected authority,
immutable release, and exact Pages package and index bytes. Any approved
replay of a published release must rerun the original successful generated
distribution workflow run, preserving its commit and source/package identity.
For chart `0.7.20`, the verified replay was attempt 2 of the original
[distribution run 40652927950](https://github.com/saintdle/helm-charts/actions/runs/40652927950)
at commit
[`1381632438f8f54088996d0cb86bf6f1d16e8602`](https://github.com/saintdle/helm-charts/commit/1381632438f8f54088996d0cb86bf6f1d16e8602).
Do not dispatch against the latest source or rebuild released package bytes.
Compare the immutable releases, package and record assets, tags, and Pages
index before and after; accept a replay only when those public identities are
unchanged. Never relabel source provenance or reuse a version for different
contents.

The retained-source rollback procedure is no longer available in this tree. A
legacy publisher can be selected only after a separately reviewed restoration
change has restored the required chart source and publisher, reconciled them
with the current public chart version axis and package history, and passed its
checks. Review that restored tree first; then drain the source and distribution
workflows and obtain separate approval for an authority change. Keep the
generated receiver disabled before selecting the restored legacy publisher so
exactly one publisher is active. Approve any replay separately and verify the
public artifacts and monotonic consumer state afterward.

## Historical pre-cutover procedure

The steps in this section describe the former source-retained tree. They are
historical context, not instructions for the generated-only tree above. Before
retirement, `charts/pacman`, `chart-release.yml`, and
`pacman-promotion.yml` were present. A merge could trigger legacy publication,
so operators reviewed its publication effect and retained the source and
historical packages. A proposed authority switch required separate approval,
verified token access to Actions variables, an accepted immutable schema-v1
app record, drained publisher runs, and a snapshot of the variable and public
index. The source and distribution repositories also had to be drained
separately because their concurrency groups did not coordinate across repos.

The former source-retained rollback depended on the old chart source and its
version axis. If generated publication advanced that axis, the old procedure
required a reviewed compatibility bridge before returning to the legacy
publisher. Retirement removed that source. Any such recovery now requires the
reviewed restoration described above before legacy authority can be selected.

## Historical audit: app 0.7.16 and chart 0.7.17

This is a historical pair, superseded by the verified migration/reference app
`0.7.17` / chart `0.7.20` pair above. App `0.7.16` was built from
[`saintdle/pacman` commit `13f04d6e6aea62f1d32d57d90e4eff786083c02e`](https://github.com/saintdle/pacman/commit/13f04d6e6aea62f1d32d57d90e4eff786083c02e)
as `docker.io/saintdle/pacman@sha256:592740129bce7530a347146b86647f8b516df3c19105aa4c2fe40b878840fccf`.
The public `pacman-0.7.17` chart source tag resolves to
[`saintdle/helm-charts` commit `1d11684428b2069aef8d4e69c37237b5b3c910a5`](https://github.com/saintdle/helm-charts/commit/1d11684428b2069aef8d4e69c37237b5b3c910a5).
Commit `c24c5267340a58259cf3d7c8f337ace4c19d1d7a` was a migration donor for
a chart copy, not the release source. These releases predate schema-v1 records;
do not create or relabel v1 records or a compatibility lock for them. The
historical [native runtime run](https://github.com/saintdle/pacman-for-k8s/actions/runs/40221882676)
exercised the old image in its owned container runtime. This is evidence for
that historical pair only, not for the current app/chart pair. Preserve the
historical package identity, tags, and Pages index entries.
