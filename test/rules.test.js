import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultContext, evaluate, RULES } from '../src/rules.js';
import { makeRepo, NOW } from './helpers.js';

const ctx = defaultContext({ now: NOW });
const cleanFacts = { readme: { size: 5000, text: '' }, stalePulls: [], dependabot: 0, fork: null };

function ruleIds(repo, facts = cleanFacts, context = ctx) {
  return evaluate(repo, { ...cleanFacts, ...facts }, context).map((f) => f.rule);
}

function has(id, repo, facts) {
  return ruleIds(repo, facts).includes(id);
}

test('every rule has id, severity, description and fixable-by', () => {
  assert.equal(RULES.length, 11);
  for (const rule of RULES) {
    assert.match(rule.id, /^[a-z-]+$/);
    assert.ok(['medium', 'low', 'info'].includes(rule.severity), rule.id);
    assert.ok(rule.description.length > 10, rule.id);
    assert.ok(rule.fixableBy === 'manual' || rule.fixableBy.startsWith('janitor '), rule.id);
  }
});

test('a healthy repository has no findings', () => {
  assert.deepEqual(ruleIds(makeRepo()), []);
});

test('missing-description: positive and negative', () => {
  assert.ok(has('missing-description', makeRepo({ description: null })));
  assert.ok(has('missing-description', makeRepo({ description: '   ' })));
  assert.ok(!has('missing-description', makeRepo({ description: 'Has one' })));
});

test('missing-license: positive, negative, and forks excluded', () => {
  assert.ok(has('missing-license', makeRepo({ license: null })));
  assert.ok(!has('missing-license', makeRepo({ license: { key: 'other' } })));
  assert.ok(!has('missing-license', makeRepo({ license: null, fork: true })));
});

test('no-topics: positive and negative', () => {
  assert.ok(has('no-topics', makeRepo({ topics: [] })));
  assert.ok(has('no-topics', makeRepo({ topics: undefined })));
  assert.ok(!has('no-topics', makeRepo({ topics: ['cli'] })));
});

test('empty-readme: absent or under 200 bytes, negative at 200 bytes', () => {
  assert.ok(has('empty-readme', makeRepo(), { readme: null }));
  assert.ok(has('empty-readme', makeRepo(), { readme: { size: 199 } }));
  assert.ok(!has('empty-readme', makeRepo(), { readme: { size: 200 } }));
});

test('stale-fork: 0 ahead and no push in a year', () => {
  const fork = makeRepo({ fork: true, pushed_at: '2025-06-01T00:00:00Z' });
  assert.ok(has('stale-fork', fork, { fork: { parent: 'up/x', aheadBy: 0 } }));
});

test('stale-fork negatives: commits ahead, recent push, unknown comparison', () => {
  const old = makeRepo({ fork: true, pushed_at: '2025-06-01T00:00:00Z' });
  assert.ok(!has('stale-fork', old, { fork: { parent: 'up/x', aheadBy: 2 } }));
  assert.ok(!has('stale-fork', old, { fork: { parent: null, aheadBy: null } }));
  const recent = makeRepo({ fork: true, pushed_at: '2026-01-01T00:00:00Z' });
  assert.ok(!has('stale-fork', recent, { fork: { parent: 'up/x', aheadBy: 0 } }));
});

test('archive-candidate: no push in 3 years and no stars', () => {
  assert.ok(has('archive-candidate', makeRepo({ pushed_at: '2023-09-25T00:00:00Z', stargazers_count: 0 })));
});

test('archive-candidate negatives: starred, recent, already archived, fork', () => {
  assert.ok(!has('archive-candidate', makeRepo({ pushed_at: '2020-01-01T00:00:00Z', stargazers_count: 1 })));
  assert.ok(!has('archive-candidate', makeRepo({ pushed_at: '2023-09-27T00:00:00Z', stargazers_count: 0 })));
  assert.ok(!has('archive-candidate', makeRepo({ pushed_at: '2020-01-01T00:00:00Z', stargazers_count: 0, archived: true })));
  assert.ok(!has('archive-candidate', makeRepo({ pushed_at: '2020-01-01T00:00:00Z', stargazers_count: 0, fork: true })));
});

test('default-branch-master: positive and negative', () => {
  assert.ok(has('default-branch-master', makeRepo({ default_branch: 'master' })));
  assert.ok(!has('default-branch-master', makeRepo({ default_branch: 'main' })));
});

test('no-homepage-with-pages: positive and negative', () => {
  assert.ok(has('no-homepage-with-pages', makeRepo({ has_pages: true, homepage: '' })));
  assert.ok(!has('no-homepage-with-pages', makeRepo({ has_pages: true, homepage: 'https://x.dev' })));
  assert.ok(!has('no-homepage-with-pages', makeRepo({ has_pages: false, homepage: null })));
});

test('dependabot-alerts-open: positive, zero, and unreadable (null)', () => {
  assert.ok(has('dependabot-alerts-open', makeRepo(), { dependabot: 2 }));
  assert.ok(!has('dependabot-alerts-open', makeRepo(), { dependabot: 0 }));
  assert.ok(!has('dependabot-alerts-open', makeRepo(), { dependabot: null }));
});

test('large-repo: over 500 MB only', () => {
  assert.ok(has('large-repo', makeRepo({ size: 500 * 1024 + 1 })));
  assert.ok(!has('large-repo', makeRepo({ size: 500 * 1024 })));
});

test('stale-open-prs: positive and negative', () => {
  const stale = [{ number: 7, title: 'x', created_at: '2024-01-01T00:00:00Z' }];
  const findings = evaluate(makeRepo(), { ...cleanFacts, stalePulls: stale }, ctx);
  assert.match(findings.find((f) => f.rule === 'stale-open-prs').message, /#7 from 2024-01-01/);
  assert.ok(!has('stale-open-prs', makeRepo(), { stalePulls: [] }));
});

test('findings are sorted by severity and carry fixable-by', () => {
  const findings = evaluate(makeRepo({ default_branch: 'master', topics: [], description: null }), cleanFacts, ctx);
  assert.deepEqual(findings.map((f) => f.severity), ['medium', 'low', 'info']);
  assert.equal(findings[0].fixableBy, 'janitor fix');
});
