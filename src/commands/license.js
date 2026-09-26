// janitor license: add a LICENSE file to owned repositories that have none.

import { licenseText } from '../licenses.js';
import { fetchRootFiles, listOwnerRepos, repoPath, visibilityOf } from '../inspect.js';
import { mapLimit } from '../util.js';
import { applyRequest, assertOwnerMatches, confirmApply } from './shared.js';

const LICENSE_FILE = /^(licen[cs]e|copying|unlicense)([.-].*)?$/i;

export async function license(ctx) {
  const { client, options } = ctx;
  const login = assertOwnerMatches(ctx);
  const holder = options.holder?.trim() || ctx.viewer.name?.trim() || login;
  const year = new Date(ctx.now).getUTCFullYear();
  const { spdx, text } = await licenseText(client, options.spdx ?? 'MIT', { year, holder });

  const all = await listOwnerRepos(client, { owner: login, viewerLogin: login });
  // Forks are always skipped: their license belongs to the upstream project.
  const unlicensed = all.filter((r) => !r.fork && !r.archived && !r.license);

  const planned = await mapLimit(unlicensed, 4, async (repo) => {
    const files = await fetchRootFiles(client, repo);
    const base = { repo: repo.full_name, visibility: visibilityOf(repo), branch: repo.default_branch };
    if (files.length === 0) return { ...base, action: 'skip', reason: 'repository is empty' };
    const existing = files.find((f) => LICENSE_FILE.test(f));
    if (existing) return { ...base, action: 'skip', reason: `${existing} exists but GitHub does not recognise the license` };
    return { ...base, action: 'create', path: 'LICENSE' };
  });

  const toCreate = planned.filter((p) => p.action === 'create');
  const message = `Add ${spdx} license`;
  const result = {
    command: 'license',
    owner: login,
    dryRun: !options.apply,
    spdx,
    holder,
    year,
    commitMessage: message,
    summary: {
      unlicensed: unlicensed.length,
      forksSkipped: all.filter((r) => r.fork && !r.license).length,
      toCreate: toCreate.length,
      applied: 0,
      failed: 0,
    },
    repos: planned.map((p) => ({ ...p, status: p.action === 'create' ? 'planned' : 'skipped' })),
    changeLog: null,
    exitCode: 0,
  };

  if (!options.apply) {
    result.exitCode = toCreate.length > 0 ? 3 : 0;
    return result;
  }
  if (toCreate.length === 0) return result;

  const ok = await confirmApply(
    ctx,
    `Commit a ${spdx} LICENSE (holder "${holder}") to ${toCreate.length} repositories?`,
    toCreate.map((p) => p.repo),
  );
  if (!ok) {
    result.aborted = true;
    result.exitCode = 1;
    return result;
  }

  const content = Buffer.from(text, 'utf8').toString('base64');
  const byName = new Map(all.map((r) => [r.full_name, r]));
  for (const entry of result.repos.filter((r) => r.action === 'create')) {
    const repo = byName.get(entry.repo);
    const req = {
      method: 'PUT',
      path: `${repoPath(repo)}/contents/LICENSE`,
      body: { message, content, branch: repo.default_branch },
    };
    const res = await applyRequest(ctx, req, [
      { command: 'license', repo: repo.full_name, field: 'LICENSE', before: null, after: `${spdx} (${holder}, ${year})` },
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
