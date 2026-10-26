import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertChartPublisherAuthority, normalizeChartPublisherAuthority, readChartPublisherAuthority } from './chart-authority.mjs';

test('the generated publisher is the only accepted authority', () => {
  assert.equal(normalizeChartPublisherAuthority('pacman'), 'pacman');
  for (const value of [undefined, null, '', 'helm-charts', 'both', 'unrecognized']) {
    assert.throws(() => normalizeChartPublisherAuthority(value), /must be set to pacman/);
  }
});

test('authority reader requires variable-read access and an explicitly selected generated publisher', async () => {
  const missing = await readChartPublisherAuthority({
    repository: 'saintdle/helm-charts',
    token: 'test-token',
    fetch: async (url) => url.includes('?per_page=1')
      ? ({ status: 200, ok: true }) : ({ status: 404, ok: false }),
  });
  assert.equal(missing, null);

  await assert.rejects(assertChartPublisherAuthority('pacman', {
    repository: 'saintdle/helm-charts', token: 'test-token',
    fetch: async (url) => url.includes('?per_page=1') ? ({ status: 200, ok: true }) : ({ status: 404, ok: false }),
  }), /authority is unset/);

  await assert.rejects(readChartPublisherAuthority({
    repository: 'saintdle/helm-charts', token: 'test-token',
    fetch: async (url) => url.includes('?per_page=1') ? ({ status: 200, ok: true }) : ({ status: 403, ok: false }),
  }), /could not read PACMAN_CHART_PUBLISHER_AUTHORITY: HTTP 403/);

  await assert.rejects(readChartPublisherAuthority({
    repository: 'saintdle/helm-charts', token: 'test-token',
    fetch: async () => ({ status: 403, ok: false }),
  }), /verify Actions variables read access/);

  await assert.rejects(readChartPublisherAuthority({
    repository: 'saintdle/helm-charts', token: 'test-token',
    fetch: async (url) => url.includes('?per_page=1')
      ? ({ status: 200, ok: true })
      : ({ status: 200, ok: true, json: async () => ({ value: 'helm-charts' }) }),
  }), /must be set to pacman/);
});

test('generated receiver rechecks authority and serializes publication without cancellation', () => {
  const generatedPublisher = readFileSync(new URL('../.github/workflows/chart-artifact-publish.yml', import.meta.url), 'utf8');
  assert.match(generatedPublisher, /group: pacman-chart-publisher/);
  assert.match(generatedPublisher, /cancel-in-progress: false/);
  assert.match(generatedPublisher, /if: vars\.PACMAN_CHART_PUBLISHER_AUTHORITY == 'pacman'/);
  assert.match(generatedPublisher, /node tools\/chart-authority\.mjs pacman/);
  assert.match(generatedPublisher, /node tools\/chart-artifact\.mjs validate-candidate/);
  assert.match(generatedPublisher, /node tools\/chart-artifact\.mjs publish/);
});
