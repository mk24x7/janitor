// Helpers shared by the commands.

import { UsageError } from '../errors.js';
import { logChange } from '../changes.js';

/**
 * Mutating commands only ever act on the token owner's own repositories.
 * Throws UsageError when --owner names somebody else.
 */
export function assertOwnerMatches(ctx) {
  const login = ctx.viewer?.login;
  if (!login) throw new UsageError('a GitHub token is required for this command');
  if (ctx.owner && ctx.owner.toLowerCase() !== login.toLowerCase()) {
    throw new UsageError(
      `refusing to run: the token belongs to ${login} but --owner is ${ctx.owner}; janitor only changes repositories owned by the token's user`,
    );
  }
  return login;
}

/**
 * Asks for confirmation before applying changes. --yes skips the prompt; a
 * non-interactive stdin without --yes is refused rather than assumed.
 */
export async function confirmApply(ctx, question, lines = []) {
  if (ctx.options.yes) return true;
  if (!ctx.io.interactive) {
    throw new UsageError('confirmation required: re-run with --yes to apply non-interactively');
  }
  for (const line of lines) ctx.io.stderr.write(`  ${line}\n`);
  return ctx.io.confirm(question);
}

/**
 * Sends one mutating request and logs a change entry per field on success.
 * Returns { ok: true } or { ok: false, error }.
 */
export async function applyRequest(ctx, { method, path, body }, entries) {
  try {
    await ctx.client.request(method, path, { body });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  for (const entry of entries) {
    logChange(ctx.changeLog, { ...entry, request: { method, path } }, new Date(ctx.now));
  }
  return { ok: true };
}

export function dryRunResult(apply) {
  return { dryRun: !apply, applied: false };
}
