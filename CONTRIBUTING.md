# Contributing to janitor

Thanks for helping. janitor changes other people's repositories, so the bar for safety is high and
the codebase is deliberately small.

## Ground rules

- Zero runtime dependencies. Use Node.js built-ins (`fetch`, `util.parseArgs`, `util.styleText`,
  `node:test`).
- Pure ASCII in every file. `scripts/check-ascii.sh` runs in CI.
- No command or option may change repository visibility, delete a repository or write repository
  contents other than a new `LICENSE`. New mutations must be added to the allowlist in
  `src/github.js` together with tests, and must be dry run by default.
- Never run `--apply` against real repositories while developing. Tests use a mocked `fetch`.

## Development

```sh
git clone https://github.com/mk24x7/janitor.git
cd janitor
npm test                      # node:test, no install step needed
node src/cli.js audit         # read-only against your own account
node src/cli.js fix           # dry run
npm run build                 # regenerate dist/ for the Action after changing src/
scripts/check-ascii.sh
```

`dist/` is committed because GitHub Actions run it directly. CI fails if it differs from a fresh
`npm run build`.

## Adding a rule

1. Add an entry to `RULES` in `src/rules.js` with `id`, `severity` (`medium`, `low` or `info`),
   `description`, `fixableBy` (a janitor command or `manual`) and a pure `check` function.
2. If it needs new data, fetch it in `collectAuditFacts` in `src/inspect.js`. Treat 403 and 404 as
   "unknown" rather than as a finding.
3. Add positive and negative tests to `test/rules.test.js`.
4. Add the rule to the table in `README.md` (a test checks the table lists every rule).

## Pull requests

- Keep changes focused and include tests.
- Use imperative commit messages ("Add stale-issues rule").
- Update `CHANGELOG.md` under "Unreleased".
