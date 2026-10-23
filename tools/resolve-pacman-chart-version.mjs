import { execFileSync } from 'node:child_process';

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;

function parseVersion(value, source) {
  const match = typeof value === 'string' ? versionPattern.exec(value) : null;
  if (!match) throw new Error(`${source} must use canonical MAJOR.MINOR.PATCH format: ${value}`);
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

function currentTags() {
  if (process.env.RELEASED_CHART_TAGS !== undefined) {
    return process.env.RELEASED_CHART_TAGS.split(',').filter(Boolean);
  }
  return execFileSync('git', ['tag', '--list', 'pacman-*'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

export function resolveNextChartVersion(appVersionValue, currentChartVersionValue, releasedTags) {
  const appVersion = parseVersion(appVersionValue, 'app version');
  const currentChartVersion = parseVersion(currentChartVersionValue, 'current chart version');
  let candidate = compareVersions(appVersion, currentChartVersion) > 0
    ? appVersion
    : patchVersion(currentChartVersion);

  while (releasedTags.includes(`pacman-${formatVersion(candidate)}`)) {
    candidate = patchVersion(candidate);
  }

  if (compareVersions(candidate, currentChartVersion) <= 0) {
    throw new Error('resolved chart version must be newer than the current chart version');
  }
  return formatVersion(candidate);
}

export function planChartPromotion({ appVersion, imageDigest, currentAppVersion, currentImageDigest, currentChartVersion, releasedTags }) {
  const app = parseVersion(appVersion, 'app version');
  const currentApp = parseVersion(currentAppVersion, 'current app version');
  const chart = parseVersion(currentChartVersion, 'current chart version');
  if (!digestPattern.test(imageDigest ?? '')) throw new Error('image digest must be a SHA-256 digest');
  if (!digestPattern.test(currentImageDigest ?? '')) throw new Error('current image digest must be a SHA-256 digest');

  const appComparison = compareVersions(app, currentApp);
  if (appComparison < 0) return { promotion: 'noop', reason: 'older-app-release' };
  if (appComparison === 0) {
    if (imageDigest !== currentImageDigest) {
      throw new Error('same app version has a conflicting image digest');
    }
    return { promotion: 'noop', reason: 'already-promoted' };
  }

  return {
    promotion: 'update',
    reason: 'newer-app-release',
    chartVersion: resolveNextChartVersion(appVersion, currentChartVersion, releasedTags),
  };
}

function main() {
  const plan = planChartPromotion({
    appVersion: process.env.APP_VERSION,
    imageDigest: process.env.IMAGE_DIGEST,
    currentAppVersion: process.env.CURRENT_APP_VERSION,
    currentImageDigest: process.env.CURRENT_IMAGE_DIGEST,
    currentChartVersion: process.env.CURRENT_CHART_VERSION,
    releasedTags: currentTags(),
  });

  console.log(`promotion=${plan.promotion}`);
  console.log(`reason=${plan.reason}`);
  if (plan.chartVersion) {
    console.log(`chart_version=${plan.chartVersion}`);
    console.log('chart_source=next unused chart version');
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
