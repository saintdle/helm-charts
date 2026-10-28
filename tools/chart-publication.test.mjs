import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createPublicationRuntime, encodeGeneratedReleaseNotification, publishChart } from './chart-publication.mjs';

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

test('existing partial draft with changed immutable identity stops before asset upload or notification', async () => {
  const api = new PublicationApi({ failAfter: 'release' });
  await assert.rejects(publishChart({ identity, api, retryDelayMs: 0 }), /injected failure after release/);
  assert.equal(api.release.draft, true);

  api.release.body = api.release.body.replace(identity.sourceCommit, 'f'.repeat(40));
  await assert.rejects(publishChart({ identity, api, retryDelayMs: 0 }), /source commit does not match the immutable publication/);
  assert.equal(api.calls.assetUpload, 0);
  assert.equal(api.calls.pagesPublish, 0);
  assert.equal(api.dispatches.length, 0);
});

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
  assert.equal(api.dispatches[0].client_payload.release.source_commit, generatedIdentity.sourceCommit);
  assert.deepEqual([...api.recordAssets.keys()].sort(), ['chart-release-record.json', 'consumer-compatibility-lock.json']);
  assert.equal(api.calls.assetUpload, 3);
  assert.equal(api.dispatches[0].client_payload.release.source_repository, 'https://github.com/saintdle/pacman');
  assert.equal(api.dispatches[0].client_payload.release.package_sha256, checksum(api.assetBytes));
  assert.equal(api.dispatches[0].client_payload.release.chart_release_sha256, checksum(api.recordAssets.get('chart-release-record.json')));
  assert.equal(api.dispatches[0].client_payload.release.compatibility_lock_sha256, checksum(api.recordAssets.get('consumer-compatibility-lock.json')));
  assert.equal(Object.keys(api.dispatches[0].client_payload.release).length, 11);
  assert.deepEqual(api.dispatches[0].client_payload, {
    schema_version: 1,
    release: {
      app_version: generatedIdentity.appVersion,
      chart_version: generatedIdentity.version,
      image_digest: generatedIdentity.imageDigest,
      source_commit: generatedIdentity.sourceCommit,
      source_repository: 'https://github.com/saintdle/pacman',
      package_reference: `https://github.com/saintdle/helm-charts/releases/download/pacman-${generatedIdentity.version}/pacman-${generatedIdentity.version}.tgz`,
      package_sha256: checksum(api.assetBytes),
      chart_release_reference: `https://github.com/saintdle/helm-charts/releases/download/pacman-${generatedIdentity.version}/chart-release-record.json`,
      chart_release_sha256: checksum(api.recordAssets.get('chart-release-record.json')),
      compatibility_lock_reference: `https://github.com/saintdle/helm-charts/releases/download/pacman-${generatedIdentity.version}/consumer-compatibility-lock.json`,
      compatibility_lock_sha256: checksum(api.recordAssets.get('consumer-compatibility-lock.json')),
    },
  });
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

test('default public readiness wait covers delayed Pages availability before notification', async () => {
  const api = new PublicationApi();
  const becomesAvailableAt = 120_000;
  let fakeTime = 0;
  let notificationTime = null;
  api.now = () => fakeTime;
  api.sleep = async (duration) => { fakeTime += duration; };
  api.dispatchNotification = async (payload) => {
    notificationTime = fakeTime;
    api.dispatches.push(structuredClone(payload));
  };
  api.readPublicPublication = async () => {
    api.calls.publicRead += 1;
    if (fakeTime < becomesAvailableAt) return { packageBytes: null, index: null };
    return {
      packageBytes: Buffer.from(api.pages.packageBytes),
      index: structuredClone(api.pages.index),
    };
  };

  const result = await publishChart({ identity, api });

  assert.equal(result.packageSha256, checksum(api.assetBytes));
  assert.ok(api.calls.publicRead > 5, 'the default must outlast the previous five-attempt window');
  assert.ok(fakeTime >= becomesAvailableAt);
  assert.ok(notificationTime >= becomesAvailableAt, 'notification must wait for exact public availability');
  assert.equal(api.dispatches.length, 1);
});

test('default public readiness wait checks the final interval despite modest timer drift', async () => {
  const api = new PublicationApi();
  const becomesAvailableAt = 599_000;
  let fakeTime = 0;
  let notificationTime = null;
  api.now = () => fakeTime;
  api.sleep = async (duration) => {
    fakeTime += duration;
    if (fakeTime === 600_000) fakeTime += 750;
  };
  api.dispatchNotification = async (payload) => {
    notificationTime = fakeTime;
    api.dispatches.push(structuredClone(payload));
  };
  api.readPublicPublication = async () => {
    api.calls.publicRead += 1;
    if (fakeTime < becomesAvailableAt) return { packageBytes: null, index: null };
    return {
      packageBytes: Buffer.from(api.pages.packageBytes),
      index: structuredClone(api.pages.index),
    };
  };

  const result = await publishChart({ identity, api });

  assert.equal(result.packageSha256, checksum(api.assetBytes));
  assert.equal(api.calls.publicRead, 61);
  assert.equal(fakeTime, 600_750);
  assert.ok(notificationTime >= becomesAvailableAt, 'notification must follow the final exact public check');
  assert.equal(api.dispatches.length, 1);
});

test('public readiness wait fails closed at its deadline without notification', async () => {
  const api = new PublicationApi();
  let fakeTime = 0;
  api.now = () => fakeTime;
  api.sleep = async (duration) => { fakeTime += duration; };
  api.readPublicPublication = async () => {
    api.calls.publicRead += 1;
    return { packageBytes: null, index: null };
  };

  await assert.rejects(
    publishChart({ identity, api, retryDelayMs: 10000, publicWaitMs: 30000 }),
    /failed verification after 4 attempts/,
  );
  assert.equal(fakeTime, 30000);
  assert.equal(api.calls.publicRead, 4);
  assert.equal(api.dispatches.length, 0);
});

test('invalid readiness bounds fail before publication side effects', async () => {
  for (const options of [
    { publicAttempts: 0 },
    { publicAttempts: 62 },
    { retryDelayMs: -1 },
    { retryDelayMs: Number.POSITIVE_INFINITY },
    { publicWaitMs: 0 },
    { publicWaitMs: 600001 },
  ]) {
    const api = new PublicationApi();
    await assert.rejects(publishChart({ identity, api, ...options }), /publicAttempts|retryDelayMs|publicWaitMs/);
    assert.equal(api.calls.tagCreate, 0);
    assert.equal(api.calls.releaseCreate, 0);
    assert.equal(api.dispatches.length, 0);
  }
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

test('workflow calls the tested production helper instead of a separate publication path', () => {
  const workflow = readFileSync(new URL('../.github/workflows/chart-release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /run: node tools\/chart-publication\.mjs/);
  assert.doesNotMatch(workflow, /steps\.guard\.outputs\.already/);
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

test('production adapter discovers an existing draft through paginated releases after tag lookup returns 404', async () => {
  const requested = [];
  const draft = {
    id: 42,
    tag_name: identity.tag ?? `${identity.name}-${identity.version}`,
    draft: true,
    prerelease: false,
    body: 'pinned draft identity',
    assets: [],
  };
  const olderReleases = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    tag_name: `older-${index + 1}`,
    draft: false,
    prerelease: false,
    assets: [],
  }));
  const pageTwo = 'https://api.github.com/repos/saintdle/helm-charts/releases?per_page=100&page=2';
  const { api } = createPublicationRuntime(identity, {
    token: 'stub-token',
    dispatchToken: 'stub-dispatch-token',
    fetch: async (url, options) => {
      requested.push({ url: String(url), options });
      if (String(url).endsWith('/releases/tags/pacman-0.7.18')) {
        return new Response('Not Found', { status: 404 });
      }
      if (String(url) === 'https://api.github.com/repos/saintdle/helm-charts/releases?per_page=100&page=1') {
        return new Response(JSON.stringify(olderReleases), {
          status: 200,
          headers: { Link: `<${pageTwo}>; rel="next"` },
        });
      }
      if (String(url) === pageTwo) return new Response(JSON.stringify([draft]), { status: 200 });
      throw new Error(`unexpected fixture request: ${url}`);
    },
  });

  const release = await api.getRelease('pacman-0.7.18');

  assert.deepEqual(release, draft);
  assert.equal(requested.length, 3);
  assert.equal(requested[1].options.headers.Authorization, 'Bearer stub-token');
  assert.equal(requested[2].url, pageTwo);
});

test('production adapter uses the published tag endpoint for replay and does not list drafts', async () => {
  const requested = [];
  const published = {
    id: 43,
    tag_name: 'pacman-0.7.18',
    draft: false,
    prerelease: false,
    body: 'published identity',
    assets: [],
  };
  const { api } = createPublicationRuntime(identity, {
    token: 'stub-token',
    dispatchToken: 'stub-dispatch-token',
    fetch: async (url) => {
      requested.push(String(url));
      if (String(url).endsWith('/releases/tags/pacman-0.7.18')) {
        return new Response(JSON.stringify(published), { status: 200 });
      }
      throw new Error(`unexpected fixture request: ${url}`);
    },
  });

  assert.deepEqual(await api.getRelease('pacman-0.7.18'), published);
  assert.equal(requested.length, 1);
});

test('production repository_dispatch rejects the old 11-field payload and accepts the bounded v1 envelope', async () => {
  const requests = [];
  const { api } = createPublicationRuntime(identity, {
    token: 'fixture-token',
    dispatchToken: 'fixture-dispatch-token',
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      return new Response(null, { status: 204 });
    },
  });
  const release = {
    app_version: '0.7.17',
    chart_version: '0.7.20',
    image_digest: `sha256:${'2a'.repeat(32)}`,
    source_commit: 'a405d8d66d63c8d121ed993f55583a6ff634c86d',
    source_repository: 'https://github.com/saintdle/pacman',
    package_reference: 'https://github.com/saintdle/helm-charts/releases/download/pacman-0.7.20/pacman-0.7.20.tgz',
    package_sha256: '1'.repeat(64),
    chart_release_reference: 'https://github.com/saintdle/helm-charts/releases/download/pacman-0.7.20/chart-release-record.json',
    chart_release_sha256: '2'.repeat(64),
    compatibility_lock_reference: 'https://github.com/saintdle/helm-charts/releases/download/pacman-0.7.20/consumer-compatibility-lock.json',
    compatibility_lock_sha256: '3'.repeat(64),
  };

  await assert.rejects(api.dispatchNotification({
    event_type: 'pacman-chart-release',
    client_payload: release,
  }), /10 top-level properties/);
  assert.equal(requests.length, 0, 'the old 11-field request must be rejected before network access');

  const notification = encodeGeneratedReleaseNotification(release);
  await api.dispatchNotification(notification);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.github.com/repos/saintdle/pacman-for-k8s/dispatches');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body), notification);
  assert.equal(Object.keys(JSON.parse(requests[0].options.body).client_payload.release).length, 11);
  assert.ok(Buffer.byteLength(requests[0].options.body, 'utf8') < 65_536);

  await assert.rejects(api.dispatchNotification({
    event_type: 'pacman-chart-release',
    client_payload: { schema_version: 1, release: { ...release, extra: 'é'.repeat(33_000) } },
  }), /UTF-8 bytes/);
  assert.equal(requests.length, 1, 'oversized request must be rejected before network access');
});

test('production repository_dispatch errors include only method, endpoint, and status', async () => {
  const { api } = createPublicationRuntime(identity, {
    token: 'fixture-token',
    dispatchToken: 'fixture-dispatch-token',
    fetch: async () => new Response('fixture response with secret text', { status: 422 }),
  });

  await assert.rejects(api.dispatchNotification({
    event_type: 'pacman-chart-release',
    client_payload: { app_version: identity.appVersion, chart_version: identity.version, image_digest: identity.imageDigest, source_commit: identity.sourceCommit },
  }), (error) => {
    assert.match(error.message, /POST \/repos\/saintdle\/pacman-for-k8s\/dispatches/);
    assert.match(error.message, /HTTP 422/);
    assert.doesNotMatch(error.message, /fixture response with secret text|fixture-dispatch-token/);
    return true;
  });
});

test('production adapter fails closed on duplicate draft matches before publication or notification', async () => {
  const writes = [];
  const draft = {
    id: 44,
    tag_name: 'pacman-0.7.18',
    draft: true,
    prerelease: false,
    body: 'pinned draft identity',
    assets: [],
  };
  const { api } = createPublicationRuntime(identity, {
    token: 'stub-token',
    dispatchToken: 'stub-dispatch-token',
    run(command, args) {
      assert.deepEqual([command, ...args], [
        'git', 'ls-remote', '--tags', 'origin', 'refs/tags/pacman-0.7.18', 'refs/tags/pacman-0.7.18^{}',
      ]);
      return `${identity.distributionCommit}\trefs/tags/pacman-0.7.18`;
    },
    fetch: async (url, options = {}) => {
      if (String(url).endsWith('/releases/tags/pacman-0.7.18')) return new Response('Not Found', { status: 404 });
      if (String(url).includes('/releases?')) return new Response(JSON.stringify([
        draft,
        { ...draft, id: 45, body: 'conflicting duplicate identity' },
      ]), { status: 200 });
      writes.push({ url: String(url), method: options.method ?? 'GET' });
      return new Response('{}', { status: 200 });
    },
  });

  await assert.rejects(publishChart({ identity, api, retryDelayMs: 0 }), /multiple releases found for tag pacman-0\.7\.18/);
  assert.deepEqual(writes, []);
});

test('production adapter propagates lookup and listing authorization or server failures', async () => {
  for (const scenario of [
    { tagStatus: 403, listStatus: null, expectedStatus: 403, requests: 1 },
    { tagStatus: 404, listStatus: 503, expectedStatus: 503, requests: 2 },
  ]) {
    const requested = [];
    const { api } = createPublicationRuntime(identity, {
      token: 'stub-token',
      dispatchToken: 'stub-dispatch-token',
      fetch: async (url) => {
        requested.push(String(url));
        if (String(url).endsWith('/releases/tags/pacman-0.7.18')) {
          return new Response('fixture failure', { status: scenario.tagStatus });
        }
        return new Response('fixture failure', { status: scenario.listStatus });
      },
    });

    await assert.rejects(api.getRelease('pacman-0.7.18'), new RegExp(`GitHub API ${scenario.expectedStatus}`));
    assert.equal(requested.length, scenario.requests);
  }
});

test('production adapter recovers an empty existing draft through upload, publish, Pages verification, then notification', async () => {
  const tag = `${identity.name}-${identity.version}`;
  const filename = `${tag}.tgz`;
  const assetUrl = 'https://api.github.com/repos/saintdle/helm-charts/releases/assets/99';
  const packageBytes = Buffer.from('exact pinned package bytes');
  const events = [];
  const release = {
    id: 77,
    tag_name: tag,
    draft: true,
    prerelease: false,
    body: [
      `Pac-Man Helm chart **${identity.version}**.`, '',
      `Source repository: https://github.com/${identity.sourceRepository}`,
      `Source commit: ${identity.sourceCommit}`,
      `Distribution repository: https://github.com/${identity.distributionRepository}`,
      `Distribution commit: ${identity.distributionCommit}`,
      `Chart version: ${identity.version}`,
      `Package: ${filename}`,
    ].join('\n'),
    assets: [],
  };
  let packageCreated = false;
  let releaseCreateAttempted = false;
  let uploadedBytes = null;
  let pagesPackage = null;
  let pagesIndex = null;
  let pagesPublished = false;

  const { identity: normalizedIdentity, api } = createPublicationRuntime(identity, {
    token: 'fixture-token',
    dispatchToken: 'fixture-dispatch-token',
    run(command, args) {
      if (command === 'git' && args[0] === 'ls-remote') return `${identity.distributionCommit}\trefs/tags/${tag}`;
      if (command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') return identity.distributionCommit;
      if (command === 'git' && args[0] === 'fetch') return '';
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') { mkdirSync(args[3], { recursive: true }); return ''; }
      if (command === 'git' && args[0] === '-C' && args[2] === 'status') return ' M index.yaml';
      if (command === 'git' && args[0] === '-C' && args[2] === 'push') { pagesPublished = true; events.push('pages-published'); return ''; }
      if (command === 'git') return '';
      if (command === 'helm' && args[0] === 'package') {
        writeFileSync(join(args[3], filename), packageBytes);
        return '';
      }
      if (command === 'helm' && args[0] === 'show' && args[1] === 'chart') {
        return `name: pacman\nversion: ${identity.version}\nappVersion: "${identity.appVersion}"`;
      }
      if (command === 'helm' && args[0] === 'show' && args[1] === 'values') {
        return `image:\n  digest: ${identity.imageDigest}`;
      }
      if (command === 'helm' && args[0] === 'repo' && args[1] === 'index') {
        pagesPackage = readFileSync(join(args[2], filename));
        pagesIndex = indexFor(identity, pagesPackage);
        writeFileSync(join(args[2], 'index.yaml'), JSON.stringify(pagesIndex));
        packageCreated = true;
        return '';
      }
      throw new Error(`unexpected fixture command: ${command} ${args.join(' ')}`);
    },
    readGitFile(_ref, filenameRead) {
      if (!pagesPublished) return null;
      if (filenameRead === 'index.yaml') return Buffer.from(JSON.stringify(pagesIndex));
      if (filenameRead === filename) return Buffer.from(pagesPackage);
      return null;
    },
    parseYaml(text) {
      if (text.startsWith('{')) return JSON.parse(text);
      if (text.startsWith('name:')) return {
        name: text.match(/^name:\s*(\S+)/m)?.[1],
        version: text.match(/^version:\s*(\S+)/m)?.[1],
        appVersion: text.match(/^appVersion:\s*["']?(\S+?)["']?\s*$/m)?.[1],
      };
      return { image: { digest: text.match(/^\s+digest:\s*(\S+)/m)?.[1] } };
    },
    fetch: async (url, options = {}) => {
      const target = String(url);
      const method = options.method ?? 'GET';
      if (target.endsWith(`/releases/tags/${tag}`)) {
        return release.draft
          ? new Response('Not Found', { status: 404 })
          : new Response(JSON.stringify(release), { status: 200 });
      }
      if (target.includes('/releases?')) return new Response(JSON.stringify([release]), { status: 200 });
      if (target === 'https://api.github.com/repos/saintdle/helm-charts/releases' && method === 'POST') {
        releaseCreateAttempted = true;
        return new Response(JSON.stringify({ ...release, id: 78 }), { status: 201 });
      }
      if (target.startsWith('https://uploads.github.com/') && method === 'POST') {
        assert.equal(target, `https://uploads.github.com/repos/saintdle/helm-charts/releases/${release.id}/assets?name=${filename}`);
        uploadedBytes = Buffer.from(options.body);
        release.assets = [{ name: filename, url: assetUrl }];
        events.push('asset-uploaded');
        return new Response(JSON.stringify(release.assets[0]), { status: 201 });
      }
      if (target === assetUrl) return new Response(packageBytes, { status: 200 });
      if (target.endsWith(`/releases/${release.id}`) && method === 'PATCH') {
        const patchBody = JSON.parse(options.body);
        release.draft = false;
        release.body = patchBody.body;
        events.push('release-published');
        return new Response(JSON.stringify(release), { status: 200 });
      }
      if (target === `${identity.pagesUrl}/index.yaml`) {
        events.push('public-index-read');
        return pagesPublished ? new Response(JSON.stringify(pagesIndex), { status: 200 }) : new Response('', { status: 404 });
      }
      if (target === normalizedIdentity.packageUrl) {
        events.push('public-package-read');
        return pagesPublished ? new Response(pagesPackage, { status: 200 }) : new Response('', { status: 404 });
      }
      if (target.endsWith('/dispatches') && method === 'POST') {
        events.push('notification');
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fixture request: ${method} ${target}`);
    },
  });

  const result = await publishChart({ identity, api, retryDelayMs: 0 });

  assert.equal(result.releaseFormat, 'chart-publication-v1');
  assert.equal(packageCreated, true);
  assert.equal(releaseCreateAttempted, false);
  assert.deepEqual(uploadedBytes, packageBytes);
  assert.equal(release.draft, false);
  assert.match(release.body, new RegExp(`Package SHA-256: ${checksum(packageBytes)}`));
  assert.deepEqual(pagesPackage, packageBytes);
  assert.equal(pagesIndex.entries.pacman[0].digest, checksum(packageBytes));
  assert.ok(events.indexOf('asset-uploaded') < events.indexOf('release-published'));
  assert.ok(events.indexOf('release-published') < events.indexOf('pages-published'));
  assert.ok(events.indexOf('pages-published') < events.indexOf('public-index-read'));
  assert.ok(events.indexOf('pages-published') < events.indexOf('public-package-read'));
  assert.ok(events.indexOf('public-index-read') < events.indexOf('notification'));
  assert.ok(events.indexOf('public-package-read') < events.indexOf('notification'));
});

test('delayed retry after draft release creation seals the exact pinned Helm package bytes', async () => {
  const helm = process.env.PACMAN_TEST_HELM ?? 'helm';
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const chartYaml = readFileSync(join(root, 'charts/pacman/Chart.yaml'), 'utf8');
  const valuesYaml = readFileSync(join(root, 'charts/pacman/values.yaml'), 'utf8');
  const version = chartYaml.match(/^version:\s*(\S+)/m)?.[1];
  const appVersion = chartYaml.match(/^appVersion:\s*["']?(\S+?)["']?\s*$/m)?.[1];
  const imageDigest = valuesYaml.match(/^\s+digest:\s*["']?(sha256:[a-f0-9]{64})["']?\s*$/m)?.[1];
  assert.ok(version && appVersion && imageDigest, 'chart metadata required for the real Helm package fixture');
  const distributionCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const realIdentity = {
    ...identity,
    version,
    appVersion,
    imageDigest,
    sourceCommit: distributionCommit,
    distributionCommit,
  };
  const runRealHelm = (command, args, options = {}) => {
    if (command === 'git' && args[0] === 'rev-parse') return distributionCommit;
    if (command === 'helm') return execFileSync(helm, args, { cwd: root, encoding: 'utf8', ...options }).trim();
    throw new Error(`unexpected local adapter command: ${command} ${args.join(' ')}`);
  };
  const parseHelmYaml = (text) => {
    if (/^name:\s*pacman\s*$/m.test(text)) {
      return {
        name: text.match(/^name:\s*(\S+)/m)?.[1],
        version: text.match(/^version:\s*(\S+)/m)?.[1],
        appVersion: text.match(/^appVersion:\s*["']?(\S+?)["']?\s*$/m)?.[1],
      };
    }
    return { image: { digest: text.match(/^\s+digest:\s*["']?(sha256:[a-f0-9]{64})["']?\s*$/m)?.[1] } };
  };
  const builder = createPublicationRuntime(realIdentity, {
    token: 'stub-token',
    dispatchToken: 'stub-dispatch-token',
    run: runRealHelm,
    parseYaml: parseHelmYaml,
  }).api;
  const api = new PublicationApi({ failAfter: 'release' });
  const builtPackageHashes = [];
  api.buildPackage = async (currentIdentity) => {
    api.calls.packageBuild += 1;
    const bytes = await builder.buildPackage(currentIdentity);
    builtPackageHashes.push(checksum(bytes));
    return bytes;
  };
  api.inspectPackage = builder.inspectPackage.bind(builder);

  await assert.rejects(publishChart({ identity: realIdentity, api, retryDelayMs: 0 }), /injected failure after release/);
  assert.equal(api.release.draft, true);
  assert.equal(api.assetBytes, null);
  assert.equal(api.dispatches.length, 0);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2100));
  await publishChart({ identity: realIdentity, api, retryDelayMs: 0 });

  assert.equal(api.release.draft, false);
  assert.equal(api.calls.packageBuild, 2);
  assert.notEqual(builtPackageHashes[0], builtPackageHashes[1], 'Helm 3.16.4 archive bytes should change across the delayed rebuild');
  assert.equal(api.calls.assetUpload, 1);
  assert.equal(api.calls.releasePublish, 1);
  assert.equal(api.release.body.includes(`Package SHA-256: ${checksum(api.assetBytes)}`), true);
  assert.deepEqual(api.pages.packageBytes, api.assetBytes);
  assert.equal(api.dispatches.length, 1);
});
