// GitHub Action entry point. Runs the CLI in-process with --json, prints the
// human-readable report to the log, appends a Markdown summary to
// GITHUB_STEP_SUMMARY and sets outputs. Findings only fail the step when the
// fail-on-findings input is true.

import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { run } from './main.js';
import { renderMarkdown, renderText } from './render.js';
import { createStyler, splitArgs } from './util.js';

export function readInputs(env = process.env) {
  const input = (name) => String(env[`INPUT_${name.toUpperCase()}`] ?? '').trim();
  return {
    token: input('token') || env.GITHUB_TOKEN || '',
    command: input('command') || 'audit',
    args: splitArgs(input('args')),
    failOnFindings: /^(true|yes|1)$/i.test(input('fail-on-findings')),
  };
}

export function buildArgv({ command, args }, env = process.env) {
  const argv = [command, ...args];
  const hasOwner = args.some((a) => a === '--owner' || a.startsWith('--owner='));
  if (!hasOwner && env.GITHUB_REPOSITORY_OWNER && command !== 'topics') {
    argv.push('--owner', env.GITHUB_REPOSITORY_OWNER);
  }
  if (!argv.includes('--json')) argv.push('--json');
  return argv;
}

function setOutput(env, name, value) {
  if (!env.GITHUB_OUTPUT) return;
  const delimiter = `janitor_${randomUUID()}`;
  appendFileSync(env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

function countFindings(result) {
  if (!result) return 0;
  if (result.command === 'audit') return result.summary.findings;
  if (result.command === 'fix') return result.summary.changes;
  if (result.command === 'license') return result.summary.toCreate;
  if (result.command === 'archive') return result.summary.candidates;
  if (result.command === 'forks') return result.summary.stale;
  return 0;
}

export async function runAction(deps = {}) {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const inputs = readInputs(env);
  const userWantsJson = inputs.args.includes('--json');
  const argv = buildArgv(inputs, env);

  let captured = '';
  const sink = { write: (chunk) => { captured += chunk; return true; }, isTTY: false };
  const { code, result } = await run(argv, {
    ...deps,
    env: { ...env, GITHUB_TOKEN: inputs.token },
    stdout: sink,
    stderr,
    noCache: true,
    interactive: false,
    resolveToken: () => ({ token: inputs.token || null, source: 'input' }),
  });

  if (result) {
    stdout.write(userWantsJson ? captured : `${renderText({ ...result, exitCode: code }, createStyler(false))}\n`);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, renderMarkdown(result));
    setOutput(env, 'findings', String(countFindings(result)));
    setOutput(env, 'exit-code', String(code));
    setOutput(env, 'result', JSON.stringify(result));
  } else {
    stdout.write(captured);
  }

  if (code === 3) {
    if (inputs.failOnFindings) {
      stderr.write(`::error::janitor ${inputs.command} reported ${countFindings(result)} finding(s)\n`);
      return 3;
    }
    return 0;
  }
  return code;
}
