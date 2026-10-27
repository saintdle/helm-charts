import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { planChartPromotion } from './resolve-pacman-chart-version.mjs';
import { preservePendingPromotion, rollbackProposal, resumeRollbackProposal, selectLatestAppRelease, validateAppRecordBytes } from './pacman-promotion.mjs';

const resolver = fileURLToPath(new URL('./resolve-pacman-chart-version.mjs', import.meta.url));
const promotionCli = fileURLToPath(new URL('./pacman-promotion.mjs', import.meta.url));
const fixture = (path) => new URL(`./fixtures/${path}`, import.meta.url);

function filterPendingState(state, pullRequests, branchSha = 'a'.repeat(40), baseSha = 'd'.repeat(40)) {
  const directory = mkdtempSync(join(tmpdir(), 'pacman-pending-test-'));
  try {
    const statePath = join(directory, 'state.json');
    const proposalPath = join(directory, 'proposals.json');
    const outputPath = join(directory, 'selected.json');
    writeFileSync(statePath, JSON.stringify(state));
    writeFileSync(proposalPath, JSON.stringify(pullRequests));
    const result = spawnSync(process.execPath, [promotionCli, 'filter-pending', statePath, proposalPath], {
      encoding: 'utf8', env: { ...process.env, PENDING_BRANCH_SHA: branchSha, PENDING_BASE_SHA: baseSha, PENDING_FILTERED_PATH: outputPath },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(readFileSync(outputPath, 'utf8'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

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

test('same app digest with a changed immutable record pin is rejected', () => {
  assert.throws(() => planChartPromotion({
    appVersion: '0.7.16',
    imageDigest: 'sha256:592740129bce7530a347146b86647f8b516df3c19105aa4c2fe40b878840fccf',
    currentAppVersion: '0.7.16',
    currentImageDigest: 'sha256:592740129bce7530a347146b86647f8b516df3c19105aa4c2fe40b878840fccf',
    appRecordReference: 'https://github.com/saintdle/pacman/releases/download/pacman-v0.7.16/app-release-record.json',
    appRecordSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    appSourceCommit: '13f04d6e6aea62f1d32d57d90e4eff786083c02e',
    currentAppRecordReference: 'https://github.com/saintdle/pacman/releases/download/pacman-v0.7.16/app-release-record.json',
    currentAppRecordSha256: 'ef15decce2fc0cb9aa0b14d4a2d059e10eb13638afc57fe99277b8688aea4c4e',
    currentAppSourceCommit: '13f04d6e6aea62f1d32d57d90e4eff786083c02e',
    currentChartVersion: '0.7.17',
    releasedTags: ['pacman-0.7.17'],
  }), /conflicting app record checksum/);
});

test('rollback dispatch produces a proposal only and resume requires that proposal state', () => {
  const candidate = {
    version: '0.7.15', reference: 'https://github.com/saintdle/pacman/releases/download/pacman-v0.7.15/release-metadata.json',
    sha256: 'a'.repeat(64), image_manifest_list_digest: `sha256:${'b'.repeat(64)}`,
  };
  const rollback = rollbackProposal({ candidate, chartVersion: '0.7.18', reason: 'Restore verified prior app' });
  assert.equal(rollback.action, 'rollback-proposal');
  assert.equal('apply' in rollback, false);
  assert.equal(resumeRollbackProposal({ state: { mode: 'rollback' }, candidate, chartVersion: '0.7.18' }).action, 'resume');
  assert.throws(() => resumeRollbackProposal({ state: { mode: 'automatic' }, candidate, chartVersion: '0.7.18' }), /pending rollback/);
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

test('workflow pending filter accepts only the exact open proposal and keeps version ordering', () => {
  const pending = { schema_version: 1, kind: 'pacman-chart-promotion-state', mode: 'automatic',
    app: { version: '0.7.18', reference: 'app.json', sha256: 'b'.repeat(64), image_manifest_list_digest: `sha256:${'c'.repeat(64)}` },
    chart: { version: '0.7.19' } };
  const proposal = { state: 'OPEN', isCrossRepository: false, headRefName: 'automation/pacman-promotion', headRefOid: 'a'.repeat(40),
    baseRefName: 'main', baseRefOid: 'd'.repeat(40) };
  assert.deepEqual(filterPendingState(pending, [proposal]), pending);
  assert.equal(preservePendingPromotion({ pendingAppVersion: pending.app.version, pendingImageDigest: pending.app.image_manifest_list_digest,
    candidateAppVersion: '0.7.17', candidateImageDigest: `sha256:${'e'.repeat(64)}` }), 'newer-pending-promotion');
  assert.equal(preservePendingPromotion({ pendingAppVersion: '0.7.16', pendingImageDigest: pending.app.image_manifest_list_digest,
    candidateAppVersion: '0.7.18', candidateImageDigest: pending.app.image_manifest_list_digest }), null);
  for (const proposalState of ['CLOSED', 'MERGED']) assert.equal(filterPendingState(pending, [{ ...proposal, state: proposalState }]), null);
  assert.equal(filterPendingState(pending, [{ ...proposal, isCrossRepository: true }]), null);
  const { isCrossRepository, ...missingRepositoryIdentity } = proposal;
  assert.equal(filterPendingState(pending, [missingRepositoryIdentity]), null);
  assert.equal(filterPendingState(pending, []), null);
  assert.equal(filterPendingState(pending, [{ ...proposal, headRefOid: 'e'.repeat(40) }]), null);
  assert.equal(filterPendingState(pending, [{ ...proposal, baseRefOid: 'f'.repeat(40) }]), null);
});

test('workflow query uses supported branch filtering and requests repository identity', () => {
  const workflow = readFileSync(new URL('../.github/workflows/pacman-promotion.yml', import.meta.url), 'utf8');
  const query = workflow.split('\n').filter((line) => line.includes('gh pr list --repo saintdle/helm-charts')
    || line.trim().startsWith('--json state,headRefName')).join(' ');
  assert.match(query, /--head automation\/pacman-promotion/);
  assert.doesNotMatch(query, /--head saintdle:/);
  assert.match(query, /isCrossRepository/);
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

test('checked-in promotion state matches the chart source and published chart package', () => {
  const state = JSON.parse(readFileSync(new URL('../pacman-promotion-state.json', import.meta.url), 'utf8'));
  const chart = readFileSync(new URL('../charts/pacman/Chart.yaml', import.meta.url), 'utf8');
  const values = readFileSync(new URL('../charts/pacman/values.yaml', import.meta.url), 'utf8');
  const field = (source, name) => {
    const match = new RegExp(`^${name}:\\s*"?([^"\\s]+)"?\\s*$`, 'm').exec(source);
    assert.ok(match, `chart source must contain ${name}`);
    return match[1];
  };
  const valuesDigest = /^image:\s*\n(?:[ \t].*\n)*?[ \t]+digest:\s*"?(sha256:[a-f0-9]{64})"?/m.exec(values)?.[1];

  assert.equal(state.app.version, field(chart, 'appVersion'), 'promotion app version must match Chart.yaml');
  assert.equal(state.app.image_manifest_list_digest, valuesDigest, 'promotion app digest must match values.yaml');
  assert.equal(state.chart.version, field(chart, 'version'), 'promotion chart version must match Chart.yaml');
  assert.equal(state.chart.format, 'legacy-chart-package-v0');
  assert.equal(state.chart.release_tag, 'pacman-0.7.18');
  assert.equal(state.chart.package_reference,
    'https://github.com/saintdle/helm-charts/releases/download/pacman-0.7.18/pacman-0.7.18.tgz');
  assert.equal(state.chart.package_sha256, '68f51615bc494f3f5f58a55e7550b156eed3374947557634c875a4affb0e29bd');
  assert.deepEqual(state.chart.missing_evidence, ['chart_release_record']);
});
