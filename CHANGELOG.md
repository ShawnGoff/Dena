# Changelog

## Unreleased

- **Listen**: a presenter on every guide step, wiki page and code page that reads it aloud and
  follows along, with previous/next part, pause, speed and voice choice. It adds no model calls:
  it rearranges text already written, and says plainly which statements Dena observed and which it
  only inferred.
- **Natural voice** (optional): a local speech model (Kokoro) for much more natural reading. Nothing
  is downloaded until you agree; it installs into `~/.dena/voice` (about 330 MB) and your text never
  leaves your computer. Remove it from the player at any time.
- The page's security policy now allows audio from the page's own `blob:` URLs (`media-src`),
  nothing else.

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
