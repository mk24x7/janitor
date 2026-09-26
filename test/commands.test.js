import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/main.js';
import { capture, fixture, makeRepo, mockFetch, NOW, readmeReply, reply, tempHome, b64 } from './helpers.js';

const LIST = 'GET /user/repos?affiliation=owner&sort=full_name&per_page=100';

async function cli(argv, { repos = [], routes = {}, interactive = false, confirm, user = fixture('user.json') } = {}) {
  const home = tempHome();
  const fetch = mockFetch({ 'GET /user': user, [LIST]: repos, ...routes });
  const stdout = capture();
  const stderr = capture();
  const { code, result } = await run(argv, {
    fetch,
    env: { JANITOR_HOME: home },
    resolveToken: () => ({ token: 'test-token', source: 'test' }),
    noCache: true,
    now: NOW,
    stdout,
    stderr,
    interactive,
    confirm,
    sleep: async () => {},
  });
  return { code, result, stdout: stdout.text, stderr: stderr.text, fetch, home, changeLog: join(home, 'changes.jsonl') };
}

function readLog(file) {
  return readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

// --- audit --------------------------------------------------------------------

test('audit --json: output shape, severity sorting, summary and exit code 3', async () => {
  const repos = [
    makeRepo({ name: 'tidy', description: 'Tidy', topics: ['x'] }),
    makeRepo({ name: 'messy', description: null, topics: [], license: null, default_branch: 'master', visibility: 'private', private: true }),
    makeRepo({ name: 'info-only', default_branch: 'master' }),
    makeRepo({ name: 'old', archived: true }),
    makeRepo({ name: 'forked', fork: true }),
  ];
  const routes = {
    'GET /repos/mk/tidy/readme': readmeReply('x'.repeat(300)),
    'GET /repos/mk/messy/readme': readmeReply('tiny'),
    'GET /repos/mk/info-only/readme': readmeReply('y'.repeat(300)),
    'GET /repos/mk/messy/dependabot/alerts': reply({ message: 'Dependabot alerts are disabled' }, 403),
    'GET /repos/mk/tidy/dependabot/alerts': [],
    'GET /repos/mk/info-only/dependabot/alerts': [],
  };
  const { code, stdout, result } = await cli(['audit', '--json'], { repos, routes });
  assert.equal(code, 3);
  const out = JSON.parse(stdout);
  assert.deepEqual(Object.keys(out), ['command', 'owner', 'generatedAt', 'options', 'summary', 'repos', 'rules']);
  assert.deepEqual(out, result);
  assert.equal(out.owner, 'mk');
  assert.deepEqual(out.repos.map((r) => r.name), ['messy', 'info-only', 'tidy']);
  assert.deepEqual(
    out.repos[0].findings.map((f) => f.rule),
    ['missing-description', 'missing-license', 'empty-readme', 'no-topics', 'default-branch-master'],
  );
  assert.deepEqual(Object.keys(out.repos[0].findings[0]), ['rule', 'severity', 'message', 'fixableBy']);
  assert.equal(out.repos[0].visibility, 'private');
  assert.equal(out.summary.repos, 3);
  assert.equal(out.summary.clean, 1);
  assert.equal(out.summary.findings, 6);
  assert.deepEqual(out.summary.bySeverity, { medium: 3, low: 1, info: 2 });
  assert.deepEqual(out.summary.skipped, { forks: 1, archived: 1 });
  assert.equal(out.summary.dependabotUnreadable, 1);
  assert.equal(out.rules.length, 11);
});

test('audit exits 0 when clean and prints a summary footer', async () => {
  const repos = [makeRepo({ name: 'tidy' })];
  const { code, stdout } = await cli(['audit', '--no-color'], { repos, routes: { 'GET /repos/mk/tidy/readme': readmeReply('z'.repeat(250)) } });
  assert.equal(code, 0);
  assert.match(stdout, /1 repository audited\./);
  assert.match(stdout, /0 with findings, 1 clean/);
});

test('audit --min-severity filters findings and the exit code follows', async () => {
  const repos = [makeRepo({ name: 'm', default_branch: 'master' })];
  const { code, result } = await cli(['audit', '--json', '--min-severity', 'low'], {
    repos,
    routes: { 'GET /repos/mk/m/readme': readmeReply('z'.repeat(250)) },
  });
  assert.equal(code, 0);
  assert.equal(result.summary.findings, 0);
});

test('audit --owner other lists /users/{login}/repos', async () => {
  const other = makeRepo({ name: 'theirs', owner: { login: 'octo' } });
  const { code, fetch } = await cli(['audit', '--owner', 'octo', '--json'], {
    routes: {
      'GET /users/octo/repos?type=owner&sort=full_name&per_page=100': [other],
      'GET /repos/octo/theirs/readme': readmeReply('z'.repeat(250)),
    },
  });
  assert.equal(code, 0);
  assert.ok(fetch.calls.some((c) => c.path.startsWith('/users/octo/repos')));
  assert.ok(!fetch.calls.some((c) => c.path.startsWith('/user/repos')));
});

test('audit --include-forks evaluates stale-fork through the compare API', async () => {
  const fork = makeRepo({ name: 'fk', fork: true, pushed_at: '2024-05-01T00:00:00Z' });
  const { result } = await cli(['audit', '--include-forks', '--json'], {
    repos: [fork],
    routes: {
      'GET /repos/mk/fk/readme': readmeReply('z'.repeat(250)),
      'GET /repos/mk/fk': { ...fork, parent: { full_name: 'up/fk', default_branch: 'main' } },
      'GET /repos/up/fk/compare/main...mk:main': { ahead_by: 0, behind_by: 12 },
    },
  });
  assert.deepEqual(result.repos[0].findings.map((f) => f.rule), ['stale-fork']);
});

// --- fix ----------------------------------------------------------------------

const fixRepos = () => [
  makeRepo({ name: 'site', description: null, topics: [], homepage: null, language: 'TypeScript', has_wiki: true, visibility: 'public' }),
  makeRepo({ name: 'done' }),
  makeRepo({ name: 'noreadme', description: '', topics: ['x'] }),
];
const fixRoutes = () => ({
  'GET /repos/mk/site/readme': readmeReply(fixture('readme-badges.md')),
  'GET /repos/mk/site/contents/': [{ name: 'package.json' }, { name: 'README.md' }],
  'GET /repos/mk/site/contents/package.json': { encoding: 'base64', content: b64(JSON.stringify(fixture('package-next.json'))) },
  'GET github.com/mk/site.wiki.git/info/refs': reply('', 404),
  'GET github.com/mk/site.git/info/refs': reply('', 200),
});

test('fix dry run prints proposals, sends no writes and exits 3', async () => {
  const { code, stdout, fetch, changeLog } = await cli(['fix', '--no-color'], { repos: fixRepos(), routes: fixRoutes() });
  assert.equal(code, 3);
  assert.match(stdout, /^DRY RUN/);
  assert.match(stdout, /description: \(empty\) -> "Fast, in-memory work queue/);
  assert.match(stdout, /homepage: \(empty\) -> "https:\/\/fastq.dev"/);
  assert.match(stdout, /topics: \(none\) -> typescript, nextjs, react, fastq/);
  assert.match(stdout, /has_wiki: true -> false/);
  assert.match(stdout, /skip description: no README/);
  assert.deepEqual(fetch.writes(), []);
  assert.equal(existsSync(changeLog), false);
});

test('fix --apply --yes issues exactly the expected requests and logs each change', async () => {
  const routes = {
    ...fixRoutes(),
    'PATCH /repos/mk/site': (call) => reply({ ...call.body }),
    'PUT /repos/mk/site/topics': (call) => reply(call.body),
  };
  const { code, fetch, changeLog, result } = await cli(['fix', '--apply', '--yes', '--json'], { repos: fixRepos(), routes });
  assert.equal(code, 0);
  assert.deepEqual(
    fetch.writes().map(({ method, path, body }) => ({ method, path, body })),
    [
      {
        method: 'PATCH',
        path: '/repos/mk/site',
        body: {
          description: 'Fast, in-memory work queue for Node.js with async workers and back pressure. See the guide for details.',
          homepage: 'https://fastq.dev',
          has_wiki: false,
        },
      },
      { method: 'PUT', path: '/repos/mk/site/topics', body: { names: ['typescript', 'nextjs', 'react', 'fastq'] } },
    ],
  );
  assert.equal(result.summary.applied, 4);
  const log = readLog(changeLog);
  assert.deepEqual(log.map((l) => l.field), ['description', 'homepage', 'has_wiki', 'topics']);
  assert.equal(log[0].before, null);
  assert.equal(log[2].before, true);
  assert.equal(log[2].after, false);
  assert.deepEqual(log[3].request, { method: 'PUT', path: '/repos/mk/site/topics' });
  assert.ok(log.every((l) => l.repo === 'mk/site' && l.command === 'fix' && l.time));
});

test('fix --only topics limits the plan', async () => {
  const routes = { ...fixRoutes(), 'PUT /repos/mk/site/topics': (call) => reply(call.body) };
  const { fetch } = await cli(['fix', '--only', 'topics', '--apply', '--yes'], { repos: fixRepos(), routes });
  assert.deepEqual(fetch.writes().map((c) => `${c.method} ${c.path}`), ['PUT /repos/mk/site/topics']);
});

test('fix --only rejects unknown fix names', async () => {
  const { code, stderr } = await cli(['fix', '--only', 'visibility'], { repos: fixRepos() });
  assert.equal(code, 2);
  assert.match(stderr, /unknown fix "visibility"/);
});

test('fix --apply without --yes refuses on a non-interactive stdin', async () => {
  const { code, fetch, stderr } = await cli(['fix', '--apply'], { repos: fixRepos(), routes: fixRoutes() });
  assert.equal(code, 2);
  assert.match(stderr, /--yes/);
  assert.deepEqual(fetch.writes(), []);
});

test('fix --apply stops when the confirmation is declined', async () => {
  const { code, fetch } = await cli(['fix', '--apply'], { repos: fixRepos(), routes: fixRoutes(), interactive: true, confirm: async () => false });
  assert.equal(code, 1);
  assert.deepEqual(fetch.writes(), []);
});

test('fix skips an ambiguous homepage and archived repositories', async () => {
  const repos = [
    makeRepo({ name: 'amb', homepage: null }),
    makeRepo({ name: 'arch', description: null, archived: true }),
  ];
  const { result, fetch } = await cli(['fix', '--json'], {
    repos,
    routes: { 'GET /repos/mk/amb/readme': readmeReply('Visit https://one.dev or https://two.dev for more.') },
  });
  assert.equal(result.repos.length, 1);
  assert.match(result.repos[0].skipped[0].reason, /several sites/);
  assert.ok(!fetch.calls.some((c) => c.path.includes('/arch')));
});

// --- license ------------------------------------------------------------------

test('license dry run lists unlicensed repositories and always skips forks', async () => {
  const repos = [
    makeRepo({ name: 'nolic', license: null }),
    makeRepo({ name: 'forked', license: null, fork: true }),
    makeRepo({ name: 'hasfile', license: null }),
    makeRepo({ name: 'empty', license: null }),
    makeRepo({ name: 'licensed' }),
  ];
  const { code, result, fetch } = await cli(['license', '--json'], {
    repos,
    routes: {
      'GET /repos/mk/nolic/contents/': [{ name: 'index.js' }],
      'GET /repos/mk/hasfile/contents/': [{ name: 'LICENSE.txt' }],
    },
  });
  assert.equal(code, 3);
  assert.deepEqual(result.repos.map((r) => [r.repo, r.status]), [
    ['mk/nolic', 'planned'],
    ['mk/hasfile', 'skipped'],
    ['mk/empty', 'skipped'],
  ]);
  assert.equal(result.summary.forksSkipped, 1);
  assert.deepEqual(fetch.writes(), []);
});

test('license --apply creates LICENSE on the default branch with the expected commit', async () => {
  const repos = [makeRepo({ name: 'nolic', license: null, default_branch: 'trunk' })];
  const { code, fetch, changeLog } = await cli(['license', '--apply', '--yes', '--holder', 'Jane Doe'], {
    repos,
    routes: {
      'GET /repos/mk/nolic/contents/': [{ name: 'index.js' }],
      'PUT /repos/mk/nolic/contents/LICENSE': reply({ content: { path: 'LICENSE' } }, 201),
    },
  });
  assert.equal(code, 0);
  const writes = fetch.writes();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.message, 'Add MIT license');
  assert.equal(writes[0].body.branch, 'trunk');
  assert.equal(writes[0].body.sha, undefined);
  const text = Buffer.from(writes[0].body.content, 'base64').toString('utf8');
  assert.match(text, /^MIT License\n\nCopyright \(c\) 2026 Jane Doe\n/);
  assert.equal(readLog(changeLog)[0].field, 'LICENSE');
});

test('license holder defaults to the name on /user', async () => {
  const { result } = await cli(['license', '--json'], { repos: [] });
  assert.equal(result.holder, 'Mukul Test');
  assert.equal(result.commitMessage, 'Add MIT license');
});

// --- archive ------------------------------------------------------------------

test('archive dry run lists candidates with last push dates', async () => {
  const repos = [
    makeRepo({ name: 'ancient', pushed_at: '2021-03-04T00:00:00Z', stargazers_count: 0 }),
    makeRepo({ name: 'active' }),
  ];
  const { code, stdout, fetch } = await cli(['archive', '--no-color'], { repos });
  assert.equal(code, 3);
  assert.match(stdout, /mk\/ancient\s+public\s+2021-03-04\s+0/);
  assert.doesNotMatch(stdout, /mk\/active/);
  assert.deepEqual(fetch.writes(), []);
});

test('archive --apply --yes sends only PATCH archived:true for candidates', async () => {
  const repos = [
    makeRepo({ name: 'ancient', pushed_at: '2021-03-04T00:00:00Z', stargazers_count: 0, visibility: 'private', private: true }),
    makeRepo({ name: 'older', pushed_at: '2020-01-01T00:00:00Z', stargazers_count: 1 }),
  ];
  const { code, fetch, changeLog } = await cli(['archive', '--apply', '--yes', '--max-stars', '1', '--older-than', '4y'], {
    repos,
    routes: { 'PATCH /repos/mk/ancient': (c) => reply(c.body), 'PATCH /repos/mk/older': (c) => reply(c.body) },
  });
  assert.equal(code, 0);
  assert.deepEqual(fetch.writes().map((c) => [c.path, c.body]), [
    ['/repos/mk/older', { archived: true }],
    ['/repos/mk/ancient', { archived: true }],
  ]);
  assert.equal(readLog(changeLog).length, 2);
});

test('archive reports API failures per repository with exit code 1', async () => {
  const repos = [makeRepo({ name: 'ancient', pushed_at: '2021-03-04T00:00:00Z', stargazers_count: 0 })];
  const { code, result } = await cli(['archive', '--apply', '--yes', '--json'], {
    repos,
    routes: { 'PATCH /repos/mk/ancient': reply({ message: 'Must have admin rights' }, 403) },
  });
  assert.equal(code, 1);
  assert.equal(result.repos[0].status, 'failed');
  assert.match(result.repos[0].error, /admin rights/);
});

// --- forks --------------------------------------------------------------------

test('forks --stale --apply archives only forks that are 0 ahead and idle for a year', async () => {
  const stale = makeRepo({ name: 'stale', fork: true, pushed_at: '2024-01-01T00:00:00Z' });
  const ahead = makeRepo({ name: 'ahead', fork: true, pushed_at: '2024-01-01T00:00:00Z' });
  const fresh = makeRepo({ name: 'fresh', fork: true, pushed_at: '2026-09-01T00:00:00Z' });
  const parent = (n) => ({ parent: { full_name: `up/${n}`, default_branch: 'main' }, default_branch: 'main' });
  const { code, fetch, result } = await cli(['forks', '--stale', '--apply', '--yes', '--json'], {
    repos: [stale, ahead, fresh, makeRepo({ name: 'own' })],
    routes: {
      'GET /repos/mk/stale': { ...stale, ...parent('stale') },
      'GET /repos/mk/ahead': { ...ahead, ...parent('ahead') },
      'GET /repos/mk/fresh': { ...fresh, ...parent('fresh') },
      'GET /repos/up/stale/compare/main...mk:main': { ahead_by: 0, behind_by: 40 },
      'GET /repos/up/ahead/compare/main...mk:main': { ahead_by: 3, behind_by: 1 },
      'GET /repos/up/fresh/compare/main...mk:main': { ahead_by: 0, behind_by: 0 },
      'PATCH /repos/mk/stale': (c) => reply(c.body),
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(fetch.writes().map((c) => [c.method, c.path, c.body]), [['PATCH', '/repos/mk/stale', { archived: true }]]);
  assert.deepEqual(result.repos.map((r) => r.repo), ['mk/stale']);
  assert.ok(!fetch.calls.some((c) => c.method === 'DELETE'));
});

test('forks dry run lists all forks with ahead/behind counts', async () => {
  const fk = makeRepo({ name: 'fk', fork: true });
  const { code, result } = await cli(['forks', '--json'], {
    repos: [fk],
    routes: {
      'GET /repos/mk/fk': { ...fk, parent: { full_name: 'up/fk', default_branch: 'dev' } },
      'GET /repos/up/fk/compare/dev...mk:main': { ahead_by: 2, behind_by: 5 },
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(
    { aheadBy: result.repos[0].aheadBy, behindBy: result.repos[0].behindBy, stale: result.repos[0].stale },
    { aheadBy: 2, behindBy: 5, stale: false },
  );
});

// --- safety -------------------------------------------------------------------

for (const command of ['fix', 'license', 'archive', 'forks']) {
  test(`${command} refuses when --owner differs from the token owner`, async () => {
    const { code, stderr, fetch } = await cli([command, '--owner', 'someone-else', '--apply', '--yes'], { repos: fixRepos() });
    assert.equal(code, 2);
    assert.match(stderr, /token belongs to mk but --owner is someone-else/);
    assert.deepEqual(fetch.writes(), []);
    assert.ok(!fetch.calls.some((c) => c.path.includes('/repos')));
  });
}

test('mutating commands refuse when the token owner cannot be identified', async () => {
  const { code, fetch } = await cli(['archive', '--apply', '--yes'], { user: reply({ message: 'Bad credentials' }, 401) });
  assert.equal(code, 2);
  assert.deepEqual(fetch.writes(), []);
});

// --- topics and misc ------------------------------------------------------------

test('topics --suggest prints the suggestion for one repository', async () => {
  const repo = makeRepo({ name: 'app', language: 'Swift', topics: [], homepage: 'https://app.appkit.dev' });
  const { code, result, stdout } = await cli(['topics', '--suggest', 'app', '--json'], {
    routes: { 'GET /repos/mk/app': repo, 'GET /repos/mk/app/contents/': [{ name: 'Package.swift' }] },
  });
  assert.equal(code, 0);
  assert.deepEqual(result.suggested, ['swift', 'swiftpm', 'appkit']);
  assert.deepEqual(JSON.parse(stdout).suggested, result.suggested);
});

test('usage errors exit 2 and are reported as JSON with --json', async () => {
  const { code, stdout } = await cli(['audit', '--json', '--apply']);
  assert.equal(code, 2);
  assert.deepEqual(JSON.parse(stdout), { error: { message: 'option --apply is not valid for "audit"', code: 2 } });
});

test('API failures exit 1', async () => {
  const { code, stderr } = await cli(['audit'], { routes: { [LIST]: reply({ message: 'Server Error' }, 500) } });
  assert.equal(code, 1);
  assert.match(stderr, /failed with 500/);
});
