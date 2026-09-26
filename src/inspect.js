// Network-backed collection of repository facts used by rules and fixes.

import { HttpError } from './errors.js';
import { isBefore, subtractDuration } from './util.js';

const enc = encodeURIComponent;

export function repoPath(repo) {
  const [owner, name] = repo.full_name.split('/');
  return `/repos/${enc(owner)}/${enc(name)}`;
}

/** The authenticated user, or null when no token is configured. */
export async function getViewer(client) {
  return client.get('/user');
}

/**
 * Lists repositories owned by `owner`. For the authenticated user this uses
 * /user/repos?affiliation=owner so private repositories are included; for any
 * other login it uses /users/{login}/repos (public repositories only).
 */
export async function listOwnerRepos(client, { owner, viewerLogin }) {
  const self = !owner || (viewerLogin && owner.toLowerCase() === viewerLogin.toLowerCase());
  const path = self
    ? '/user/repos?affiliation=owner&sort=full_name&per_page=100'
    : `/users/${enc(owner)}/repos?type=owner&sort=full_name&per_page=100`;
  const repos = await client.paginate(path);
  const login = (self ? viewerLogin : owner) ?? '';
  // affiliation=owner already filters, but be defensive about the owner check.
  return repos.filter((r) => !login || r.owner?.login?.toLowerCase() === login.toLowerCase());
}

export function filterRepos(repos, { includeForks = false, includeArchived = false } = {}) {
  return repos.filter((r) => (includeForks || !r.fork) && (includeArchived || !r.archived));
}

export function visibilityOf(repo) {
  return repo.visibility ?? (repo.private ? 'private' : 'public');
}

/** README metadata and decoded text, or null when the repository has none. */
export async function fetchReadme(client, repo) {
  const data = await client.getOptional(`${repoPath(repo)}/readme`);
  if (!data) return null;
  const text = data.content && data.encoding === 'base64' ? Buffer.from(data.content, 'base64').toString('utf8') : '';
  return { path: data.path, size: typeof data.size === 'number' ? data.size : Buffer.byteLength(text), text };
}

/** Open pull requests older than `olderThan` (default 1 year). */
export async function fetchStalePulls(client, repo, { now = Date.now(), olderThan = '1y' } = {}) {
  const cutoff = subtractDuration(now, olderThan);
  const pulls = await client.getOptional(
    `${repoPath(repo)}/pulls?state=open&sort=created&direction=asc&per_page=100`,
    { quietStatuses: [403, 404] },
  );
  if (!Array.isArray(pulls)) return [];
  return pulls
    .filter((p) => isBefore(p.created_at, cutoff))
    .map((p) => ({ number: p.number, title: p.title, created_at: p.created_at }));
}

/**
 * Number of open Dependabot alerts, or null when the token cannot read them
 * (403), alerts are disabled, or the repository is not found (404).
 */
export async function fetchDependabotCount(client, repo) {
  try {
    const alerts = await client.paginate(`${repoPath(repo)}/dependabot/alerts?state=open&per_page=100`);
    return alerts.length;
  } catch (err) {
    if (err instanceof HttpError && [401, 403, 404, 422].includes(err.status)) return null;
    throw err;
  }
}

/**
 * For a fork, compares its default branch with the parent's default branch.
 * @returns {{ parent: string|null, aheadBy: number|null, behindBy: number|null, reason?: string }}
 */
export async function fetchForkStatus(client, repo) {
  const full = await client.getOptional(repoPath(repo));
  const parent = full?.parent;
  if (!parent) return { parent: null, aheadBy: null, behindBy: null, reason: 'parent repository not available' };
  const [pOwner, pName] = parent.full_name.split('/');
  const base = enc(parent.default_branch);
  const head = `${enc(repo.owner.login)}:${enc(full.default_branch ?? repo.default_branch)}`;
  try {
    const cmp = await client.get(`/repos/${enc(pOwner)}/${enc(pName)}/compare/${base}...${head}`);
    return { parent: parent.full_name, aheadBy: cmp.ahead_by, behindBy: cmp.behind_by };
  } catch (err) {
    if (err instanceof HttpError && [404, 422].includes(err.status)) {
      return { parent: parent.full_name, aheadBy: null, behindBy: null, reason: 'branches cannot be compared' };
    }
    throw err;
  }
}

/** Names of files and directories in the repository root. */
export async function fetchRootFiles(client, repo) {
  const entries = await client.getOptional(`${repoPath(repo)}/contents/`);
  return Array.isArray(entries) ? entries.map((e) => e.name) : [];
}

/** Decoded text of a file, or null. */
export async function fetchFileText(client, repo, path) {
  const data = await client.getOptional(`${repoPath(repo)}/contents/${path.split('/').map(enc).join('/')}`);
  if (!data || Array.isArray(data) || data.encoding !== 'base64') return null;
  return Buffer.from(data.content ?? '', 'base64').toString('utf8');
}

/** GitHub Pages site URL, or null when Pages is not configured or not readable. */
export async function fetchPagesUrl(client, repo) {
  const pages = await client.getOptional(`${repoPath(repo)}/pages`, { quietStatuses: [403, 404] });
  return pages?.html_url ?? null;
}

/** All facts the audit rules need, fetched with as few requests as possible. */
export async function collectAuditFacts(client, repo, { now = Date.now(), checkDependabot = true } = {}) {
  const facts = { readme: null, stalePulls: [], dependabot: null, fork: null };
  facts.readme = await fetchReadme(client, repo);
  if (!repo.archived) {
    facts.stalePulls = await fetchStalePulls(client, repo, { now });
    if (checkDependabot) facts.dependabot = await fetchDependabotCount(client, repo);
  }
  if (repo.fork) facts.fork = await fetchForkStatus(client, repo);
  return facts;
}
