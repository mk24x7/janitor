// janitor archive: archive repositories with no recent pushes and few stars.
// Archiving is reversible from the repository settings and never changes
// visibility.

import { UsageError } from '../errors.js';
import { listOwnerRepos, repoPath, visibilityOf } from '../inspect.js';
import { formatDate, isBefore, parseDuration, subtractDuration } from '../util.js';
import { applyRequest, assertOwnerMatches, confirmApply } from './shared.js';

export function parseMaxStars(value) {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(String(value))) throw new UsageError(`--max-stars must be a whole number, got "${value}"`);
  return Number(value);
}

/** Pure selection of archive candidates, exported for tests. */
export function selectArchiveCandidates(repos, { now, olderThan = '3y', maxStars = 0, includeForks = false }) {
  const cutoff = subtractDuration(now, parseDuration(olderThan));
  return repos
    .filter((r) => !r.archived)
    .filter((r) => includeForks || !r.fork)
    .filter((r) => (r.stargazers_count ?? 0) <= maxStars)
    .filter((r) => isBefore(r.pushed_at, cutoff))
    .sort((a, b) => String(a.pushed_at ?? '').localeCompare(String(b.pushed_at ?? '')));
}

export async function archive(ctx) {
  const { client, options } = ctx;
  const login = assertOwnerMatches(ctx);
  const olderThan = parseDuration(options.olderThan ?? '3y').text;
  const maxStars = parseMaxStars(options.maxStars);
  const all = await listOwnerRepos(client, { owner: login, viewerLogin: login });
  const candidates = selectArchiveCandidates(all, {
    now: ctx.now,
    olderThan,
    maxStars,
    includeForks: options.includeForks,
  });
  const cutoff = subtractDuration(ctx.now, parseDuration(olderThan));

  const result = {
    command: 'archive',
    owner: login,
    dryRun: !options.apply,
    criteria: { olderThan, cutoff: cutoff.toISOString(), maxStars, includeForks: Boolean(options.includeForks) },
    summary: { candidates: candidates.length, applied: 0, failed: 0 },
    repos: candidates.map((r) => ({
      repo: r.full_name,
      visibility: visibilityOf(r),
      fork: Boolean(r.fork),
      pushedAt: r.pushed_at ?? null,
      stars: r.stargazers_count ?? 0,
      status: 'planned',
    })),
    changeLog: null,
    exitCode: 0,
  };

  if (!options.apply) {
    result.exitCode = candidates.length > 0 ? 3 : 0;
    return result;
  }
  if (candidates.length === 0) return result;

  const ok = await confirmApply(
    ctx,
    `Archive ${candidates.length} repositories? Visibility is not changed and archiving can be undone in Settings.`,
    candidates.map((r) => `${r.full_name} (last push ${formatDate(r.pushed_at)})`),
  );
  if (!ok) {
    result.aborted = true;
    result.exitCode = 1;
    return result;
  }
  return archiveAll(ctx, candidates, result, 'archive');
}

/** Archives each repository with PATCH { archived: true } and logs it. */
export async function archiveAll(ctx, repos, result, command) {
  for (const repo of repos) {
    const entry = result.repos.find((r) => r.repo === repo.full_name);
    const res = await applyRequest(ctx, { method: 'PATCH', path: repoPath(repo), body: { archived: true } }, [
      { command, repo: repo.full_name, field: 'archived', before: false, after: true },
    ]);
    entry.status = res.ok ? 'applied' : 'failed';
    if (res.ok) result.summary.applied += 1;
    else {
      entry.error = res.error;
      result.summary.failed += 1;
    }
  }
  result.changeLog = ctx.changeLog;
  result.exitCode = result.summary.failed > 0 ? 1 : 0;
  return result;
}
