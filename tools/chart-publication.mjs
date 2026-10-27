import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const commitPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const checksumPattern = /^[a-f0-9]{64}$/;
const apiBase = 'https://api.github.com';
const uploadBase = 'https://uploads.github.com';

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateIdentity(identity) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(identity.name ?? '')) fail('chart name is invalid');
  if (!versionPattern.test(identity.version ?? '')) fail('chart version must be canonical MAJOR.MINOR.PATCH');
  if (!versionPattern.test(identity.appVersion ?? '')) fail('app version must be canonical MAJOR.MINOR.PATCH');
  if (!digestPattern.test(identity.imageDigest ?? '')) fail('image digest must be a SHA-256 digest');
  for (const [name, value] of [['source commit', identity.sourceCommit], ['distribution commit', identity.distributionCommit]]) {
    if (!commitPattern.test(value ?? '')) fail(`${name} must be a full lowercase commit SHA`);
  }
  for (const [name, value] of [['source repository', identity.sourceRepository], ['distribution repository', identity.distributionRepository]]) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) fail(`${name} must be owner/repository`);
  }
  if (identity.sourceRepository === identity.distributionRepository && identity.sourceCommit !== identity.distributionCommit) {
    fail('source and distribution commits must match when they are the same repository');
  }
  let pagesUrl;
  try { pagesUrl = new URL(identity.pagesUrl); }
  catch { fail('Pages URL must be an HTTPS URL'); }
  if (pagesUrl.protocol !== 'https:' || pagesUrl.username || pagesUrl.password || pagesUrl.search || pagesUrl.hash) {
    fail('Pages URL must be a credential-free HTTPS URL without query or fragment');
  }
  const tag = `${identity.name}-${identity.version}`;
  const filename = `${tag}.tgz`;
  return {
    ...identity,
    tag,
    filename,
    pagesUrl: pagesUrl.toString().replace(/\/$/, ''),
    packageUrl: `${pagesUrl.toString().replace(/\/$/, '')}/${filename}`,
  };
}

function releaseNotes(identity, packageChecksum) {
  return [
    `Pac-Man Helm chart **${identity.version}**.`,
    '',
    `Source repository: https://github.com/${identity.sourceRepository}`,
    `Source commit: ${identity.sourceCommit}`,
    `Distribution repository: https://github.com/${identity.distributionRepository}`,
    `Distribution commit: ${identity.distributionCommit}`,
    `Chart version: ${identity.version}`,
    `Package: ${identity.filename}`,
    `Package SHA-256: ${packageChecksum}`,
    '',
    '### Install',
    '```sh',
    `helm repo add saintdle ${identity.pagesUrl}`,
    'helm repo update',
    `helm install pacman saintdle/pacman --version ${identity.version}`,
    '```',
  ].join('\n');
}

function draftReleaseNotes(identity) {
  return [
    `Pac-Man Helm chart **${identity.version}**.`,
    '',
    `Source repository: https://github.com/${identity.sourceRepository}`,
    `Source commit: ${identity.sourceCommit}`,
    `Distribution repository: https://github.com/${identity.distributionRepository}`,
    `Distribution commit: ${identity.distributionCommit}`,
    `Chart version: ${identity.version}`,
    `Package: ${identity.filename}`,
  ].join('\n');
}

function releaseEvidence(release, identity, packageChecksum, { allowDraft = false } = {}) {
  if (!release || release.tag_name !== identity.tag || release.prerelease || (release.draft && !allowDraft)) {
    fail(`release ${identity.tag} is missing, unpublished, or bound to a different tag`);
  }
  const labels = [
    'Source repository', 'Source commit', 'Distribution repository', 'Distribution commit',
    'Chart version', 'Package', 'Package SHA-256',
  ];
  const found = Object.fromEntries(labels.map((label) => {
    const line = (release.body ?? '').split('\n').find((item) => item.startsWith(`${label}: `));
    return [label, line?.slice(label.length + 2)];
  }));
  const present = Object.values(found).filter((value) => value !== undefined).length;
  if (release.draft) {
    const identityLabels = labels.slice(0, -1);
    if (present !== identityLabels.length || found['Package SHA-256'] !== undefined) {
      fail(`draft release ${identity.tag} has incomplete or premature package metadata`);
    }
    const expected = {
      'Source repository': `https://github.com/${identity.sourceRepository}`,
      'Source commit': identity.sourceCommit,
      'Distribution repository': `https://github.com/${identity.distributionRepository}`,
      'Distribution commit': identity.distributionCommit,
      'Chart version': identity.version,
      Package: identity.filename,
    };
    for (const label of identityLabels) {
      if (found[label] !== expected[label]) fail(`draft release ${identity.tag} ${label.toLowerCase()} does not match the immutable publication`);
    }
    return { format: 'pending-chart-publication-v1', missingEvidence: ['package-sha256', 'published-release'] };
  }
  if (present === 0) {
    if (identity.sourceRepository !== identity.distributionRepository
      || identity.sourceCommit !== identity.distributionCommit) {
      fail(`legacy release ${identity.tag} has no source identity evidence for the separate source repository`);
    }
    return { format: 'verified-legacy-release-v0', missingEvidence: labels };
  }
  if (present !== labels.length) fail(`release ${identity.tag} has incomplete immutable publication metadata`);
  const expected = {
    'Source repository': `https://github.com/${identity.sourceRepository}`,
    'Source commit': identity.sourceCommit,
    'Distribution repository': `https://github.com/${identity.distributionRepository}`,
    'Distribution commit': identity.distributionCommit,
    'Chart version': identity.version,
    Package: identity.filename,
    'Package SHA-256': packageChecksum ?? found['Package SHA-256'],
  };
  for (const label of labels) {
    if (found[label] !== expected[label]) fail(`release ${identity.tag} ${label.toLowerCase()} does not match the immutable publication`);
  }
  if (!checksumPattern.test(found['Package SHA-256'])) fail(`release ${identity.tag} package checksum is invalid`);
  return { format: 'chart-publication-v1', missingEvidence: [] };
}

function verifyPackageMetadata(metadata, identity) {
  if (!metadata || metadata.name !== identity.name || metadata.version !== identity.version
    || metadata.appVersion !== identity.appVersion || metadata.imageDigest !== identity.imageDigest) {
    fail(`chart package ${identity.filename} metadata does not match its source, tag, and promotion payload`);
  }
}

function indexHasPackage(index, identity, packageChecksum) {
  if (!index || !Array.isArray(index.entries?.[identity.name])) return false;
  const matches = index.entries[identity.name].filter((entry) => entry.version === identity.version);
  if (matches.length !== 1) return false;
  const [entry] = matches;
  return entry.name === identity.name
    && entry.appVersion === identity.appVersion
    && entry.digest === packageChecksum
    && Array.isArray(entry.urls)
    && entry.urls.includes(identity.packageUrl);
}

function assertGeneratedSourceCandidate(identity, candidateValidation) {
  if (identity.sourceRepository === identity.distributionRepository) return;
  if (identity.sourceRepository !== 'saintdle/pacman'
    || candidateValidation?.sourceRepository !== 'saintdle/pacman'
    || candidateValidation?.sourceCommit !== identity.sourceCommit
    || candidateValidation?.ref !== 'refs/heads/main'
    || candidateValidation?.workflow !== 'chart-ci.yml'
    || candidateValidation?.event !== 'push'
    || candidateValidation?.conclusion !== 'success') {
    fail('exact pacman source SHA validation must use chart-ci.yml on refs/heads/main and finish with success');
  }
}

function validateGeneratedReleaseAssets(releaseAssets, identity, packageChecksum) {
  if (!releaseAssets || typeof releaseAssets !== 'object') fail('generated publication requires a chart release record and compatibility lock');
  const chartRecordBytes = Buffer.from(releaseAssets['chart-release-record.json'] ?? '');
  const lockBytes = Buffer.from(releaseAssets['consumer-compatibility-lock.json'] ?? '');
  let chartRecord;
  let lock;
  try {
    chartRecord = JSON.parse(chartRecordBytes.toString('utf8'));
    lock = JSON.parse(lockBytes.toString('utf8'));
  } catch {
    fail('generated release record and compatibility lock must be valid JSON');
  }
  const packageUrl = `https://github.com/${identity.distributionRepository}/releases/download/${identity.tag}/${identity.filename}`;
  const recordUrl = `https://github.com/${identity.distributionRepository}/releases/download/${identity.tag}/chart-release-record.json`;
  if (chartRecord.schema_version !== 1 || chartRecord.kind !== 'chart-release'
    || chartRecord.chart_version !== identity.version
    || chartRecord.source?.repository !== `https://github.com/${identity.sourceRepository}`
    || chartRecord.source?.commit !== identity.sourceCommit
    || chartRecord.package?.filename !== identity.filename
    || chartRecord.package?.immutable_url !== packageUrl
    || chartRecord.package?.sha256 !== packageChecksum) {
    fail('generated chart-release record does not pin the exact source, version, immutable package URL, and checksum');
  }
  if (lock.schema_version !== 1 || lock.kind !== 'consumer-compatibility-lock'
    || lock.chart?.version !== identity.version
    || lock.chart?.reference !== recordUrl
    || lock.chart?.sha256 !== sha256(chartRecordBytes)
    || lock.chart?.package_reference !== packageUrl
    || lock.chart?.package_sha256 !== packageChecksum
    || lock.chart?.source_repository !== `https://github.com/${identity.sourceRepository}`
    || lock.chart?.source_commit !== identity.sourceCommit) {
    fail('generated compatibility lock does not pin the exact chart record, package, source, and version');
  }
  return {
    'chart-release-record.json': chartRecordBytes,
    'consumer-compatibility-lock.json': lockBytes,
  };
}

async function ensureImmutableReleaseAsset(api, tag, filename, proposedBytes) {
  let existing = await api.getReleaseAsset(tag, filename);
  if (existing && !Buffer.from(existing).equals(proposedBytes)) fail(`release asset ${filename} already exists with different bytes`);
  if (!existing) {
    await api.uploadReleaseAsset(tag, filename, proposedBytes);
    existing = await api.getReleaseAsset(tag, filename);
  }
  if (!existing || !Buffer.from(existing).equals(proposedBytes)) fail(`release asset ${filename} was not stored with the exact proposed bytes`);
}

async function checkpoint(api, stage) {
  await api.checkpoint?.(stage);
}

export async function publishChart({ identity: inputIdentity, api, candidateValidation, releaseAssets, publicAttempts = 5, retryDelayMs = 5000 }) {
  if (!api) fail('publication API is required');
  if (!Number.isInteger(publicAttempts) || publicAttempts < 1) fail('publicAttempts must be a positive integer');
  const identity = validateIdentity(inputIdentity);
  assertGeneratedSourceCandidate(identity, candidateValidation);
  let generatedAssets = null;
  let generatedPackageBytes = null;
  if (identity.sourceRepository !== identity.distributionRepository) {
    if (typeof api.buildPackage !== 'function' || typeof api.inspectPackage !== 'function') fail('generated publication requires package validation');
    generatedPackageBytes = Buffer.from(await api.buildPackage(identity));
    verifyPackageMetadata(await api.inspectPackage(generatedPackageBytes), identity);
    generatedAssets = validateGeneratedReleaseAssets(releaseAssets, identity, sha256(generatedPackageBytes));
  }

  let tagCommit = await api.getTagCommit(identity.tag);
  if (tagCommit === null) {
    await api.createTag(identity.tag, identity.distributionCommit);
    tagCommit = await api.getTagCommit(identity.tag);
  }
  if (tagCommit !== identity.distributionCommit) fail(`tag ${identity.tag} does not point at the exact distribution commit`);
  await checkpoint(api, 'tag');

  let release = await api.getRelease(identity.tag);
  let asset = release ? await api.getReleaseAsset(identity.tag, identity.filename) : null;
  let packageBytes = null;
  let packageChecksum = null;
  if (!release && !asset) {
    packageBytes = generatedPackageBytes ?? Buffer.from(await api.buildPackage(identity));
    if (!generatedPackageBytes) verifyPackageMetadata(await api.inspectPackage(packageBytes), identity);
    packageChecksum = sha256(packageBytes);
  }
  if (!release) {
    release = await api.createRelease(identity.tag, {
      title: `pacman ${identity.version}`,
      body: draftReleaseNotes(identity),
      distributionCommit: identity.distributionCommit,
      draft: true,
    });
    if (!release) release = await api.getRelease(identity.tag);
  }
  releaseEvidence(release, identity, packageChecksum, { allowDraft: true });
  await checkpoint(api, 'release');

  if (!asset) {
    if (!packageBytes) {
      packageBytes = generatedPackageBytes ?? Buffer.from(await api.buildPackage(identity));
      if (!generatedPackageBytes) verifyPackageMetadata(await api.inspectPackage(packageBytes), identity);
      packageChecksum = sha256(packageBytes);
    }
    releaseEvidence(release, identity, packageChecksum, { allowDraft: true });
    await api.uploadReleaseAsset(identity.tag, identity.filename, packageBytes);
    asset = await api.getReleaseAsset(identity.tag, identity.filename);
  }
  if (!asset) fail(`release asset ${identity.filename} was not available after upload`);
  const exactPackageBytes = Buffer.from(asset);
  const assetChecksum = sha256(exactPackageBytes);
  if (packageBytes && assetChecksum !== sha256(packageBytes)) fail(`release asset ${identity.filename} changed during upload`);
  verifyPackageMetadata(await api.inspectPackage(exactPackageBytes), identity);
  if (release.draft) {
    await api.publishRelease(identity.tag, releaseNotes(identity, assetChecksum));
    release = await api.getRelease(identity.tag);
  }
  releaseEvidence(release, identity, assetChecksum);
  await checkpoint(api, 'asset');

  if (generatedAssets) {
    for (const [filename, bytes] of Object.entries(generatedAssets)) {
      await ensureImmutableReleaseAsset(api, identity.tag, filename, bytes);
    }
    await checkpoint(api, 'records');
  }

  let pages = await api.readPages(identity);
  if (pages.packageBytes && sha256(Buffer.from(pages.packageBytes)) !== assetChecksum) {
    fail(`Pages package ${identity.filename} already exists with different bytes`);
  }
  if (!pages.packageBytes || !indexHasPackage(pages.index, identity, assetChecksum)) {
    await api.publishPages({ identity, packageBytes: exactPackageBytes, packageChecksum: assetChecksum });
    pages = await api.readPages(identity);
  }
  if (!pages.packageBytes || sha256(Buffer.from(pages.packageBytes)) !== assetChecksum
    || !indexHasPackage(pages.index, identity, assetChecksum)) {
    fail(`Pages package or index for ${identity.tag} is not consistent with the immutable release asset`);
  }
  await checkpoint(api, 'index');

  let verifiedPublic = false;
  let lastPublicError = 'public package or Helm index is unavailable';
  for (let attempt = 1; attempt <= publicAttempts; attempt += 1) {
    try {
      const publication = await api.readPublicPublication(identity);
      if (publication?.packageBytes && sha256(Buffer.from(publication.packageBytes)) === assetChecksum
        && indexHasPackage(publication.index, identity, assetChecksum)) {
        verifiedPublic = true;
        break;
      }
      lastPublicError = 'public package checksum or Helm index does not match the immutable release asset';
    } catch (error) {
      lastPublicError = error.message;
    }
    if (attempt < publicAttempts) await api.sleep(retryDelayMs);
  }
  if (!verifiedPublic) fail(`public publication for ${identity.tag} failed verification after ${publicAttempts} attempts: ${lastPublicError}`);
  await checkpoint(api, 'public-checksum');

  const payload = {
    event_type: 'pacman-chart-release',
    client_payload: {
      app_version: identity.appVersion,
      chart_version: identity.version,
      image_digest: identity.imageDigest,
      source_commit: identity.sourceCommit,
      ...(generatedAssets ? {
        source_repository: `https://github.com/${identity.sourceRepository}`,
        package_reference: `https://github.com/${identity.distributionRepository}/releases/download/${identity.tag}/${identity.filename}`,
        package_sha256: assetChecksum,
        chart_release_reference: `https://github.com/${identity.distributionRepository}/releases/download/${identity.tag}/chart-release-record.json`,
        chart_release_sha256: sha256(generatedAssets['chart-release-record.json']),
        compatibility_lock_reference: `https://github.com/${identity.distributionRepository}/releases/download/${identity.tag}/consumer-compatibility-lock.json`,
        compatibility_lock_sha256: sha256(generatedAssets['consumer-compatibility-lock.json']),
      } : {}),
    },
  };
  await api.dispatchNotification(payload);
  await checkpoint(api, 'notification');

  return {
    tag: identity.tag,
    package: identity.filename,
    packageSha256: assetChecksum,
    sourceRepository: identity.sourceRepository,
    sourceCommit: identity.sourceCommit,
    releaseFormat: releaseEvidence(release, identity, assetChecksum).format,
    publicUrl: identity.packageUrl,
  };
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options }).trim();
}

function parseYaml(yaml) {
  return JSON.parse(run('yq', ['-o=json', '.'], { input: yaml }));
}

function gitFile(ref, filename) {
  try { return execFileSync('git', ['show', `${ref}:${filename}`]); }
  catch (error) {
    if (error.status !== 128) throw error;
    return null;
  }
}

export function createLiveAdapter(inputIdentity, dependencies = {}) {
  const identity = validateIdentity(inputIdentity);
  const command = dependencies.run ?? run;
  const readGitFile = dependencies.readGitFile ?? gitFile;
  const parseDocument = dependencies.parseYaml ?? parseYaml;
  const fetchRequest = dependencies.fetch ?? fetch;
  const token = dependencies.token ?? process.env.GH_TOKEN;
  const dispatchToken = dependencies.dispatchToken ?? process.env.RELEASE_AUTOMATION_TOKEN;
  const repo = identity.distributionRepository;
  if (!token) fail('GH_TOKEN is required to repair the GitHub release');
  if (!dispatchToken) fail('RELEASE_AUTOMATION_TOKEN is required to notify pacman-for-k8s');

  async function request(url, { allowNotFound = false, ...options } = {}) {
    const response = await fetchRequest(url, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.headers ?? {}),
      },
    });
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`GitHub API ${response.status}: ${detail}`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  async function getRelease(tag) {
    return request(`${apiBase}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { allowNotFound: true });
  }

  async function inspectPackage(bytes) {
    const directory = mkdtempSync(join(tmpdir(), 'pacman-chart-inspect-'));
    const path = join(directory, 'package.tgz');
    try {
      writeFileSync(path, bytes);
      const chart = parseDocument(command('helm', ['show', 'chart', path]));
      const values = parseDocument(command('helm', ['show', 'values', path]));
      return { name: chart.name, version: chart.version, appVersion: String(chart.appVersion), imageDigest: values.image?.digest };
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }

  async function fetchPublic(url) {
    const response = await fetchRequest(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    });
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  }

  return {
    async getTagCommit(tag) {
      const output = command('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
      const refs = new Map(output.split('\n').filter(Boolean).map((line) => {
        const [sha, ref] = line.split(/\s+/);
        return [ref, sha];
      }));
      return refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`) ?? null;
    },
    async createTag(tag, commit) {
      let localCommit = null;
      try { localCommit = command('git', ['rev-parse', '--verify', `refs/tags/${tag}^{}`]); }
      catch (error) { if (error.status !== 128) throw error; }
      if (localCommit && localCommit !== commit) fail(`local tag ${tag} already points at a different commit`);
      if (!localCommit) command('git', ['tag', tag, commit]);
      try { command('git', ['push', 'origin', `refs/tags/${tag}`]); }
      catch (error) {
        if (await this.getTagCommit(tag) !== commit) throw error;
      }
    },
    getRelease,
    async createRelease(tag, details) {
      const body = {
        tag_name: tag,
        target_commitish: details.distributionCommit,
        name: details.title,
        body: details.body,
        draft: details.draft ?? false,
        prerelease: false,
      };
      try { return await request(`${apiBase}/repos/${repo}/releases`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }); }
      catch (error) {
        const existing = await getRelease(tag);
        if (existing) return existing;
        throw error;
      }
    },
    async publishRelease(tag, body) {
      const release = await getRelease(tag);
      if (!release) fail(`draft release ${tag} disappeared before publication`);
      await request(`${apiBase}/repos/${repo}/releases/${release.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ draft: false, body }),
        headers: { 'Content-Type': 'application/json' },
      });
    },
    async getReleaseAsset(tag, filename) {
      const release = await getRelease(tag);
      if (!release) return null;
      const assets = release.assets.filter((asset) => asset.name === filename);
      if (assets.length > 1) fail(`release ${tag} has multiple assets named ${filename}`);
      if (!assets.length) return null;
      const response = await fetch(assets[0].url, { headers: { Accept: 'application/octet-stream', Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`could not download ${filename} from release ${tag}: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
    async uploadReleaseAsset(tag, filename, bytes) {
      const release = await getRelease(tag);
      if (!release) fail(`release ${tag} disappeared before asset upload`);
      const url = `${uploadBase}/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(filename)}`;
      try {
        await request(url, { method: 'POST', body: bytes, headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/gzip' } });
      } catch (error) {
        if (!(await this.getReleaseAsset(tag, filename))) throw error;
      }
    },
    async buildPackage(currentIdentity) {
      const head = command('git', ['rev-parse', 'HEAD']);
      if (head !== currentIdentity.distributionCommit) fail('checkout is not the exact distribution commit requested for this publication');
      if (currentIdentity.sourceRepository !== currentIdentity.distributionRepository
        || currentIdentity.sourceCommit !== currentIdentity.distributionCommit) {
        fail('the legacy Helm package builder only accepts a same-repository source; generated packages must provide their own builder');
      }
      const directory = mkdtempSync(join(tmpdir(), 'pacman-chart-package-'));
      try {
        command('helm', ['package', `charts/${currentIdentity.name}`, '-d', directory]);
        return readFileSync(join(directory, currentIdentity.filename));
      } finally { rmSync(directory, { recursive: true, force: true }); }
    },
    inspectPackage,
    async readPages() {
      command('git', ['fetch', '--no-tags', 'origin', 'refs/heads/gh-pages:refs/remotes/origin/gh-pages']);
      const ref = 'refs/remotes/origin/gh-pages';
      const indexBytes = readGitFile(ref, 'index.yaml');
      const packageBytes = readGitFile(ref, identity.filename);
      return {
        index: indexBytes ? parseDocument(indexBytes.toString('utf8')) : null,
        packageBytes,
      };
    },
    async publishPages({ identity: currentIdentity, packageBytes }) {
      command('git', ['fetch', '--no-tags', 'origin', 'refs/heads/gh-pages:refs/remotes/origin/gh-pages']);
      const parent = mkdtempSync(join(tmpdir(), 'pacman-gh-pages-'));
      const directory = join(parent, 'checkout');
      try {
        command('git', ['worktree', 'add', '--detach', directory, 'refs/remotes/origin/gh-pages']);
        const target = join(directory, currentIdentity.filename);
        try {
          const previous = readFileSync(target);
          if (sha256(previous) !== sha256(packageBytes)) fail(`gh-pages branch already has different bytes for ${currentIdentity.filename}`);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          writeFileSync(target, packageBytes);
        }
        command('helm', ['repo', 'index', directory, '--url', currentIdentity.pagesUrl, '--merge', join(directory, 'index.yaml')]);
        command('git', ['-C', directory, 'config', 'user.name', 'github-actions[bot]']);
        command('git', ['-C', directory, 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
        command('git', ['-C', directory, 'add', currentIdentity.filename, 'index.yaml']);
        if (command('git', ['-C', directory, 'status', '--porcelain'])) {
          command('git', ['-C', directory, 'commit', '-m', `Publish pacman ${currentIdentity.version} [skip ci]`]);
          command('git', ['-C', directory, 'push', 'origin', 'HEAD:refs/heads/gh-pages']);
        }
      } finally {
        rmSync(parent, { recursive: true, force: true });
        try { command('git', ['worktree', 'prune']); } catch { /* The action workspace is disposable. */ }
      }
    },
    async readPublicPublication(currentIdentity) {
      const [indexBytes, packageBytes] = await Promise.all([
        fetchPublic(`${currentIdentity.pagesUrl}/index.yaml`),
        fetchPublic(currentIdentity.packageUrl),
      ]);
      return { index: indexBytes ? parseYaml(indexBytes.toString('utf8')) : null, packageBytes };
    },
    sleep: (duration) => new Promise((resolvePromise) => setTimeout(resolvePromise, duration)),
    async dispatchNotification(payload) {
      const response = await fetchRequest(`${apiBase}/repos/saintdle/pacman-for-k8s/dispatches`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${dispatchToken}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`promotion notification failed: HTTP ${response.status}`);
    },
  };
}

export function createPublicationRuntime(inputIdentity, adapterDependencies = {}) {
  const identity = validateIdentity(inputIdentity);
  const api = createLiveAdapter(identity, adapterDependencies);
  return { identity, api };
}

async function main() {
  const identity = {
    name: process.env.CHART_NAME,
    version: process.env.CHART_VERSION,
    appVersion: process.env.APP_VERSION,
    imageDigest: process.env.IMAGE_DIGEST,
    sourceRepository: process.env.CHART_SOURCE_REPOSITORY,
    sourceCommit: process.env.CHART_SOURCE_COMMIT,
    distributionRepository: process.env.GITHUB_REPOSITORY,
    distributionCommit: process.env.GITHUB_SHA,
    pagesUrl: process.env.PAGES_URL,
  };
  const { identity: normalizedIdentity, api } = createPublicationRuntime(identity);
  const result = await publishChart({ identity: normalizedIdentity, api });
  console.log(`published ${result.tag} ${result.package} sha256:${result.packageSha256} (${result.releaseFormat})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
