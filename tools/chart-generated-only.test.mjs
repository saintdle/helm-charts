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
