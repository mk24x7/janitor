import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildArgv, readInputs, runAction } from '../src/action.js';
import { renderMarkdown } from '../src/render.js';
import { capture, fixture, makeRepo, mockFetch, NOW, readmeReply, tempHome } from './helpers.js';

test('readInputs reads INPUT_* variables with defaults', () => {
  const inputs = readInputs({ INPUT_TOKEN: 't', INPUT_ARGS: '--include-forks --min-severity "low"', 'INPUT_FAIL-ON-FINDINGS': 'true' });
  assert.deepEqual(inputs, { token: 't', command: 'audit', args: ['--include-forks', '--min-severity', 'low'], failOnFindings: true });
  assert.equal(readInputs({}).failOnFindings, false);
});

test('buildArgv adds the repository owner and --json', () => {
  assert.deepEqual(buildArgv({ command: 'audit', args: [] }, { GITHUB_REPOSITORY_OWNER: 'mk' }), ['audit', '--owner', 'mk', '--json']);
  assert.deepEqual(buildArgv({ command: 'audit', args: ['--owner', 'x'] }, { GITHUB_REPOSITORY_OWNER: 'mk' }), ['audit', '--owner', 'x', '--json']);
});

async function action(env, repos) {
  const dir = tempHome();
  const summary = join(dir, 'summary.md');
  const output = join(dir, 'output.txt');
  const fetch = mockFetch({
    'GET /user': fixture('user.json'),
    'GET /user/repos?affiliation=owner&sort=full_name&per_page=100': repos,
    'GET /repos/mk/messy/readme': readmeReply('x'.repeat(300)),
  });
  const stdout = capture();
  const code = await runAction({
    env: { INPUT_TOKEN: 'tok', GITHUB_REPOSITORY_OWNER: 'mk', GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output, JANITOR_HOME: dir, ...env },
    fetch,
    now: NOW,
    stdout,
    stderr: capture(),
  });
  return { code, stdout: stdout.text, summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '', output: readFileSync(output, 'utf8') };
}

test('action writes a Markdown job summary and outputs; findings do not fail by default', async () => {
  const { code, stdout, summary, output } = await action({}, [makeRepo({ name: 'messy', license: null })]);
  assert.equal(code, 0);
  assert.match(stdout, /janitor audit for mk/);
  assert.match(summary, /^## janitor audit: mk/);
  assert.match(summary, /\| missing-license \| medium \| 1 \| janitor license \|/);
  assert.match(output, /findings<<janitor_[\w-]+\n1\n/);
  assert.match(output, /exit-code<<janitor_[\w-]+\n3\n/);
});

test('action fails with exit 3 when fail-on-findings is true', async () => {
  const { code } = await action({ 'INPUT_FAIL-ON-FINDINGS': 'true' }, [makeRepo({ name: 'messy', license: null })]);
  assert.equal(code, 3);
});

test('action passes when there are no findings even with fail-on-findings', async () => {
  const { code } = await action({ 'INPUT_FAIL-ON-FINDINGS': 'true' }, [makeRepo({ name: 'messy' })]);
  assert.equal(code, 0);
});

test('renderMarkdown escapes table pipes and renders non-audit results', () => {
  const md = renderMarkdown({
    command: 'archive',
    owner: 'mk',
    dryRun: true,
    repos: [{ repo: 'mk/a|b', pushedAt: '2020-01-01T00:00:00Z', stars: 0, status: 'planned' }],
  });
  assert.match(md, /## janitor archive \(dry run\): mk/);
  assert.match(md, /mk\/a\\\|b/);
});

test('action.yml runs dist/index.js on node24 with the documented inputs', () => {
  const yml = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
  assert.match(yml, /using: node24/);
  assert.match(yml, /main: dist\/index\.js/);
  for (const input of ['token', 'command', 'args', 'fail-on-findings']) assert.match(yml, new RegExp(`\\n  ${input}:\\n`));
  assert.ok(existsSync(new URL('../dist/index.js', import.meta.url)));
});
