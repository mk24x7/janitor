// janitor forks: find forks with nothing ahead of upstream and no recent push.
// --apply archives stale forks. Forks are never deleted.

import { fetchForkStatus, listOwnerRepos, visibilityOf } from '../inspect.js';
import { formatDate, isBefore, mapLimit, subtractDuration } from '../util.js';
import { archiveAll } from './archive.js';
import { assertOwnerMatches, confirmApply } from './shared.js';

export const STALE_FORK_AGE = '1y';

/** A fork is stale when it is 0 commits ahead and has not been pushed in a year. */
export function isStaleFork(repo, status, now) {
  if (!status || status.aheadBy !== 0) return false;
  return isBefore(repo.pushed_at, subtractDuration(now, STALE_FORK_AGE));
}

export async function forks(ctx) {
  const { client, options } = ctx;
  const login = assertOwnerMatches(ctx);
  const all = await listOwnerRepos(client, { owner: login, viewerLogin: login });
  const forkRepos = all.filter((r) => r.fork && !r.archived);

  const rows = await mapLimit(forkRepos, 4, async (repo) => {
    const status = await fetchForkStatus(client, repo);
    return {
      repo,
      row: {
        repo: repo.full_name,
        visibility: visibilityOf(repo),
        parent: status.parent,
        aheadBy: status.aheadBy,
        behindBy: status.behindBy,
        pushedAt: repo.pushed_at ?? null,
        stale: isStaleFork(repo, status, ctx.now),
        note: status.reason ?? null,
        status: 'listed',
      },
    };
  });

  const stale = rows.filter((r) => r.row.stale);
  const shown = options.stale || options.apply ? stale : rows;
  const result = {
    command: 'forks',
    owner: login,
    dryRun: !options.apply,
    staleOnly: Boolean(options.stale || options.apply),
    summary: {
      forks: forkRepos.length,
      stale: stale.length,
      archivedForksSkipped: all.filter((r) => r.fork && r.archived).length,
      applied: 0,
      failed: 0,
    },
    repos: shown.map((r) => ({ ...r.row, status: r.row.stale ? 'planned' : 'listed' })),
    changeLog: null,
    exitCode: 0,
  };

  if (!options.apply) {
    result.exitCode = stale.length > 0 ? 3 : 0;
    return result;
  }
  if (stale.length === 0) return result;

  const ok = await confirmApply(
    ctx,
    `Archive ${stale.length} stale forks? They are not deleted and visibility is not changed.`,
    stale.map((r) => `${r.row.repo} (0 ahead of ${r.row.parent}, last push ${formatDate(r.row.pushedAt)})`),
  );
  if (!ok) {
    result.aborted = true;
    result.exitCode = 1;
    return result;
  }
  return archiveAll(ctx, stale.map((r) => r.repo), result, 'forks');
}
