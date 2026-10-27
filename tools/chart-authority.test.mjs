import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizeChartPublisherAuthority, publisherState, readChartPublisherAuthority } from './chart-authority.mjs';

test('the missing authority keeps the legacy publisher as the only active publisher', () => {
  assert.deepEqual(publisherState(undefined), {
    authority: 'helm-charts',
    legacyEnabled: true,
    generatedEnabled: false,
  });
});

test('switch and rollback checkpoints each select exactly one publisher', () => {
  const expansion = publisherState(undefined);
  const switched = publisherState('pacman');
  const rollback = publisherState('helm-charts');
  for (const checkpoint of [expansion, switched, rollback]) {
    assert.equal(Number(checkpoint.legacyEnabled) + Number(checkpoint.generatedEnabled), 1);
  }
  assert.equal(expansion.legacyEnabled, true);
  assert.equal(switched.generatedEnabled, true);
  assert.equal(rollback.legacyEnabled, true);
});

test('unknown authority values fail closed', () => {
  assert.throws(() => normalizeChartPublisherAuthority('both'), /must be either helm-charts or pacman/);
  assert.throws(() => publisherState('unrecognized'), /must be either helm-charts or pacman/);
});

test('authority reader defaults only on a missing variable and rejects API failures', async () => {
  const missing = await readChartPublisherAuthority({
    repository: 'saintdle/helm-charts',
    token: 'test-token',
    fetch: async (url) => url.includes('?per_page=1')
      ? ({ status: 200, ok: true }) : ({ status: 404, ok: false }),
  });
  assert.equal(missing, 'helm-charts');

  await assert.rejects(readChartPublisherAuthority({
    repository: 'saintdle/helm-charts',
    token: 'test-token',
    fetch: async (url) => url.includes('?per_page=1') ? ({ status: 200, ok: true }) : ({ status: 403, ok: false }),
  }), /could not read PACMAN_CHART_PUBLISHER_AUTHORITY: HTTP 403/);

  await assert.rejects(readChartPublisherAuthority({
    repository: 'saintdle/helm-charts', token: 'test-token',
    fetch: async () => ({ status: 404, ok: false }),
  }), /verify Actions variables read access/);

  await assert.rejects(readChartPublisherAuthority({
    repository: 'saintdle/helm-charts',
    token: 'test-token',
    fetch: async () => ({ status: 200, ok: true, json: async () => ({ value: 'typo' }) }),
  }), /must be either helm-charts or pacman/);
});

test('legacy and generated workflows share serialization and recheck the selected authority', () => {
  const legacyPublisher = readFileSync(new URL('../.github/workflows/chart-release.yml', import.meta.url), 'utf8');
  const legacyPromoter = readFileSync(new URL('../.github/workflows/pacman-promotion.yml', import.meta.url), 'utf8');
  const generatedPublisher = readFileSync(new URL('../.github/workflows/chart-artifact-publish.yml', import.meta.url), 'utf8');

  for (const workflow of [legacyPublisher, legacyPromoter, generatedPublisher]) {
    assert.match(workflow, /group: pacman-chart-publisher/);
    assert.match(workflow, /cancel-in-progress: false/);
  }
  assert.match(legacyPublisher, /if: vars\.PACMAN_CHART_PUBLISHER_AUTHORITY != 'pacman'/);
  assert.match(legacyPromoter, /if: vars\.PACMAN_CHART_PUBLISHER_AUTHORITY != 'pacman'/);
  assert.match(generatedPublisher, /if: vars\.PACMAN_CHART_PUBLISHER_AUTHORITY == 'pacman'/);
  assert.match(legacyPublisher, /node tools\/chart-authority\.mjs helm-charts/);
  assert.match(legacyPromoter, /node tools\/chart-authority\.mjs helm-charts/);
  assert.match(generatedPublisher, /node tools\/chart-authority\.mjs pacman/);

  const candidateCheck = generatedPublisher.indexOf('node tools/chart-artifact.mjs validate-candidate');
  const sourceCheckout = generatedPublisher.indexOf('Check out only the authoritative release record codec');
  const publish = generatedPublisher.indexOf('node tools/chart-artifact.mjs publish');
  assert.ok(candidateCheck >= 0 && sourceCheckout > candidateCheck && publish > sourceCheckout);
  assert.equal(fileURLToPath(new URL('../.github/workflows/chart-artifact-publish.yml', import.meta.url)).endsWith('.yml'), true);
});
