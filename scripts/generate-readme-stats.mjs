import fs from 'node:fs/promises';
import path from 'node:path';

const owner = process.env.GITHUB_STATS_OWNER || 'Hylouis233';
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const outputDir = path.resolve('github-readme-stats');
const featuredRepos = [
  'phsciencedata_crawler_region',
  'Breteau-Index-Prediction-Model-using-machine-learning',
  'bibverify',
];

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': `${owner}-readme-stats-generator`,
  'X-GitHub-Api-Version': '2022-11-28',
};

if (token) {
  headers.Authorization = `Bearer ${token}`;
}

async function github(pathname) {
  const response = await fetch(`https://api.github.com${pathname}`, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 240)}`);
  }
  return response.json();
}

async function getAllRepos() {
  const repos = [];
  for (let page = 1; page <= 5; page += 1) {
    const batch = await github(`/users/${owner}/repos?per_page=100&page=${page}&sort=updated&type=owner`);
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos;
}

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function truncate(value, maxLength) {
  const text = String(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function cardSvg({ width = 420, height = 160, title, subtitle = '', body }) {
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(title)}</title>
  <desc id="desc">${escapeXml(subtitle || title)}</desc>
  <style>
    .card { fill: #282c34; stroke: #3a404b; stroke-width: 1; }
    .title { fill: #61afef; font: 600 17px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .subtitle { fill: #abb2bf; font: 500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .label { fill: #abb2bf; font: 500 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .value { fill: #e5c07b; font: 700 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .muted { fill: #98c379; font: 500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  </style>
  <rect class="card" x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="6" />
  <text class="title" x="20" y="30">${escapeXml(title)}</text>
  ${subtitle ? `<text class="subtitle" x="20" y="51">${escapeXml(subtitle)}</text>` : ''}
  ${body}
</svg>
`;
}

function statRows(stats) {
  return stats.map((item, index) => {
    const x = index % 2 === 0 ? 24 : 220;
    const y = 78 + Math.floor(index / 2) * 34;
    return `<text class="label" x="${x}" y="${y}">${escapeXml(item.label)}</text>
  <text class="value" x="${x + 92}" y="${y}">${escapeXml(item.value)}</text>`;
  }).join('\n  ');
}

function progressRows(items, total) {
  return items.map((item, index) => {
    const y = 72 + index * 25;
    const ratio = total > 0 ? item.bytes / total : 0;
    const barWidth = Math.max(4, Math.round(ratio * 180));
    return `<text class="label" x="22" y="${y}">${escapeXml(item.name)}</text>
  <rect x="138" y="${y - 11}" width="180" height="9" rx="4.5" fill="#3a404b"/>
  <rect x="138" y="${y - 11}" width="${barWidth}" height="9" rx="4.5" fill="${item.color}"/>
  <text class="muted" x="330" y="${y}">${(ratio * 100).toFixed(1)}%</text>`;
  }).join('\n  ');
}

function languageColor(name) {
  const colors = {
    JavaScript: '#f1e05a',
    TypeScript: '#3178c6',
    Python: '#3572A5',
    R: '#198ce7',
    HTML: '#e34c26',
    CSS: '#563d7c',
    TeX: '#3D6117',
    'C++': '#f34b7d',
    C: '#555555',
    Shell: '#89e051',
    Jupyter: '#DA5B0B',
  };
  return colors[name] || '#98c379';
}

async function generate() {
  await fs.mkdir(outputDir, { recursive: true });

  const [user, repos] = await Promise.all([
    github(`/users/${owner}`),
    getAllRepos(),
  ]);
  const ownRepos = repos.filter((repo) => !repo.fork);
  const stars = ownRepos.reduce((sum, repo) => sum + repo.stargazers_count, 0);
  const forks = ownRepos.reduce((sum, repo) => sum + repo.forks_count, 0);
  const watchers = ownRepos.reduce((sum, repo) => sum + repo.watchers_count, 0);

  const statsSvg = cardSvg({
    title: `${owner}'s GitHub Stats`,
    subtitle: 'Generated from GitHub API',
    body: statRows([
      { label: 'Public repos', value: user.public_repos },
      { label: 'Stars', value: stars },
      { label: 'Forks', value: forks },
      { label: 'Watchers', value: watchers },
      { label: 'Followers', value: user.followers },
      { label: 'Public gists', value: user.public_gists },
    ]),
  });
  await fs.writeFile(path.join(outputDir, 'profile-stats.svg'), statsSvg);

  const languageTotals = new Map();
  for (const repo of ownRepos.slice(0, 80)) {
    const languages = await github(`/repos/${owner}/${repo.name}/languages`);
    for (const [language, bytes] of Object.entries(languages)) {
      languageTotals.set(language, (languageTotals.get(language) || 0) + bytes);
    }
  }
  const topLanguages = [...languageTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, bytes]) => ({ name, bytes, color: languageColor(name) }));
  const languageTotal = topLanguages.reduce((sum, item) => sum + item.bytes, 0);

  const topLangsSvg = cardSvg({
    title: 'Top Languages',
    subtitle: 'Aggregated from owned public repositories',
    height: 210,
    body: progressRows(topLanguages, languageTotal),
  });
  await fs.writeFile(path.join(outputDir, 'top-langs.svg'), topLangsSvg);

  for (const repoName of featuredRepos) {
    const repo = await github(`/repos/${owner}/${repoName}`);
    const language = repo.language || 'Repository';
    const repoSvg = cardSvg({
      title: repo.name,
      subtitle: truncate(repo.description || repo.html_url, 72),
      body: `<text class="label" x="24" y="92">Language</text>
  <text class="value" x="116" y="92">${escapeXml(language)}</text>
  <text class="label" x="24" y="126">Stars</text>
  <text class="value" x="116" y="126">${repo.stargazers_count}</text>
  <text class="label" x="220" y="126">Forks</text>
  <text class="value" x="292" y="126">${repo.forks_count}</text>`,
    });
    await fs.writeFile(path.join(outputDir, `repo-${repoName}.svg`), repoSvg);
  }
}

generate().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
