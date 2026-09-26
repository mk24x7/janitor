// janitor audit: evaluate every rule for every repository of the owner.

import { collectAuditFacts, filterRepos, listOwnerRepos, visibilityOf } from '../inspect.js';
import { defaultContext, describeRules, evaluate, RULE_IDS, SEVERITIES, severityRank } from '../rules.js';
import { mapLimit } from '../util.js';

export async function audit(ctx) {
  const { client, options } = ctx;
  const all = await listOwnerRepos(client, { owner: ctx.owner, viewerLogin: ctx.viewer?.login });
  const repos = filterRepos(all, { includeForks: options.includeForks, includeArchived: options.includeArchived });
  const ruleCtx = defaultContext({ now: ctx.now, includeForks: false });
  const minRank = severityRank(options.minSeverity ?? 'info');

  const rows = await mapLimit(repos, 4, async (repo) => {
    const facts = await collectAuditFacts(client, repo, { now: ctx.now });
    const findings = evaluate(repo, facts, ruleCtx).filter((f) => severityRank(f.severity) <= minRank);
    return {
      name: repo.name,
      fullName: repo.full_name,
      visibility: visibilityOf(repo),
      fork: Boolean(repo.fork),
      archived: Boolean(repo.archived),
      url: repo.html_url,
      pushedAt: repo.pushed_at ?? null,
      stars: repo.stargazers_count ?? 0,
      dependabotReadable: repo.archived ? null : facts.dependabot !== null,
      findings,
    };
  });

  rows.sort((a, b) => {
    const ra = a.findings.length ? severityRank(a.findings[0].severity) : SEVERITIES.length;
    const rb = b.findings.length ? severityRank(b.findings[0].severity) : SEVERITIES.length;
    return ra - rb || b.findings.length - a.findings.length || a.fullName.localeCompare(b.fullName);
  });

  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  const byRule = Object.fromEntries(RULE_IDS.map((id) => [id, 0]));
  let findings = 0;
  for (const row of rows) {
    for (const f of row.findings) {
      bySeverity[f.severity] += 1;
      byRule[f.rule] += 1;
      findings += 1;
    }
  }
  const withFindings = rows.filter((r) => r.findings.length > 0).length;
  const summary = {
    repos: rows.length,
    withFindings,
    clean: rows.length - withFindings,
    findings,
    bySeverity,
    byRule,
    skipped: {
      forks: options.includeForks ? 0 : all.filter((r) => r.fork && (options.includeArchived || !r.archived)).length,
      archived: options.includeArchived ? 0 : all.filter((r) => r.archived).length,
    },
    dependabotUnreadable: rows.filter((r) => r.dependabotReadable === false).length,
  };

  return {
    command: 'audit',
    owner: ctx.owner ?? ctx.viewer?.login ?? null,
    generatedAt: new Date(ctx.now).toISOString(),
    options: {
      includeForks: Boolean(options.includeForks),
      includeArchived: Boolean(options.includeArchived),
      minSeverity: options.minSeverity ?? 'info',
    },
    summary,
    repos: rows,
    rules: describeRules(),
    exitCode: findings > 0 ? 3 : 0,
  };
}
