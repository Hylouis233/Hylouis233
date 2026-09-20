// Profile README health check.
//
// Runs standalone (node scripts/health-check.mjs) with GITHUB_TOKEN set.
// What it does:
//   1. Extracts every image URL (src / srcset) from README.md and verifies
//      each answers 200 with SVG/image content.
//   2. Checks that every generator workflow finished successfully recently.
//   3. Self-heals: re-dispatches workflows whose output is broken or whose
//      last run is missing / failed / stale.
//   4. Alerts: opens (or comments on) a tracking issue for anything it cannot
//      fix itself, e.g. a dead third-party image service. Closes the issue
//      once everything is healthy again.
//
// Set HEALTH_CHECK_NO_WRITE=1 to run read-only (local dry runs).

import fs from 'node:fs/promises';

const owner = process.env.GITHUB_STATS_OWNER || 'Hylouis233';
const repository = process.env.GITHUB_REPOSITORY || `${owner}/${owner}`;
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const noWrite = process.env.HEALTH_CHECK_NO_WRITE === '1';

const ISSUE_TITLE = '🚨 Profile README health check failed';
const STALE_RUN_MS = 48 * 60 * 60 * 1000; // generators are daily; 2 days of silence = problem
const FETCH_TIMEOUT_MS = 25_000;

// Directory prefix of generated assets -> workflow that regenerates them.
const GENERATED_DIR_TO_WORKFLOW = new Map([
  ['github-readme-stats', 'readme-stats.yml'],
  ['github-metrics', 'metrics.yml'],
  ['profile-snake-contrib', 'snake.yml'],
  ['profile-3d-contrib', 'contrib.yml'],
]);

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': `${owner}-profile-health-check`,
  'X-GitHub-Api-Version': '2022-11-28',
};

async function api(pathname, options = {}) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body ? JSON.stringify(body).slice(0, 240) : response.statusText;
    throw new Error(`api ${pathname} -> ${response.status}: ${detail}`);
  }
  return body;
}

function extractImageUrls(markdown) {
  const urls = new Set();
  for (const match of markdown.matchAll(/\b(?:src|srcset)="([^"]+)"/g)) {
    for (const part of match[1].split(/\s+/)) {
      if (/^https:\/\//.test(part)) urls.add(part);
    }
  }
  return [...urls];
}

function parseInternalPath(url) {
  const match = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!match) return null;
  const [, urlOwner, urlRepo, ref, filePath] = match;
  if (urlOwner !== owner || urlRepo !== owner || ref !== 'main') return null;
  return filePath;
}

async function checkImage(url) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': `${owner}-profile-health-check` },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const contentType = response.headers.get('content-type') || '';
    const body = await response.text().catch(() => '');
    const head = body.slice(0, 256).trim().toLowerCase();
    const looksLikeImage = head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!doctype svg');
    const ok = response.ok && (contentType.startsWith('image/') || looksLikeImage);
    return { url, ok, status: response.status, contentType: contentType || 'unknown' };
  } catch (error) {
    return { url, ok: false, status: 0, contentType: `fetch error: ${error.message}` };
  }
}

async function checkWorkflowRuns() {
  const results = [];
  for (const workflowFile of new Set(GENERATED_DIR_TO_WORKFLOW.values())) {
    const runs = await api(`/repos/${repository}/actions/workflows/${workflowFile}/runs?per_page=1`);
    const latest = runs.workflow_runs[0] || null;
    if (!latest) {
      results.push({ workflowFile, healthy: false, reason: 'no runs recorded' });
      continue;
    }
    if (latest.status !== 'completed') {
      results.push({ workflowFile, healthy: true, reason: `run ${latest.status} (in flight)` });
      continue;
    }
    const age = Date.now() - new Date(latest.updated_at).getTime();
    if (latest.conclusion !== 'success') {
      results.push({ workflowFile, healthy: false, reason: `last run ${latest.conclusion} (${latest.html_url})` });
    } else if (age > STALE_RUN_MS) {
      results.push({ workflowFile, healthy: false, reason: `last success ${Math.round(age / 86400000)}d ago (stale)` });
    } else {
      results.push({ workflowFile, healthy: true, reason: `last run success, ${Math.round(age / 3600000)}h ago` });
    }
  }
  return results;
}

async function dispatchWorkflow(workflowFile, reason) {
  if (noWrite) {
    console.log(`  [dry-run] would dispatch ${workflowFile} (${reason})`);
    return;
  }
  await api(`/repos/${repository}/actions/workflows/${workflowFile}/dispatches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main' }),
  });
  console.log(`  🔁 re-dispatched ${workflowFile} (${reason})`);
}

async function manageAlertIssue(failures, heals) {
  const existing = (await api(`/repos/${repository}/issues?state=open&per_page=100`))
    .find((issue) => issue.title === ISSUE_TITLE && !issue.pull_request);

  if (failures.length === 0) {
    if (existing && !noWrite) {
      await api(`/repos/${repository}/issues/${existing.number}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'closed' }),
      });
      await api(`/repos/${repository}/issues/${existing.number}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: '✅ All checks passed — closing this alert.' }),
      });
      console.log(`  ✅ closed alert issue #${existing.number}`);
    }
    return;
  }

  const lines = [
    'Automated health check found problems it could not fully fix:',
    '',
    ...failures.map((item) => `- ❌ ${item.kind}: \`${item.detail}\``),
  ];
  if (heals.length > 0) {
    lines.push('', 'Self-healing was triggered (results visible on the next check):',
      ...heals.map((heal) => `- 🔁 dispatched \`${heal.workflowFile}\` (${heal.reason})`));
  }
  lines.push('', `_Triggered by profile health check, ${new Date().toISOString()}._`);
  const body = lines.join('\n');

  if (noWrite) {
    console.log('  [dry-run] would update alert issue with:', failures.map((f) => f.detail));
    return;
  }
  if (existing) {
    await api(`/repos/${repository}/issues/${existing.number}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    console.log(`  📝 commented on alert issue #${existing.number}`);
  } else {
    const created = await api(`/repos/${repository}/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: ISSUE_TITLE, body, labels: ['profile-health'] }),
    });
    console.log(`  🚨 opened alert issue #${created.number}`);
  }
}

async function main() {
  if (!token) {
    throw new Error('GITHUB_TOKEN is required');
  }
  console.log(`Profile health check for ${repository} (mode: ${noWrite ? 'dry-run' : 'live'})\n`);

  const markdown = await fs.readFile('README.md', 'utf8');
  const urls = extractImageUrls(markdown);
  console.log(`[1/3] Checking ${urls.length} image URLs from README.md...`);
  const imageResults = [];
  for (const url of urls) {
    const result = await checkImage(url);
    imageResults.push(result);
    console.log(`  ${result.ok ? '✅' : '❌'} ${result.status} ${url.slice(0, 96)}`);
  }

  console.log('\n[2/3] Checking generator workflow health...');
  const workflowResults = await checkWorkflowRuns();
  for (const result of workflowResults) {
    console.log(`  ${result.healthy ? '✅' : '❌'} ${result.workflowFile}: ${result.reason}`);
  }

  console.log('\n[3/3] Self-healing...');
  const heals = [];
  const brokenInternalDirs = new Set();
  for (const result of imageResults.filter((item) => !item.ok)) {
    const filePath = parseInternalPath(result.url);
    if (!filePath) continue;
    const dir = filePath.split('/')[0];
    const workflowFile = GENERATED_DIR_TO_WORKFLOW.get(dir);
    if (workflowFile) brokenInternalDirs.add(workflowFile);
  }
  for (const result of workflowResults.filter((item) => !item.healthy)) {
    if (!brokenInternalDirs.has(result.workflowFile)) {
      await dispatchWorkflow(result.workflowFile, result.reason);
      heals.push({ workflowFile: result.workflowFile, reason: result.reason });
    }
  }
  for (const workflowFile of brokenInternalDirs) {
    await dispatchWorkflow(workflowFile, 'generated asset broken or missing');
    heals.push({ workflowFile, reason: 'generated asset broken or missing' });
  }
  if (heals.length === 0) console.log('  nothing to heal');

  const failures = [
    ...imageResults
      .filter((item) => !item.ok)
      .map((item) => ({ kind: 'image', detail: `${item.status} ${item.url} (${item.contentType})` })),
    ...workflowResults
      .filter((item) => !item.healthy)
      .map((item) => ({ kind: 'workflow', detail: `${item.workflowFile}: ${item.reason}` })),
  ];

  console.log('\n[alert] Syncing tracking issue...');
  await manageAlertIssue(failures, heals);

  const broken = imageResults.filter((item) => !item.ok).length;
  console.log(`\nSummary: ${imageResults.length - broken}/${imageResults.length} images OK, `
    + `${workflowResults.filter((item) => item.healthy).length}/${workflowResults.length} workflows OK, `
    + `${heals.length} healed.`);
  if (broken > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
