// Append-only log of applied changes at ~/.janitor/changes.jsonl.

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function janitorHome(env = process.env) {
  return env.JANITOR_HOME || join(homedir(), '.janitor');
}

export function changeLogPath(env = process.env) {
  return join(janitorHome(env), 'changes.jsonl');
}

/**
 * Appends one JSON line per applied change.
 * @param {string} file
 * @param {object} entry { repo, command, field, before, after, request }
 */
export function logChange(file, entry, now = new Date()) {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify({ time: now.toISOString(), ...entry })}\n`, { mode: 0o600 });
}
