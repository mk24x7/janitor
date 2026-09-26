// janitor fix: derive and (with --apply) set missing repository metadata.
// Only description, topics, homepage and has_wiki are ever changed.

import { UsageError } from '../errors.js';
import { deriveDescription, deriveHomepage, deriveTopics } from '../derive.js';
import {
  fetchFileText,
  fetchPagesUrl,
  fetchReadme,
  fetchRootFiles,
  filterRepos,
  listOwnerRepos,
  repoPath,
  visibilityOf,
} from '../inspect.js';
import { mapLimit } from '../util.js';
import { applyRequest, assertOwnerMatches, confirmApply } from './shared.js';

export const FIX_KINDS = ['description', 'topics', 'homepage', 'wiki'];

const ALIASES = {
  description: 'description',
  'missing-description': 'description',
  topics: 'topics',
  'no-topics': 'topics',
  homepage: 'homepage',
  'no-homepage-with-pages': 'homepage',
  wiki: 'wiki',
  has_wiki: 'wiki',
  'has-wiki': 'wiki',
};

export function parseOnly(value) {
  if (!value) return new Set(FIX_KINDS);
  const kinds = new Set();
  for (const part of String(value).split(',').map((s) => s.trim()).filter(Boolean)) {
    const kind = ALIASES[part.toLowerCase()];
    if (!kind) throw new UsageError(`unknown fix "${part}"; choose from ${FIX_KINDS.join(', ')}`);
    kinds.add(kind);
  }
  if (kinds.size === 0) throw new UsageError('--only needs at least one fix name');
  return kinds;
}

/**
 * Works out the metadata changes for one repository. Pure with respect to
 * the repository: only GET requests are made.
 * @returns {{ repo: string, visibility: string, changes: object[], skipped: object[], requests: object[] }}
 */
export async function planRepoFixes(client, repo, { kinds, owner }) {
  const changes = [];
  const skipped = [];
  const needsDescription = kinds.has('description') && !repo.description?.trim();
  const needsHomepage = kinds.has('homepage') && !repo.homepage?.trim();
  const needsTopics = kinds.has('topics') && (!Array.isArray(repo.topics) || repo.topics.length === 0);
  const needsWiki = kinds.has('wiki') && repo.has_wiki === true;

  let readme = null;
  if (needsDescription || needsHomepage) readme = await fetchReadme(client, repo);

  if (needsDescription) {
    if (!readme) {
      skipped.push({ field: 'description', reason: 'no README to derive a description from' });
    } else {
      const description = deriveDescription(readme.text, { repoName: repo.name });
      if (description) changes.push({ field: 'description', before: repo.description ?? null, after: description });
      else skipped.push({ field: 'description', reason: 'README has no usable paragraph' });
    }
  }

  let homepage = repo.homepage?.trim() || null;
  if (needsHomepage) {
    let url = null;
    if (repo.has_pages) {
      url = await fetchPagesUrl(client, repo);
      if (!url) skipped.push({ field: 'homepage', reason: 'GitHub Pages is enabled but its URL could not be read' });
    }
    if (!url && readme) {
      const found = deriveHomepage(readme.text);
      if (found.url) url = found.url;
      else if (found.reason === 'ambiguous') {
        skipped.push({ field: 'homepage', reason: `README links to several sites (${found.hosts.join(', ')})` });
      }
    }
    if (url) {
      changes.push({ field: 'homepage', before: repo.homepage || null, after: url });
      homepage = url;
    }
  }

  if (needsTopics) {
    const files = await fetchRootFiles(client, repo);
    let packageJson = null;
    if (files.includes('package.json')) {
      try {
        packageJson = JSON.parse((await fetchFileText(client, repo, 'package.json')) ?? 'null');
      } catch {
        packageJson = null;
      }
    }
    const topics = deriveTopics({ language: repo.language, files, packageJson, homepage, owner });
    if (topics.length > 0) changes.push({ field: 'topics', before: repo.topics ?? [], after: topics });
    else skipped.push({ field: 'topics', reason: 'no language, manifest or homepage to derive topics from' });
  }

  if (needsWiki) {
    const wiki = await client.probeWiki(repo.full_name);
    if (wiki === 'empty') changes.push({ field: 'has_wiki', before: true, after: false });
    else if (wiki === 'unknown') skipped.push({ field: 'has_wiki', reason: 'could not tell whether the wiki has pages' });
  }

  return {
    repo: repo.full_name,
    visibility: visibilityOf(repo),
    changes,
    skipped,
    requests: requestsFor(repo, changes),
  };
}

/** The exact requests that applying `changes` sends: one PATCH, one PUT. */
export function requestsFor(repo, changes) {
  const requests = [];
  const patch = {};
  for (const c of changes) {
    if (c.field !== 'topics') patch[c.field] = c.after;
  }
  if (Object.keys(patch).length > 0) requests.push({ method: 'PATCH', path: repoPath(repo), body: patch });
  const topics = changes.find((c) => c.field === 'topics');
  if (topics) requests.push({ method: 'PUT', path: `${repoPath(repo)}/topics`, body: { names: topics.after } });
  return requests;
}

export async function fix(ctx) {
  const { client, options } = ctx;
  const login = assertOwnerMatches(ctx);
  const kinds = parseOnly(options.only);
  const all = await listOwnerRepos(client, { owner: login, viewerLogin: login });
  // Archived repositories are read-only; forks keep their upstream's metadata.
  const repos = filterRepos(all, { includeForks: options.includeForks, includeArchived: false });

  const plans = await mapLimit(repos, 4, (repo) => planRepoFixes(client, repo, { kinds, owner: login }));
  const withChanges = plans.filter((p) => p.changes.length > 0);
  const changeCount = withChanges.reduce((n, p) => n + p.changes.length, 0);

  const result = {
    command: 'fix',
    owner: login,
    dryRun: !options.apply,
    only: [...kinds],
    summary: { repos: repos.length, reposWithChanges: withChanges.length, changes: changeCount, applied: 0, failed: 0 },
    repos: plans
      .filter((p) => p.changes.length > 0 || p.skipped.length > 0)
      .map((p) => ({ repo: p.repo, visibility: p.visibility, changes: p.changes, skipped: p.skipped, status: 'planned' })),
    changeLog: null,
    exitCode: 0,
  };

  if (!options.apply) {
    result.exitCode = changeCount > 0 ? 3 : 0;
    return result;
  }
  if (changeCount === 0) return result;

  const ok = await confirmApply(
    ctx,
    `Apply ${changeCount} change(s) to ${withChanges.length} repositories?`,
    withChanges.map((p) => `${p.repo}: ${p.changes.map((c) => c.field).join(', ')}`),
  );
  if (!ok) {
    result.aborted = true;
    result.exitCode = 1;
    return result;
  }

  const byRepo = new Map(repos.map((r) => [r.full_name, r]));
  for (const plan of withChanges) {
    const entry = result.repos.find((r) => r.repo === plan.repo);
    const repo = byRepo.get(plan.repo);
    let failed = null;
    for (const req of plan.requests) {
      const fields = req.method === 'PUT' ? ['topics'] : Object.keys(req.body);
      const entries = plan.changes
        .filter((c) => fields.includes(c.field))
        .map((c) => ({ command: 'fix', repo: repo.full_name, field: c.field, before: c.before, after: c.after }));
      const res = await applyRequest(ctx, req, entries);
      if (res.ok) result.summary.applied += entries.length;
      else {
        failed = res.error;
        result.summary.failed += entries.length;
      }
    }
    entry.status = failed ? 'failed' : 'applied';
    if (failed) entry.error = failed;
  }
  result.changeLog = ctx.changeLog;
  result.exitCode = result.summary.failed > 0 ? 1 : 0;
  return result;
}
