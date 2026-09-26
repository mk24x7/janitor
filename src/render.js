// Human-readable (text) and Markdown renderings of command results.
// JSON output is the result object itself, see src/main.js.

import { formatDate, plural } from './util.js';

export const DRY_RUN_BANNER = 'DRY RUN: no changes will be made. Re-run with --apply to apply them.';

function pad(text, width) {
  return text + ' '.repeat(Math.max(0, width - text.length));
}

/** Renders rows as an aligned table; `style` colours cells after padding. */
export function table(headers, rows, { style = null, colorize = null } = {}) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const lines = [];
  const head = headers.map((h, i) => pad(h, widths[i])).join('  ').trimEnd();
  lines.push(style ? style.bold(head) : head);
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    const cells = row.map((cell, i) => {
      const text = pad(String(cell ?? ''), i === row.length - 1 ? 0 : widths[i]);
      return colorize ? colorize(i, text, row) : text;
    });
    lines.push(cells.join('  ').trimEnd());
  }
  return lines.join('\n');
}

function severityColor(style, severity) {
  if (severity === 'medium') return style.yellow;
  if (severity === 'low') return style.cyan;
  return style.dim;
}

function renderAudit(r, style) {
  const out = [];
  const rows = r.repos.filter((x) => x.findings.length > 0);
  out.push(style.bold(`janitor audit for ${r.owner}`));
  out.push('');
  if (rows.length > 0) {
    const tableRows = rows.map((x) => [
      x.fullName + (x.archived ? ' (archived)' : '') + (x.fork ? ' (fork)' : ''),
      x.visibility,
      x.findings.map((f) => f.rule).join(', '),
    ]);
    out.push(
      table(['REPO', 'VISIBILITY', 'FINDINGS'], tableRows, {
        style,
        colorize: (i, text, row) => {
          if (i !== 2) return text;
          const repo = rows[tableRows.indexOf(row)];
          return repo.findings.map((f) => severityColor(style, f.severity)(f.rule)).join(', ');
        },
      }),
    );
    out.push('');
  }
  const s = r.summary;
  const skipped = [];
  if (s.skipped.archived) skipped.push(`${s.skipped.archived} archived (--include-archived)`);
  if (s.skipped.forks) skipped.push(`${s.skipped.forks} forks (--include-forks)`);
  out.push(
    `${plural(s.repos, 'repository', 'repositories')} audited` +
      (skipped.length ? `, skipped ${skipped.join(' and ')}` : '') +
      '.',
  );
  out.push(
    `${s.withFindings} with findings, ${s.clean} clean. ${plural(s.findings, 'finding')}: ` +
      `${style.yellow(`${s.bySeverity.medium} medium`)}, ${style.cyan(`${s.bySeverity.low} low`)}, ${style.dim(`${s.bySeverity.info} info`)}.`,
  );
  const ruleCounts = Object.entries(s.byRule).filter(([, n]) => n > 0);
  if (ruleCounts.length) out.push(`By rule: ${ruleCounts.map(([id, n]) => `${id} ${n}`).join(', ')}.`);
  if (s.dependabotUnreadable > 0) {
    out.push(style.dim(`Dependabot alerts were not readable for ${plural(s.dependabotUnreadable, 'repository', 'repositories')}; skipped quietly.`));
  }
  if (s.findings > 0) {
    const hints = new Set(
      r.repos.flatMap((x) => x.findings.map((f) => f.fixableBy)).filter((f) => f !== 'manual'),
    );
    if (hints.size) out.push(`Next: preview fixes with ${[...hints].map((h) => h.replace(/ --apply$/, '')).join(', ')} (dry run by default).`);
  }
  return out.join('\n');
}

function show(value) {
  if (value === null || value === undefined || value === '') return '(empty)';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '(none)';
  return JSON.stringify(value);
}

function renderFix(r, style) {
  const out = [];
  for (const repo of r.repos) {
    const status = repo.status === 'planned' ? '' : ` [${repo.status}]`;
    out.push(style.bold(`${repo.repo} (${repo.visibility})${status}`));
    for (const c of repo.changes) {
      out.push(`  ${c.field}: ${show(c.before)} -> ${style.green(show(c.after))}`);
    }
    for (const s of repo.skipped) out.push(style.dim(`  skip ${s.field}: ${s.reason}`));
    if (repo.error) out.push(style.red(`  error: ${repo.error}`));
  }
  if (r.repos.length) out.push('');
  const s = r.summary;
  if (r.dryRun) {
    out.push(`${plural(s.changes, 'change')} proposed for ${plural(s.reposWithChanges, 'repository', 'repositories')} (of ${s.repos} checked).`);
    if (s.changes > 0) out.push('Run `janitor fix --apply` to apply them.');
  } else if (r.aborted) {
    out.push('Aborted; nothing was changed.');
  } else {
    out.push(`${plural(s.applied, 'change')} applied, ${s.failed} failed.`);
    if (r.changeLog) out.push(`Change log: ${r.changeLog}`);
  }
  return out.join('\n');
}

function renderLicense(r, style) {
  const out = [];
  const rows = r.repos.map((x) => [x.repo, x.visibility, x.status === 'skipped' ? `skip: ${x.reason}` : x.status === 'planned' ? `create LICENSE on ${x.branch}` : x.status + (x.error ? `: ${x.error}` : '')]);
  if (rows.length) {
    out.push(table(['REPO', 'VISIBILITY', 'ACTION'], rows, { style }));
    out.push('');
  }
  const s = r.summary;
  out.push(`License: ${r.spdx}, holder "${r.holder}", year ${r.year}, commit message "${r.commitMessage}".`);
  out.push(`${s.unlicensed} unlicensed owned repositories (${s.forksSkipped} unlicensed forks always skipped).`);
  if (r.dryRun) {
    out.push(`${s.toCreate} LICENSE file(s) would be created.`);
    if (s.toCreate > 0) out.push('Run `janitor license --apply` to create them.');
  } else if (r.aborted) out.push('Aborted; nothing was changed.');
  else {
    out.push(`${s.applied} created, ${s.failed} failed.`);
    if (r.changeLog) out.push(`Change log: ${r.changeLog}`);
  }
  return out.join('\n');
}

function renderArchive(r, style) {
  const out = [];
  const rows = r.repos.map((x) => [x.repo + (x.fork ? ' (fork)' : ''), x.visibility, formatDate(x.pushedAt), String(x.stars), x.status + (x.error ? `: ${x.error}` : '')]);
  if (rows.length) {
    out.push(table(['REPO', 'VISIBILITY', 'LAST PUSH', 'STARS', 'STATUS'], rows, { style }));
    out.push('');
  }
  const c = r.criteria;
  out.push(`Criteria: no push since ${formatDate(c.cutoff)} (${c.olderThan}), at most ${c.maxStars} stars${c.includeForks ? ', forks included' : ''}.`);
  if (r.dryRun) {
    out.push(`${plural(r.summary.candidates, 'archive candidate')}.`);
    if (r.summary.candidates > 0) out.push('Run `janitor archive --apply` to archive them (reversible, visibility unchanged).');
  } else if (r.aborted) out.push('Aborted; nothing was changed.');
  else {
    out.push(`${r.summary.applied} archived, ${r.summary.failed} failed.`);
    if (r.changeLog) out.push(`Change log: ${r.changeLog}`);
  }
  return out.join('\n');
}

function renderForks(r, style) {
  const out = [];
  const rows = r.repos.map((x) => [
    x.repo,
    x.parent ?? '(unknown)',
    x.aheadBy === null ? '?' : String(x.aheadBy),
    x.behindBy === null ? '?' : String(x.behindBy),
    formatDate(x.pushedAt),
    x.stale ? (x.status === 'planned' ? 'stale' : x.status + (x.error ? `: ${x.error}` : '')) : x.note ?? '',
  ]);
  if (rows.length) {
    out.push(table(['FORK', 'UPSTREAM', 'AHEAD', 'BEHIND', 'LAST PUSH', 'STATUS'], rows, { style }));
    out.push('');
  }
  const s = r.summary;
  out.push(`${plural(s.forks, 'fork')} checked, ${s.stale} stale (0 commits ahead and no push in a year).`);
  if (r.dryRun) {
    if (s.stale > 0) out.push('Run `janitor forks --stale --apply` to archive them (never deleted).');
  } else if (r.aborted) out.push('Aborted; nothing was changed.');
  else {
    out.push(`${s.applied} archived, ${s.failed} failed.`);
    if (r.changeLog) out.push(`Change log: ${r.changeLog}`);
  }
  return out.join('\n');
}

function renderTopics(r, style) {
  const out = [];
  out.push(`${style.bold(r.repo)}`);
  out.push(`  current:   ${show(r.current)}`);
  out.push(`  suggested: ${style.green(show(r.suggested))}`);
  return out.join('\n');
}

const TEXT = { audit: renderAudit, fix: renderFix, license: renderLicense, archive: renderArchive, forks: renderForks, topics: renderTopics };

export function renderText(result, style) {
  return TEXT[result.command](result, style);
}

// --- Markdown (GitHub Actions job summary) -----------------------------------

function mdEscape(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function mdTable(headers, rows) {
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const row of rows) lines.push(`| ${row.map(mdEscape).join(' | ')} |`);
  return lines.join('\n');
}

export function renderMarkdown(result) {
  const r = result;
  const out = [];
  if (r.command === 'audit') {
    const s = r.summary;
    out.push(`## janitor audit: ${r.owner}`);
    out.push('');
    out.push(`${s.repos} repositories audited, ${s.withFindings} with findings, ${s.clean} clean. ${s.findings} findings (${s.bySeverity.medium} medium, ${s.bySeverity.low} low, ${s.bySeverity.info} info).`);
    out.push('');
    const ruleRows = r.rules.filter((rule) => s.byRule[rule.id] > 0).map((rule) => [rule.id, rule.severity, String(s.byRule[rule.id]), rule.fixableBy]);
    if (ruleRows.length) {
      out.push(mdTable(['Rule', 'Severity', 'Count', 'Fixable by'], ruleRows));
      out.push('');
      const repoRows = r.repos.filter((x) => x.findings.length).map((x) => [x.fullName, x.visibility, x.findings.map((f) => `${f.rule}: ${f.message}`).join('<br>')]);
      out.push('<details><summary>Repositories with findings</summary>');
      out.push('');
      out.push(mdTable(['Repository', 'Visibility', 'Findings'], repoRows));
      out.push('');
      out.push('</details>');
    }
  } else if (r.command === 'topics') {
    out.push(`## janitor topics: ${r.repo}`);
    out.push('');
    out.push(`Suggested: ${r.suggested.map((t) => `\`${t}\``).join(' ') || '(none)'}`);
  } else {
    out.push(`## janitor ${r.command}${r.dryRun ? ' (dry run)' : ''}: ${r.owner}`);
    out.push('');
    if (r.command === 'fix') {
      const rows = r.repos.flatMap((x) => [
        ...x.changes.map((c) => [x.repo, c.field, show(c.before), show(c.after), x.status]),
        ...x.skipped.map((sk) => [x.repo, sk.field, '', `skipped: ${sk.reason}`, 'skipped']),
      ]);
      if (rows.length) out.push(mdTable(['Repository', 'Field', 'Before', 'After', 'Status'], rows));
    } else if (r.command === 'license') {
      out.push(mdTable(['Repository', 'Action', 'Status'], r.repos.map((x) => [x.repo, x.action === 'create' ? 'create LICENSE' : `skip: ${x.reason}`, x.status])));
    } else if (r.command === 'archive') {
      out.push(mdTable(['Repository', 'Last push', 'Stars', 'Status'], r.repos.map((x) => [x.repo, formatDate(x.pushedAt), String(x.stars), x.status])));
    } else if (r.command === 'forks') {
      out.push(mdTable(['Fork', 'Upstream', 'Ahead', 'Last push', 'Stale'], r.repos.map((x) => [x.repo, x.parent ?? '', String(x.aheadBy ?? '?'), formatDate(x.pushedAt), x.stale ? 'yes' : 'no'])));
    }
  }
  return `${out.join('\n')}\n`;
}
