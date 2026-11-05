# Security policy

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately through GitHub's
**Security → Report a vulnerability** form on this repository. Include what you found, the steps
to reproduce it, and the Dena version (the `version` in the installed package's `package.json`).

You can expect an acknowledgement within a few days. Fixes ship in a new release, and the report
is credited in the changelog unless you ask otherwise.

## Scope

Dena runs on your own computer and serves its interface on `127.0.0.1` only. In scope:

- anything that exposes Dena's data or its API beyond the local machine or to other web pages
  (the page link carries a key; the key is stored in `~/.dena/server-key` with owner-only access);
- secrets, prompts or transcript content leaking into exports, logs or the wiki;
- the Claude Code hook changing a session in ways it should not.

Out of scope: problems in Claude Code itself or in the Anthropic API, and issues that need access
to your own account already.
