import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createPublicationRuntime, publishChart } from './chart-publication.mjs';

const identity = {
  name: 'pacman',
  version: '0.7.18',
  appVersion: '0.7.18',
  imageDigest: `sha256:${'b'.repeat(64)}`,
  sourceRepository: 'saintdle/helm-charts',
  sourceCommit: 'a'.repeat(40),
  distributionRepository: 'saintdle/helm-charts',
  distributionCommit: 'a'.repeat(40),
  pagesUrl: 'https://saintdle.github.io/helm-charts',
};

function checksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function indexFor(currentIdentity, bytes) {
  return {
    entries: {
      [currentIdentity.name]: [{
        name: currentIdentity.name,
        version: currentIdentity.version,
        appVersion: currentIdentity.appVersion,
        digest: checksum(bytes),
        urls: [`${currentIdentity.pagesUrl}/${currentIdentity.name}-${currentIdentity.version}.tgz`],
      }],
    },
  };
}

function generatedReleaseAssets(currentIdentity, bytes = Buffer.from('exact-package-bytes')) {
  const packageUrl = `https://github.com/${currentIdentity.distributionRepository}/releases/download/pacman-${currentIdentity.version}/${currentIdentity.name}-${currentIdentity.version}.tgz`;
  const recordUrl = `https://github.com/${currentIdentity.distributionRepository}/releases/download/pacman-${currentIdentity.version}/chart-release-record.json`;
  const chartRecord = {
    schema_version: 1,
    kind: 'chart-release',
    chart_version: currentIdentity.version,
    source: { repository: `https://github.com/${currentIdentity.sourceRepository}`, commit: currentIdentity.sourceCommit },
    package: { filename: `${currentIdentity.name}-${currentIdentity.version}.tgz`, immutable_url: packageUrl, sha256: checksum(bytes) },
    app_release: { reference: 'https://github.com/saintdle/pacman/releases/download/pacman-v0.7.18/app-release-record.json', sha256: 'd'.repeat(64) },
  };
  const chartRecordBytes = Buffer.from(`${JSON.stringify(chartRecord)}\n`);
  const lock = {
    schema_version: 1,
    kind: 'consumer-compatibility-lock',
    app: {},
    chart: {
      version: currentIdentity.version,
      reference: recordUrl,
      sha256: checksum(chartRecordBytes),
      package_reference: packageUrl,
      package_sha256: checksum(bytes),
      source_repository: `https://github.com/${currentIdentity.sourceRepository}`,
      source_commit: currentIdentity.sourceCommit,
    },
    supported_evidence_lanes: ['chart-package-sha256'],
  };
  return {
    'chart-release-record.json': chartRecordBytes,
    'consumer-compatibility-lock.json': Buffer.from(`${JSON.stringify(lock)}\n`),
  };
}

class PublicationApi {
  constructor({ failAfter = null, packageMetadata = null } = {}) {
    this.tagCommit = null;
    this.release = null;
    this.assetBytes = null;
    this.recordAssets = new Map();
    this.pages = { packageBytes: null, index: null };
    this.dispatches = [];
    this.failAfter = failAfter;
    this.failedOnce = false;
    this.packageMetadata = packageMetadata;
    this.calls = { tagCreate: 0, releaseCreate: 0, releasePublish: 0, assetUpload: 0, pagesPublish: 0, packageBuild: 0, publicRead: 0 };
  }

  async getTagCommit() { return this.tagCommit; }
  async createTag(_tag, commit) { this.calls.tagCreate += 1; this.tagCommit = commit; }
  async getRelease() { return this.release ? structuredClone(this.release) : null; }
  async createRelease(tag, details) {
    this.calls.releaseCreate += 1;
    this.release = { id: 1, tag_name: tag, draft: details.draft ?? false, prerelease: false, body: details.body };
    return structuredClone(this.release);
  }
  async publishRelease(_tag, body) {
    this.calls.releasePublish += 1;
    this.release.body = body;
    this.release.draft = false;
  }
  async getReleaseAsset(_tag, filename) {
    if (filename.endsWith('.tgz')) return this.assetBytes ? Buffer.from(this.assetBytes) : null;
    const bytes = this.recordAssets.get(filename);
    return bytes ? Buffer.from(bytes) : null;
  }
  async uploadReleaseAsset(_tag, filename, bytes) {
    this.calls.assetUpload += 1;
    if (filename.endsWith('.tgz')) this.assetBytes = Buffer.from(bytes);
    else this.recordAssets.set(filename, Buffer.from(bytes));
  }
  async buildPackage() { this.calls.packageBuild += 1; return Buffer.from('exact-package-bytes'); }
  async inspectPackage(bytes) {
    if (bytes.toString() === 'invalid-package') return { name: 'pacman', version: '0.7.99', appVersion: '0.7.99', imageDigest: `sha256:${'c'.repeat(64)}` };
    return this.packageMetadata ?? {
      name: identity.name, version: identity.version, appVersion: identity.appVersion, imageDigest: identity.imageDigest,
    };
  }
  async readPages() {
    return {
      packageBytes: this.pages.packageBytes ? Buffer.from(this.pages.packageBytes) : null,
      index: this.pages.index ? structuredClone(this.pages.index) : null,
    };
  }
  async publishPages({ identity: currentIdentity, packageBytes }) {
    this.calls.pagesPublish += 1;
    this.pages.packageBytes = Buffer.from(packageBytes);
    this.pages.index = indexFor(currentIdentity, packageBytes);
  }
  async readPublicPublication() {
    this.calls.publicRead += 1;
    return {
      packageBytes: this.pages.packageBytes ? Buffer.from(this.pages.packageBytes) : null,
      index: this.pages.index ? structuredClone(this.pages.index) : null,
    };
  }
  async sleep() {}
  async dispatchNotification(payload) { this.dispatches.push(structuredClone(payload)); }
  async checkpoint(stage) {
    if (!this.failedOnce && stage === this.failAfter) {
      this.failedOnce = true;
      throw new Error(`injected failure after ${stage}`);
    }
  }
}

test('retry repairs a legacy release with its exact existing asset and missing Pages package/index', async () => {
  const api = new PublicationApi();
  const immutableBytes = Buffer.from('original immutable legacy chart package');
  api.tagCommit = identity.distributionCommit;
  api.release = { id: 31, tag_name: 'pacman-0.7.18', draft: false, prerelease: false, body: 'Pac-Man Helm chart **0.7.18**.' };
  api.assetBytes = Buffer.from(immutableBytes);

  const result = await publishChart({ identity, api, retryDelayMs: 0 });

  assert.equal(result.releaseFormat, 'verified-legacy-release-v0');
  assert.equal(result.packageSha256, checksum(immutableBytes));
  assert.deepEqual(api.pages.packageBytes, immutableBytes);
  assert.equal(api.calls.packageBuild, 0);
  assert.equal(api.calls.releaseCreate, 0);
  assert.equal(api.calls.assetUpload, 0);
  assert.equal(api.calls.pagesPublish, 1);
  assert.equal(api.dispatches.length, 1);
});

for (const stage of ['tag', 'release', 'asset', 'index', 'public-checksum', 'notification']) {
  test(`retry resumes after injected ${stage} failure without duplicating publication`, async () => {
    const api = new PublicationApi({ failAfter: stage });
    await assert.rejects(publishChart({ identity, api, retryDelayMs: 0 }), new RegExp(`injected failure after ${stage}`));
    await publishChart({ identity, api, retryDelayMs: 0 });

    assert.equal(api.calls.tagCreate, 1);
    assert.equal(api.calls.releaseCreate, 1);
    assert.equal(api.calls.assetUpload, 1);
    assert.equal(api.calls.pagesPublish, 1);
    assert.deepEqual(api.pages.packageBytes, Buffer.from('exact-package-bytes'));
    assert.equal(api.dispatches.length, stage === 'notification' ? 2 : 1);
    if (stage === 'notification') assert.deepEqual(api.dispatches[0], api.dispatches[1]);
  });
}

test('repeated delivery reuses tag, release, asset, and Pages bytes while sending the same monotonic event', async () => {
  const api = new PublicationApi();
  await publishChart({ identity, api, retryDelayMs: 0 });
  const originalBytes = Buffer.from(api.assetBytes);
  await publishChart({ identity, api, retryDelayMs: 0 });

  assert.equal(api.calls.tagCreate, 1);
  assert.equal(api.calls.releaseCreate, 1);
  assert.equal(api.calls.assetUpload, 1);
  assert.equal(api.calls.pagesPublish, 1);
  assert.deepEqual(api.assetBytes, originalBytes);
  assert.deepEqual(api.pages.packageBytes, originalBytes);
  assert.deepEqual(api.dispatches[0], api.dispatches[1]);
  assert.deepEqual(api.dispatches[0], {
    event_type: 'pacman-chart-release',
    client_payload: {
      app_version: identity.appVersion,
      chart_version: identity.version,
      image_digest: identity.imageDigest,
      source_commit: identity.sourceCommit,
    },
  });
});

test('publication identity keeps source and distribution repositories independent', async () => {
  const generatedIdentity = {
    ...identity,
    sourceRepository: 'saintdle/pacman',
    sourceCommit: 'c'.repeat(40),
  };
  const api = new PublicationApi();
  const result = await publishChart({
    identity: generatedIdentity,
    candidateValidation: {
      sourceRepository: 'saintdle/pacman',
      sourceCommit: generatedIdentity.sourceCommit,
      ref: 'refs/heads/main',
      workflow: 'chart-ci.yml',
      event: 'push',
      conclusion: 'success',
    },
    releaseAssets: generatedReleaseAssets(generatedIdentity),
    api,
    retryDelayMs: 0,
  });

  assert.equal(api.tagCommit, generatedIdentity.distributionCommit);
  assert.match(api.release.body, new RegExp(`Source repository: https://github.com/${generatedIdentity.sourceRepository}`));
  assert.match(api.release.body, new RegExp(`Source commit: ${generatedIdentity.sourceCommit}`));
  assert.equal(result.sourceRepository, generatedIdentity.sourceRepository);
  assert.equal(api.dispatches[0].client_payload.source_commit, generatedIdentity.sourceCommit);
  assert.deepEqual([...api.recordAssets.keys()].sort(), ['chart-release-record.json', 'consumer-compatibility-lock.json']);
  assert.equal(api.calls.assetUpload, 3);
  assert.equal(api.dispatches[0].client_payload.source_repository, 'https://github.com/saintdle/pacman');
  assert.equal(api.dispatches[0].client_payload.package_sha256, checksum(api.assetBytes));
  assert.equal(api.dispatches[0].client_payload.chart_release_sha256, checksum(api.recordAssets.get('chart-release-record.json')));
  assert.equal(api.dispatches[0].client_payload.compatibility_lock_sha256, checksum(api.recordAssets.get('consumer-compatibility-lock.json')));
});

test('generated record assets are immutable and publication replay retains exact bytes', async () => {
  const generatedIdentity = { ...identity, sourceRepository: 'saintdle/pacman', sourceCommit: 'c'.repeat(40) };
  const candidateValidation = {
    sourceRepository: 'saintdle/pacman', sourceCommit: generatedIdentity.sourceCommit,
    ref: 'refs/heads/main', workflow: 'chart-ci.yml', event: 'push', conclusion: 'success',
  };
  const releaseAssets = generatedReleaseAssets(generatedIdentity);
  const api = new PublicationApi();
  await publishChart({ identity: generatedIdentity, candidateValidation, releaseAssets, api, retryDelayMs: 0 });
  const originalPackage = Buffer.from(api.assetBytes);
  const originalRecords = new Map([...api.recordAssets].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  await publishChart({ identity: generatedIdentity, candidateValidation, releaseAssets, api, retryDelayMs: 0 });

  assert.deepEqual(api.assetBytes, originalPackage);
  assert.deepEqual(api.recordAssets, originalRecords);
  assert.equal(api.calls.assetUpload, 3);
  assert.equal(api.calls.pagesPublish, 1);
  assert.equal(api.dispatches.length, 2);
  assert.deepEqual(api.dispatches[0], api.dispatches[1]);

  const changedRecordAssets = {
    ...releaseAssets,
    'chart-release-record.json': Buffer.from('changed record bytes'),
  };
  await assert.rejects(publishChart({ identity: generatedIdentity, candidateValidation, releaseAssets: changedRecordAssets, api, retryDelayMs: 0 }), /generated release record/);
  assert.equal(api.calls.pagesPublish, 1);
  assert.equal(api.dispatches.length, 2);
});

test('tag bound to another distribution commit stops before release or notification', async () => {
  const api = new PublicationApi();
  api.tagCommit = 'f'.repeat(40);
  await assert.rejects(publishChart({ identity, api, retryDelayMs: 0 }), /exact distribution commit/);
  assert.equal(api.calls.releaseCreate, 0);
  assert.equal(api.dispatches.length, 0);
});

test('inconsistent package metadata stops before creating a release or notifying', async () => {
  const api = new PublicationApi({ packageMetadata: { name: 'pacman', version: '0.7.99', appVersion: '0.7.99', imageDigest: `sha256:${'c'.repeat(64)}` } });
  await assert.rejects(publishChart({ identity, api, retryDelayMs: 0 }), /metadata does not match/);
  assert.equal(api.calls.releaseCreate, 0);
  assert.equal(api.dispatches.length, 0);
});

test('mismatched existing Pages package bytes are never overwritten or dispatched', async () => {
  const api = new PublicationApi();
  api.pages.packageBytes = Buffer.from('different package already at this version');
  await assert.rejects(publishChart({ identity, api, retryDelayMs: 0 }), /already exists with different bytes/);
  assert.equal(api.calls.pagesPublish, 0);
  assert.equal(api.dispatches.length, 0);
});

test('unavailable or inconsistent public package/index exhausts bounded retries without notification', async () => {
  const api = new PublicationApi();
  api.readPublicPublication = async () => {
    api.calls.publicRead += 1;
    return { packageBytes: Buffer.from('wrong public package'), index: null };
  };
  await assert.rejects(publishChart({ identity, api, publicAttempts: 3, retryDelayMs: 0 }), /failed verification after 3 attempts/);
  assert.equal(api.calls.publicRead, 3);
  assert.equal(api.dispatches.length, 0);
});

test('public package and index are retried until both become available', async () => {
  const api = new PublicationApi();
  api.readPublicPublication = async (...args) => {
    api.calls.publicRead += 1;
    if (api.calls.publicRead === 1) return { packageBytes: null, index: null };
    return {
      packageBytes: Buffer.from(api.pages.packageBytes),
      index: structuredClone(api.pages.index),
    };
  };

  await publishChart({ identity, api, publicAttempts: 3, retryDelayMs: 0 });

  assert.equal(api.calls.publicRead, 2);
  assert.equal(api.dispatches.length, 1);
});

test('generated package publication fails closed before effects when exact-SHA candidate validation is absent or mismatched', async () => {
  const generatedIdentity = {
    ...identity,
    sourceRepository: 'saintdle/pacman',
    sourceCommit: 'c'.repeat(40),
  };
  const invalidCandidates = [
    undefined,
    { sourceRepository: 'saintdle/pacman', sourceCommit: generatedIdentity.sourceCommit, workflow: 'chart-ci.yml', conclusion: 'failure' },
    { sourceRepository: 'saintdle/pacman', sourceCommit: 'd'.repeat(40), workflow: 'chart-ci.yml', conclusion: 'success' },
    { sourceRepository: 'saintdle/pacman', sourceCommit: generatedIdentity.sourceCommit, workflow: 'release.yml', conclusion: 'success' },
  ];

  for (const candidateValidation of invalidCandidates) {
    const api = new PublicationApi();
    await assert.rejects(
      publishChart({ identity: generatedIdentity, candidateValidation, releaseAssets: generatedReleaseAssets(generatedIdentity), api, retryDelayMs: 0 }),
      /exact pacman source SHA.*chart-ci\.yml.*success/i,
    );
    assert.deepEqual(api.calls, {
      tagCreate: 0, releaseCreate: 0, releasePublish: 0, assetUpload: 0,
      pagesPublish: 0, packageBuild: 0, publicRead: 0,
    });
    assert.equal(api.dispatches.length, 0);
  }
});

test('new release metadata rejects a changed source or package checksum on retry', async () => {
  const api = new PublicationApi();
  await publishChart({ identity, api, retryDelayMs: 0 });
  api.release.body = api.release.body.replace(identity.sourceCommit, 'f'.repeat(40));
  await assert.rejects(publishChart({ identity, api, retryDelayMs: 0 }), /source commit does not match/);
  assert.equal(api.dispatches.length, 1);

  api.release.body = api.release.body.replace('Source commit: ' + 'f'.repeat(40), `Source commit: ${identity.sourceCommit}`);
  api.release.body = api.release.body.replace(checksum(api.assetBytes), 'e'.repeat(64));
  await assert.rejects(publishChart({ identity, api, retryDelayMs: 0 }), /package sha-256 does not match/);
  assert.equal(api.dispatches.length, 1);
});

test('generated receiver calls the candidate validator and tested publication helper', () => {
  const workflow = readFileSync(new URL('../.github/workflows/chart-artifact-publish.yml', import.meta.url), 'utf8');
  assert.match(workflow, /node tools\/chart-artifact\.mjs validate-candidate/);
  assert.match(workflow, /node tools\/chart-artifact\.mjs publish/);
  assert.match(workflow, /node tools\/chart-authority\.mjs pacman/);
  assert.doesNotMatch(workflow, /gh release create|gh release upload|api\.github\.com\/repos\/saintdle\/pacman-for-k8s\/dispatches/);
});

test('production runtime normalizes identity before the adapter reads Pages files', async () => {
  const requestedFiles = [];
  const inputIdentity = { ...identity, filename: 'wrong.tgz', tag: 'wrong-tag' };
  const { identity: normalized, api } = createPublicationRuntime(inputIdentity, {
    token: 'stub-token',
    dispatchToken: 'stub-dispatch-token',
    run(command, args) {
      assert.deepEqual([command, ...args], ['git', 'fetch', '--no-tags', 'origin', 'refs/heads/gh-pages:refs/remotes/origin/gh-pages']);
      return '';
    },
    readGitFile(_ref, filename) {
      requestedFiles.push(filename);
      return filename === 'index.yaml' ? Buffer.from('index fixture') : Buffer.from('package fixture');
    },
    parseYaml(text) {
      assert.equal(text, 'index fixture');
      return { entries: {} };
    },
    fetch: async () => { throw new Error('unexpected network request in read-only adapter test'); },
  });

  const pages = await api.readPages();

  assert.equal(normalized.filename, 'pacman-0.7.18.tgz');
  assert.equal(normalized.tag, 'pacman-0.7.18');
  assert.deepEqual(requestedFiles, ['index.yaml', normalized.filename]);
  assert.equal(pages.packageBytes.toString(), 'package fixture');
  assert.deepEqual(pages.index, { entries: {} });
});

test('retry after draft release creation seals the exact generated package bytes', async () => {
  const generatedIdentity = {
    ...identity,
    sourceRepository: 'saintdle/pacman',
    sourceCommit: 'c'.repeat(40),
  };
  const packageBytes = Buffer.from('exact package from the validated Pac-Man source artifact');
  const api = new PublicationApi({ failAfter: 'release' });
  api.buildPackage = async () => {
    api.calls.packageBuild += 1;
    return Buffer.from(packageBytes);
  };

  const publication = {
    identity: generatedIdentity,
    candidateValidation: {
      sourceRepository: 'saintdle/pacman',
      sourceCommit: generatedIdentity.sourceCommit,
      ref: 'refs/heads/main',
      workflow: 'chart-ci.yml',
      event: 'push',
      conclusion: 'success',
    },
    releaseAssets: generatedReleaseAssets(generatedIdentity, packageBytes),
    api,
    retryDelayMs: 0,
  };

  await assert.rejects(publishChart(publication), /injected failure after release/);
  assert.equal(api.release.draft, true);
  assert.equal(api.assetBytes, null);
  assert.equal(api.dispatches.length, 0);
  await publishChart(publication);

  assert.equal(api.release.draft, false);
  assert.equal(api.calls.packageBuild, 2);
  assert.equal(api.calls.assetUpload, 3);
  assert.equal(api.calls.releasePublish, 1);
  assert.equal(api.release.body.includes(`Package SHA-256: ${checksum(packageBytes)}`), true);
  assert.deepEqual(api.assetBytes, packageBytes);
  assert.deepEqual(api.pages.packageBytes, packageBytes);
  assert.equal(api.pages.index.entries.pacman[0].digest, checksum(packageBytes));
  assert.equal(api.dispatches.length, 1);
});
