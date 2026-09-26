# janitor

Tidy every GitHub repo you own: descriptions, licenses, topics, stale forks, archive candidates. Dry run first, always.

[![Marketplace](https://img.shields.io/badge/Marketplace-Repo%20Hygiene%20Janitor-blue?style=flat-square&logo=github)](https://github.com/marketplace/actions/repo-hygiene-janitor)
[![CI](https://github.com/mk24x7/janitor/actions/workflows/ci.yml/badge.svg)](https://github.com/mk24x7/janitor/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@mk24x7/janitor.svg)](https://www.npmjs.com/package/@mk24x7/janitor)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

```
$ npx @mk24x7/janitor audit
REPO                    VISIBILITY  FINDINGS
----------------------  ----------  ---------------------------------------------------
mk24x7/old-experiment   private     missing-description, missing-license, empty-readme, no-topics, archive-candidate
mk24x7/landing-page     public      missing-license, no-topics, default-branch-master
...
70 repositories audited, skipped 22 archived (--include-archived) and 2 forks (--include-forks).
```

## Why

After a few years on GitHub most accounts collect the same debris: repositories with no description,
no license and no topics, forks that were never touched, and experiments nobody has pushed to since
2021. The author of this tool spent a week doing it by hand: 22 repositories archived and metadata
fixed one settings page at a time. janitor automates that work, and it is built to be boring and safe:
every command that changes something is a dry run unless you pass `--apply`.

## Install

Requires Node.js 20.12 or later. No runtime dependencies.

```sh
npx @mk24x7/janitor audit          # run once without installing
npm i -g @mk24x7/janitor           # or install the `janitor` command globally
```

janitor finds a token in this order: `--token`, `GITHUB_TOKEN`, `GH_TOKEN`, then `gh auth token`
(only if the GitHub CLI is installed). If you already use `gh`, it just works.

## Commands

| Command | What it does | Changes anything? |
| --- | --- | --- |
| `janitor audit` | Evaluates every rule for every repository you own | Never |
| `janitor fix` | Fills in missing descriptions, topics and homepages; disables empty wikis | Only with `--apply` |
| `janitor license` | Adds a `LICENSE` file where none is detected (never to forks) | Only with `--apply` |
| `janitor archive` | Archives repositories with no push in a period and few stars | Only with `--apply` |
| `janitor forks` | Finds forks with nothing ahead of upstream; archives stale ones | Only with `--apply` |
| `janitor topics --suggest <repo>` | Prints the topics janitor would set for one repository | Never |

Every command accepts `--json`, `--no-color`, `--token`, `--owner` and `--no-cache`.

### audit

```sh
janitor audit                         # your repositories, public and private
janitor audit --include-forks         # also audit forks (enables the stale-fork rule)
janitor audit --include-archived      # also audit archived repositories
janitor audit --min-severity medium   # hide low and info findings
janitor audit --owner octocat         # another account (public repositories only)
janitor audit --json > audit.json
```

The table is sorted by severity. The footer summarises repositories, findings per severity and per
rule, and which commands can fix what. Exit code is 0 when clean and 3 when there are findings.

### fix

```sh
janitor fix                                   # dry run: prints exactly what would change
janitor fix --only description,topics         # limit to some fixes
janitor fix --apply                           # apply after one confirmation
janitor fix --apply --yes                     # apply without a prompt (CI)
```

```
DRY RUN: no changes will be made. Re-run with --apply to apply them.
mk24x7/site (public)
  description: (empty) -> "Fast, in-memory work queue for Node.js with async workers and back pressure."
  homepage: (empty) -> "https://fastq.dev"
  topics: (none) -> typescript, nextjs, react, fastq
  has_wiki: true -> false
mk24x7/tool (private)
  skip description: no README to derive a description from
```

| Fix | When | How the value is derived |
| --- | --- | --- |
| `description` | description is empty | First real paragraph of the README (frontmatter, headings, badge rows, images, navigation links, code, tables, lists and HTML-only blocks are skipped), trimmed to 200 characters at a sentence or word boundary. No README: skipped and reported. |
| `topics` | repository has no topics | Up to 8 of: primary language; `next`, `react`, `vue`, `express` (and a few other frameworks) from `package.json`; `swift` and `swiftpm` from `Package.swift`; `rust` from `Cargo.toml`; `python` from `pyproject.toml` or `requirements.txt`; `go` from `go.mod`; `ruby` from `Gemfile`; `php` from `composer.json`; the homepage domain name. Lower-case, hyphenated, valid topic characters only. |
| `homepage` | homepage is empty | The GitHub Pages URL when Pages is enabled, otherwise the single site the README links to. Several candidate sites: skipped as ambiguous. Code hosts, badges, registries, CI and social links are ignored. |
| `wiki` | `has_wiki` is on | Turned off only when the wiki provably has no pages (its git repository does not exist while the main repository is readable with the same token). Unsure: skipped. |

Archived repositories are read-only and are never touched. Forks are skipped unless `--include-forks`.

### license

```sh
janitor license                                  # dry run: which repositories lack a license
janitor license --apply                          # commit LICENSE with "Add MIT license"
janitor license --apply --spdx Apache-2.0 --holder "Jane Doe"
```

Creates `LICENSE` through the contents API on each repository's default branch. The holder is
`--holder`, else the name on your GitHub profile, else your login; the year is the current year.
MIT and ISC are bundled; any other SPDX id is fetched from the GitHub licenses API. Forks are always
skipped, and so are empty repositories and repositories that already have an unrecognised license
file. An existing file is never overwritten.

### archive

```sh
janitor archive                                  # candidates: no push in 3 years and 0 stars
janitor archive --older-than 2y --max-stars 1
janitor archive --apply                          # one confirmation listing every name
janitor archive --apply --yes
```

Durations accept `y`, `mo` (or `m`), `w` and `d`, computed with calendar arithmetic in UTC. Forks are
excluded unless `--include-forks`. Archiving is reversible (Settings, "Unarchive this repository")
and never changes visibility.

### forks

```sh
janitor forks                  # every fork with commits ahead of and behind upstream
janitor forks --stale          # only stale forks: 0 commits ahead and no push in a year
janitor forks --stale --apply  # archive the stale forks (they are never deleted)
```

### topics

```sh
janitor topics --suggest janitor
janitor topics --suggest octocat/hello-world --json
```

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success; audit found nothing, or changes were applied |
| 1 | Error (API failure, a change that failed, declined confirmation) |
| 2 | Usage error or refusal (bad option, owner mismatch, missing `--yes` without a terminal) |
| 3 | Findings (audit) or pending changes (dry run of the other commands) |

## Rules

| Rule | Severity | Description | Fixable by |
| --- | --- | --- | --- |
| `missing-description` | medium | The repository has no description | `janitor fix` |
| `missing-license` | medium | No license detected (forks excluded) | `janitor license` |
| `no-topics` | low | The repository has no topics | `janitor fix` |
| `empty-readme` | medium | README missing or smaller than 200 bytes | manual |
| `stale-fork` | low | Fork with 0 commits ahead of upstream and no push in a year (audited with `--include-forks`) | `janitor forks --stale --apply` |
| `archive-candidate` | low | No push in 3 years and 0 stars | `janitor archive --apply` |
| `default-branch-master` | info | Default branch is still `master` | manual |
| `no-homepage-with-pages` | info | GitHub Pages is enabled but no homepage is set | `janitor fix` |
| `dependabot-alerts-open` | medium | Open Dependabot alerts (skipped quietly when the token cannot read them) | manual |
| `large-repo` | info | Repository is larger than 500 MB | manual |
| `stale-open-prs` | low | A pull request has been open for more than a year | manual |

Have an idea for another rule? Open a [rule request](https://github.com/mk24x7/janitor/issues/new?template=rule_request.yml).

## Safety guarantees

- **Never visibility.** There is no command or option that changes whether a repository is public or
  private. The HTTP client rejects any `PATCH` that contains a field other than `description`,
  `homepage`, `has_wiki` or `archived: true`, before a request is built.
- **Never delete.** janitor never sends a `DELETE` request; the client refuses them. Stale forks and
  old repositories are archived, which you can undo.
- **Dry run by default.** Mutating commands print a one-line `DRY RUN` banner and only read unless you
  pass `--apply`. Without `--apply` the client is created read-only, so a bug cannot write either.
- **Confirmation.** `--apply` asks once, listing every repository, unless you pass `--yes`. Without a
  terminal and without `--yes` janitor refuses instead of assuming yes.
- **Your repositories only.** Mutating commands refuse to run when `--owner` differs from the login
  that owns the token.
- **Narrow contents writes.** The only file janitor ever writes is a new `LICENSE`; it never overwrites
  an existing file, and never touches default branches, branch protection or collaborators.
- **Change log.** Every applied change is appended to `~/.janitor/changes.jsonl` with the time,
  repository, field, value before, value after and the request that made it:

  ```json
  {"time":"2026-09-26T12:00:00.000Z","command":"fix","repo":"mk24x7/site","field":"description","before":null,"after":"Fast, in-memory work queue.","request":{"method":"PATCH","path":"/repos/mk24x7/site"}}
  ```

## Rate limits

janitor watches `X-RateLimit-Remaining` and pauses until the reset when it reaches zero (up to 15
minutes; longer waits stop with an error), backs off on secondary rate limits using `Retry-After`,
and never has more than 4 requests in flight. GET responses are cached by ETag in
`~/.janitor/cache/` (per token, files readable only by you); conditional requests answered with
`304 Not Modified` do not count against the rate limit. Use `--no-cache` to bypass the cache.
Set `JANITOR_HOME` to move both the cache and the change log.

## GitHub Action

Run a weekly, read-only audit and get the report as the job summary:

```yaml
name: Repository hygiene
on:
  schedule:
    - cron: '0 6 * * 1'
  workflow_dispatch:

permissions:
  contents: read

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: mk24x7/janitor@v1
        with:
          token: ${{ secrets.JANITOR_TOKEN }}
          command: audit
          args: --min-severity low
          fail-on-findings: false
```

| Input | Default | Description |
| --- | --- | --- |
| `token` | `github.token` | Token for the API. The built-in token only sees public repositories of the repository owner; use a personal access token secret to include private ones. |
| `command` | `audit` | Any janitor command. |
| `args` | empty | Extra arguments. `--owner` defaults to the repository owner. |
| `fail-on-findings` | `false` | Fail the step when there are findings or pending changes. |

Outputs: `findings` (count), `exit-code` and `result` (the JSON result).

Job summaries and logs of a public repository are public. If the token can see private repositories,
run the workflow in a private repository so their names are not published.

The Action is not listed on the GitHub Marketplace yet; publishing there is a manual step in the
release form.

## Token scopes

Fine-grained personal access tokens (recommended), with "Repository access: All repositories":

| Command | Permissions |
| --- | --- |
| `audit` | Metadata: read, Contents: read (README, manifests), Pull requests: read. Optional: Dependabot alerts: read, Pages: read |
| `fix` | Administration: read and write (description, homepage, topics, wiki setting), Contents: read, Pages: read |
| `archive`, `forks --apply` | Administration: read and write |
| `license --apply` | Contents: read and write |

Classic tokens: `repo` covers everything (`public_repo` is enough if you only have public
repositories). The token from `gh auth login` has `repo` scope.

## FAQ

**Will it make my private repositories public?**
No. There is no code path that can change visibility; the client refuses such requests outright.

**Can it delete anything?**
No. It never sends `DELETE`. The worst it can do is archive a repository you selected, which you can
unarchive in Settings.

**Why did `fix` skip my description?**
The README has no plain paragraph (only headings, badges, code or lists), or there is no README. Write
one sentence under the title, or set the description by hand.

**Why was a homepage skipped as ambiguous?**
The README links to more than one site that could be the project's home. janitor only sets a
homepage when there is exactly one candidate.

**Why does the audit say Dependabot alerts were not readable?**
Alerts are disabled for those repositories or the token lacks the Dependabot alerts permission. The
rule is skipped quietly for them.

**Does it work for organizations?**
`janitor audit --owner <org>` audits an organization's public repositories. Mutating commands only
act on repositories owned by the token's user.

**How do I undo a change?**
Read `~/.janitor/changes.jsonl`: each line has the previous value. Archived repositories can be
unarchived from their settings page.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports and rule requests are welcome as
[issues](https://github.com/mk24x7/janitor/issues/new/choose); security problems go through
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE), Copyright (c) 2026 Mukul Kumar Yadav.
