# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.2] - 2026-09-26

### Changed

- The GitHub Action is listed as "Repo Hygiene Janitor"; "Repo Janitor" is also taken on the Marketplace.

## [1.0.1] - 2026-09-26

### Changed

- The GitHub Action is listed as "Repo Janitor"; the plain name "janitor" is taken on the Marketplace.

## [1.0.0] - 2026-09-26

### Added

- `janitor audit` with eleven rules: missing-description, missing-license, no-topics, empty-readme,
  stale-fork, archive-candidate, default-branch-master, no-homepage-with-pages,
  dependabot-alerts-open, large-repo and stale-open-prs. Table sorted by severity, summary footer,
  `--min-severity`, `--include-forks`, `--include-archived` and `--owner`.
- `janitor fix` for descriptions (from the README), topics (from language, manifests and homepage),
  homepages (GitHub Pages or the single site linked from the README) and empty wikis.
- `janitor license` to add a LICENSE file (MIT and ISC bundled, other SPDX ids from the GitHub API).
- `janitor archive` for repositories with no push in a period and few stars.
- `janitor forks` to find forks with nothing ahead of upstream and archive stale ones.
- `janitor topics --suggest <repo>`.
- `--json` on every command; exit codes 0, 1, 2 and 3.
- Dry run by default, confirmation prompt, owner check, request allowlist and a change log at
  `~/.janitor/changes.jsonl`.
- Rate limit handling, a concurrency cap of 4 and ETag caching in `~/.janitor/cache/`.
- GitHub Action (`node24`) that writes a Markdown job summary.

[Unreleased]: https://github.com/mk24x7/janitor/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/mk24x7/janitor/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/mk24x7/janitor/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/mk24x7/janitor/releases/tag/v1.0.0
