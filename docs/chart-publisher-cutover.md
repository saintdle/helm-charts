# Pac-Man chart publisher cutover

The new artifact receiver is dormant when the Actions variable
`PACMAN_CHART_PUBLISHER_AUTHORITY` is unset; the legacy `helm-charts`
publisher remains the sole authority. The variable accepts only `helm-charts`
and `pacman`. The receiver verifies a successful `chart-ci.yml` push run for
the exact Pac-Man main SHA before downloading or publishing anything.

## Expansion and switch

1. Merge the Pac-Man publisher PR and this distribution receiver PR while the
   variable remains unset or `helm-charts`. Verify the candidate and contract
   workflows pass on the merged heads. No Pages, tag, asset, or live workflow
   activation is part of either merge.
2. Confirm the existing cross-repository automation token can read Actions
   variables in `saintdle/helm-charts`. The code probes collection read access
   before interpreting a missing variable as the legacy default. This token
   capability has not been verified by the implementation change.
3. When a separately approved cutover is ready, set the single variable in
   `saintdle/helm-charts` to `pacman`. Its atomic value change disables legacy
   source mutation/publication and enables the generated artifact receiver.
   Both paths use the same non-cancelling Actions concurrency group and check
   the current authority at job start, so queued work runs serially and stale
   or wrong-authority work exits before publication effects.

## Rollback

Set the same variable back to `helm-charts`. This disables the generated
receiver and re-enables the legacy publisher in one value change. The shared
non-cancelling concurrency group drains any already-running job before a
queued publisher proceeds. Reconcile an interrupted event through the normal
idempotent publisher retry after checking the selected authority.

No authority variable was changed during implementation. Public chart names,
the `https://saintdle.github.io/helm-charts` repository, historical index
entries, and existing release tags remain under the existing publication
engine's recovery and immutability checks.
