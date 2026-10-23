import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { planChartPromotion } from './resolve-pacman-chart-version.mjs';
import { preservePendingPromotion, selectLatestAppRelease, validateAppRecordBytes } from './pacman-promotion.mjs';

const resolver = fileURLToPath(new URL('./resolve-pacman-chart-version.mjs', import.meta.url));
const fixture = (path) => new URL(`./fixtures/${path}`, import.meta.url);

test('historical 0.7.15 release cannot allocate a newer chart over app 0.7.16', () => {
  const result = spawnSync(process.execPath, [resolver], {
    encoding: 'utf8',
    env: {
      ...process.env,
      APP_VERSION: '0.7.15',
      CURRENT_APP_VERSION: '0.7.16',
      CURRENT_IMAGE_DIGEST: 'sha256:592740129bce7530a347146b86647f8b516df3c19105aa4c2fe40b878840fccf',
      IMAGE_DIGEST: 'sha256:bc887001ae81ce5692703704c356d718ae42514512e28d10c98690518f8547c4',
      CURRENT_CHART_VERSION: '0.7.17',
      RELEASED_CHART_TAGS: 'pacman-0.7.17',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /promotion=noop/);
  assert.match(result.stdout, /reason=older-app-release/);
  assert.doesNotMatch(result.stdout, /chart_version=0\.7\.18/);
});

test('duplicate app event is a no-op', () => {
  assert.deepEqual(planChartPromotion({
    appVersion: '0.7.16',
    imageDigest: 'sha256:592740129bce7530a347146b86647f8b516df3c19105aa4c2fe40b878840fccf',
    currentAppVersion: '0.7.16',
    currentImageDigest: 'sha256:592740129bce7530a347146b86647f8b516df3c19105aa4c2fe40b878840fccf',
    currentChartVersion: '0.7.17',
    releasedTags: ['pacman-0.7.17'],
  }), { promotion: 'noop', reason: 'already-promoted' });
});

test('same app version with a different digest is an identity conflict', () => {
  assert.throws(() => planChartPromotion({
    appVersion: '0.7.16',
    imageDigest: 'sha256:bc887001ae81ce5692703704c356d718ae42514512e28d10c98690518f8547c4',
    currentAppVersion: '0.7.16',
    currentImageDigest: 'sha256:592740129bce7530a347146b86647f8b516df3c19105aa4c2fe40b878840fccf',
    currentChartVersion: '0.7.17',
    releasedTags: ['pacman-0.7.17'],
  }), /conflicting image digest/);
});

test('newer app promotion allocates a chart version above the current axis', () => {
  const plan = planChartPromotion({
    appVersion: '0.7.18',
    imageDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    currentAppVersion: '0.7.16',
    currentImageDigest: 'sha256:592740129bce7530a347146b86647f8b516df3c19105aa4c2fe40b878840fccf',
    currentChartVersion: '0.7.17',
    releasedTags: ['pacman-0.7.17', 'pacman-0.7.18'],
  });

  assert.equal(plan.promotion, 'update');
  assert.equal(plan.chartVersion, '0.7.19');
});

test('reconciliation selects the highest app release regardless of event order', () => {
  const releases = [
    { tag_name: 'pacman-v0.7.15', draft: false, prerelease: false },
    { tag_name: 'pacman-v0.7.16', draft: false, prerelease: false },
  ];

  assert.equal(selectLatestAppRelease(releases).tag_name, 'pacman-v0.7.16');
  assert.equal(selectLatestAppRelease([...releases].reverse()).tag_name, 'pacman-v0.7.16');
});

test('delayed intermediate event cannot replace a newer coherent pending promotion', () => {
  const scenario = JSON.parse(readFileSync(fixture('promotion/pending-reordered.json'), 'utf8'));
  assert.equal(
    preservePendingPromotion({
      pendingAppVersion: scenario.pending.app_version,
      pendingImageDigest: scenario.pending.image_digest,
      candidateAppVersion: scenario.delayed_event.app_version,
      candidateImageDigest: scenario.delayed_event.image_digest,
    }),
    'newer-pending-promotion',
  );
});

test('schema-v1 app record and metadata must agree on checksum and identity', () => {
  const recordBytes = readFileSync(fixture('release-records/app-release-record.json'));
  const metadataBytes = readFileSync(fixture('release-records/release-metadata.json'));
  const verified = validateAppRecordBytes(recordBytes, metadataBytes, {
    version: '1.3.0',
    tag: 'pacman-v1.3.0',
    commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    reference: 'https://github.com/saintdle/pacman/releases/download/pacman-v1.3.0/app-release-record.json',
    sha256: '5e8c313be3fca5718168b8a2ad669bd56d49935d2d4f54c4315561124777db79',
    format: 'app-release-v1',
  });

  assert.equal(verified.image_manifest_list_digest, 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  const changedMetadata = Buffer.from(metadataBytes.toString('utf8').replace('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
  assert.throws(() => validateAppRecordBytes(recordBytes, changedMetadata, {
    version: '1.3.0', tag: 'pacman-v1.3.0', commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    reference: 'https://github.com/saintdle/pacman/releases/download/pacman-v1.3.0/app-release-record.json',
    sha256: '5e8c313be3fca5718168b8a2ad669bd56d49935d2d4f54c4315561124777db79', format: 'app-release-v1',
  }), /does not pin/);
});
