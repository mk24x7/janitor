// Test helpers: a routing mock for fetch that records every call, fixture
// loading and a repository factory.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const NOW = Date.parse('2026-09-26T12:00:00Z');

const FIXTURES = new URL('./fixtures/', import.meta.url);

export function fixture(name) {
  const text = readFileSync(new URL(name, FIXTURES), 'utf8');
  return name.endsWith('.json') ? JSON.parse(text) : text;
}

export function reply(body, status = 200, headers = {}) {
  return { __reply: true, body, status, headers };
}

export function sequence(...items) {
  return { __sequence: true, items };
}

export const notFound = () => reply({ message: 'Not Found' }, 404);

export function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

export function readmeReply(text) {
  return reply({ path: 'README.md', size: Buffer.byteLength(text), encoding: 'base64', content: b64(text) });
}

/**
 * Creates a fetch mock. `routes` maps "METHOD /path?query" (or "METHOD /path"
 * to match any query) to a reply, plain JSON data, a function returning a
 * reply, or sequence(...) of replies consumed in order (the last repeats). Unmatched GETs return 404; unmatched writes
 * throw so tests notice unexpected mutations.
 */
export function mockFetch(routes = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const path = `${u.pathname}${u.search}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    const call = { method, url: String(url), host: u.host, path, pathname: u.pathname, body, headers: init.headers ?? {} };
    calls.push(call);
    let handler = routes[`${method} ${path}`] ?? routes[`${method} ${u.pathname}`] ?? routes[`${method} ${u.host}${u.pathname}`];
    if (handler && handler.__sequence) handler = handler.items.length > 1 ? handler.items.shift() : handler.items[0];
    if (typeof handler === 'function') handler = await handler(call);
    if (handler === undefined) {
      if (method === 'GET') handler = notFound();
      else throw new Error(`unexpected request ${method} ${path}`);
    }
    const spec = handler && handler.__reply ? handler : reply(handler);
    const text = spec.body === null || spec.body === undefined ? null : typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
    return new Response(spec.status === 304 ? null : text, { status: spec.status, headers: spec.headers });
  };
  fetch.calls = calls;
  fetch.writes = () => calls.filter((c) => c.method !== 'GET' && c.method !== 'HEAD');
  return fetch;
}

let counter = 0;
export function makeRepo(overrides = {}) {
  counter += 1;
  const name = overrides.name ?? `repo-${counter}`;
  const owner = overrides.owner?.login ?? 'mk';
  return {
    name,
    full_name: `${owner}/${name}`,
    owner: { login: owner },
    private: false,
    visibility: 'public',
    html_url: `https://github.com/${owner}/${name}`,
    description: 'A repository',
    fork: false,
    archived: false,
    homepage: null,
    language: 'JavaScript',
    topics: ['tools'],
    license: { key: 'mit', spdx_id: 'MIT' },
    has_pages: false,
    has_wiki: false,
    default_branch: 'main',
    size: 100,
    stargazers_count: 3,
    pushed_at: '2026-09-01T00:00:00Z',
    created_at: '2020-01-01T00:00:00Z',
    ...overrides,
  };
}

export function tempHome() {
  return mkdtempSync(join(tmpdir(), 'janitor-test-'));
}

export function capture() {
  let text = '';
  return {
    isTTY: false,
    write(chunk) {
      text += chunk;
      return true;
    },
    get text() {
      return text;
    },
  };
}
