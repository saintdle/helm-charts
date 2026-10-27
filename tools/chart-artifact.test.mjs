import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decodeArtifactPayload, prepareGeneratedPublication, verifyPacmanChartCandidate } from './chart-artifact.mjs';

const sourceCommit = 'a'.repeat(40);
const realApiRun = {
  id: 39959561062,
  path: '.github/workflows/chart-ci.yml',
  head_sha: sourceCommit,
  head_branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
};

function fetchRun(run) {
  return async (url) => {
    assert.match(url, /actions\/workflows\/chart-ci\.yml\/runs\?head_sha=/);
    return { ok: true, json: async () => ({ workflow_runs: run ? [run] : [] }) };
  };
}

function checksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function responseJson(value) {
  return { ok: true, json: async () => value };
}

function responseBytes(bytes) {
  return {
    ok: true,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

test('candidate accepts exact GitHub main workflow identities only for a successful exact main push SHA', async () => {
  for (const path of [
    '.github/workflows/chart-ci.yml',
    '.github/workflows/chart-ci.yml@main',
    '.github/workflows/chart-ci.yml@refs/heads/main',
  ]) {
    const validation = await verifyPacmanChartCandidate({
      sourceCommit, token: 'fixture', fetch: fetchRun({ ...realApiRun, path }),
    });
    assert.equal(validation.runId, '39959561062');
    assert.equal(validation.sourceCommit, sourceCommit);
  }

  for (const changed of [
    { ...realApiRun, head_sha: 'b'.repeat(40) },
    { ...realApiRun, head_branch: 'feature' },
    { ...realApiRun, event: 'pull_request' },
    { ...realApiRun, status: 'in_progress' },
    { ...realApiRun, conclusion: 'failure' },
    { ...realApiRun, path: '.github/workflows/other.yml' },
    { ...realApiRun, path: '.github/workflows/chart-ci.yml@feature' },
    { ...realApiRun, path: '.github/workflows/chart-ci.yml@refs/heads/feature' },
    { ...realApiRun, path: '.github/workflows/chart-ci.yml@refs/tags/main' },
    { ...realApiRun, path: '.github/workflows/chart-ci.yml@main/extra' },
    { ...realApiRun, path: '.github/workflows/chart-ci.yml@@main' },
  ]) {
    await assert.rejects(verifyPacmanChartCandidate({ sourceCommit, token: 'fixture', fetch: fetchRun(changed) }), /no successful chart-ci\.yml push validation/);
  }
});

test('generated artifact consumer decodes the strict v1 envelope and keeps all immutable source fields', async () => {
  const sourceCommit = 'a405d8d66d63c8d121ed993f55583a6ff634c86d';
  const packageBytes = Buffer.from('original validated chart package fixture');
  const appRecord = {
    schema_version: 1,
    app_version: '0.7.17',
    image: { manifest_list_digest: `sha256:${'2a55f4d74bc05dea3ae05912fbdcbe9348f9aafb752902054a7f066cfa112f68'}` },
  };
  const appRecordBytes = Buffer.from(`${JSON.stringify(appRecord)}\n`);
  const payload = {
    chart_name: 'pacman',
    chart_version: '0.7.20',
    app_version: '0.7.17',
    image_digest: appRecord.image.manifest_list_digest,
    source_repository: 'saintdle/pacman',
    source_commit: sourceCommit,
    source_package_reference: 'https://github.com/saintdle/pacman/releases/download/pacman-v0.7.17/pacman-0.7.20.tgz',
    package_sha256: checksum(packageBytes),
    app_record_reference: 'https://github.com/saintdle/pacman/releases/download/pacman-v0.7.17/app-release-record.json',
    app_record_sha256: checksum(appRecordBytes),
    source_identity_reference: 'https://github.com/saintdle/pacman/releases/download/pacman-v0.7.17/pacman-0.7.20.tgz.identity.json',
  };
  const sidecar = {
    schema_version: 1,
    kind: 'pacman-chart-source-package',
    chart_version: payload.chart_version,
    source_commit: payload.source_commit,
    package_sha256: payload.package_sha256,
    app_record_reference: payload.app_record_reference,
    app_record_sha256: payload.app_record_sha256,
    image_digest: payload.image_digest,
  };
  const sidecarBytes = Buffer.from(`${JSON.stringify(sidecar)}\n`);
  payload.source_identity_sha256 = checksum(sidecarBytes);
  const tag = 'pacman-v0.7.17';
  const assets = [
    { name: 'pacman-0.7.20.tgz', url: 'https://api.github.com/assets/package' },
    { name: 'app-release-record.json', url: 'https://api.github.com/assets/app-record' },
    { name: 'pacman-0.7.20.tgz.identity.json', url: 'https://api.github.com/assets/identity' },
  ];
  const bytesByUrl = new Map([
    [assets[0].url, packageBytes],
    [assets[1].url, appRecordBytes],
    [assets[2].url, sidecarBytes],
  ]);
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/actions/workflows/chart-ci.yml/runs?')) {
      return responseJson({ workflow_runs: [{ ...realApiRun, head_sha: sourceCommit }] });
    }
    if (String(url) === `https://api.github.com/repos/saintdle/pacman/releases/tags/${tag}`) {
      return responseJson({ tag_name: tag, draft: false, prerelease: false, assets });
    }
    if (bytesByUrl.has(String(url))) return responseBytes(bytesByUrl.get(String(url)));
    throw new Error(`unexpected fixture request: ${url}`);
  };
  const directory = mkdtempSync(join(tmpdir(), 'pacman-artifact-codec-'));
  const codecPath = join(directory, 'codec.mjs');
  writeFileSync(codecPath, `
    export function parseAppReleaseRecord(bytes) { return JSON.parse(bytes.toString('utf8')); }
    export function createChartReleaseBundle({ chartVersion, sourceCommit, packageBytes }) {
      return { chartRecordBytes: Buffer.from('chart-release-record:' + chartVersion + ':' + sourceCommit), compatibilityLockBytes: Buffer.from('compatibility-lock'), packageBytes };
    }
    export function verifyChartReleaseBundle() { return true; }
  `);
  try {
    const prepared = await prepareGeneratedPublication({
      payload: { schema_version: 1, artifact: payload }, codecPath, token: 'fixture-token', fetch,
    });

    assert.equal(prepared.candidateValidation.sourceCommit, sourceCommit);
    assert.deepEqual(prepared.packageBytes, packageBytes);
    assert.deepEqual(prepared.releaseAssets['chart-release-record.json'], Buffer.from(`chart-release-record:0.7.20:${sourceCommit}`));
    assert.deepEqual(Object.keys(prepared.releaseAssets).sort(), ['chart-release-record.json', 'consumer-compatibility-lock.json']);
    assert.equal(calls.filter((url) => bytesByUrl.has(url)).length, 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('generated artifact consumer rejects mixed, malformed, and unknown-version envelopes before fetching', async () => {
  const flat = {
    chart_name: 'pacman', chart_version: '0.7.20', app_version: '0.7.17',
    image_digest: `sha256:${'2a'.repeat(32)}`, source_repository: 'saintdle/pacman', source_commit: 'a'.repeat(40),
    source_package_reference: 'https://github.com/saintdle/pacman/releases/download/pacman-v0.7.17/pacman-0.7.20.tgz',
    package_sha256: 'b'.repeat(64),
    app_record_reference: 'https://github.com/saintdle/pacman/releases/download/pacman-v0.7.17/app-release-record.json',
    app_record_sha256: 'c'.repeat(64),
    source_identity_reference: 'https://github.com/saintdle/pacman/releases/download/pacman-v0.7.17/pacman-0.7.20.tgz.identity.json',
    source_identity_sha256: 'd'.repeat(64),
  };
  let fetchCalls = 0;
  const fetch = async () => { fetchCalls += 1; throw new Error('network should not be reached'); };
  for (const payload of [
    { schema_version: 2, artifact: flat },
    { schema_version: 1, artifact: { ...flat, source_commit: undefined } },
    { schema_version: 1, artifact: flat, ...flat },
    { schema_version: 1 },
    { artifact: flat },
  ]) {
    await assert.rejects(prepareGeneratedPublication({ payload, codecPath: 'unused', token: 'fixture-token', fetch }));
  }
  assert.equal(fetchCalls, 0);

  assert.deepEqual(decodeArtifactPayload(flat), flat, 'internal flat payloads remain supported');
});
