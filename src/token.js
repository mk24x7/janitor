// Token resolution: --token, then GITHUB_TOKEN (or GH_TOKEN), then `gh auth token`.

import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

export function findExecutable(name, env = process.env, platform = process.platform) {
  const dirs = String(env.PATH ?? '').split(delimiter).filter(Boolean);
  const exts = platform === 'win32' ? String(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

/**
 * @returns {{ token: string|null, source: string|null }}
 */
export function resolveToken({ flag, env = process.env, spawn = spawnSync, which = findExecutable } = {}) {
  if (flag) return { token: flag, source: '--token' };
  if (env.GITHUB_TOKEN) return { token: env.GITHUB_TOKEN, source: 'GITHUB_TOKEN' };
  if (env.GH_TOKEN) return { token: env.GH_TOKEN, source: 'GH_TOKEN' };
  const gh = which('gh', env);
  if (!gh) return { token: null, source: null };
  const result = spawn(gh, ['auth', 'token'], { encoding: 'utf8', timeout: 10_000 });
  const token = result && result.status === 0 ? String(result.stdout ?? '').trim() : '';
  return token ? { token, source: 'gh auth token' } : { token: null, source: null };
}
