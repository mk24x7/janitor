# Security Policy

## Supported versions

Only the latest release of janitor receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub private vulnerability reporting: open the
repository's Security tab and choose "Report a vulnerability"
(https://github.com/mk24x7/janitor/security/advisories/new).

Do not open a public issue for security problems.

Include the janitor version, Node.js version, the command you ran and the smallest steps that
reproduce the problem. Never include your token.

You should receive an acknowledgement within 7 days. Once a fix is released the advisory will be
published and you will be credited unless you ask otherwise.

## Scope

janitor holds a token that can administer every repository you own, so the most serious bugs are
those that change something the user did not intend. In scope:

- Any way janitor could change repository visibility, delete a repository or branch, change the
  default branch, branch protection or collaborators, or write any file other than a new `LICENSE`.
- Any mutating request sent without `--apply`, without confirmation (when `--yes` was not given), or
  against repositories of an owner other than the token's user.
- Leaking the token, for example into logs, the change log, the ETag cache, or requests to hosts
  other than api.github.com and github.com.

Out of scope: derived descriptions, topics or homepages that are inaccurate but were shown in the dry
run and applied by the user.
