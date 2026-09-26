// janitor topics --suggest <repo>: print the topics janitor would set.

import { UsageError } from '../errors.js';
import { deriveTopics } from '../derive.js';
import { fetchFileText, fetchRootFiles, repoPath } from '../inspect.js';

export async function topics(ctx) {
  const { client, options } = ctx;
  const target = options.suggest;
  if (!target) throw new UsageError('usage: janitor topics --suggest <repo>');
  const owner = ctx.owner ?? ctx.viewer?.login;
  const fullName = target.includes('/') ? target : `${owner}/${target}`;
  if (!/^[^/\s]+\/[^/\s]+$/.test(fullName)) throw new UsageError(`invalid repository "${target}"`);

  const repo = await client.get(repoPath({ full_name: fullName }));
  const files = await fetchRootFiles(client, repo);
  let packageJson = null;
  if (files.includes('package.json')) {
    try {
      packageJson = JSON.parse((await fetchFileText(client, repo, 'package.json')) ?? 'null');
    } catch {
      packageJson = null;
    }
  }
  const suggested = deriveTopics({
    language: repo.language,
    files,
    packageJson,
    homepage: repo.homepage,
    owner: repo.owner?.login ?? owner,
  });
  return {
    command: 'topics',
    repo: repo.full_name,
    current: repo.topics ?? [],
    suggested,
    inputs: { language: repo.language ?? null, rootFiles: files, homepage: repo.homepage || null },
    exitCode: 0,
  };
}
