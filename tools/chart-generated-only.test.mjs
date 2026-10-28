import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const path = (relative) => new URL(relative, root);
const repositoryRoot = fileURLToPath(root);
const expectedWorkflows = ['chart-artifact-publish.yml', 'chart-ci.yml'];

function chartMetadataFiles(directory, repository) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== '.git' && entry.name !== 'node_modules') {
        files.push(...chartMetadataFiles(join(directory, entry.name), repository));
      }
    } else if (entry.name.toLowerCase() === 'chart.yaml') {
      files.push(relative(repository, join(directory, entry.name)).split(sep).join('/'));
    }
  }
  return files.sort();
}

function generatedOnlyInventory(repository) {
  const violations = [];
  const workflowDirectory = join(repository, '.github', 'workflows');
  const workflowEntries = existsSync(workflowDirectory)
    ? readdirSync(workflowDirectory).sort()
    : [];

  if (JSON.stringify(workflowEntries) !== JSON.stringify(expectedWorkflows)) {
    violations.push(
      `workflow inventory must be exactly ${expectedWorkflows.join(', ')}; found ${workflowEntries.join(', ') || '(none)'}`,
    );
  }

  if (existsSync(join(repository, 'charts'))) {
    violations.push('editable chart source root charts/ must stay absent');
  }

  const chartFiles = chartMetadataFiles(repository, repository);
  if (chartFiles.length > 0) {
    violations.push(`editable Helm chart metadata must stay absent: ${chartFiles.join(', ')}`);
  }

  return violations;
}

test('generated-only inventory rejects newly named chart source and publisher paths', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'chart-generated-only-inventory-'));
  try {
    const workflowDirectory = join(fixture, '.github', 'workflows');
    mkdirSync(workflowDirectory, { recursive: true });
    writeFileSync(join(workflowDirectory, 'chart-artifact-publish.yml'), 'name: generated receiver\n');
    writeFileSync(join(workflowDirectory, 'chart-ci.yml'), 'name: chart checks\n');
    assert.deepEqual(generatedOnlyInventory(fixture), [], 'the intended generated-only layout should pass');

    const sourceDirectory = join(fixture, 'charts', 'pacman-copy');
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(join(sourceDirectory, 'Chart.yaml'), 'apiVersion: v2\nname: pacman-copy\nversion: 1.0.0\n');
    writeFileSync(join(workflowDirectory, 'chart-release-again.yml'), 'name: extra publisher\non: [push]\n');

    const violations = generatedOnlyInventory(fixture).join('\n');
    assert.match(violations, /chart-release-again\.yml/);
    assert.match(violations, /charts\/pacman-copy\/Chart\.yaml/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('the repository keeps only the intended generated publisher workflows and no editable chart source', () => {
  assert.deepEqual(generatedOnlyInventory(repositoryRoot), []);
});

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
