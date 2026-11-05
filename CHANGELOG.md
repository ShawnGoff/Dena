# Changelog

## 0.1.0

First public release, as `dena-guide` on npm (the command is `dena`).

- Captures Claude Code conversations, file changes and git history for each project folder, and
  imports what Claude Code still keeps on disk. Live capture through Claude Code hooks is optional.
- Groups activity into steps and explains each one: what was done, how to do it, what to check,
  and common pitfalls, with links back to the evidence.
- Project memory, a wiki (overview, product, architecture, component pages, tutorial), and code
  explainers for source files in about 50 languages.
- Keeps a plain activity log with no AI involved, and tracks token use with a per-project budget.
- Exports the guide as Markdown or as one self-contained HTML page.
- Local web interface, with a link that keeps the same key between runs; optional background
  service on macOS.
- Claude Code plugin with a first-run checklist.
- Runs on macOS, Linux and Windows (CI covers all three).
