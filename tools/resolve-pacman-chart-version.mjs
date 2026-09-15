import { execFileSync } from 'node:child_process';

const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/;

function parseVersion(value, source) {
  const match = versionPattern.exec(value);
  if (!match) throw new Error(`${source} must use MAJOR.MINOR.PATCH format: ${value}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function formatVersion(version) {
  return version.join('.');
}

function patchVersion(version) {
  return [version[0], version[1], version[2] + 1];
}

function git(...argumentsList) {
  return execFileSync('git', argumentsList, { encoding: 'utf8' }).trim();
}

const appVersion = parseVersion(process.env.APP_VERSION, 'app version');
const currentChartVersion = parseVersion(process.env.CURRENT_CHART_VERSION, 'current chart version');
const releasedTags = new Set(
  git('tag', '--list', 'pacman-*')
    .split('\n')
    .filter(Boolean),
);

let candidate = compareVersions(appVersion, currentChartVersion) > 0 ? appVersion : currentChartVersion;
while (releasedTags.has(`pacman-${formatVersion(candidate)}`)) {
  candidate = patchVersion(candidate);
}

console.log(`chart_version=${formatVersion(candidate)}`);
console.log(`chart_source=${formatVersion(candidate) === formatVersion(appVersion) ? 'synchronized with app version' : 'next unused chart patch'}`);