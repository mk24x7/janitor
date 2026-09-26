import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit, parseDuration, splitArgs, subtractDuration } from '../src/util.js';
import { selectArchiveCandidates } from '../src/commands/archive.js';
import { isStaleFork } from '../src/commands/forks.js';
import { UsageError } from '../src/errors.js';
import { makeRepo, NOW } from './helpers.js';

test('parseDuration accepts y, mo/m, w and d', () => {
  assert.deepEqual(parseDuration('3y'), { amount: 3, unit: 'y', text: '3y' });
  assert.equal(parseDuration('18m').unit, 'mo');
  assert.equal(parseDuration('18mo').text, '18mo');
  assert.equal(parseDuration('6w').unit, 'w');
  assert.equal(parseDuration('90d').amount, 90);
});

test('parseDuration rejects garbage and zero', () => {
  for (const bad of ['', '3', 'y', '0y', '3 years', '-1y']) assert.throws(() => parseDuration(bad), UsageError, bad);
});

test('subtractDuration uses calendar years and months in UTC', () => {
  assert.equal(subtractDuration(Date.parse('2026-09-26T12:00:00Z'), '3y').toISOString(), '2023-09-26T12:00:00.000Z');
  assert.equal(subtractDuration(Date.parse('2024-02-29T00:00:00Z'), '1y').toISOString(), '2023-02-28T00:00:00.000Z');
  assert.equal(subtractDuration(Date.parse('2026-03-31T00:00:00Z'), '1mo').toISOString(), '2026-02-28T00:00:00.000Z');
  assert.equal(subtractDuration(Date.parse('2026-01-15T00:00:00Z'), '2mo').toISOString(), '2025-11-15T00:00:00.000Z');
  assert.equal(subtractDuration(Date.parse('2026-01-15T00:00:00Z'), '2w').toISOString(), '2026-01-01T00:00:00.000Z');
});

test('archive candidates: cutoff boundary, stars threshold, forks and archived', () => {
  const repos = [
    makeRepo({ name: 'just-old', pushed_at: '2023-09-26T11:59:59Z', stargazers_count: 0 }),
    makeRepo({ name: 'boundary', pushed_at: '2023-09-26T12:00:00Z', stargazers_count: 0 }),
    makeRepo({ name: 'starred', pushed_at: '2020-01-01T00:00:00Z', stargazers_count: 2 }),
    makeRepo({ name: 'fork', pushed_at: '2020-01-01T00:00:00Z', stargazers_count: 0, fork: true }),
    makeRepo({ name: 'archived', pushed_at: '2020-01-01T00:00:00Z', stargazers_count: 0, archived: true }),
    makeRepo({ name: 'never-pushed', pushed_at: null, stargazers_count: 0 }),
  ];
  const names = (opts) => selectArchiveCandidates(repos, { now: NOW, ...opts }).map((r) => r.name).sort();
  assert.deepEqual(names({}), ['just-old', 'never-pushed']);
  assert.deepEqual(names({ maxStars: 2 }), ['just-old', 'never-pushed', 'starred']);
  assert.deepEqual(names({ includeForks: true }), ['fork', 'just-old', 'never-pushed']);
  assert.deepEqual(names({ olderThan: '10y' }), ['never-pushed']);
  assert.deepEqual(names({ olderThan: '1y' }), ['just-old', 'boundary', 'never-pushed'].sort());
});

test('fork staleness requires 0 ahead and no push for a year', () => {
  const old = makeRepo({ fork: true, pushed_at: '2025-09-25T00:00:00Z' });
  const recent = makeRepo({ fork: true, pushed_at: '2025-09-27T00:00:00Z' });
  assert.equal(isStaleFork(old, { aheadBy: 0 }, NOW), true);
  assert.equal(isStaleFork(old, { aheadBy: 1 }, NOW), false);
  assert.equal(isStaleFork(old, { aheadBy: null }, NOW), false);
  assert.equal(isStaleFork(recent, { aheadBy: 0 }, NOW), false);
});

test('mapLimit preserves order and limits concurrency', async () => {
  let active = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 2));
    active -= 1;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.equal(peak, 3);
});

test('splitArgs handles quotes and escapes', () => {
  assert.deepEqual(splitArgs('--include-forks --holder "Jane Doe" --only \'a,b\''), ['--include-forks', '--holder', 'Jane Doe', '--only', 'a,b']);
  assert.deepEqual(splitArgs('  '), []);
  assert.deepEqual(splitArgs('--holder ""'), ['--holder', '']);
  assert.throws(() => splitArgs('"open'), UsageError);
});
