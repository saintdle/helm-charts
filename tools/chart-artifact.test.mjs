import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyPacmanChartCandidate } from './chart-artifact.mjs';

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
