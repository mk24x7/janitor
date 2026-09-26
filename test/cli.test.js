import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCli, run } from '../src/main.js';
import { resolveToken } from '../src/token.js';
import { VERSION } from '../src/version.js';
import { UsageError } from '../src/errors.js';
import { capture } from './helpers.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('src/version.js matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
  assert.equal(pkg.bin.janitor, 'src/cli.js');
  assert.equal(pkg.dependencies, undefined, 'janitor has zero runtime dependencies');
});

test('--version prints the version and exits 0 (subprocess)', () => {
  assert.equal(execFileSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' }).trim(), VERSION);
});

test('--help lists every command and the exit codes', async () => {
  const stdout = capture();
  const { code } = await run(['--help'], { stdout, stderr: capture() });
  assert.equal(code, 0);
  for (const cmd of ['audit', 'fix', 'license', 'archive', 'forks', 'topics']) assert.match(stdout.text, new RegExp(`\\n  ${cmd} `));
  assert.match(stdout.text, /Exit codes: 0 ok, 1 error, 2 usage error or refusal, 3 findings/);
});

test('no command prints help and exits 2; unknown command exits 2', () => {
  assert.equal(spawnSync(process.execPath, [CLI], { encoding: 'utf8' }).status, 2);
  const res = spawnSync(process.execPath, [CLI, 'delete'], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown command "delete"/);
});

test('parseCli validates options per command', () => {
  assert.throws(() => parseCli(['audit', '--yes']), UsageError);
  assert.throws(() => parseCli(['topics']), UsageError);
  assert.throws(() => parseCli(['audit', '--min-severity', 'high']), UsageError);
  assert.throws(() => parseCli(['audit', '--owner', 'bad/name']), UsageError);
  assert.throws(() => parseCli(['audit', 'extra']), UsageError);
  assert.equal(parseCli(['archive', '--older-than', '2y', '--apply']).values['older-than'], '2y');
});

test('there is no command or option that changes visibility or deletes', async () => {
  const stdout = capture();
  await run(['--help'], { stdout, stderr: capture() });
  assert.doesNotMatch(stdout.text, /--(visibility|private|public|delete)/);
  assert.throws(() => parseCli(['fix', '--visibility', 'public']), UsageError);
});

test('token resolution order: flag, GITHUB_TOKEN, GH_TOKEN, gh auth token', () => {
  const spawn = () => ({ status: 0, stdout: 'from-gh\n' });
  assert.equal(resolveToken({ flag: 'f', env: { GITHUB_TOKEN: 'e' }, spawn, which: () => '/bin/gh' }).token, 'f');
  assert.equal(resolveToken({ env: { GITHUB_TOKEN: 'e', GH_TOKEN: 'g' }, spawn, which: () => '/bin/gh' }).token, 'e');
  assert.equal(resolveToken({ env: { GH_TOKEN: 'g' }, spawn, which: () => '/bin/gh' }).token, 'g');
  assert.deepEqual(resolveToken({ env: {}, spawn, which: () => '/bin/gh' }), { token: 'from-gh', source: 'gh auth token' });
});

test('gh is only spawned when it is on PATH', () => {
  let spawned = false;
  const spawn = () => {
    spawned = true;
    return { status: 0, stdout: 'x' };
  };
  assert.deepEqual(resolveToken({ env: {}, spawn, which: () => null }), { token: null, source: null });
  assert.equal(spawned, false);
});

test('missing token is a usage error with guidance', async () => {
  const stderr = capture();
  const { code } = await run(['audit'], { stdout: capture(), stderr, resolveToken: () => ({ token: null }) });
  assert.equal(code, 2);
  assert.match(stderr.text, /no GitHub token found/);
});
