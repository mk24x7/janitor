import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAllowedMutation, createClient, parseLinkHeader } from '../src/github.js';
import { HttpError, SafetyError } from '../src/errors.js';
import { fixture, mockFetch, reply, sequence, tempHome } from './helpers.js';

const API = 'https://api.github.com';

test('paginate follows Link rel="next" across pages', async () => {
  const fetch = mockFetch({
    'GET /user/repos?affiliation=owner&per_page=100': reply(fixture('repos-page1.json'), 200, {
      link: `<${API}/user/repos?affiliation=owner&per_page=100&page=2>; rel="next", <${API}/user/repos?affiliation=owner&per_page=100&page=2>; rel="last"`,
    }),
    'GET /user/repos?affiliation=owner&per_page=100&page=2': reply(fixture('repos-page2.json'), 200, {
      link: `<${API}/user/repos?affiliation=owner&per_page=100&page=1>; rel="prev"`,
    }),
  });
  const client = createClient({ token: 't', fetch });
  const repos = await client.paginate('/user/repos?affiliation=owner&per_page=100');
  assert.deepEqual(repos.map((r) => r.name), ['alpha', 'beta', 'gamma', 'delta']);
  assert.equal(fetch.calls.length, 2);
});

test('parseLinkHeader extracts relations', () => {
  const links = parseLinkHeader('<https://x/a?page=2>; rel="next", <https://x/a?page=9>; rel="last"');
  assert.deepEqual(links, { next: 'https://x/a?page=2', last: 'https://x/a?page=9' });
  assert.deepEqual(parseLinkHeader(null), {});
});

test('requests carry auth, API version and user agent headers', async () => {
  const fetch = mockFetch({ 'GET /user': { login: 'mk' } });
  const client = createClient({ token: 'secret', fetch });
  await client.get('/user');
  const h = fetch.calls[0].headers;
  assert.equal(h.Authorization, 'Bearer secret');
  assert.equal(h['X-GitHub-Api-Version'], '2022-11-28');
  assert.match(h['User-Agent'], /^janitor\//);
});

test('secondary rate limit: waits for Retry-After and retries', async () => {
  const sleeps = [];
  const fetch = mockFetch({
    'GET /user': sequence(reply({ message: 'You have exceeded a secondary rate limit' }, 403, { 'retry-after': '2' }), reply({ login: 'mk' })),
  });
  const client = createClient({ token: 't', fetch, sleep: async (ms) => sleeps.push(ms) });
  const user = await client.get('/user');
  assert.equal(user.login, 'mk');
  assert.deepEqual(sleeps, [2000]);
  assert.equal(fetch.calls.length, 2);
});

test('secondary rate limit without Retry-After backs off exponentially', async () => {
  const sleeps = [];
  const fetch = mockFetch({
    'GET /user': sequence(reply({ message: 'You have exceeded a secondary rate limit.' }, 403), reply({ login: 'mk' })),
  });
  const client = createClient({ token: 't', fetch, sleep: async (ms) => sleeps.push(ms) });
  await client.get('/user');
  assert.deepEqual(sleeps, [60_000]);
});

test('primary rate limit: waits until X-RateLimit-Reset before the next request', async () => {
  const now = 1_000_000_000_000;
  const reset = now / 1000 + 30;
  const sleeps = [];
  const fetch = mockFetch({
    'GET /a': reply([], 200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }),
    'GET /b': reply([], 200, { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String(reset + 3600) }),
  });
  const client = createClient({ token: 't', fetch, now: () => now, sleep: async (ms) => sleeps.push(ms) });
  await client.get('/a');
  await client.get('/b');
  assert.deepEqual(sleeps, [31_000]);
  assert.equal(client.rate.remaining, 4999);
});

test('a plain 403 permission error is not retried', async () => {
  const fetch = mockFetch({ 'GET /repos/mk/a/dependabot/alerts': reply({ message: 'Resource not accessible' }, 403) });
  const client = createClient({ token: 't', fetch, sleep: async () => assert.fail('should not sleep') });
  await assert.rejects(client.get('/repos/mk/a/dependabot/alerts'), (err) => err instanceof HttpError && err.status === 403);
  assert.equal(fetch.calls.length, 1);
});

test('getOptional maps 404 to null', async () => {
  const client = createClient({ token: 't', fetch: mockFetch({}) });
  assert.equal(await client.getOptional('/repos/mk/a/readme'), null);
});

test('mutations are refused before any network call when writes are disabled', async () => {
  const fetch = mockFetch({});
  const client = createClient({ token: 't', fetch });
  await assert.rejects(client.request('PATCH', '/repos/mk/a', { body: { description: 'x' } }), SafetyError);
  assert.equal(fetch.calls.length, 0);
});

test('never changes visibility, default branch or other fields, even with writes enabled', async () => {
  const fetch = mockFetch({});
  const client = createClient({ token: 't', fetch, allowWrites: true });
  for (const body of [{ private: true }, { visibility: 'public' }, { default_branch: 'main' }, { description: 'ok', private: false }]) {
    await assert.rejects(client.request('PATCH', '/repos/mk/a', { body }), SafetyError);
  }
  assert.equal(fetch.calls.length, 0);
});

test('assertAllowedMutation: allowlist of janitor writes', () => {
  assert.doesNotThrow(() => assertAllowedMutation('PATCH', '/repos/mk/a', { description: 'x', homepage: 'https://x.dev', has_wiki: false }));
  assert.doesNotThrow(() => assertAllowedMutation('PATCH', '/repos/mk/a', { archived: true }));
  assert.doesNotThrow(() => assertAllowedMutation('PUT', '/repos/mk/a/topics', { names: ['x'] }));
  assert.doesNotThrow(() => assertAllowedMutation('PUT', '/repos/mk/a/contents/LICENSE', { message: 'm', content: 'eA==' }));
  assert.throws(() => assertAllowedMutation('DELETE', '/repos/mk/a'), SafetyError);
  assert.throws(() => assertAllowedMutation('PATCH', '/repos/mk/a', { archived: false }), SafetyError);
  assert.throws(() => assertAllowedMutation('PUT', '/repos/mk/a/contents/LICENSE', { message: 'm', content: 'x', sha: 'abc' }), SafetyError);
  assert.throws(() => assertAllowedMutation('PUT', '/repos/mk/a/contents/README.md', { message: 'm', content: 'x' }), SafetyError);
  assert.throws(() => assertAllowedMutation('POST', '/repos/mk/a/transfer', { new_owner: 'x' }), SafetyError);
  assert.throws(() => assertAllowedMutation('PUT', '/repos/mk/a/collaborators/x', {}), SafetyError);
});

test('caps concurrent requests at 4', async () => {
  let inFlight = 0;
  let peak = 0;
  const fetch = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return new Response('{}', { status: 200 });
  };
  const client = createClient({ token: 't', fetch });
  await Promise.all(Array.from({ length: 12 }, (_, i) => client.get(`/x/${i}`)));
  assert.equal(peak, 4);
});

test('ETag cache sends If-None-Match and serves the cached body on 304', async () => {
  const cacheDir = tempHome();
  const fetch = mockFetch({
    'GET /user/repos': sequence(
      reply([{ name: 'a' }], 200, { etag: '"v1"' }),
      (call) => {
        assert.equal(call.headers['If-None-Match'], '"v1"');
        return reply(null, 304);
      },
    ),
  });
  const client = createClient({ token: 't', fetch, cacheDir });
  assert.deepEqual(await client.get('/user/repos'), [{ name: 'a' }]);
  assert.deepEqual(await client.get('/user/repos'), [{ name: 'a' }]);
  assert.equal(client.stats.cacheHits, 1);
});

test('probeWiki distinguishes pages, empty and unknown', async () => {
  const make = (wiki, main) =>
    createClient({
      token: 't',
      fetch: mockFetch({
        'GET github.com/mk/a.wiki.git/info/refs': reply('', wiki),
        'GET github.com/mk/a.git/info/refs': reply('', main),
      }),
    });
  assert.equal(await make(200, 200).probeWiki('mk/a'), 'pages');
  assert.equal(await make(404, 200).probeWiki('mk/a'), 'empty');
  assert.equal(await make(404, 404).probeWiki('mk/a'), 'unknown');
  assert.equal(await make(401, 200).probeWiki('mk/a'), 'unknown');
  assert.equal(await createClient({ fetch: mockFetch({}) }).probeWiki('mk/a'), 'unknown');
});
