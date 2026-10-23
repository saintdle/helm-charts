const validAuthorities = new Set(['helm-charts', 'pacman']);
const variableName = 'PACMAN_CHART_PUBLISHER_AUTHORITY';

function fail(message) {
  throw new Error(message);
}

export function normalizeChartPublisherAuthority(value) {
  const authority = value === undefined || value === null || value === '' ? 'helm-charts' : value;
  if (!validAuthorities.has(authority)) fail(`${variableName} must be either helm-charts or pacman`);
  return authority;
}

export function publisherState(value) {
  const authority = normalizeChartPublisherAuthority(value);
  return {
    authority,
    legacyEnabled: authority === 'helm-charts',
    generatedEnabled: authority === 'pacman',
  };
}

export async function readChartPublisherAuthority({ repository, token, fetch: fetchRequest = fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) fail('GITHUB_REPOSITORY must be owner/repository');
  if (!token) fail('GH_TOKEN is required to read the chart publisher authority');
  const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
  // GitHub can mask insufficient Variables permissions as 404. Prove read access first.
  const capability = await fetchRequest(`https://api.github.com/repos/${repository}/actions/variables?per_page=1`, { headers });
  if (!capability.ok) fail(`could not verify Actions variables read access: HTTP ${capability.status}`);
  const response = await fetchRequest(`https://api.github.com/repos/${repository}/actions/variables/${variableName}`, { headers });
  if (response.status === 404) return 'helm-charts';
  if (!response.ok) fail(`could not read ${variableName}: HTTP ${response.status}`);
  const body = await response.json();
  return normalizeChartPublisherAuthority(body.value);
}

export async function assertChartPublisherAuthority(expected, options = {}) {
  const authority = await readChartPublisherAuthority(options);
  if (authority !== expected) fail(`chart publisher authority is ${authority}; ${expected} publisher is not active`);
  return authority;
}

async function main() {
  const expected = process.argv[2];
  if (!validAuthorities.has(expected)) fail('usage: chart-authority.mjs helm-charts|pacman');
  const authority = await assertChartPublisherAuthority(expected, {
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GH_TOKEN,
  });
  console.log(`chart publisher authority confirmed: ${authority}`);
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
