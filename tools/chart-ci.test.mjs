import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/chart-ci.yml', import.meta.url), 'utf8');
const lifecycle = readFileSync(new URL('./check-pacman-lifecycle.sh', import.meta.url), 'utf8');
const repositoryRoot = path.resolve(new URL('..', import.meta.url).pathname);

test('required manifests aggregates all chart contracts and both database lifecycle lanes', () => {
  assert.match(workflow, /^  manifests:\n[\s\S]*?needs: \[detect, chart-contracts, candidate-identity, lifecycle\]/m);
  assert.match(workflow, /^  manifests:\n[\s\S]*?if: always\(\)/m);

  for (const contract of [
    'check-pacman-probes.sh',
    'check-pacman-postgres-migration.sh',
    'check-pacman-fault-demo.sh',
    'check-pacman-optional-resources.sh',
  ]) {
    assert.match(workflow, new RegExp(`bash tools/${contract.replaceAll('.', '\\.')}`));
  }

  assert.match(workflow, /database: \[mongo, postgres\]/);
  assert.match(workflow, /run: bash tools\/check-pacman-lifecycle\.sh "\$CHART_DIR" pacman-source "\$DATABASE" "\$EXPECTED_SOURCE_SHA"/);
});

test('lifecycle candidate identity accepts the promoted commit and rejects a mismatch before Docker', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pacman-lifecycle-identity-'));
  try {
    const source = path.join(directory, 'source');
    const fakeBin = path.join(directory, 'bin');
    const dockerTrace = path.join(directory, 'docker-called');
    mkdirSync(source);
    mkdirSync(fakeBin);
    execFileSync('git', ['init', '--quiet', source]);
    writeFileSync(path.join(source, 'candidate.txt'), 'promoted candidate\n');
    execFileSync('git', ['-C', source, 'add', 'candidate.txt']);
    execFileSync('git', ['-C', source, 'commit', '--quiet', '-m', 'candidate'], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Chart CI test',
        GIT_AUTHOR_EMAIL: 'chart-ci-test@example.invalid',
        GIT_COMMITTER_NAME: 'Chart CI test',
        GIT_COMMITTER_EMAIL: 'chart-ci-test@example.invalid',
      },
    });
    const sourceSha = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dockerStub = path.join(fakeBin, 'docker');
    writeFileSync(dockerStub, '#!/bin/sh\nprintf called >> "$DOCKER_TRACE"\nprintf unsupported\n');
    chmodSync(dockerStub, 0o755);

    const env = {
      ...process.env,
      DOCKER_TRACE: dockerTrace,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    };
    const run = (expectedSha) => spawnSync('bash', [
      new URL('./check-pacman-lifecycle.sh', import.meta.url).pathname,
      'charts/pacman', source, 'mongo', expectedSha,
    ], { cwd: repositoryRoot, env, encoding: 'utf8' });

    const accepted = run(sourceSha);
    assert.notEqual(accepted.status, 0);
    assert.match(accepted.stderr, /unsupported Docker server architecture/);
    assert.ok(existsSync(dockerTrace), 'matching promoted source should reach Docker after identity validation');

    rmSync(dockerTrace, { force: true });
    const rejected = run('a'.repeat(40));
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /does not match promoted source/);
    assert.ok(!existsSync(dockerTrace), 'mismatched source must fail before Docker is invoked');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('lifecycle helper does not pin an unrelated source commit', () => {
  assert.match(lifecycle, /candidate_sha_actual="\$\(git -C "\$candidate_dir" rev-parse HEAD\)"/);
  assert.match(lifecycle, /candidate_sha_expected/);
  assert.doesNotMatch(lifecycle, /e05647623417f620ec0b156c9e7551ec5ad040dd/);
});
