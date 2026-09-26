// Minimal GitHub REST client built on the global fetch.
//
// Responsibilities:
// - authentication and standard headers
// - pagination through Link headers
// - primary rate limit tracking (X-RateLimit-Remaining / X-RateLimit-Reset)
// - secondary rate limit backoff (Retry-After on 403/429)
// - a global cap on concurrent requests
// - optional ETag caching of GET responses on disk
// - a hard allowlist of mutating requests, so that no code path can change
//   repository visibility, delete anything or write repository contents other
//   than a new LICENSE file.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError, JanitorError, SafetyError } from './errors.js';
import { VERSION } from './version.js';

export const API_URL = 'https://api.github.com';
export const WEB_URL = 'https://github.com';

// Repository fields that janitor may change through PATCH /repos/{owner}/{repo}.
// Anything else (private, visibility, default_branch, security settings, ...)
// is rejected before a request is built.
export const ALLOWED_REPO_FIELDS = Object.freeze(['description', 'homepage', 'has_wiki', 'archived']);

const REPO_PATH = /^\/repos\/[^/]+\/[^/]+$/;
const TOPICS_PATH = /^\/repos\/[^/]+\/[^/]+\/topics$/;
const LICENSE_PATH = /^\/repos\/[^/]+\/[^/]+\/contents\/LICENSE$/;

/**
 * Throws SafetyError unless the request is one of the few mutations janitor
 * performs. GET and HEAD are always allowed.
 */
export function assertAllowedMutation(method, path, body) {
  const verb = String(method).toUpperCase();
  if (verb === 'GET' || verb === 'HEAD') return;
  if (verb === 'DELETE') {
    throw new SafetyError('janitor never sends DELETE requests');
  }
  const pathname = new URL(path, API_URL).pathname;
  if (verb === 'PATCH' && REPO_PATH.test(pathname)) {
    const fields = Object.keys(body ?? {});
    if (fields.length === 0) throw new SafetyError(`refusing empty PATCH ${pathname}`);
    const forbidden = fields.filter((f) => !ALLOWED_REPO_FIELDS.includes(f));
    if (forbidden.length > 0) {
      throw new SafetyError(`refusing to change repository field(s) ${forbidden.join(', ')} on ${pathname}`);
    }
    if ('archived' in body && body.archived !== true) {
      throw new SafetyError('janitor only archives repositories; it never unarchives them');
    }
    return;
  }
  if (verb === 'PUT' && TOPICS_PATH.test(pathname)) return;
  if (verb === 'PUT' && LICENSE_PATH.test(pathname)) {
    if (body && 'sha' in body) {
      throw new SafetyError('janitor only creates LICENSE files; it never overwrites an existing file');
    }
    return;
  }
  throw new SafetyError(`refusing unexpected request ${verb} ${pathname}`);
}

export function parseLinkHeader(header) {
  const links = {};
  if (!header) return links;
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (match) links[match[2]] = match[1];
  }
  return links;
}

function parseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} options
 * @param {string} [options.token]
 * @param {typeof fetch} [options.fetch] injectable fetch (tests pass a mock)
 * @param {boolean} [options.allowWrites] mutating requests throw unless true
 * @param {number} [options.concurrency] maximum requests in flight (default 4)
 * @param {string|null} [options.cacheDir] directory for ETag cache, or null
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.now]
 * @param {(msg: string) => void} [options.onNotice] receives backoff notices
 */
export function createClient(options = {}) {
  const {
    token = null,
    fetch: fetchImpl = globalThis.fetch,
    baseUrl = API_URL,
    webUrl = WEB_URL,
    allowWrites = false,
    concurrency = 4,
    cacheDir = null,
    sleep = defaultSleep,
    now = Date.now,
    maxRetries = 3,
    maxWaitMs = 15 * 60 * 1000,
    onNotice = () => {},
  } = options;

  if (typeof fetchImpl !== 'function') {
    throw new JanitorError('global fetch is not available; janitor needs Node.js 20 or later');
  }

  // Concurrency gate. release() hands the slot directly to the next waiter.
  let active = 0;
  const waiters = [];
  async function acquire() {
    if (active < concurrency) {
      active += 1;
      return;
    }
    await new Promise((resolve) => waiters.push(resolve));
  }
  function release() {
    const next = waiters.shift();
    if (next) next();
    else active -= 1;
  }

  const rate = { remaining: null, reset: null, limit: null };
  const stats = { requests: 0, cacheHits: 0 };

  function noteRateLimit(headers) {
    const remaining = headers.get('x-ratelimit-remaining');
    const reset = headers.get('x-ratelimit-reset');
    const limit = headers.get('x-ratelimit-limit');
    if (remaining !== null && remaining !== '') rate.remaining = Number(remaining);
    if (reset !== null && reset !== '') rate.reset = Number(reset);
    if (limit !== null && limit !== '') rate.limit = Number(limit);
  }

  async function waitForBudget() {
    if (rate.remaining !== 0 || rate.reset === null) return;
    const waitMs = rate.reset * 1000 - now() + 1000;
    if (waitMs <= 0) {
      rate.remaining = null;
      return;
    }
    if (waitMs > maxWaitMs) {
      throw new JanitorError(
        `GitHub API rate limit exhausted; it resets at ${new Date(rate.reset * 1000).toISOString()}`,
      );
    }
    onNotice(`rate limit exhausted, waiting ${Math.ceil(waitMs / 1000)}s for reset`);
    await sleep(waitMs);
    rate.remaining = null;
  }

  // Decide whether a 403/429 is a rate limit and how long to wait. Returns
  // null when the response is a real permission error or the wait is too long.
  function retryDelay(res, data, attempt) {
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter !== null && retryAfter !== '' && !Number.isNaN(Number(retryAfter))) {
      return Math.max(0, Number(retryAfter) * 1000);
    }
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const waitMs = reset * 1000 - now() + 1000;
      if (Number.isFinite(waitMs) && waitMs <= maxWaitMs) return Math.max(0, waitMs);
      return null;
    }
    const message = typeof data === 'object' && data ? String(data.message ?? '') : String(data ?? '');
    if (/secondary rate limit|abuse detection/i.test(message)) {
      return 60_000 * 2 ** attempt;
    }
    return null;
  }

  const tokenFingerprint = createHash('sha256').update(String(token ?? 'anonymous')).digest('hex').slice(0, 16);

  function cachePath(url) {
    return join(cacheDir, `${createHash('sha256').update(`${tokenFingerprint} ${url}`).digest('hex')}.json`);
  }
  function readCache(url) {
    try {
      return JSON.parse(readFileSync(cachePath(url), 'utf8'));
    } catch {
      return null;
    }
  }
  function writeCache(url, entry) {
    try {
      mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      writeFileSync(cachePath(url), JSON.stringify(entry), { mode: 0o600 });
    } catch {
      // The cache is an optimisation; failing to write it is not an error.
    }
  }

  /**
   * Sends one request. Resolves to { status, data, headers, link } for 2xx,
   * throws HttpError otherwise.
   */
  async function request(method, path, { body, accept, headers: extraHeaders } = {}) {
    const verb = String(method).toUpperCase();
    if (verb !== 'GET' && verb !== 'HEAD') {
      if (!allowWrites) {
        throw new SafetyError(`refusing ${verb} ${path}: mutating requests need --apply`);
      }
      assertAllowedMutation(verb, path, body);
    }
    const url = /^https?:\/\//.test(path) ? path : `${baseUrl}${path}`;
    const headers = {
      Accept: accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': `janitor/${VERSION}`,
      ...extraHeaders,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const cached = cacheDir && verb === 'GET' ? readCache(url) : null;
    if (cached?.etag) headers['If-None-Match'] = cached.etag;

    for (let attempt = 0; ; attempt += 1) {
      await waitForBudget();
      await acquire();
      let res;
      try {
        stats.requests += 1;
        res = await fetchImpl(url, {
          method: verb,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } finally {
        release();
      }
      noteRateLimit(res.headers);

      if (res.status === 304 && cached) {
        stats.cacheHits += 1;
        return { status: 200, data: cached.data, headers: res.headers, link: cached.link ?? null };
      }

      const text = await res.text();
      const data = parseBody(text);

      if ((res.status === 403 || res.status === 429) && attempt < maxRetries) {
        const waitMs = retryDelay(res, data, attempt);
        if (waitMs !== null) {
          onNotice(`rate limited on ${verb} ${new URL(url).pathname}, retrying in ${Math.ceil(waitMs / 1000)}s`);
          await sleep(waitMs);
          continue;
        }
      }

      if (!res.ok) {
        const detail = data && typeof data === 'object' && data.message ? data.message : res.statusText || 'request failed';
        throw new HttpError(res.status, `${verb} ${new URL(url).pathname} failed with ${res.status}: ${detail}`, {
          method: verb,
          url,
          data,
        });
      }

      const link = res.headers.get('link');
      if (cacheDir && verb === 'GET') {
        const etag = res.headers.get('etag');
        if (etag) writeCache(url, { etag, data, link });
      }
      return { status: res.status, data, headers: res.headers, link };
    }
  }

  async function get(path, opts) {
    return (await request('GET', path, opts)).data;
  }

  // GET that maps 404 (and optionally other statuses) to null.
  async function getOptional(path, { quietStatuses = [404], ...opts } = {}) {
    try {
      return await get(path, opts);
    } catch (err) {
      if (err instanceof HttpError && quietStatuses.includes(err.status)) return null;
      throw err;
    }
  }

  // Follows rel="next" links and concatenates array pages.
  async function paginate(path, opts) {
    const items = [];
    let next = path;
    let pages = 0;
    while (next) {
      const res = await request('GET', next, opts);
      if (!Array.isArray(res.data)) {
        throw new JanitorError(`expected a JSON array from ${next}`);
      }
      items.push(...res.data);
      next = parseLinkHeader(res.link).next ?? null;
      pages += 1;
      if (pages > 1000) throw new JanitorError(`pagination did not terminate for ${path}`);
    }
    return items;
  }

  /**
   * Returns 'pages', 'empty' or 'unknown' for a repository wiki, using the
   * git smart-HTTP endpoint of the wiki repository. An empty wiki has no git
   * repository behind it. A 404 is only trusted when the same credentials can
   * read the main repository, otherwise the answer is 'unknown'.
   */
  async function probeWiki(fullName) {
    if (webUrl !== WEB_URL || baseUrl !== API_URL || !token) return 'unknown';
    const auth = `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    const probe = async (repoPath) => {
      await acquire();
      try {
        stats.requests += 1;
        const res = await fetchImpl(`${webUrl}/${repoPath}/info/refs?service=git-upload-pack`, {
          method: 'GET',
          headers: { Authorization: auth, 'User-Agent': `janitor/${VERSION}` },
          redirect: 'manual',
        });
        await res.arrayBuffer().catch(() => {});
        return res.status;
      } finally {
        release();
      }
    };
    try {
      const wiki = await probe(`${fullName}.wiki.git`);
      if (wiki === 200) return 'pages';
      if (wiki !== 404) return 'unknown';
      const main = await probe(`${fullName}.git`);
      return main === 200 ? 'empty' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  return { request, get, getOptional, paginate, probeWiki, rate, stats, allowWrites };
}
