// Argument parsing, dependency wiring and dispatch. main() never calls
// process.exit so it can be driven from tests and from the GitHub Action.

import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { changeLogPath, janitorHome } from './changes.js';
import { JanitorError, UsageError } from './errors.js';
import { createClient } from './github.js';
import { renderText, DRY_RUN_BANNER } from './render.js';
import { SEVERITIES } from './rules.js';
import { resolveToken } from './token.js';
import { colorEnabled, confirm, createStyler } from './util.js';
import { VERSION } from './version.js';
import { audit } from './commands/audit.js';
import { fix } from './commands/fix.js';
import { license } from './commands/license.js';
import { archive } from './commands/archive.js';
import { forks } from './commands/forks.js';
import { topics } from './commands/topics.js';

export const EXIT = { OK: 0, ERROR: 1, USAGE: 2, FINDINGS: 3 };

const OPTIONS = {
  token: { type: 'string' },
  owner: { type: 'string' },
  json: { type: 'boolean' },
  'no-color': { type: 'boolean' },
  'no-cache': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  'include-forks': { type: 'boolean' },
  'include-archived': { type: 'boolean' },
  'min-severity': { type: 'string' },
  apply: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  only: { type: 'string' },
  spdx: { type: 'string' },
  holder: { type: 'string' },
  'older-than': { type: 'string' },
  'max-stars': { type: 'string' },
  stale: { type: 'boolean' },
  suggest: { type: 'string' },
};

const COMMON = ['token', 'owner', 'json', 'no-color', 'no-cache', 'help'];

const COMMANDS = {
  audit: {
    run: audit,
    mutating: false,
    options: ['include-forks', 'include-archived', 'min-severity'],
    usage: 'janitor audit [--owner <login>] [--include-forks] [--include-archived] [--min-severity <level>] [--json]',
    summary: 'List hygiene findings for every repository the owner has.',
  },
  fix: {
    run: fix,
    mutating: true,
    options: ['apply', 'yes', 'only', 'include-forks'],
    usage: 'janitor fix [--apply] [--only description,topics,homepage,wiki] [--yes] [--json]',
    summary: 'Fill in missing descriptions, topics and homepages; turn off empty wikis.',
  },
  license: {
    run: license,
    mutating: true,
    options: ['apply', 'yes', 'spdx', 'holder'],
    usage: 'janitor license [--apply] [--spdx MIT] [--holder "Name"] [--yes] [--json]',
    summary: 'Add a LICENSE file to repositories without a detected license (never forks).',
  },
  archive: {
    run: archive,
    mutating: true,
    options: ['apply', 'yes', 'older-than', 'max-stars', 'include-forks'],
    usage: 'janitor archive [--older-than 3y] [--max-stars 0] [--include-forks] [--apply] [--yes] [--json]',
    summary: 'Archive repositories with no recent push and few stars (reversible).',
  },
  forks: {
    run: forks,
    mutating: true,
    options: ['apply', 'yes', 'stale'],
    usage: 'janitor forks [--stale] [--apply] [--yes] [--json]',
    summary: 'Find forks with no commits ahead of upstream; archive stale ones.',
  },
  topics: {
    run: topics,
    mutating: false,
    options: ['suggest'],
    usage: 'janitor topics --suggest <repo> [--json]',
    summary: 'Print the topics janitor would set for one repository.',
  },
};

export function helpText(command) {
  if (command && COMMANDS[command]) {
    const c = COMMANDS[command];
    return `${c.summary}\n\nUsage: ${c.usage}\n\nCommon options: --token <token>, --owner <login>, --json, --no-color, --no-cache, --help\n`;
  }
  const lines = [
    `janitor ${VERSION} - tidy every GitHub repository you own. Dry run first, always.`,
    '',
    'Usage: janitor <command> [options]',
    '',
    'Commands:',
    ...Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(8)} ${c.summary}`),
    '',
    'Common options:',
    '  --token <token>   GitHub token (default: GITHUB_TOKEN, GH_TOKEN, then `gh auth token`)',
    '  --owner <login>   Account to audit (default: the token owner)',
    '  --json            Machine-readable output on stdout',
    '  --no-color        Disable colours (NO_COLOR is honoured too)',
    '  --no-cache        Do not use the ETag cache in ~/.janitor/cache',
    '  --apply           Perform changes (every mutating command is a dry run without it)',
    '  --yes, -y         Skip the confirmation prompt when applying',
    '  --help, -h        Show help (janitor <command> --help for details)',
    '  --version, -v     Print the version',
    '',
    'Exit codes: 0 ok, 1 error, 2 usage error or refusal, 3 findings or pending changes.',
    '',
    'janitor never changes repository visibility and never deletes repositories.',
  ];
  return `${lines.join('\n')}\n`;
}

function camel(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/** Parses argv into { command, options, positionals }. Throws UsageError. */
export function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err.message);
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.version || values.help || !command) return { command: command ?? null, values, rest };
  const spec = COMMANDS[command];
  if (!spec) throw new UsageError(`unknown command "${command}"; run janitor --help`);
  if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0]}"`);
  const allowed = new Set([...COMMON, ...spec.options]);
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) throw new UsageError(`option --${key} is not valid for "${command}"`);
  }
  if (values['min-severity'] && !SEVERITIES.includes(values['min-severity'])) {
    throw new UsageError(`--min-severity must be one of ${SEVERITIES.join(', ')}`);
  }
  if (values.owner !== undefined && !/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(values.owner)) {
    throw new UsageError(`invalid --owner "${values.owner}"`);
  }
  if (command === 'topics' && !values.suggest) throw new UsageError('usage: janitor topics --suggest <repo>');
  return { command, values, rest };
}

/**
 * Runs the CLI.
 * @param {string[]} argv arguments after `janitor`
 * @param {object} deps injectable dependencies for tests and the Action
 * @returns {Promise<{ code: number, result: object|null }>}
 */
export async function run(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  let json = argv.includes('--json');
  try {
    const { command, values } = parseCli(argv);
    json = Boolean(values.json);
    if (values.version) {
      stdout.write(json ? `${JSON.stringify({ version: VERSION })}\n` : `${VERSION}\n`);
      return { code: EXIT.OK, result: null };
    }
    if (values.help || !command) {
      stdout.write(helpText(command));
      return { code: command || values.help ? EXIT.OK : EXIT.USAGE, result: null };
    }

    const spec = COMMANDS[command];
    const style = createStyler(!json && colorEnabled({ noColor: values['no-color'], stream: stdout, env }));
    const options = Object.fromEntries(Object.entries(values).map(([k, v]) => [camel(k), v]));

    let client = deps.client;
    let token = null;
    if (!client) {
      ({ token } = (deps.resolveToken ?? resolveToken)({ flag: values.token, env }));
      if (!token && (spec.mutating || !values.owner)) {
        throw new UsageError('no GitHub token found: pass --token, set GITHUB_TOKEN, or run `gh auth login`');
      }
      client = createClient({
        token,
        fetch: deps.fetch,
        allowWrites: Boolean(spec.mutating && values.apply),
        cacheDir: values['no-cache'] || deps.noCache ? null : join(janitorHome(env), 'cache'),
        sleep: deps.sleep,
        onNotice: (msg) => stderr.write(`janitor: ${msg}\n`),
      });
    }

    // /user answers 401 for a bad token and 403 for installation tokens such
    // as the Actions GITHUB_TOKEN; with --owner an audit can still proceed.
    const viewer = token || deps.client ? await client.getOptional('/user', { quietStatuses: [401, 403] }) : null;
    if (!viewer && (spec.mutating || !values.owner)) {
      throw new UsageError(
        'could not identify the token owner through GET /user; use a personal access token, or pass --owner for a read-only audit',
      );
    }

    if (spec.mutating && !values.apply) {
      (json ? stderr : stdout).write(`${style.yellow(DRY_RUN_BANNER)}\n`);
    }

    const ctx = {
      client,
      viewer,
      owner: values.owner ?? null,
      options,
      now: deps.now ?? Date.now(),
      changeLog: deps.changeLog ?? changeLogPath(env),
      io: {
        stdout,
        stderr,
        interactive: deps.interactive ?? Boolean(process.stdin.isTTY),
        confirm: deps.confirm ?? ((q) => confirm(q, { output: stderr })),
      },
    };
    const result = await spec.run(ctx);
    const { exitCode, ...publicResult } = result;
    stdout.write(json ? `${JSON.stringify(publicResult, null, 2)}\n` : `${renderText(result, style)}\n`);
    return { code: exitCode, result: publicResult };
  } catch (err) {
    const code = err instanceof JanitorError ? err.exitCode : EXIT.ERROR;
    if (json) stdout.write(`${JSON.stringify({ error: { message: err.message, code } }, null, 2)}\n`);
    stderr.write(`janitor: ${err.message}\n`);
    if (code === EXIT.ERROR && !(err instanceof JanitorError) && env.JANITOR_DEBUG) stderr.write(`${err.stack}\n`);
    return { code, result: null };
  }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { code } = await run(argv, deps);
  return code;
}
