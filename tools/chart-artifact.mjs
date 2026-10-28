import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createPublicationRuntime, publishChart } from './chart-publication.mjs';
import { assertChartPublisherAuthority } from './chart-authority.mjs';

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const checksumPattern = /^[a-f0-9]{64}$/;
const apiBase = 'https://api.github.com';
const artifactFields = [
  'chart_name', 'chart_version', 'app_version', 'image_digest', 'source_repository', 'source_commit',
  'source_package_reference', 'package_sha256', 'app_record_reference', 'app_record_sha256',
  'source_identity_reference', 'source_identity_sha256',
];

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertFlatPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('chart artifact event payload is required');
  if (payload.chart_name !== 'pacman') fail('chart artifact must identify the pacman chart');
  if (!versionPattern.test(payload.chart_version ?? '') || !versionPattern.test(payload.app_version ?? '')) fail('chart and app versions must be canonical stable versions');
  if (payload.source_repository !== 'saintdle/pacman' || !shaPattern.test(payload.source_commit ?? '')) fail('chart source must be saintdle/pacman at a full commit SHA');
  if (!digestPattern.test(payload.image_digest ?? '')) fail('chart image digest must be sha256');
  if (!checksumPattern.test(payload.package_sha256 ?? '') || !checksumPattern.test(payload.app_record_sha256 ?? '') || !checksumPattern.test(payload.source_identity_sha256 ?? '')) fail('package, app record, and source identity checksums must be lowercase SHA-256');
  const expectedPackage = `https://github.com/saintdle/pacman/releases/download/pacman-v${payload.app_version}/pacman-${payload.chart_version}.tgz`;
  const expectedAppRecord = `https://github.com/saintdle/pacman/releases/download/pacman-v${payload.app_version}/app-release-record.json`;
  const expectedIdentity = `${expectedPackage}.identity.json`;
  if (payload.source_package_reference !== expectedPackage || payload.app_record_reference !== expectedAppRecord || payload.source_identity_reference !== expectedIdentity) fail('source package, identity sidecar, and app record must be versioned assets in the exact pacman app release');
}

export function decodeArtifactPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('chart artifact event payload is required');
  const hasSchemaVersion = Object.hasOwn(payload, 'schema_version');
  const hasArtifact = Object.hasOwn(payload, 'artifact');
  if (hasSchemaVersion || hasArtifact) {
    const envelopeKeys = Object.keys(payload);
    if (!hasSchemaVersion || !hasArtifact || envelopeKeys.length !== 2
      || !envelopeKeys.includes('schema_version') || !envelopeKeys.includes('artifact')) {
      fail('chart artifact dispatch envelope must contain only schema_version and artifact');
    }
    if (payload.schema_version !== 1) fail('chart artifact dispatch envelope has an unsupported schema_version');
    if (!payload.artifact || typeof payload.artifact !== 'object' || Array.isArray(payload.artifact)) {
      fail('chart artifact dispatch envelope must contain an artifact object');
    }
    const fields = Object.keys(payload.artifact);
    if (fields.length !== artifactFields.length || artifactFields.some((field) => !Object.hasOwn(payload.artifact, field))) {
      fail('chart artifact dispatch envelope identity must contain exactly the v1 artifact fields');
    }
    assertFlatPayload(payload.artifact);
    return payload.artifact;
  }
  // Flat values remain accepted by internal helper callers and existing fixtures.
  assertFlatPayload(payload);
  return payload;
}

async function githubRequest(path, { token, fetch: fetchRequest = fetch, octet = false } = {}) {
  if (!token) fail('GH_TOKEN is required to verify and download generated chart artifacts');
  const response = await fetchRequest(path.startsWith('http') ? path : `${apiBase}${path}`, {
    headers: {
      Accept: octet ? 'application/octet-stream' : 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) fail(`GitHub API request failed: HTTP ${response.status}`);
  return octet ? Buffer.from(await response.arrayBuffer()) : response.json();
}

export async function verifyPacmanChartCandidate({ sourceCommit, token, fetch: fetchRequest = fetch }) {
  if (!shaPattern.test(sourceCommit ?? '')) fail('chart source commit must be a full lowercase SHA');
  const runs = await githubRequest(`/repos/saintdle/pacman/actions/workflows/chart-ci.yml/runs?head_sha=${sourceCommit}&branch=main&per_page=100`, { token, fetch: fetchRequest });
  const run = runs.workflow_runs?.find((candidate) => candidate.head_sha === sourceCommit
    && candidate.head_branch === 'main'
    && candidate.event === 'push'
    && candidate.status === 'completed'
    && candidate.conclusion === 'success'
    && [
      '.github/workflows/chart-ci.yml',
      '.github/workflows/chart-ci.yml@main',
      '.github/workflows/chart-ci.yml@refs/heads/main',
    ].includes(candidate.path));
  if (!run) fail(`no successful chart-ci.yml push validation exists for exact pacman SHA ${sourceCommit} on main`);
  return {
    sourceRepository: 'saintdle/pacman',
    sourceCommit,
    ref: 'refs/heads/main',
    workflow: 'chart-ci.yml',
    event: 'push',
    conclusion: 'success',
    runId: String(run.id),
  };
}

async function downloadReleaseAsset({ tag, filename, token, fetch: fetchRequest = fetch }) {
  const release = await githubRequest(`/repos/saintdle/pacman/releases/tags/${encodeURIComponent(tag)}`, { token, fetch: fetchRequest });
  if (release.draft || release.prerelease || release.tag_name !== tag) fail(`Pacman release ${tag} is not a published immutable release`);
  const matches = (release.assets ?? []).filter((asset) => asset.name === filename);
  if (matches.length !== 1) fail(`Pacman release ${tag} must contain exactly one ${filename} asset`);
  return githubRequest(matches[0].url, { token, fetch: fetchRequest, octet: true });
}

export async function prepareGeneratedPublication({ payload, codecPath, token, fetch: fetchRequest = fetch }) {
  const artifact = decodeArtifactPayload(payload);
  const candidateValidation = await verifyPacmanChartCandidate({ sourceCommit: artifact.source_commit, token, fetch: fetchRequest });
  const packageBytes = await downloadReleaseAsset({
    tag: `pacman-v${artifact.app_version}`,
    filename: `pacman-${artifact.chart_version}.tgz`,
    token,
    fetch: fetchRequest,
  });
  if (sha256(packageBytes) !== artifact.package_sha256) fail('Pacman source package checksum does not match the dispatched immutable artifact identity');
  const appRecordBytes = await downloadReleaseAsset({
    tag: `pacman-v${artifact.app_version}`,
    filename: 'app-release-record.json',
    token,
    fetch: fetchRequest,
  });
  if (sha256(appRecordBytes) !== artifact.app_record_sha256) fail('Pacman app record checksum does not match the dispatched immutable artifact identity');
  const identityBytes = await downloadReleaseAsset({
    tag: `pacman-v${artifact.app_version}`,
    filename: `pacman-${artifact.chart_version}.tgz.identity.json`,
    token,
    fetch: fetchRequest,
  });
  if (sha256(identityBytes) !== artifact.source_identity_sha256) fail('Pacman chart source identity sidecar checksum does not match the dispatched immutable identity');
  const identity = JSON.parse(identityBytes.toString('utf8'));
  const expectedIdentity = { schema_version: 1, kind: 'pacman-chart-source-package', chart_version: artifact.chart_version,
    source_commit: artifact.source_commit, package_sha256: artifact.package_sha256, app_record_reference: artifact.app_record_reference,
    app_record_sha256: artifact.app_record_sha256, image_digest: artifact.image_digest };
  if (`${JSON.stringify(identity)}\n` !== identityBytes.toString('utf8') || JSON.stringify(identity) !== JSON.stringify(expectedIdentity)) {
    fail('Pacman chart source identity sidecar does not match the exact package, app record, image, and chart source');
  }
  const codecUrl = pathToFileURL(resolve(codecPath));
  const codec = await import(codecUrl.href);
  const appRecord = codec.parseAppReleaseRecord(appRecordBytes);
  if (appRecord.app_version !== artifact.app_version || appRecord.image.manifest_list_digest !== artifact.image_digest) fail('Pacman app record does not match the chart app version and image digest');
  const releasePackageReference = `https://github.com/saintdle/helm-charts/releases/download/pacman-${artifact.chart_version}/pacman-${artifact.chart_version}.tgz`;
  const bundle = codec.createChartReleaseBundle({
    appRecordBytes,
    chartVersion: artifact.chart_version,
    sourceRepository: 'https://github.com/saintdle/pacman',
    sourceCommit: artifact.source_commit,
    packageReference: releasePackageReference,
    packageBytes,
  });
  codec.verifyChartReleaseBundle({
    appRecordBytes,
    chartRecordBytes: bundle.chartRecordBytes,
    compatibilityLockBytes: bundle.compatibilityLockBytes,
    packageBytes,
  });
  return {
    candidateValidation,
    packageBytes,
    releaseAssets: {
      'chart-release-record.json': bundle.chartRecordBytes,
      'consumer-compatibility-lock.json': bundle.compatibilityLockBytes,
    },
  };
}

async function main() {
  const mode = process.argv[2] ?? 'publish';
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const payload = event.client_payload;
  const token = process.env.GH_TOKEN;
  if (mode === 'validate-candidate') {
    const artifact = decodeArtifactPayload(payload);
    const validation = await verifyPacmanChartCandidate({ sourceCommit: artifact.source_commit, token });
    console.log(JSON.stringify(validation));
    return;
  }
  if (mode !== 'publish') fail('usage: chart-artifact.mjs validate-candidate|publish');
  await assertChartPublisherAuthority('pacman', { repository: process.env.GITHUB_REPOSITORY, token });
  const artifact = decodeArtifactPayload(payload);
  const { candidateValidation, packageBytes, releaseAssets } = await prepareGeneratedPublication({
    payload: artifact,
    codecPath: process.env.PACMAN_RELEASE_RECORDS_CODEC,
    token,
  });
  const identity = {
    name: artifact.chart_name,
    version: artifact.chart_version,
    appVersion: artifact.app_version,
    imageDigest: artifact.image_digest,
    sourceRepository: artifact.source_repository,
    sourceCommit: artifact.source_commit,
    distributionRepository: process.env.GITHUB_REPOSITORY,
    distributionCommit: process.env.GITHUB_SHA,
    pagesUrl: process.env.PAGES_URL,
  };
  const { api } = createPublicationRuntime(identity);
  api.buildPackage = async () => packageBytes;
  const result = await publishChart({ identity, api, candidateValidation, releaseAssets });
  console.log(`published ${result.tag} ${result.package} sha256:${result.packageSha256} (${result.releaseFormat})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
