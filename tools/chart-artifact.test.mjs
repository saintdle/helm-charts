import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import test from 'node:test';
import { decodeArtifactPayload, prepareGeneratedPublication, verifyPacmanChartCandidate } from './chart-artifact.mjs';

const publisherWorkflow = readFileSync(new URL('../.github/workflows/chart-artifact-publish.yml', import.meta.url), 'utf8');
const repositoryRoot = path.resolve(new URL('..', import.meta.url).pathname);

function publisherWorkflowStep(name) {
  const marker = `      - name: ${name}\n`;
  const start = publisherWorkflow.indexOf(marker);
  assert.notEqual(start, -1, `publisher workflow must contain the ${name} step`);
  const end = publisherWorkflow.indexOf('\n      - name:', start + marker.length);
  return { start, text: publisherWorkflow.slice(start, end === -1 ? publisherWorkflow.length : end) };
}

function workflowRunBlock(step, name) {
  const marker = '        run: |\n';
  const start = step.text.indexOf(marker);
  assert.notEqual(start, -1, `${name} must use a multiline workflow run block`);
  const lines = step.text.slice(start + marker.length).split('\n');
  const script = [];
  for (const line of lines) {
    if (line === '') {
      script.push('');
      continue;
    }
    if (!line.startsWith('          ')) break;
    script.push(line.slice(10));
  }
  return script.join('\n').trimEnd();
}

function createGitCommit(repository, filename, content, message) {
  writeFileSync(join(repository, filename), content);
  execFileSync('git', ['-C', repository, 'add', filename]);
  execFileSync('git', ['-C', repository, 'commit', '--quiet', '-m', message], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Chart artifact workflow test',
      GIT_AUTHOR_EMAIL: 'chart-artifact-workflow-test@example.invalid',
      GIT_COMMITTER_NAME: 'Chart artifact workflow test',
      GIT_COMMITTER_EMAIL: 'chart-artifact-workflow-test@example.invalid',
    },
  });
  return execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function checkoutFixture(repository, directory, ref) {
  execFileSync('git', ['clone', '--quiet', '--no-checkout', repository, directory]);
  execFileSync('git', ['-C', directory, 'checkout', '--quiet', '--detach', ref]);
}

test('publisher workflow checks out the validated nested or flat source and blocks a missing or wrong codec checkout', () => {
  const validationStep = publisherWorkflowStep('Verify the exact Pac-Man main source candidate before checkout');
  const checkoutStep = publisherWorkflowStep('Check out only the authoritative release record codec');
  const guardStep = publisherWorkflowStep('Confirm checked-out codec source identity');
  const publishStep = publisherWorkflowStep('Publish immutable package, records, Pages index, and notification');
  const validationId = /^        id: ([\w-]+)$/m.exec(validationStep.text)?.[1];
  assert.ok(validationId, 'candidate validation must expose its decoded, verified source SHA');

  const validationRun = workflowRunBlock(validationStep, 'candidate validation');
  const guardRun = workflowRunBlock(guardStep, 'codec checkout guard');
  const checkoutRef = /^\s+ref: (.+)$/m.exec(checkoutStep.text)?.[1];
  assert.ok(checkoutRef, 'the codec checkout must declare its ref');
  const expectedShaExpression = /^\s+EXPECTED_CODEC_SHA: (.+)$/m.exec(guardStep.text)?.[1];
  assert.ok(expectedShaExpression, 'the checkout guard must receive the validated source SHA');
  assert.ok(guardStep.start < publishStep.start, 'the checkout identity guard must run before importing the codec or publishing');
  assert.match(publishStep.text, /PACMAN_RELEASE_RECORDS_CODEC: pacman-codec\/tools\/release-records\.js/);

  const outputExpressionValue = (expression, outputs) => {
    const match = /^\$\{\{\s*steps\.([^.]+)\.outputs\.([\w-]+)\s*\}\}$/.exec(expression.trim());
    assert.ok(match, `workflow ref must come from a step output, received ${expression}`);
    assert.equal(match[1], validationId, 'codec ref must come from candidate validation');
    assert.ok(Object.hasOwn(outputs, match[2]), `candidate validation must emit ${match[2]}`);
    return outputs[match[2]];
  };

  const directory = mkdtempSync(join(tmpdir(), 'pacman-codec-workflow-'));
  try {
    const sourceRepository = join(directory, 'source');
    mkdirSync(sourceRepository);
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', sourceRepository]);
    const sourceSha = createGitCommit(sourceRepository, 'codec.js', 'validated original source\n', 'validated original source');
    const trustedCurrentMainSha = createGitCommit(sourceRepository, 'codec.js', 'trusted current main\n', 'advance current main');
    assert.notEqual(sourceSha, trustedCurrentMainSha, 'fixture must distinguish the artifact source from trusted current main');

    const fakeBin = join(directory, 'bin');
    mkdirSync(fakeBin);
    const fakeNode = join(fakeBin, 'node');
    const outputPath = join(directory, 'github-output');
    const eventPath = join(directory, 'event.json');
    const fetchPreload = join(directory, 'mock-candidate-fetch.mjs');
    writeFileSync(fetchPreload, `
      globalThis.fetch = async (url) => {
        const sourceSha = process.env.MOCK_SOURCE_SHA;
        if (!String(url).includes('head_sha=' + sourceSha)) throw new Error('unexpected candidate validation request');
        return {
          ok: true,
          json: async () => ({ workflow_runs: [{
            id: 52,
            path: '.github/workflows/chart-ci.yml',
            head_sha: sourceSha,
            head_branch: 'main',
            event: 'push',
            status: 'completed',
            conclusion: 'success',
          }] }),
        };
      };
    `);
    writeFileSync(fakeNode, '#!/bin/sh\nexec "$REAL_NODE" --import "$NODE_PRELOAD" "$@"\n');
    chmodSync(fakeNode, 0o755);
    const validArtifact = {
      chart_name: 'pacman',
      chart_version: '0.7.20',
      app_version: '0.7.17',
      image_digest: `sha256:${'2a'.repeat(32)}`,
      source_repository: 'saintdle/pacman',
      source_commit: sourceSha,
      source_package_reference: 'https://github.com/saintdle/pacman/releases/download/pacman-v0.7.17/pacman-0.7.20.tgz',
      package_sha256: 'b'.repeat(64),
      app_record_reference: 'https://github.com/saintdle/pacman/releases/download/pacman-v0.7.17/app-release-record.json',
      app_record_sha256: 'c'.repeat(64),
      source_identity_reference: 'https://github.com/saintdle/pacman/releases/download/pacman-v0.7.17/pacman-0.7.20.tgz.identity.json',
      source_identity_sha256: 'd'.repeat(64),
    };
    const payloads = [
      ['nested v1 envelope', { schema_version: 1, artifact: validArtifact }],
      ['retained flat payload', validArtifact],
    ];

    const runValidationStep = (payload) => {
      writeFileSync(eventPath, JSON.stringify({ client_payload: payload }));
      writeFileSync(outputPath, '');
      const result = spawnSync('bash', ['-e', '-u', '-o', 'pipefail', '-c', validationRun], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: outputPath,
          GH_TOKEN: 'fixture-token',
          MOCK_SOURCE_SHA: sourceSha,
          REAL_NODE: process.execPath,
          NODE_PRELOAD: fetchPreload,
        },
        encoding: 'utf8',
      });
      return { result, outputs: readFileSync(outputPath, 'utf8') };
    };

    const runGuard = (workspace, expectedSha, marker) => spawnSync('bash', ['-e', '-u', '-o', 'pipefail', '-c', `${guardRun}\n: > "$PUBLISH_MARKER"`], {
      cwd: workspace,
      env: {
        ...process.env,
        EXPECTED_CODEC_SHA: expectedSha,
        GITHUB_WORKSPACE: workspace,
        PUBLISH_MARKER: marker,
      },
      encoding: 'utf8',
    });

    for (const [label, payload] of payloads) {
      const validation = runValidationStep(payload);
      assert.equal(validation.result.status, 0, `${label} validation step failed: ${validation.result.stderr}`);
      const outputs = Object.fromEntries(validation.outputs.trim().split('\n').map((line) => line.split('=')));
      const ref = outputExpressionValue(checkoutRef, outputs);
      const expectedSha = outputExpressionValue(expectedShaExpression, outputs);
      assert.equal(ref, sourceSha, `${label} codec checkout must not resolve to trusted current main`);
      assert.equal(expectedSha, sourceSha);

      const workspace = join(directory, `workspace-${label.replaceAll(' ', '-')}`);
      mkdirSync(workspace);
      checkoutFixture(sourceRepository, join(workspace, 'pacman-codec'), ref);
      const marker = join(workspace, 'publish-ran');
      const accepted = runGuard(workspace, expectedSha, marker);
      assert.equal(accepted.status, 0, `${label} exact codec checkout should pass: ${accepted.stderr}`);
      assert.ok(existsSync(marker), `${label} exact codec checkout should allow the following publish step`);
    }

    const missingSource = runValidationStep({});
    assert.notEqual(missingSource.result.status, 0, 'missing validated source must fail before checkout');
    assert.doesNotMatch(missingSource.outputs, /^source_sha=/m, 'missing source must not produce an empty checkout ref');

    const missingWorkspace = join(directory, 'missing-workspace');
    mkdirSync(missingWorkspace);
    const missingMarker = join(directory, 'missing-publish-ran');
    const missingCheckout = runGuard(missingWorkspace, sourceSha, missingMarker);
    assert.notEqual(missingCheckout.status, 0, 'a missing codec checkout must fail the workflow guard');
    assert.match(missingCheckout.stderr, /could not determine checked-out codec SHA/);
    assert.ok(!existsSync(missingMarker), 'a missing checkout must stop before publication');

    const wrongWorkspace = join(directory, 'wrong-workspace');
    mkdirSync(wrongWorkspace);
    checkoutFixture(sourceRepository, join(wrongWorkspace, 'pacman-codec'), trustedCurrentMainSha);
    const wrongMarker = join(directory, 'wrong-publish-ran');
    const wrongCheckout = runGuard(wrongWorkspace, sourceSha, wrongMarker);
    assert.notEqual(wrongCheckout.status, 0, 'a trusted-current-main checkout must fail when it differs from the artifact source');
    assert.match(wrongCheckout.stderr, /does not match validated source/);
    assert.ok(!existsSync(wrongMarker), 'a wrong codec checkout must stop before publication');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
