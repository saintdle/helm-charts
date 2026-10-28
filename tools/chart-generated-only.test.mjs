import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const path = (relative) => new URL(relative, root);

test('generated-only distribution rejects the retired source and publisher inputs', () => {
  for (const relative of [
    'charts/pacman',
    '.github/workflows/chart-release.yml',
    '.github/workflows/pacman-promotion.yml',
    'pacman-promotion-state.json',
    'tools/check-pacman-fault-demo.sh',
    'tools/check-pacman-optional-resources.sh',
    'tools/check-pacman-postgres-migration.sh',
    'tools/check-pacman-probes.sh',
    'tools/check-pacman-lifecycle.sh',
    'tools/chart-ci.test.mjs',
    'tools/pacman-promotion.mjs',
    'tools/pacman-promotion.test.mjs',
    'tools/resolve-pacman-chart-version.mjs',
  ]) {
    assert.equal(existsSync(path(relative)), false, `${relative} must stay retired`);
  }
});

test('the generated receiver is the only chart publisher and accepts only generated authority', () => {
  const receiver = readFileSync(path('.github/workflows/chart-artifact-publish.yml'), 'utf8');
  const authority = readFileSync(path('tools/chart-authority.mjs'), 'utf8');

  assert.match(receiver, /repository_dispatch:\s*\n\s+types:\s*\[pacman-chart-artifact\]/);
  assert.doesNotMatch(receiver, /workflow_dispatch:|push:|pull_request:/);
  assert.match(receiver, /node tools\/chart-authority\.mjs pacman/);
  assert.doesNotMatch(authority, /helm-charts|legacyEnabled/);
});

test('stable required checks run generated publisher transport and recovery regressions', () => {
  const workflow = readFileSync(path('.github/workflows/chart-ci.yml'), 'utf8');
  const artifactTests = readFileSync(path('tools/chart-artifact.test.mjs'), 'utf8');
  const publicationTests = readFileSync(path('tools/chart-publication.test.mjs'), 'utf8');

  assert.match(workflow, /^  version-gate:\n    name: version-gate/m);
  assert.match(workflow, /^  manifests:\n    name: manifests/m);
  assert.match(workflow,
    /Validate generated chart distribution and recovery\n        run: node --test tools\/chart-artifact\.test\.mjs tools\/chart-authority\.test\.mjs tools\/chart-generated-only\.test\.mjs tools\/chart-publication\.test\.mjs/);
  assert.match(artifactTests, /publisher workflow checks out the validated nested or flat source/);
  assert.match(artifactTests, /generated artifact consumer decodes the strict v1 envelope/);
  assert.match(publicationTests, /default public readiness wait covers delayed Pages availability/);
  assert.match(publicationTests, /production adapter recovers an empty existing draft/);
  assert.match(publicationTests, /retry after draft release creation seals the exact generated package bytes/);
});
