import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/chart-ci.yml', import.meta.url), 'utf8');
const lifecycle = readFileSync(new URL('./check-pacman-lifecycle.sh', import.meta.url), 'utf8');
const repositoryRoot = path.resolve(new URL('..', import.meta.url).pathname);

function workflowRunBlock(name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `Chart CI must contain the ${name} step`);
  const stepEnd = workflow.indexOf('\n      - name:', start + marker.length);
  const step = workflow.slice(start, stepEnd === -1 ? workflow.length : stepEnd);
  const runMarker = '        run: |\n';
  const runStart = step.indexOf(runMarker);
  assert.notEqual(runStart, -1, `${name} must use a multiline run block`);
  const lines = step.slice(runStart + runMarker.length).split('\n');
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

test('required manifests aggregates all chart contracts and both database lifecycle lanes', () => {
  assert.match(workflow, /^  manifests:\n[\s\S]*?needs: \[detect, chart-contracts, candidate-identity, lifecycle, promotion-state-regression\]/m);
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

test('required manifests runs artifact and publication transport suites when helpers or publisher workflow change', () => {
  assert.match(workflow, /publisher_transport_changed: \$\{\{ steps\.detect\.outputs\.publisher_transport_changed \}\}/);
  assert.match(workflow, /git diff --quiet FETCH_HEAD -- tools\/chart-artifact\.mjs tools\/chart-artifact\.test\.mjs tools\/chart-publication\.mjs tools\/chart-publication\.test\.mjs tools\/chart-ci\.test\.mjs \.github\/workflows\/chart-ci\.yml \.github\/workflows\/chart-artifact-publish\.yml/);
  assert.match(workflow, /Set up Helm\n\s+if: needs\.detect\.outputs\.changed == 'true' \|\| needs\.detect\.outputs\.publisher_transport_changed == 'true'/);
  assert.match(workflow, /name: Set up Node\.js for publisher transport suites\n\s+if: needs\.detect\.outputs\.publisher_transport_changed == 'true'/);
  assert.match(workflow, /name: Run artifact and publication transport suites\n\s+if: needs\.detect\.outputs\.publisher_transport_changed == 'true'\n\s+run: node --test tools\/chart-artifact\.test\.mjs tools\/chart-publication\.test\.mjs/);
  assert.match(workflow, /^  manifests:\n[\s\S]*?name: Run artifact and publication transport suites/m);
});

test('publisher-workflow-only change selects the existing required manifests transport suites', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pacman-chart-ci-selector-'));
  try {
    const remote = path.join(directory, 'origin.git');
    const candidate = path.join(directory, 'candidate');
    const output = path.join(directory, 'github-output');
    execFileSync('git', ['init', '--quiet', '--bare', remote]);
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', candidate]);
    execFileSync('git', ['-C', candidate, 'config', 'user.name', 'Chart CI selector test']);
    execFileSync('git', ['-C', candidate, 'config', 'user.email', 'chart-ci-selector-test@example.invalid']);
    execFileSync('git', ['-C', candidate, 'remote', 'add', 'origin', remote]);
    const publisherWorkflowPath = path.join(candidate, '.github/workflows/chart-artifact-publish.yml');
    mkdirSync(path.dirname(publisherWorkflowPath), { recursive: true });
    writeFileSync(publisherWorkflowPath, 'name: original publisher workflow\n');
    execFileSync('git', ['-C', candidate, 'add', '.github/workflows/chart-artifact-publish.yml']);
    execFileSync('git', ['-C', candidate, 'commit', '--quiet', '-m', 'base publisher workflow']);
    execFileSync('git', ['-C', candidate, 'push', '--quiet', '-u', 'origin', 'main']);

    writeFileSync(publisherWorkflowPath, 'name: updated publisher workflow\n');
    execFileSync('git', ['-C', candidate, 'commit', '--quiet', '-am', 'change publisher workflow']);
    const changedPaths = execFileSync('git', ['-C', candidate, 'diff', '--name-only', 'origin/main', 'HEAD'], { encoding: 'utf8' });
    assert.equal(changedPaths.trim(), '.github/workflows/chart-artifact-publish.yml');

    const detectRun = workflowRunBlock('Detect chart contract change').replaceAll('${{ github.base_ref }}', 'main');
    writeFileSync(output, '');
    const result = spawnSync('bash', ['-e', '-u', '-o', 'pipefail', '-c', detectRun], {
      cwd: candidate,
      env: { ...process.env, CHART_DIR: 'charts/pacman', GITHUB_OUTPUT: output },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `Chart CI change detection failed: ${result.stderr}`);
    assert.deepEqual(
      Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map((line) => line.split('='))),
      { changed: 'false', promotion_state_changed: 'false', publisher_transport_changed: 'true' },
    );

    assert.match(workflow, /name: Run artifact and publication transport suites\n\s+if: needs\.detect\.outputs\.publisher_transport_changed == 'true'\n\s+run: node --test tools\/chart-artifact\.test\.mjs tools\/chart-publication\.test\.mjs/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('promotion-state regression selects both promotion and Chart CI contract tests', () => {
  const paths = /if git diff --quiet FETCH_HEAD -- ([^\n]+); then\n\s+echo "promotion_state_changed=false"/.exec(workflow)?.[1];

  assert.ok(paths, 'Chart CI must detect changes that affect promotion-state regression');
  assert.match(paths, /tools\/pacman-promotion\.test\.mjs/);
  assert.match(paths, /tools\/chart-ci\.test\.mjs/);
  assert.match(workflow, /promotion-state-regression:\n[\s\S]*?if: needs\.detect\.outputs\.promotion_state_changed == 'true'/);
  assert.match(workflow, /run: node --test tools\/pacman-promotion\.test\.mjs tools\/chart-ci\.test\.mjs/);
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

test('lifecycle waits for owned pods to disappear before strict uninstall assertions', () => {
  const uninstall = lifecycle.indexOf('  helm uninstall "$release"');
  const podWait = lifecycle.indexOf('  wait_for_owned_pod_deletion "$namespace" "$release"');
  const strictAbsence = lifecycle.indexOf('  for resource in deployments services pods configmaps jobs serviceaccounts; do');

  assert.ok(uninstall >= 0 && uninstall < podWait && podWait < strictAbsence,
    'owned pod deletion must be awaited between Helm uninstall and strict absence checks');
  assert.match(lifecycle, /kubectl[\s\S]*?wait --for=delete pods -l "\$selector" --timeout=2m/);
  assert.match(lifecycle, /owned pods remain after helm uninstall for \$release/);
  assert.match(lifecycle, /local selector="app\.kubernetes\.io\/instance=\$release"/);
});

test('owned pod deletion wait handles absence and fails closed on query or timeout errors', () => {
  const functionStart = lifecycle.indexOf('wait_for_owned_pod_deletion() {');
  assert.ok(functionStart >= 0, 'the lifecycle helper must define the owned pod deletion wait');
  const functionLines = lifecycle.slice(functionStart).split('\n');
  const functionEnd = functionLines.findIndex((line, index) => index > 0 && line === '}');
  assert.ok(functionEnd > 0, 'the owned pod deletion helper must be a complete shell function');
  const waitFunction = functionLines.slice(0, functionEnd + 1).join('\n');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pacman-lifecycle-pod-wait-'));
  try {
    const fakeBin = path.join(directory, 'bin');
    mkdirSync(fakeBin);
    const counter = path.join(directory, 'get-count');
    const trace = path.join(directory, 'kubectl-trace');
    writeFileSync(counter, '0');
    const kubectl = path.join(fakeBin, 'kubectl');
    writeFileSync(kubectl, `#!/bin/sh
case " $* " in
  *" wait --for=delete pods "*)
    printf 'wait\\n' >> "$KUBECTL_TRACE"
    [ "$KUBECTL_MODE" = wait-success ] && exit 0
    exit 1
    ;;
  *" get pods "*)
    printf 'get\\n' >> "$KUBECTL_TRACE"
    count=$(cat "$KUBECTL_COUNTER")
    count=$((count + 1))
    printf '%s' "$count" > "$KUBECTL_COUNTER"
    case "$KUBECTL_MODE" in
      query-error) echo 'forbidden' >&2; exit 23 ;;
      absent) exit 0 ;;
      disappeared-before-wait)
        [ "$count" -eq 1 ] && printf 'pod/owned\\n'
        exit 0
        ;;
      *) printf 'pod/owned\\n'; exit 0 ;;
    esac
    ;;
  *) echo "unexpected kubectl call: $*" >&2; exit 64 ;;
esac
`);
    chmodSync(kubectl, 0o755);

    const run = (mode) => spawnSync('bash', ['-c', [
      'set -euo pipefail',
      waitFunction,
      'tmp_dir="$KUBECTL_TMP"',
      'wait_for_owned_pod_deletion test-namespace test-release',
    ].join('\n')], {
      env: {
        ...process.env,
        KUBECTL_COUNTER: counter,
        KUBECTL_MODE: mode,
        KUBECTL_TMP: directory,
        KUBECTL_TRACE: trace,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      },
      encoding: 'utf8',
    });

    const completed = run('wait-success');
    assert.equal(completed.status, 0, completed.stderr);
    assert.match(readFileSync(trace, 'utf8'), /get[\s\S]*wait/);

    writeFileSync(counter, '0');
    writeFileSync(trace, '');
    const absent = run('absent');
    assert.equal(absent.status, 0, absent.stderr);
    assert.doesNotMatch(readFileSync(trace, 'utf8'), /wait/);

    writeFileSync(counter, '0');
    const queryError = run('query-error');
    assert.notEqual(queryError.status, 0, 'a kubectl list error must fail the lifecycle check');

    writeFileSync(counter, '0');
    const stillPresent = run('wait-fails-present');
    assert.notEqual(stillPresent.status, 0, 'a timed-out wait with an owned pod still present must fail');

    writeFileSync(counter, '0');
    const goneAfterFailedWait = run('disappeared-before-wait');
    assert.equal(goneAfterFailedWait.status, 0, goneAfterFailedWait.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('lifecycle invocation matches the promoted smoke tool platform=image parser after checking the revision label', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pacman-lifecycle-smoke-'));
  try {
    const parser = path.join(directory, 'historical-smoke-parser.mjs');
    writeFileSync(parser, `
import assert from 'node:assert/strict';
// Adapter for the promoted historical CLI: each argument is linux/{amd64,arm64}=image.
function parseTarget(value) {
  const separator = value.indexOf('=');
  if (separator < 0) throw new Error('Expected platform=image, received: ' + value);
  const platform = value.slice(0, separator);
  const image = value.slice(separator + 1);
  if (!['linux/amd64', 'linux/arm64'].includes(platform) || !image) {
    throw new Error('Expected linux/amd64=image or linux/arm64=image, received: ' + value);
  }
  return { platform, image };
}
const targets = process.argv.slice(2).map(parseTarget);
assert.ok(targets.length > 0, 'pass one or more platform=image targets');
console.log(JSON.stringify(targets));
`);
    const image = `docker.io/library/pacman:ci-${'a'.repeat(40)}`;
    const run = (args) => spawnSync(process.execPath, [parser, ...args], { encoding: 'utf8' });
    const accepted = run([`linux/amd64=${image}`]);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout)[0].image, image);

    const rejected = run(['--expected-revision', 'a'.repeat(40), `linux/amd64=${image}`]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Expected platform=image, received: --expected-revision/);

    const revisionCheck = lifecycle.indexOf('[[ "$image_revision" == "$candidate_sha" ]]');
    const smokeInvocation = lifecycle.indexOf('node "$candidate_dir/tools/smoke-container-images.js"');
    assert.ok(revisionCheck >= 0 && revisionCheck < smokeInvocation, 'built image revision must be checked before the smoke tool runs');
    assert.match(lifecycle.slice(smokeInvocation), /"linux\/\$image_arch=\$image"/);
    assert.doesNotMatch(lifecycle.slice(smokeInvocation), /--expected-revision/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
