// Audit rules. Each rule is pure: it receives the repository object from the
// REST API, the facts collected by src/inspect.js and an evaluation context,
// and returns a message string when the repository violates the rule.

import { formatDate, isBefore, subtractDuration } from './util.js';

export const SEVERITIES = ['medium', 'low', 'info'];

export function severityRank(severity) {
  const i = SEVERITIES.indexOf(severity);
  return i === -1 ? SEVERITIES.length : i;
}

export const LARGE_REPO_KB = 500 * 1024;
export const EMPTY_README_BYTES = 200;

export const RULES = [
  {
    id: 'missing-description',
    severity: 'medium',
    description: 'The repository has no description.',
    fixableBy: 'janitor fix',
    check: (repo) => (!repo.description || !repo.description.trim() ? 'no description' : null),
  },
  {
    id: 'missing-license',
    severity: 'medium',
    description: 'No license was detected (forks are excluded).',
    fixableBy: 'janitor license',
    check: (repo) => (!repo.fork && !repo.license ? 'no license detected' : null),
  },
  {
    id: 'no-topics',
    severity: 'low',
    description: 'The repository has no topics.',
    fixableBy: 'janitor fix',
    check: (repo) => (!Array.isArray(repo.topics) || repo.topics.length === 0 ? 'no topics' : null),
  },
  {
    id: 'empty-readme',
    severity: 'medium',
    description: `The README is missing or smaller than ${EMPTY_README_BYTES} bytes.`,
    fixableBy: 'manual',
    check: (repo, facts) => {
      if (!facts.readme) return 'no README';
      if (facts.readme.size < EMPTY_README_BYTES) return `README is only ${facts.readme.size} bytes`;
      return null;
    },
  },
  {
    id: 'stale-fork',
    severity: 'low',
    description: 'A fork with no commits ahead of its upstream and no push in a year.',
    fixableBy: 'janitor forks --stale --apply',
    check: (repo, facts, ctx) => {
      if (!repo.fork || repo.archived || !facts.fork || facts.fork.aheadBy !== 0) return null;
      if (!isBefore(repo.pushed_at, subtractDuration(ctx.now, ctx.staleForkAge))) return null;
      return `0 commits ahead of ${facts.fork.parent}, last push ${formatDate(repo.pushed_at)}`;
    },
  },
  {
    id: 'archive-candidate',
    severity: 'low',
    description: 'No push within the archive period (default 3y) and stars at or below the threshold (default 0).',
    fixableBy: 'janitor archive --apply',
    check: (repo, facts, ctx) => {
      if (repo.archived || (repo.fork && !ctx.includeForks)) return null;
      if ((repo.stargazers_count ?? 0) > ctx.maxStars) return null;
      if (!isBefore(repo.pushed_at, subtractDuration(ctx.now, ctx.archiveOlderThan))) return null;
      return `last push ${formatDate(repo.pushed_at)}, ${repo.stargazers_count ?? 0} stars`;
    },
  },
  {
    id: 'default-branch-master',
    severity: 'info',
    description: 'The default branch is still named master.',
    fixableBy: 'manual',
    check: (repo) => (repo.default_branch === 'master' ? 'default branch is master' : null),
  },
  {
    id: 'no-homepage-with-pages',
    severity: 'info',
    description: 'GitHub Pages is enabled but no homepage URL is set.',
    fixableBy: 'janitor fix',
    check: (repo) => (repo.has_pages && !repo.homepage ? 'Pages enabled but homepage empty' : null),
  },
  {
    id: 'dependabot-alerts-open',
    severity: 'medium',
    description: 'Open Dependabot alerts (checked only when the token can read them).',
    fixableBy: 'manual',
    check: (repo, facts) => (facts.dependabot > 0 ? `${facts.dependabot} open Dependabot alert(s)` : null),
  },
  {
    id: 'large-repo',
    severity: 'info',
    description: 'Repository size is over 500 MB.',
    fixableBy: 'manual',
    check: (repo) => (repo.size > LARGE_REPO_KB ? `size ${Math.round(repo.size / 1024)} MB` : null),
  },
  {
    id: 'stale-open-prs',
    severity: 'low',
    description: 'A pull request has been open for more than a year.',
    fixableBy: 'manual',
    check: (repo, facts) => {
      const stale = facts.stalePulls ?? [];
      if (stale.length === 0) return null;
      return `${stale.length} PR(s) open over a year, oldest #${stale[0].number} from ${formatDate(stale[0].created_at)}`;
    },
  },
];

export const RULE_IDS = RULES.map((r) => r.id);

export function defaultContext(overrides = {}) {
  return {
    now: Date.now(),
    archiveOlderThan: '3y',
    maxStars: 0,
    staleForkAge: '1y',
    includeForks: false,
    ...overrides,
  };
}

/** Evaluates every rule and returns findings sorted by severity. */
export function evaluate(repo, facts = {}, ctx = defaultContext(), rules = RULES) {
  const findings = [];
  for (const rule of rules) {
    const message = rule.check(repo, facts, ctx);
    if (message) {
      findings.push({ rule: rule.id, severity: rule.severity, message, fixableBy: rule.fixableBy });
    }
  }
  return findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

export function describeRules() {
  return RULES.map(({ id, severity, description, fixableBy }) => ({ id, severity, description, fixableBy }));
}
