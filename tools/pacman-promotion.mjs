import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planChartPromotion, resolveNextChartVersion } from './resolve-pacman-chart-version.mjs';

const appRepository = 'https://github.com/saintdle/pacman';
const imageRepository = 'docker.io/saintdle/pacman';
const apiRepository = 'saintdle/pacman';
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const commitPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const checksumPattern = /^[a-f0-9]{64}$/;
const appRecordFile = 'app-release-record.json';
const metadataFile = 'release-metadata.json';

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireKeys(value, keys, name) {
  if (!isObject(value)) fail(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${name} must contain exactly: ${expected.join(', ')}`);
  }
}

function requireVersion(value, name) {
  if (typeof value !== 'string' || !versionPattern.test(value)) fail(`${name} must be canonical MAJOR.MINOR.PATCH`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function releaseReference(version, filename) {
  return `${appRepository}/releases/download/pacman-v${version}/${filename}`;
}

function compareVersions(leftValue, rightValue) {
  const left = leftValue.split('.').map(Number);
  const right = rightValue.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function validateAppRecordBytes(recordBytes, metadataBytes, expected) {
  const record = JSON.parse(recordBytes.toString('utf8'));
  const metadata = JSON.parse(metadataBytes.toString('utf8'));
  requireKeys(record, [
    'schema_version', 'kind', 'app_version', 'tag', 'source', 'image', 'platforms',
    'provenance_reference', 'signature_reference',
  ], 'app release record');
  if (record.schema_version !== 1 || record.kind !== 'app-release') fail('unsupported app release record kind or schema');
  requireVersion(record.app_version, 'app_version');
  if (record.tag !== `pacman-v${record.app_version}`) fail('app release tag does not match its version');
  requireKeys(record.source, ['repository', 'commit'], 'app source');
  if (record.source.repository !== appRepository || !commitPattern.test(record.source.commit)) fail('app source identity is invalid');
  requireKeys(record.image, ['repository', 'manifest_list_digest'], 'app image');
  if (record.image.repository !== imageRepository || !digestPattern.test(record.image.manifest_list_digest)) fail('app image identity is invalid');
  if (!Array.isArray(record.platforms)) fail('app platforms must be an array');
  const platforms = new Map();
  for (const descriptor of record.platforms) {
    requireKeys(descriptor, ['platform', 'digest'], 'platform descriptor');
    if (!digestPattern.test(descriptor.digest) || platforms.has(descriptor.platform)) fail('app platform descriptor is invalid');
    platforms.set(descriptor.platform, descriptor.digest);
  }
  for (const platform of ['linux/amd64', 'linux/arm64']) {
    if (!platforms.has(platform)) fail(`app record is missing ${platform}`);
  }
  if (!/^https:\/\/github\.com\/saintdle\/pacman\/actions\/runs\/\d+$/.test(record.provenance_reference)) fail('app provenance reference is invalid');
  if (record.signature_reference !== `docker://${imageRepository}@${record.image.manifest_list_digest}`) fail('app signature reference does not match image digest');

  requireKeys(metadata, ['version', 'tag', 'commit', 'image_digest', 'app_record_ref', 'app_record_sha256'], 'release metadata');
  const recordSha = sha256(recordBytes);
  const expectedReference = releaseReference(record.app_version, appRecordFile);
  if (metadata.version !== record.app_version || metadata.tag !== record.tag || metadata.commit !== record.source.commit
    || metadata.image_digest !== record.image.manifest_list_digest || metadata.app_record_ref !== expectedReference
    || metadata.app_record_sha256 !== recordSha) {
    fail('release metadata does not pin the immutable app record identity and bytes');
  }
  if (expected.version !== record.app_version || expected.tag !== record.tag || expected.commit !== record.source.commit
    || expected.reference !== expectedReference || expected.sha256 !== recordSha || expected.format !== 'app-release-v1') {
    fail('event hint does not match the verified app release record');
  }
  return {
    format: 'app-release-v1',
    version: record.app_version,
    tag: record.tag,
    reference: expectedReference,
    sha256: recordSha,
    source_commit: record.source.commit,
    image_repository: record.image.repository,
    image_manifest_list_digest: record.image.manifest_list_digest,
    missing_evidence: [],
  };
}

export function validateLegacyMetadataBytes(metadataBytes, expected) {
  const metadata = JSON.parse(metadataBytes.toString('utf8'));
  requireKeys(metadata, ['version', 'tag', 'commit'], 'legacy release metadata');
  requireVersion(metadata.version, 'legacy app version');
  if (metadata.tag !== `pacman-v${metadata.version}` || !commitPattern.test(metadata.commit)) fail('legacy app release identity is invalid');
  const reference = releaseReference(metadata.version, metadataFile);
  const checksum = sha256(metadataBytes);
  if (expected.version !== metadata.version || expected.tag !== metadata.tag || expected.commit !== metadata.commit
    || expected.reference !== reference || expected.sha256 !== checksum || expected.format !== 'legacy-release-metadata-v0'
    || !digestPattern.test(expected.image_digest ?? '')) {
    fail('legacy event hint does not match the verified release metadata and image');
  }
  return {
    format: 'legacy-release-metadata-v0',
    version: metadata.version,
    tag: metadata.tag,
    reference,
    sha256: checksum,
    source_commit: metadata.commit,
    image_repository: imageRepository,
    image_manifest_list_digest: expected.image_digest,
    missing_evidence: ['platform_descriptors', 'provenance', 'signature'],
  };
}

export function selectLatestAppRelease(releases) {
  const candidates = releases
    .filter((release) => !release.draft && !release.prerelease && /^pacman-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.tag_name))
    .map((release) => ({ release, version: release.tag_name.slice('pacman-v'.length) }))
    .sort((left, right) => compareVersions(right.version, left.version));
  if (candidates.length === 0) fail('no published Pac-Man app release is available');
  if (candidates.length > 1 && compareVersions(candidates[0].version, candidates[1].version) === 0) {
    fail(`multiple app releases claim version ${candidates[0].version}`);
  }
  return candidates[0].release;
}

export function preservePendingPromotion({ pendingAppVersion, pendingImageDigest, candidateAppVersion, candidateImageDigest,
  pendingAppReference, pendingAppSha256, pendingAppSourceCommit, candidateAppReference, candidateAppSha256, candidateAppSourceCommit }) {
  requireVersion(pendingAppVersion, 'pending app version');
  requireVersion(candidateAppVersion, 'candidate app version');
  if (!digestPattern.test(pendingImageDigest ?? '') || !digestPattern.test(candidateImageDigest ?? '')) {
    fail('pending and candidate image digests must be SHA-256 digests');
  }
  const comparison = compareVersions(pendingAppVersion, candidateAppVersion);
  if (comparison > 0) return 'newer-pending-promotion';
  if (comparison === 0) {
    if (pendingImageDigest !== candidateImageDigest) fail('pending promotion conflicts with the verified app release identity');
    const identities = [
      ['app record reference', pendingAppReference, candidateAppReference],
      ['app record checksum', pendingAppSha256, candidateAppSha256],
      ['app source commit', pendingAppSourceCommit, candidateAppSourceCommit],
    ];
    for (const [name, pending, candidate] of identities) {
      if (pending !== undefined || candidate !== undefined) {
        if (!pending || !candidate || pending !== candidate) fail(`pending promotion conflicts with the verified ${name}`);
      }
    }
    return 'same-pending-promotion';
  }
  return null;
}

export function rollbackProposal({ candidate, chartVersion, reason }) {
  if (!candidate?.reference || !checksumPattern.test(candidate.sha256 ?? '') || !digestPattern.test(candidate.image_manifest_list_digest ?? '')
    || !versionPattern.test(chartVersion ?? '') || reason.trim().length < 8) {
    fail('rollback proposal requires verified immutable app evidence, chart version, and a reason');
  }
  return { action: 'rollback-proposal', reason: 'explicit-rollback-proposal', rollback_reason: reason.trim(), app: candidate, chart: { version: chartVersion } };
}

export function resumeRollbackProposal({ state, candidate, chartVersion }) {
  if (state?.mode !== 'rollback') fail('resume requires a pending rollback proposal');
  return { action: 'resume', reason: 'explicit-resume-after-rollback', app: candidate, chart: { version: chartVersion } };
}

export function selectPendingProposalState({ state, pullRequests, branchSha, baseSha, stateKind = 'pacman-chart-promotion-state' }) {
  if (!isObject(state) || state.schema_version !== 1 || state.kind !== stateKind
    || !['automatic', 'rollback'].includes(state.mode) || !Array.isArray(pullRequests)
    || typeof state.app?.reference !== 'string'
    || !digestPattern.test(state.app?.image_manifest_list_digest ?? '')
    || !checksumPattern.test(state.app?.sha256 ?? '') || !versionPattern.test(state.app?.version ?? '')
    || !versionPattern.test(state.chart?.version ?? '')) return null;
  const matches = pullRequests.filter((proposal) => proposal?.state === 'OPEN' && proposal.isCrossRepository === false
    && proposal.headRefName === 'automation/pacman-promotion' && proposal.headRefOid === branchSha
    && proposal.baseRefName === 'main' && proposal.baseRefOid === baseSha);
  return matches.length === 1 ? state : null;
}

async function github(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!response.ok) fail(`GitHub API request failed (${response.status}): ${path}`);
  return response;
}

async function releaseByTag(tag) {
  return github(`/repos/${apiRepository}/releases/tags/${encodeURIComponent(tag)}`).then((response) => response.json());
}

async function resolveTagCommit(tag) {
  let ref = await github(`/repos/${apiRepository}/git/ref/tags/${encodeURIComponent(tag)}`).then((response) => response.json());
  let object = ref.object;
  for (let count = 0; object?.type === 'tag' && count < 5; count += 1) {
    object = await github(`/repos/${apiRepository}/git/tags/${object.sha}`).then((response) => response.json()).then((tagObject) => tagObject.object);
  }
  if (object?.type !== 'commit' || !commitPattern.test(object.sha)) fail(`app release tag ${tag} does not resolve to a commit`);
  return object.sha;
}

async function assetBytes(release, name) {
  const matches = release.assets.filter((asset) => asset.name === name);
  if (matches.length !== 1) fail(`${release.tag_name} must contain exactly one ${name}`);
  const response = await fetch(matches[0].browser_download_url);
  if (!response.ok) fail(`could not download ${name} for ${release.tag_name}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const checksum = sha256(bytes);
  if (matches[0].digest && matches[0].digest !== `sha256:${checksum}`) fail(`${name} asset checksum does not match GitHub release metadata`);
  return bytes;
}

function imageDigestFromRegistry(reference) {
  const output = execFileSync('docker', ['buildx', 'imagetools', 'inspect', reference], { encoding: 'utf8' });
  const match = /^Digest:\s+(sha256:[a-f0-9]{64})$/m.exec(output);
  if (!match) fail(`could not verify published image digest for ${reference}`);
  return match[1];
}

async function validateRelease(release, hint = {}) {
  if (release.draft || release.prerelease) fail('app release must be published and stable');
  const versionMatch = /^pacman-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(release.tag_name);
  if (!versionMatch) fail('app release tag is not canonical stable SemVer');
  const version = versionMatch[1] + '.' + versionMatch[2] + '.' + versionMatch[3];
  const commit = await resolveTagCommit(release.tag_name);
  const recordAsset = release.assets.find((asset) => asset.name === appRecordFile);
  let candidate;
  if (recordAsset) {
    const [recordBytes, metadataBytes] = await Promise.all([
      assetBytes(release, appRecordFile),
      assetBytes(release, metadataFile),
    ]);
    const metadata = JSON.parse(metadataBytes.toString('utf8'));
    candidate = validateAppRecordBytes(recordBytes, metadataBytes, {
      version,
      tag: release.tag_name,
      commit,
      reference: releaseReference(version, appRecordFile),
      sha256: sha256(recordBytes),
      format: 'app-release-v1',
    });
    if (hint.reference && hint.reference !== candidate.reference) fail('dispatch app record reference does not match the published release');
    if (hint.sha256 && hint.sha256 !== candidate.sha256) fail('dispatch app record checksum does not match the published release');
    if (hint.format && hint.format !== candidate.format) fail('dispatch app record format does not match the published release');
    if (metadata.image_digest !== candidate.image_manifest_list_digest) fail('app record digest does not match release metadata');
    const verifiedDigest = imageDigestFromRegistry(`${imageRepository}@${candidate.image_manifest_list_digest}`);
    if (verifiedDigest !== candidate.image_manifest_list_digest) fail('app record image digest is not present in the registry');
  } else {
    const metadataBytes = await assetBytes(release, metadataFile);
    const metadata = JSON.parse(metadataBytes.toString('utf8'));
    const digestMatch = /(?:^|\n)- Digest: (sha256:[a-f0-9]{64})(?:\n|$)/.exec(release.body ?? '');
    if (!digestMatch) fail('legacy release body must identify the published image digest');
    const actualDigest = imageDigestFromRegistry(`${imageRepository}:${version}`);
    if (actualDigest !== digestMatch[1]) fail('legacy release image digest does not match the published image');
    candidate = validateLegacyMetadataBytes(metadataBytes, {
      version,
      tag: release.tag_name,
      commit,
      reference: releaseReference(version, metadataFile),
      sha256: sha256(metadataBytes),
      format: 'legacy-release-metadata-v0',
      image_digest: digestMatch[1],
    });
    if (hint.reference && hint.reference !== candidate.reference) fail('dispatch legacy metadata reference does not match the published release');
    if (hint.sha256 && hint.sha256 !== candidate.sha256) fail('dispatch legacy metadata checksum does not match the published release');
    if (hint.format && hint.format !== candidate.format) fail('dispatch legacy metadata format does not match the published release');
  }
  return candidate;
}

function parseHint() {
  const value = process.env.EVENT_PAYLOAD || '{}';
  const payload = value === 'null' ? {} : JSON.parse(value);
  if (!isObject(payload)) fail('dispatch payload must be an object');
  if (!payload.app_version) return null;
  requireVersion(payload.app_version, 'dispatch app_version');
  return {
    tag: `pacman-v${payload.app_version}`,
    version: payload.app_version,
    reference: payload.app_record_ref,
    sha256: payload.app_record_sha256,
    format: payload.app_record_format,
  };
}

async function authoritativeCandidate(mode) {
  if (mode === 'rollback') {
    const reference = process.env.ROLLBACK_APP_RECORD_REF ?? '';
    const checksum = process.env.ROLLBACK_APP_RECORD_SHA256 ?? '';
    const reason = process.env.ROLLBACK_REASON?.trim() ?? '';
    if (!reference || !checksumPattern.test(checksum) || reason.length < 8) {
      fail('rollback requires an immutable app record reference, its SHA-256, and a reason of at least 8 characters');
    }
    const url = new URL(reference);
    if (url.origin !== 'https://github.com' || url.pathname.split('/').slice(1, 3).join('/') !== apiRepository) {
      fail('rollback app record must reference saintdle/pacman');
    }
    const tag = url.pathname.split('/')[5];
    if (!tag) fail('rollback app record reference must include a release tag');
    const release = await releaseByTag(tag);
    const candidate = await validateRelease(release, { reference, sha256: checksum });
    return { candidate, reason };
  }

  const hint = parseHint();
  if (hint) {
    const release = await releaseByTag(hint.tag);
    await validateRelease(release, hint);
  }
  const response = await github(`/repos/${apiRepository}/releases?per_page=100`);
  const releases = await response.json();
  const release = selectLatestAppRelease(releases);
  return { candidate: await validateRelease(release), reason: '' };
}

function readCurrentState() {
  const path = process.env.CURRENT_STATE_PATH;
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function createPlan() {
  const mode = process.env.PROMOTION_MODE || 'reconcile';
  if (!['reconcile', 'rollback', 'resume'].includes(mode)) fail('unsupported promotion mode');
  const { candidate, reason } = await authoritativeCandidate(mode);
  const current = {
    appVersion: process.env.CURRENT_APP_VERSION,
    imageDigest: process.env.CURRENT_IMAGE_DIGEST,
    chartVersion: process.env.CURRENT_CHART_VERSION,
  };
  const state = readCurrentState();
  const pendingAppVersion = process.env.PENDING_APP_VERSION || '';
  const pendingImageDigest = process.env.PENDING_IMAGE_DIGEST || '';
  const pendingChartVersion = process.env.PENDING_CHART_VERSION || '';
  if (state) {
    if (state.kind !== 'pacman-chart-promotion-state' || state.app?.version !== current.appVersion
      || state.app?.image_manifest_list_digest !== current.imageDigest || state.chart?.version !== current.chartVersion) {
      fail('promotion state does not match Chart.yaml and values.yaml');
    }
  }
  if (state?.mode === 'rollback' && mode !== 'resume' && mode !== 'rollback') {
    return { action: 'noop', reason: 'rollback-state-requires-explicit-resume' };
  }
  if (mode === 'rollback' && compareVersions(candidate.version, current.appVersion) >= 0) {
    fail('rollback target must be an older app release than the current promotion state');
  }
  if (mode === 'reconcile' && pendingAppVersion) {
    const pendingDecision = preservePendingPromotion({
      pendingAppVersion,
      pendingImageDigest,
      candidateAppVersion: candidate.version,
      candidateImageDigest: candidate.image_manifest_list_digest,
      pendingAppReference: process.env.PENDING_APP_RECORD_REFERENCE || undefined,
      pendingAppSha256: process.env.PENDING_APP_RECORD_SHA256 || undefined,
      pendingAppSourceCommit: process.env.PENDING_APP_SOURCE_COMMIT || undefined,
      candidateAppReference: candidate.reference,
      candidateAppSha256: candidate.sha256,
      candidateAppSourceCommit: candidate.source_commit,
    });
    if (pendingDecision) return { action: 'noop', reason: pendingDecision };
  }

  let chartVersionFloor = current.chartVersion;
  if (mode === 'reconcile' && pendingAppVersion && pendingChartVersion) {
    requireVersion(pendingChartVersion, 'pending chart version');
    if (compareVersions(pendingAppVersion, candidate.version) < 0
      && compareVersions(pendingChartVersion, chartVersionFloor) > 0) {
      chartVersionFloor = pendingChartVersion;
    }
  }

  const plan = mode === 'rollback'
    ? {
      promotion: 'update',
      reason: 'explicit-rollback-proposal',
      chartVersion: resolveNextChartVersion(candidate.version, chartVersionFloor, process.env.RELEASED_CHART_TAGS?.split(',').filter(Boolean)
        ?? execFileSync('git', ['tag', '--list', 'pacman-*'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)),
    }
    : planChartPromotion({
      appVersion: candidate.version,
      imageDigest: candidate.image_manifest_list_digest,
      currentAppVersion: current.appVersion,
      currentImageDigest: current.imageDigest,
      currentChartVersion: chartVersionFloor,
      appRecordReference: candidate.reference,
      appRecordSha256: candidate.sha256,
      appSourceCommit: candidate.source_commit,
      currentAppRecordReference: state?.app?.reference,
      currentAppRecordSha256: state?.app?.sha256,
      currentAppSourceCommit: state?.app?.source_commit,
      releasedTags: process.env.RELEASED_CHART_TAGS?.split(',').filter(Boolean)
        ?? execFileSync('git', ['tag', '--list', 'pacman-*'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean),
    });
  if (plan.promotion === 'noop') {
    if (mode === 'resume' && state?.mode === 'rollback') {
      return resumeRollbackProposal({ state, candidate, chartVersion: current.chartVersion });
    }
    return { action: 'noop', reason: plan.reason };
  }
  if (mode === 'rollback') return rollbackProposal({ candidate, chartVersion: plan.chartVersion, reason });
  return { action: 'promotion', reason: plan.reason, app: candidate, chart: { version: plan.chartVersion } };
}

function writeState(plan, outputPath) {
  if (plan.action === 'noop') return;
  const state = {
    schema_version: 1,
    kind: 'pacman-chart-promotion-state',
    mode: plan.action === 'rollback-proposal' ? 'rollback' : 'automatic',
    app: {
      version: plan.app.version,
      reference: plan.app.reference,
      sha256: plan.app.sha256,
      format: plan.app.format,
      source_repository: appRepository,
      source_commit: plan.app.source_commit,
      image_repository: plan.app.image_repository,
      image_manifest_list_digest: plan.app.image_manifest_list_digest,
      missing_evidence: plan.app.missing_evidence,
    },
    chart: { version: plan.chart.version },
  };
  if (plan.action === 'rollback-proposal') {
    state.rollback = { target_reference: plan.app.reference, target_sha256: plan.app.sha256, reason: plan.rollback_reason };
  }
  writeFileSync(outputPath, `${JSON.stringify(state, null, 2)}\n`);
}

async function main() {
  const [command, inputPath, outputPath] = process.argv.slice(2);
  if (command === 'filter-pending') {
    let state = null;
    try { state = JSON.parse(readFileSync(inputPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const proposals = JSON.parse(readFileSync(outputPath, 'utf8'));
    const selected = selectPendingProposalState({ state, pullRequests: proposals,
      branchSha: process.env.PENDING_BRANCH_SHA, baseSha: process.env.PENDING_BASE_SHA });
    writeFileSync(process.env.PENDING_FILTERED_PATH, `${JSON.stringify(selected, null, 2)}\n`);
    return;
  }
  if (command === 'plan') {
    const plan = await createPlan();
    writeFileSync(inputPath, `${JSON.stringify(plan, null, 2)}\n`);
    console.log(`action=${plan.action}`);
    console.log(`reason=${plan.reason}`);
    if (plan.app) console.log(`app_version=${plan.app.version}`);
    if (plan.chart) console.log(`chart_version=${plan.chart.version}`);
    return;
  }
  if (command === 'write-state') {
    const plan = JSON.parse(readFileSync(inputPath, 'utf8'));
    writeState(plan, outputPath);
    return;
  }
  fail('usage: pacman-promotion.mjs plan <output.json> | write-state <plan.json> <state.json>');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
